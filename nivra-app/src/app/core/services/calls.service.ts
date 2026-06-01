import { DestroyRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { CallPhase, CallSession, CallSignalEvent, PublicKeyDirectory, RecipientCipherRequest } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

interface PeerState {
  connection: RTCPeerConnection;
  pendingIce: RTCIceCandidate[];
}

interface DecodedCallSignalPayload {
  type?: string;
  payload?: unknown;
  at?: string;
}

interface SecureCallSignalEnvelope {
  v: 2;
  type: 'nivra-call-signal';
  recipients: RecipientCipherRequest[];
}

const CALL_RING_TIMEOUT_MS = 45_000;

@Injectable({ providedIn: 'root' })
export class CallsService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly crypto = inject(CryptoService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly peers = new Map<string, PeerState>();
  private readonly pendingSignals: CallSignalEvent[] = [];
  private readonly timedOutCallIds = new Set<string>();
  private readonly directories = new Map<string, PublicKeyDirectory>();
  private readonly textDecoder = new TextDecoder();
  private ringTimeout: number | null = null;

  readonly activeCall = signal<CallSession | null>(null);
  readonly phase = signal<CallPhase>('idle');
  readonly localStream = signal<MediaStream | null>(null);
  readonly remoteStreams = signal<Record<string, MediaStream>>({});
  readonly remoteStates = signal<Record<string, Record<string, unknown>>>({});
  readonly muted = signal(false);
  readonly cameraOff = signal(false);
  readonly speaker = signal(true);
  readonly error = signal('');
  readonly history = signal<CallSession[]>(this.loadHistory());
  readonly remoteEntries = computed(() => Object.entries(this.remoteStreams()));

  constructor() {
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event.type === 'call.started' || event.type === 'incomingCall') {
        void this.receiveIncoming(event.payload as CallSession);
      }
      if (event.type === 'call.signal') {
        void this.handleCallSignal(event.payload as CallSignalEvent);
      }
      if (event.type === 'call.ended' || event.type === 'CallEnded') {
        const call = event.payload as CallSession;
        if (call?.id === this.activeCall()?.id) {
          this.cleanup({ remember: false });
        }
        if (call?.id && this.timedOutCallIds.delete(call.id)) {
          this.addHistory({ ...call, status: 'Missed' });
        } else {
          this.addHistory(call);
        }
      }
      if (
        event.type === 'call.rejected' ||
        event.type === 'CallRejected' ||
        event.type === 'call.timeout' ||
        event.type === 'CallTimeout' ||
        event.type === 'call.failed'
      ) {
        const call = event.payload as CallSession;
        if (call?.id === this.activeCall()?.id) {
          const historyStatus = event.type.toLowerCase().includes('timeout')
            ? 'Missed'
            : event.type.toLowerCase().includes('failed') ? 'Failed' : 'Rejected';
          this.cleanup({ historyStatus });
        }
        this.addHistory(call);
      }
    });

    effect(() => {
      const userId = this.auth.session()?.user.id;
      untracked(() => {
        if (userId) {
          this.history.set(this.loadHistory());
        } else {
          this.cleanup({ remember: false });
          this.history.set([]);
        }
      });
    });
  }

  ngOnDestroy(): void {
    this.cleanup({ remember: false });
  }

  async start(type: 'Voice' | 'Video', conversationId: string | null, participantUserIds: string[] = []): Promise<CallSession> {
    this.error.set('');
    await this.prepareMedia(type === 'Video');
    try {
      const call = await firstValueFrom(this.api.post<CallSession>('/calls/start', {
        type,
        conversationId,
        participantUserIds,
      }));
      this.activeCall.set(call);
      this.phase.set('calling');
      this.addHistory(call);
      this.scheduleRingTimeout(call);
      await this.establishCallPeers();
      await this.flushPendingCallSignals();
      return call;
    } catch (error) {
      this.cleanup({ remember: false });
      this.error.set(error instanceof Error ? error.message : 'No se pudo iniciar la llamada.');
      throw error;
    }
  }

  async accept(): Promise<void> {
    const call = this.activeCall();
    if (!call) {
      return;
    }
    this.error.set('');
    await this.prepareMedia(call.type === 'Video');
    this.phase.set('connecting');
    this.clearRingTimeout();
    await Promise.all(this.otherParticipantIds(call).map((userId) =>
      this.sendCallSignal(call, userId, 'accepted', { accepted: true }).catch(() => undefined)));
    await this.establishCallPeers();
    await this.flushPendingCallSignals();
  }

  async decline(): Promise<void> {
    const call = this.activeCall();
    if (!call) {
      return;
    }
    this.phase.set('rejected');
    await Promise.all(this.otherParticipantIds(call).map((userId) =>
      this.sendCallSignal(call, userId, 'declined', { declined: true }).catch(() => undefined)));
    await this.chat.recordCallSystemMessage(call, 'call-rejected').catch(() => undefined);
    const shouldEndRoom = call.participantUserIds.length <= 2 || call.initiatorUserId === this.currentUserId();
    this.cleanup({ historyStatus: 'Rejected' });
    if (shouldEndRoom) {
      await firstValueFrom(this.api.post<CallSession>(`/calls/${encodeURIComponent(call.id)}/end`, {})).catch(() => null);
    }
  }

  async end(callId = this.activeCall()?.id): Promise<void> {
    if (!callId) {
      return;
    }
    const activeBeforeEnd = this.activeCall();
    this.phase.set('ended');
    const call = await firstValueFrom(this.api.post<CallSession>(`/calls/${encodeURIComponent(callId)}/end`, {}));
    const callLog = {
      ...(activeBeforeEnd?.id === call.id ? activeBeforeEnd : {}),
      ...call,
      endedAt: call.endedAt || new Date().toISOString(),
    };
    await this.chat.recordCallSystemMessage(callLog, 'call-ended', this.durationMsForCall(callLog)).catch(() => undefined);
    if (call.id === this.activeCall()?.id) {
      this.cleanup({ remember: false });
    }
    this.addHistory(call);
  }

  async rejoin(callId: string): Promise<void> {
    if (!callId || this.activeCall()) {
      return;
    }
    const call = await firstValueFrom(this.api.get<CallSession>(`/calls/${encodeURIComponent(callId)}`));
    if (call.status === 'Ended' || call.endedAt) {
      this.addHistory(call);
      return;
    }
    await this.prepareMedia(call.type === 'Video');
    this.activeCall.set(call);
    this.phase.set('connecting');
    this.clearRingTimeout();
    this.addHistory(call);
    await Promise.all(this.otherParticipantIds(call).map((userId) =>
      this.sendCallSignal(call, userId, 'accepted', { accepted: true, rejoined: true }).catch(() => undefined)));
    await this.establishCallPeers();
    await this.flushPendingCallSignals();
  }

  toggleMute(): void {
    const next = !this.muted();
    this.muted.set(next);
    this.localStream()?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    this.broadcastControl('muted', next);
  }

  toggleCamera(): void {
    const next = !this.cameraOff();
    this.cameraOff.set(next);
    this.localStream()?.getVideoTracks().forEach((track) => {
      track.enabled = !next;
    });
    this.broadcastControl('camera', next ? 'off' : 'on');
  }

  toggleSpeaker(): void {
    this.speaker.update((value) => !value);
  }

  releaseLocalResources(): void {
    this.cleanup({ remember: false });
  }

  private async receiveIncoming(call: CallSession): Promise<void> {
    if (!call?.id || call.status === 'Ended' || call.endedAt) {
      return;
    }
    const currentUserId = this.currentUserId();
    if (!currentUserId) {
      return;
    }
    if (this.activeCall()?.id === call.id) {
      this.addHistory(call);
      return;
    }
    if (this.activeCall() && this.activeCall()?.id !== call.id && this.phase() !== 'idle') {
      await this.sendCallSignal(call, call.initiatorUserId, 'busy', { busy: true }).catch(() => undefined);
      return;
    }

    this.activeCall.set(call);
    this.phase.set(call.initiatorUserId === currentUserId ? 'calling' : 'ringing');
    this.addHistory(call);
    this.scheduleRingTimeout(call);
    if (this.phase() !== 'ringing') {
      await this.flushPendingCallSignals();
    }
  }

  private async prepareMedia(withVideo: boolean): Promise<MediaStream> {
    this.stopLocalMedia();
    this.muted.set(false);
    this.cameraOff.set(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no expone microfono/camara.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo })
      .catch(() => {
        throw new Error(withVideo ? 'Permite camara y microfono para la videollamada.' : 'Permite el microfono para la llamada.');
      });
    this.localStream.set(stream);
    return stream;
  }

  private async handleCallSignal(signal: CallSignalEvent): Promise<void> {
    const call = this.activeCall();
    const signalType = (signal.signalType || '').toLowerCase();
    if (!signal.callId || !call || signal.callId !== call.id) {
      if (signal.callId) {
        this.pendingSignals.push(signal);
      }
      return;
    }

    if (signalType === 'accepted') {
      if (this.phase() === 'ringing') {
        this.pendingSignals.push(signal);
        return;
      }
      this.phase.set('connecting');
      this.clearRingTimeout();
      await this.establishAcceptedCallPeer(signal.fromUserId);
      return;
    }

    if (signalType === 'declined' || signalType === 'busy') {
      if (call.participantUserIds.length > 2) {
        this.updateRemoteCallState(signal.fromUserId, signalType, true);
        this.closePeerConnectionForUser(signal.fromUserId);
        return;
      }
      this.phase.set(signalType === 'busy' ? 'failed' : 'rejected');
      this.cleanup({ historyStatus: signalType === 'busy' ? 'Busy' : 'Rejected' });
      return;
    }

    if (signalType === 'left') {
      this.updateRemoteCallState(signal.fromUserId, 'left', true);
      this.closePeerConnectionForUser(signal.fromUserId);
      return;
    }

    if (signalType === 'offer' || signalType === 'answer' || signalType === 'ice') {
      if (this.phase() === 'ringing') {
        this.pendingSignals.push(signal);
        return;
      }
      await this.handleWebRtcSignal(signal);
      return;
    }

    if (signalType === 'muted' || signalType === 'camera') {
      const decoded = await this.decodeCallSignalPayload(signal);
      this.updateRemoteCallState(signal.fromUserId, signalType, decoded?.payload);
    }
  }

  private async establishCallPeers(onlyUserId: string | null = null): Promise<void> {
    const call = this.activeCall();
    if (!call || !this.localStream()) {
      return;
    }
    for (const userId of this.otherParticipantIds(call).filter((id) => !onlyUserId || id === onlyUserId)) {
      this.ensurePeerConnection(userId);
      if (this.shouldCreateOfferTo(userId)) {
        await this.createAndSendOffer(userId);
      }
    }
  }

  private async establishAcceptedCallPeer(userId: string): Promise<void> {
    const peer = this.peers.get(userId);
    if (this.shouldCreateOfferTo(userId) && peer?.connection && !peer.connection.remoteDescription) {
      peer.connection.close();
      this.peers.delete(userId);
      this.removeRemoteStream(userId);
    }
    await this.establishCallPeers(userId);
  }

  private ensurePeerConnection(userId: string): RTCPeerConnection | null {
    if (!window.RTCPeerConnection) {
      this.error.set('Este navegador no soporta WebRTC.');
      return null;
    }
    const existing = this.peers.get(userId);
    if (existing?.connection) {
      return existing.connection;
    }

    const connection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
    });
    this.peers.set(userId, { connection, pendingIce: [] });
    this.localStream()?.getTracks().forEach((track) => {
      const stream = this.localStream();
      if (stream) {
        connection.addTrack(track, stream);
      }
    });

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        const call = this.activeCall();
        if (call) {
          void this.sendCallSignal(call, userId, 'ice', { candidate: event.candidate.toJSON() }).catch(() => undefined);
        }
      }
    };
    connection.ontrack = (event) => {
      const stream = event.streams?.[0] || this.remoteStreams()[userId] || new MediaStream();
      if (!event.streams?.[0] && event.track) {
        stream.addTrack(event.track);
      }
      this.remoteStreams.update((items) => ({ ...items, [userId]: stream }));
    };
    connection.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(connection.connectionState)) {
        this.removeRemoteStream(userId);
      }
    };

    return connection;
  }

  private shouldCreateOfferTo(userId: string): boolean {
    const currentUserId = this.currentUserId();
    return Boolean(currentUserId && String(currentUserId) < String(userId));
  }

  private async createAndSendOffer(userId: string): Promise<void> {
    const call = this.activeCall();
    const connection = this.ensurePeerConnection(userId);
    if (!call || !connection || connection.signalingState !== 'stable') {
      return;
    }
    const offer = await connection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: call.type === 'Video' });
    await connection.setLocalDescription(offer);
    await this.sendCallSignal(call, userId, 'offer', { description: connection.localDescription });
  }

  private async handleWebRtcSignal(signal: CallSignalEvent): Promise<void> {
    const signalType = (signal.signalType || '').toLowerCase();
    const payload = (await this.decodeCallSignalPayload(signal))?.payload as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } | undefined;
    if (!signal.fromUserId || !payload) {
      return;
    }
    const call = this.activeCall();
    if (!this.localStream() && call) {
      await this.prepareMedia(call.type === 'Video');
    }
    const connection = this.ensurePeerConnection(signal.fromUserId);
    if (!connection || !call) {
      return;
    }

    if (signalType === 'offer' && payload.description) {
      if (connection.signalingState !== 'stable') {
        await connection.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit).catch(() => undefined);
      }
      await this.setRemoteDescriptionAndFlush(signal.fromUserId, connection, payload.description);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.sendCallSignal(call, signal.fromUserId, 'answer', { description: connection.localDescription });
      this.phase.set('connected');
      this.clearRingTimeout();
      return;
    }

    if (signalType === 'answer' && payload.description && connection.signalingState !== 'stable') {
      await this.setRemoteDescriptionAndFlush(signal.fromUserId, connection, payload.description);
      this.phase.set('connected');
      this.clearRingTimeout();
      return;
    }

    if (signalType === 'ice' && payload.candidate) {
      await this.addOrQueueRemoteIceCandidate(signal.fromUserId, payload.candidate);
    }
  }

  private async setRemoteDescriptionAndFlush(
    userId: string,
    connection: RTCPeerConnection,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await connection.setRemoteDescription(new RTCSessionDescription(description));
    await this.flushPeerIce(userId);
  }

  private async addOrQueueRemoteIceCandidate(userId: string, candidateInit: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(userId);
    if (!peer?.connection || !candidateInit) {
      return;
    }
    const candidate = new RTCIceCandidate(candidateInit);
    if (!peer.connection.remoteDescription?.type) {
      peer.pendingIce.push(candidate);
      return;
    }
    await peer.connection.addIceCandidate(candidate).catch(() => {
      if (!peer.connection.remoteDescription?.type) {
        peer.pendingIce.push(candidate);
      }
    });
  }

  private async flushPeerIce(userId: string): Promise<void> {
    const peer = this.peers.get(userId);
    if (!peer?.pendingIce.length || !peer.connection.remoteDescription?.type) {
      return;
    }
    const candidates = peer.pendingIce.splice(0);
    for (const candidate of candidates) {
      await peer.connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private async flushPendingCallSignals(): Promise<void> {
    const pending = this.pendingSignals.splice(0);
    for (const signal of pending) {
      await this.handleCallSignal(signal);
    }
  }

  private async sendCallSignal(call: CallSession, targetUserId: string, signalType: string, payload: unknown): Promise<unknown> {
    if (!call?.id || !targetUserId || targetUserId === this.currentUserId()) {
      return Promise.resolve(null);
    }
    const payloadCiphertext = await this.encryptCallSignalForUser(targetUserId, {
      type: signalType,
      payload,
      at: new Date().toISOString(),
    });
    return firstValueFrom(this.api.post(`/calls/${encodeURIComponent(call.id)}/signal`, {
      targetUserId,
      signalType,
      payloadCiphertext,
    }));
  }

  private broadcastControl(signalType: 'muted' | 'camera', payload: unknown): void {
    const call = this.activeCall();
    if (!call) {
      return;
    }
    this.otherParticipantIds(call).forEach((userId) => {
      void this.sendCallSignal(call, userId, signalType, payload).catch(() => undefined);
    });
  }

  private async encryptCallSignalForUser(targetUserId: string, value: DecodedCallSignalPayload): Promise<string> {
    const current = this.auth.session();
    if (!current) {
      throw new Error('No hay sesion local para cifrar la llamada.');
    }
    const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const directory = await this.directoryForUser(targetUserId);
    const recipients: RecipientCipherRequest[] = [];
    const usedDeviceIds = new Set<string>();
    for (const device of directory?.devices ?? []) {
      const publicKey = this.crypto.parsePublicJwk(device.keyBundle?.identityKey);
      if (!device.deviceId || !publicKey || usedDeviceIds.has(device.deviceId)) {
        continue;
      }
      const sealed = await this.crypto.encryptForPublicKey(own, publicKey, value);
      recipients.push({
        userId: targetUserId,
        deviceId: device.deviceId,
        ciphertext: sealed.ciphertext,
        header: sealed.header,
      });
      usedDeviceIds.add(device.deviceId);
    }
    if (!recipients.length) {
      throw new Error('No hay llaves publicas para senalizar la llamada.');
    }
    return this.crypto.base64UrlJson({
      v: 2,
      type: 'nivra-call-signal',
      recipients,
    } satisfies SecureCallSignalEnvelope);
  }

  private async decodeCallSignalPayload(signal: CallSignalEvent): Promise<DecodedCallSignalPayload | null> {
    try {
      const raw = signal.payloadCiphertext || '';
      const envelope = this.tryDecodeSecureEnvelope(raw);
      if (envelope?.v === 2 && envelope.type === 'nivra-call-signal') {
        const current = this.auth.session();
        if (!current) {
          return null;
        }
        const recipient = envelope.recipients.find((item) => item.userId === current.user.id && item.deviceId === current.device.id)
          ?? envelope.recipients.find((item) => item.userId === current.user.id);
        if (!recipient?.ciphertext) {
          return null;
        }
        const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
        return this.crypto.decryptEnvelope<DecodedCallSignalPayload>(own, recipient.header, recipient.ciphertext);
      }
      const binary = atob(raw);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return JSON.parse(this.textDecoder.decode(bytes)) as { type?: string; payload?: unknown; at?: string };
    } catch {
      return null;
    }
  }

  private tryDecodeSecureEnvelope(raw: string): SecureCallSignalEnvelope | null {
    if (!raw) {
      return null;
    }
    try {
      return raw.trim().startsWith('{')
        ? JSON.parse(raw) as SecureCallSignalEnvelope
        : this.crypto.jsonFromBase64Url<SecureCallSignalEnvelope>(raw);
    } catch {
      return null;
    }
  }

  private updateRemoteCallState(userId: string, key: string, value: unknown): void {
    this.remoteStates.update((items) => ({
      ...items,
      [userId]: {
        ...(items[userId] ?? {}),
        [key]: value,
      },
    }));
  }

  private cleanup(options: { remember?: boolean; historyStatus?: string } = {}): void {
    const call = this.activeCall();
    this.clearRingTimeout();
    if (call && options.remember !== false) {
      this.addHistory({
        ...call,
        status: options.historyStatus || 'Ended',
        endedAt: call.endedAt || new Date().toISOString(),
      });
    }
    this.stopLocalMedia();
    this.closePeerConnections();
    this.stopRemoteMedia();
    this.pendingSignals.splice(0);
    this.activeCall.set(null);
    this.phase.set('idle');
    this.remoteStates.set({});
    this.muted.set(false);
    this.cameraOff.set(false);
    this.speaker.set(true);
  }

  private stopLocalMedia(): void {
    this.localStream()?.getTracks().forEach((track) => track.stop());
    this.localStream.set(null);
  }

  private closePeerConnections(): void {
    for (const peer of this.peers.values()) {
      this.closePeerConnection(peer.connection);
      peer.pendingIce.splice(0);
    }
    this.peers.clear();
  }

  private closePeerConnectionForUser(userId: string): void {
    const peer = this.peers.get(userId);
    if (peer) {
      this.closePeerConnection(peer.connection);
      peer.pendingIce.splice(0);
    }
    this.peers.delete(userId);
    this.removeRemoteStream(userId);
  }

  private removeRemoteStream(userId: string): void {
    this.remoteStreams()[userId]?.getTracks().forEach((track) => track.stop());
    this.remoteStreams.update((items) => {
      const next = { ...items };
      delete next[userId];
      return next;
    });
  }

  private closePeerConnection(connection: RTCPeerConnection): void {
    connection.onicecandidate = null;
    connection.ontrack = null;
    connection.onconnectionstatechange = null;
    connection.getReceivers?.().forEach((receiver) => receiver.track?.stop());
    connection.close();
  }

  private stopRemoteMedia(): void {
    Object.values(this.remoteStreams()).forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    this.remoteStreams.set({});
  }

  private otherParticipantIds(call: CallSession): string[] {
    const currentUserId = this.currentUserId();
    return (call.participantUserIds ?? []).filter((userId) => userId && userId !== currentUserId);
  }

  private currentUserId(): string | null {
    return this.auth.session()?.user.id ?? null;
  }

  private addHistory(call: CallSession): void {
    if (!call?.id) {
      return;
    }
    this.history.update((items) => {
      const next = [call, ...items.filter((item) => item.id !== call.id)].slice(0, 80);
      this.saveHistory(next);
      return next;
    });
  }

  private callHistoryStorageKey(): string {
    const userId = this.auth.session()?.user.id;
    return userId ? `nivra.callHistory.${userId}` : 'nivra.callHistory';
  }

  private loadHistory(): CallSession[] {
    try {
      const scoped = JSON.parse(localStorage.getItem(this.callHistoryStorageKey()) || 'null') as CallSession[] | null;
      if (Array.isArray(scoped)) {
        return scoped.slice(0, 80);
      }
      const legacy = JSON.parse(localStorage.getItem('nivra.callHistory') || '[]') as CallSession[];
      return Array.isArray(legacy) ? legacy.slice(0, 80) : [];
    } catch {
      return [];
    }
  }

  private saveHistory(items: CallSession[]): void {
    if (!this.auth.session()?.user.id) {
      return;
    }
    localStorage.setItem(this.callHistoryStorageKey(), JSON.stringify(items.slice(0, 80)));
  }

  private scheduleRingTimeout(call: CallSession): void {
    this.clearRingTimeout();
    if (!call?.id || !this.isWaitingForAnswer()) {
      return;
    }
    this.ringTimeout = window.setTimeout(() => {
      void this.handleRingTimeout(call.id);
    }, CALL_RING_TIMEOUT_MS);
  }

  private clearRingTimeout(): void {
    if (this.ringTimeout !== null) {
      window.clearTimeout(this.ringTimeout);
      this.ringTimeout = null;
    }
  }

  private async handleRingTimeout(callId: string): Promise<void> {
    const call = this.activeCall();
    if (!call || call.id !== callId || !this.isWaitingForAnswer()) {
      return;
    }

    this.phase.set('missed');
    const endedAt = new Date().toISOString();
    this.timedOutCallIds.add(call.id);
    try {
      const ended = await firstValueFrom(this.api.post<CallSession>(`/calls/${encodeURIComponent(call.id)}/end`, {}));
      const missedCall = {
        ...ended,
        status: 'Missed',
        endedAt: ended.endedAt || endedAt,
      };
      await this.chat.recordCallSystemMessage(missedCall, 'missed-call').catch(() => undefined);
      this.addHistory(missedCall);
    } catch {
      const missedCall = {
        ...call,
        status: 'Missed',
        endedAt,
      };
      await this.chat.recordCallSystemMessage(missedCall, 'missed-call').catch(() => undefined);
      this.addHistory(missedCall);
    } finally {
      if (this.activeCall()?.id === callId) {
        this.cleanup({ remember: false });
      }
    }
  }

  private durationMsForCall(call: Pick<CallSession, 'startedAt' | 'endedAt'>): number {
    const started = Date.parse(call.startedAt || '');
    const ended = Date.parse(call.endedAt || '') || Date.now();
    if (!Number.isFinite(started) || !Number.isFinite(ended)) {
      return 0;
    }
    return Math.max(0, ended - started);
  }

  private async directoryForUser(userId: string): Promise<PublicKeyDirectory | null> {
    if (this.directories.has(userId)) {
      return this.directories.get(userId) ?? null;
    }
    const directories = await firstValueFrom(
      this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: [userId], aliases: [] }),
    ).catch(() => []);
    for (const directory of directories ?? []) {
      this.directories.set(directory.userId, directory);
    }
    return this.directories.get(userId) ?? null;
  }

  private isWaitingForAnswer(): boolean {
    return this.phase() === 'ringing' || this.phase() === 'calling';
  }
}
