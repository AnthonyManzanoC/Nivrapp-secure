import { DestroyRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Room, RoomEvent, type AudioCaptureOptions } from 'livekit-client';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CallPhase, CallSession, CallSignalEvent, GroupCallRoom, PublicKeyDirectory, RecipientCipherRequest } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
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
  sourceDeviceId?: string | null;
  sourceSessionId?: string | null;
}

interface SecureCallSignalEnvelope {
  v: 2;
  type: 'nivra-call-signal';
  recipients: RecipientCipherRequest[];
}

interface LiveKitRoomTokenResponse {
  serverUrl: string;
  token: string;
}

const CALL_RING_TIMEOUT_MS = 45_000;
const CALL_AUDIO_PROCESSING: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

@Injectable({ providedIn: 'root' })
export class CallsService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly crypto = inject(CryptoService);
  private readonly historyStore = inject(LocalHistoryService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly peers = new Map<string, PeerState>();
  private readonly pendingRemoteStreams = new Map<string, MediaStream>();
  private readonly pendingSignals: CallSignalEvent[] = [];
  private readonly timedOutCallIds = new Set<string>();
  private readonly systemLoggedCallIds = new Set<string>();
  private readonly directories = new Map<string, PublicKeyDirectory>();
  private liveKitRoom: Room | null = null;
  private readonly textDecoder = new TextDecoder();
  private ringTimeout: number | null = null;
  private ringToneInterval: number | null = null;
  private ringAudioContext: AudioContext | null = null;
  private ringTonePhase: 'calling' | 'ringing' | null = null;
  private readonly callSignalSessionId = crypto.randomUUID();
  private screenShareStream: MediaStream | null = null;
  private cameraTrackBeforeScreenShare: MediaStreamTrack | null = null;

  readonly activeCall = signal<CallSession | null>(null);
  readonly phase = signal<CallPhase>('idle');
  readonly localStream = signal<MediaStream | null>(null);
  readonly remoteStreams = signal<Record<string, MediaStream>>({});
  readonly remoteStates = signal<Record<string, Record<string, unknown>>>({});
  readonly muted = signal(false);
  readonly cameraOff = signal(false);
  readonly speaker = signal(true);
  readonly screenSharing = signal(false);
  readonly error = signal('');
  readonly history = signal<CallSession[]>(this.loadHistory());
  readonly activeGroupRooms = signal<Record<string, GroupCallRoom>>({});
  readonly remoteEntries = computed(() => Object.entries(this.remoteStreams()));

  constructor() {
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event.type === 'call.started' || event.type === 'incomingCall') {
        void this.receiveIncoming(event.payload as CallSession);
      }
      if (event.type === 'GroupCallStarted' || event.type === 'group.call.started' || event.type === 'groupCallStarted') {
        void this.receiveGroupCallStarted(event.payload);
      }
      if (event.type === 'call.signal') {
        void this.handleCallSignal(event.payload as CallSignalEvent);
      }
      if (event.type === 'call_answered_elsewhere') {
        this.handleAnsweredElsewhere(event.payload);
      }
      if (event.type === 'call.ended' || event.type === 'CallEnded') {
        const call = event.payload as CallSession;
        this.forgetGroupRoom(call);
        if (this.isGroupCall(call)) {
          void this.recordCallSystemOnce(call, 'call-ended', this.durationMsForCall(call));
        }
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
          void this.loadPersistentHistory();
        } else {
          this.cleanup({ remember: false });
        }
      });
    });
  }

  ngOnDestroy(): void {
    this.cleanup({ remember: false });
  }

  async start(type: 'Voice' | 'Video', conversationId: string | null, participantUserIds: string[] = []): Promise<CallSession> {
    this.error.set('');
    if (this.activeCall()) {
      const error = new Error('Ya hay una llamada activa.');
      this.error.set(error.message);
      throw error;
    }
    try {
      const groupCall = this.isGroupConversationId(conversationId);
      if (type === 'Video' && !groupCall) {
        await this.prepareMedia(true);
      }
      const call = await firstValueFrom(this.api.post<CallSession>('/calls/start', {
        type,
        conversationId,
        participantUserIds,
        groupId: groupCall ? conversationId : null,
        roomMode: groupCall ? 'GroupRoom' : 'Direct',
      }));
      const normalized = this.withGroupRoomMetadata(call, conversationId, groupCall);
      this.rememberGroupRoom(normalized);
      this.activeCall.set(normalized);
      this.phase.set('calling');
      this.addHistory(normalized);
      if (groupCall) {
        await this.connectLiveKitRoom(normalized);
      } else {
        this.scheduleRingTimeout(normalized);
        this.startRingingTone('calling');
        await this.flushPendingCallSignals();
      }
      return normalized;
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
    if (this.isGroupCall(call)) {
      this.phase.set('connecting');
      this.clearRingTimeout();
      this.stopRingingTone();
      await this.realtime.callAnsweredElsewhere(call.id).catch(() => undefined);
      await this.connectLiveKitRoom(call);
      return;
    }
    await this.prepareMedia(call.type === 'Video');
    this.phase.set('connecting');
    this.clearRingTimeout();
    this.stopRingingTone();
    await Promise.all(this.otherParticipantIds(call).map((userId) =>
      this.sendCallSignal(call, userId, 'accepted', { accepted: true }).catch(() => undefined)));
    await this.realtime.callAnsweredElsewhere(call.id).catch(() => undefined);
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
    if (!this.isGroupCall(call)) {
      await this.chat.recordCallSystemMessage(call, 'call-rejected').catch(() => undefined);
    }
    const shouldEndRoom = !this.isGroupCall(call) || call.initiatorUserId === this.currentUserId();
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
    await this.recordCallSystemOnce(callLog, 'call-ended', this.durationMsForCall(callLog));
    this.forgetGroupRoom(callLog);
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
    const normalized = this.withGroupRoomMetadata(call, call.conversationId ?? null, this.isGroupCall(call));
    if (this.isGroupCall(normalized)) {
      this.rememberGroupRoom(normalized);
      this.activeCall.set(normalized);
      this.phase.set('connecting');
      this.clearRingTimeout();
      this.addHistory(normalized);
      await this.connectLiveKitRoom(normalized);
      return;
    }
    await this.prepareMedia(normalized.type === 'Video');
    this.rememberGroupRoom(normalized);
    this.activeCall.set(normalized);
    this.phase.set('connecting');
    this.clearRingTimeout();
    this.addHistory(normalized);
    await Promise.all(this.otherParticipantIds(normalized).map((userId) =>
      this.sendCallSignal(normalized, userId, 'accepted', { accepted: true, rejoined: true }).catch(() => undefined)));
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
    if (next && this.screenSharing()) {
      void this.stopScreenShare();
    }
    this.cameraOff.set(next);
    this.localStream()?.getVideoTracks().forEach((track) => {
      track.enabled = !next;
    });
    this.broadcastControl('camera', next ? 'off' : 'on');
  }

  toggleSpeaker(): void {
    this.speaker.update((value) => !value);
  }

  canShareScreen(): boolean {
    const call = this.activeCall();
    if (!call || call.type !== 'Video' || !['connecting', 'connected'].includes(this.phase())) {
      return false;
    }
    if (this.isGroupCall(call)) {
      const participant = this.liveKitRoom?.localParticipant as unknown as { setScreenShareEnabled?: (enabled: boolean) => Promise<unknown> } | undefined;
      return typeof participant?.setScreenShareEnabled === 'function' || Boolean(this.displayMediaApi());
    }
    return Boolean(this.displayMediaApi());
  }

  async toggleScreenShare(): Promise<void> {
    if (this.screenSharing()) {
      await this.stopScreenShare();
    } else {
      await this.startScreenShare();
    }
  }

  releaseLocalResources(): void {
    this.cleanup({ remember: false });
  }

  activeGroupRoomForConversation(conversationId: string | null | undefined): GroupCallRoom | null {
    if (!conversationId) {
      return null;
    }
    return this.activeGroupRooms()[conversationId] ?? null;
  }

  async joinGroupRoom(room: GroupCallRoom): Promise<void> {
    if (!room?.call?.id) {
      return;
    }
    if (this.activeCall()?.id === room.call.id) {
      return;
    }
    if (this.activeCall()) {
      this.error.set('Ya hay una llamada activa.');
      return;
    }
    const call = this.withGroupRoomMetadata(room.call, room.conversationId, true);
    this.rememberGroupRoom(call);
    this.activeCall.set(call);
    this.phase.set('connecting');
    this.clearRingTimeout();
    this.stopRingingTone();
    this.addHistory(call);
    await this.connectLiveKitRoom(call);
  }

  private async startScreenShare(): Promise<void> {
    const call = this.activeCall();
    if (!call || call.type !== 'Video') {
      return;
    }
    this.error.set('');

    if (this.isGroupCall(call) && this.liveKitRoom) {
      const participant = this.liveKitRoom.localParticipant as unknown as {
        setScreenShareEnabled?: (enabled: boolean) => Promise<unknown>;
      };
      if (typeof participant.setScreenShareEnabled === 'function') {
        await participant.setScreenShareEnabled(true);
        this.screenSharing.set(true);
        this.broadcastControl('screen', 'on');
        this.syncLiveKitLocalTracks();
        return;
      }
    }

    const getDisplayMedia = this.displayMediaApi();
    if (!getDisplayMedia) {
      this.error.set('Compartir pantalla esta disponible desde Web o PC.');
      return;
    }

    const displayStream = await getDisplayMedia({ video: true, audio: false }).catch(() => null);
    const screenTrack = displayStream?.getVideoTracks()[0];
    if (!displayStream || !screenTrack) {
      this.error.set('No se pudo iniciar la captura de pantalla.');
      return;
    }

    this.screenShareStream = displayStream;
    this.cameraTrackBeforeScreenShare = this.localStream()?.getVideoTracks()[0] ?? null;
    await this.replaceOutgoingVideoTrack(screenTrack);
    this.publishLocalScreenTrack(screenTrack);
    screenTrack.onended = () => void this.stopScreenShare();
    this.screenSharing.set(true);
    this.broadcastControl('screen', 'on');
  }

  private async stopScreenShare(options: { restoreCamera?: boolean; broadcast?: boolean } = {}): Promise<void> {
    const restoreCamera = options.restoreCamera !== false;
    const broadcast = options.broadcast !== false;
    const call = this.activeCall();

    if (this.liveKitRoom && this.isGroupCall(call)) {
      const participant = this.liveKitRoom.localParticipant as unknown as {
        setScreenShareEnabled?: (enabled: boolean) => Promise<unknown>;
      };
      if (typeof participant.setScreenShareEnabled === 'function') {
        await participant.setScreenShareEnabled(false).catch(() => undefined);
        this.syncLiveKitLocalTracks();
      }
    }

    const previousCamera = this.cameraTrackBeforeScreenShare;
    if (restoreCamera && previousCamera && previousCamera.readyState !== 'ended') {
      await this.replaceOutgoingVideoTrack(previousCamera).catch(() => undefined);
      this.publishLocalCameraTrack(previousCamera);
    }

    this.screenShareStream?.getTracks().forEach((track) => track.stop());
    this.screenShareStream = null;
    this.cameraTrackBeforeScreenShare = null;
    if (this.screenSharing()) {
      this.screenSharing.set(false);
      if (broadcast) {
        this.broadcastControl('screen', 'off');
      }
    }
  }

  private displayMediaApi(): ((constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>) | null {
    const devices = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
    };
    return typeof devices?.getDisplayMedia === 'function'
      ? devices.getDisplayMedia.bind(devices)
      : null;
  }

  private async replaceOutgoingVideoTrack(track: MediaStreamTrack): Promise<void> {
    const replacements: Promise<void>[] = [];
    for (const peer of this.peers.values()) {
      const sender = peer.connection.getSenders().find((item) => item.track?.kind === 'video');
      if (sender) {
        replacements.push(sender.replaceTrack(track));
      }
    }
    await Promise.all(replacements);
  }

  private publishLocalScreenTrack(screenTrack: MediaStreamTrack): void {
    const current = this.localStream();
    const audioTracks = current?.getAudioTracks() ?? [];
    this.localStream.set(new MediaStream([...audioTracks, screenTrack]));
  }

  private publishLocalCameraTrack(cameraTrack: MediaStreamTrack): void {
    const current = this.localStream();
    const audioTracks = current?.getAudioTracks() ?? [];
    this.localStream.set(new MediaStream([...audioTracks, cameraTrack]));
  }

  private async connectLiveKitRoom(call: CallSession): Promise<void> {
    const credentials = await this.liveKitCredentialsForCall(call).catch((error) => {
      this.error.set(error instanceof Error ? error.message : 'No se pudo obtener el token LiveKit.');
      return null;
    });
    if (!credentials?.serverUrl || !credentials.token) {
      this.phase.set('calling');
      this.rememberGroupRoom(call);
      return;
    }
    this.disconnectLiveKitRoom();
    const room = new Room({
      audioCaptureDefaults: CALL_AUDIO_PROCESSING,
    });
    this.liveKitRoom = room;
    room.on(RoomEvent.TrackSubscribed, (track: unknown, _publication: unknown, participant: { identity?: string }) => {
      this.addLiveKitRemoteTrack(participant?.identity || crypto.randomUUID(), track);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: unknown, _publication: unknown, participant: { identity?: string }) => {
      this.removeLiveKitRemoteTrack(participant?.identity || '', track);
    });
    room.on(RoomEvent.LocalTrackPublished, () => this.syncLiveKitLocalTracks());
    room.on(RoomEvent.LocalTrackUnpublished, () => this.syncLiveKitLocalTracks());
    room.on(RoomEvent.Disconnected, () => {
      if (this.activeCall()?.id === call.id) {
        this.phase.set('ended');
      }
    });
    await room.connect(credentials.serverUrl, credentials.token);
    await (room.localParticipant as unknown as {
      setMicrophoneEnabled: (enabled: boolean, options?: AudioCaptureOptions) => Promise<unknown>;
      setCameraEnabled: (enabled: boolean) => Promise<unknown>;
    }).setMicrophoneEnabled(true, CALL_AUDIO_PROCESSING);
    if (call.type === 'Video') {
      await (room.localParticipant as unknown as {
        setCameraEnabled: (enabled: boolean) => Promise<unknown>;
      }).setCameraEnabled(true);
    }
    this.syncLiveKitLocalTracks();
    this.phase.set('connected');
    this.error.set('');
    this.clearRingTimeout();
    this.stopRingingTone();
  }

  private async liveKitCredentialsForCall(call: CallSession): Promise<LiveKitRoomTokenResponse | null> {
    const embeddedUrl = this.liveKitString(call, 'liveKitUrl') || environment.livekit?.url || '';
    const embeddedToken = this.liveKitString(call, 'liveKitToken') || environment.livekit?.token || '';
    if (embeddedUrl && embeddedToken) {
      return {
        serverUrl: embeddedUrl,
        token: embeddedToken,
      };
    }

    const groupId = call.groupId || call.conversationId;
    if (!groupId) {
      throw new Error('No se pudo resolver el grupo para la sala LiveKit.');
    }

    const response = await firstValueFrom(this.api.get<LiveKitRoomTokenResponse>(`/api/calls/room-token/${encodeURIComponent(groupId)}`));
    if (!response?.serverUrl || !response.token) {
      throw new Error('El servidor no devolvio credenciales LiveKit validas.');
    }
    return response;
  }

  private liveKitString(call: CallSession, key: 'liveKitUrl' | 'liveKitToken'): string {
    const value = (call as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  private addLiveKitRemoteTrack(participantId: string, track: unknown): void {
    const mediaTrack = (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
    if (!participantId || !mediaTrack) {
      return;
    }
    const stream = this.remoteStreams()[participantId] ?? new MediaStream();
    if (!stream.getTracks().some((item) => item.id === mediaTrack.id)) {
      stream.addTrack(mediaTrack);
    }
    this.remoteStreams.update((items) => ({ ...items, [participantId]: stream }));
  }

  private removeLiveKitRemoteTrack(participantId: string, track: unknown): void {
    const mediaTrack = (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
    if (!participantId || !mediaTrack) {
      return;
    }
    const stream = this.remoteStreams()[participantId];
    stream?.removeTrack(mediaTrack);
    if (!stream || !stream.getTracks().length) {
      this.remoteStreams.update((items) => {
        const next = { ...items };
        delete next[participantId];
        return next;
      });
    }
  }

  private syncLiveKitLocalTracks(): void {
    const localParticipant = this.liveKitRoom?.localParticipant as unknown as {
      trackPublications?: Map<string, { track?: { mediaStreamTrack?: MediaStreamTrack } | null }>;
    } | undefined;
    const tracks = [...(localParticipant?.trackPublications?.values() ?? [])]
      .map((publication) => publication.track?.mediaStreamTrack)
      .filter((track): track is MediaStreamTrack => Boolean(track));
    this.localStream.set(tracks.length ? new MediaStream(tracks) : null);
  }

  private disconnectLiveKitRoom(): void {
    const room = this.liveKitRoom;
    this.liveKitRoom = null;
    if (!room) {
      return;
    }
    room.removeAllListeners();
    room.disconnect();
  }

  inviteToCall(contactId: string): void {
    const call = this.activeCall();
    console.log('Migrating to Group SFU Call...', { contactId, callId: call?.id, roomId: call?.roomId || call?.id });
  }

  clearInactiveCallUi(): void {
    const phase = this.phase();
    const terminal = ['idle', 'ended', 'missed', 'rejected', 'failed'].includes(phase);
    if (!this.activeCall()) {
      if (phase !== 'idle') {
        this.phase.set('idle');
      }
      return;
    }
    if (terminal) {
      this.cleanup({ remember: false });
    }
  }

  callTitle(call: CallSession | null | undefined): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.chat.conversationTitle(conversation);
    }
    const participantNames = call
      ? this.callParticipantIds(call).map((userId) => this.chat.participantDisplayName(userId)).filter(Boolean)
      : [];
    if (participantNames.length) {
      return participantNames.join(', ');
    }
    return call?.type === 'Video' ? 'Videollamada' : 'Llamada';
  }

  callPhoto(call: CallSession | null | undefined): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.chat.conversationPhoto(conversation);
    }
    const participantId = call ? this.callParticipantIds(call)[0] : null;
    return this.chat.participantPhoto(participantId);
  }

  callInitials(call: CallSession | null | undefined): string {
    const conversation = this.conversationForCall(call);
    return conversation ? this.chat.avatarLabel(conversation) : this.initials(this.callTitle(call));
  }

  callStatusLabel(call: CallSession | null | undefined): string {
    const phase = this.phase();
    if (phase === 'calling') {
      return 'Llamando';
    }
    if (phase === 'ringing') {
      return 'Entrante';
    }
    if (phase === 'connecting') {
      return 'Conectando';
    }
    if (phase === 'connected') {
      return 'En llamada';
    }
    if (phase === 'missed') {
      return 'No respondio';
    }
    return call?.status || phase;
  }

  callParticipantAvatars(call: CallSession | null | undefined): { id: string; label: string; photo: string; initials: string }[] {
    const conversation = this.conversationForCall(call);
    const currentUserId = this.currentUserId();
    const fallbackParticipants: Array<{
      userId: string;
      displayName?: string | null;
      phone?: string | null;
      alias?: string | null;
      profilePhotoDataUrl?: string | null;
    }> = (call?.participantUserIds ?? [])
      .filter((userId) => userId !== currentUserId)
      .map((userId) => ({ userId }));
    const participants = conversation?.participants?.length
      ? conversation.participants.filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
      : fallbackParticipants;
    return participants.slice(0, 6).map((participant) => {
      const label = this.chat.participantDisplayName(participant.userId, participant);
      return {
        id: participant.userId,
        label,
        photo: this.chat.participantPhoto(participant.userId, participant),
        initials: this.initials(label),
      };
    });
  }

  isGroupCall(call: CallSession | null | undefined): boolean {
    if (!call) {
      return false;
    }
    return Boolean(call.isGroupRoom || call.groupId || (call.conversationId && this.isGroupConversationId(call.conversationId)));
  }

  private async receiveIncoming(call: CallSession): Promise<void> {
    if (!call?.id || call.status === 'Ended' || call.endedAt) {
      return;
    }
    const currentUserId = this.currentUserId();
    if (!currentUserId) {
      return;
    }
    const normalized = this.withGroupRoomMetadata(call, call.conversationId ?? call.groupId ?? null, this.isGroupCall(call));
    this.rememberGroupRoom(normalized);
    if (normalized.initiatorUserId === currentUserId && normalized.initiatorDeviceId && normalized.initiatorDeviceId !== this.currentDeviceId()) {
      this.addHistory(normalized);
      return;
    }
    if (this.activeCall()?.id === normalized.id) {
      this.addHistory(normalized);
      return;
    }
    if (this.activeCall() && this.activeCall()?.id !== normalized.id && this.phase() !== 'idle') {
      if (this.isGroupCall(normalized)) {
        this.addHistory(normalized);
        return;
      }
      await this.sendCallSignal(normalized, normalized.initiatorUserId, 'busy', { busy: true }).catch(() => undefined);
      return;
    }

    this.activeCall.set(normalized);
    this.phase.set(normalized.initiatorUserId === currentUserId ? 'calling' : 'ringing');
    this.addHistory(normalized);
    this.scheduleRingTimeout(normalized);
    this.startRingingTone(this.phase());
    if (this.phase() !== 'ringing') {
      await this.flushPendingCallSignals();
    }
  }

  private handleAnsweredElsewhere(payload: unknown): void {
    const value = payload as { callId?: string; answeredByUserId?: string; answeredByDeviceId?: string | null };
    const call = this.activeCall();
    if (!call?.id || call.id !== value.callId || value.answeredByUserId !== this.currentUserId()) {
      return;
    }
    if (!value.answeredByDeviceId || value.answeredByDeviceId === this.currentDeviceId()) {
      return;
    }
    if (['ringing', 'calling', 'connecting'].includes(this.phase())) {
      this.cleanup({ remember: false });
      this.addHistory({ ...call, status: 'Active' });
    }
  }

  private async prepareMedia(withVideo: boolean): Promise<MediaStream> {
    this.stopLocalMedia();
    this.muted.set(false);
    this.cameraOff.set(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no expone microfono/camara.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO_PROCESSING, video: withVideo })
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
      this.stopRingingTone();
      if (!this.localStream()) {
        await this.prepareMedia(call.type === 'Video');
      }
      await this.establishAcceptedCallPeer(signal.fromUserId);
      return;
    }

    if (signalType === 'declined' || signalType === 'busy') {
      if (this.isGroupCall(call) || call.participantUserIds.length > 2) {
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
    this.attachLocalTracks(connection);

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
      this.pendingRemoteStreams.set(userId, stream);
      this.publishRemoteStreamIfConnected(userId, connection);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') {
        this.phase.set('connected');
        this.clearRingTimeout();
        this.stopRingingTone();
        this.publishRemoteStreamIfConnected(userId, connection);
      }
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
      this.phase.set('connecting');
      this.clearRingTimeout();
      return;
    }

    if (signalType === 'answer' && payload.description && connection.signalingState !== 'stable') {
      await this.setRemoteDescriptionAndFlush(signal.fromUserId, connection, payload.description);
      this.phase.set('connecting');
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
      sourceDeviceId: this.currentDeviceId(),
      sourceSessionId: this.callSignalSessionId,
    });
    return firstValueFrom(this.api.post(`/calls/${encodeURIComponent(call.id)}/signal`, {
      targetUserId,
      signalType,
      payloadCiphertext,
    }));
  }

  private broadcastControl(signalType: 'muted' | 'camera' | 'screen', payload: unknown): void {
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

  private attachLocalTracks(connection: RTCPeerConnection): void {
    const stream = this.localStream();
    if (!stream) {
      return;
    }
    const existingTrackIds = new Set(connection.getSenders().map((sender) => sender.track?.id).filter(Boolean));
    stream.getTracks().forEach((track) => {
      if (!existingTrackIds.has(track.id)) {
        connection.addTrack(track, stream);
      }
    });
  }

  private publishRemoteStreamIfConnected(userId: string, connection: RTCPeerConnection): void {
    const stream = this.pendingRemoteStreams.get(userId);
    if (!stream || connection.connectionState !== 'connected') {
      return;
    }
    this.remoteStreams.update((items) => ({ ...items, [userId]: stream }));
  }

  private cleanup(options: { remember?: boolean; historyStatus?: string } = {}): void {
    const call = this.activeCall();
    this.clearRingTimeout();
    this.stopRingingTone();
    void this.stopScreenShare({ restoreCamera: false, broadcast: false });
    this.disconnectLiveKitRoom();
    if (call && options.remember !== false) {
      this.addHistory({
        ...call,
        status: options.historyStatus || 'Ended',
        endedAt: call.endedAt || new Date().toISOString(),
      });
    }
    this.stopLocalMedia();
    this.closePeerConnections();
    this.stopPendingRemoteMedia();
    this.stopRemoteMedia();
    this.pendingSignals.splice(0);
    this.activeCall.set(null);
    this.phase.set('idle');
    this.remoteStates.set({});
    this.muted.set(false);
    this.cameraOff.set(false);
    this.screenSharing.set(false);
    this.speaker.set(true);
    if (!this.auth.session()?.user.id) {
      this.activeGroupRooms.set({});
    }
  }

  private stopLocalMedia(): void {
    const stream = this.localStream();
    stream?.getTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
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
    this.pendingRemoteStreams.get(userId)?.getTracks().forEach((track) => track.stop());
    this.pendingRemoteStreams.delete(userId);
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

  private stopPendingRemoteMedia(): void {
    for (const stream of this.pendingRemoteStreams.values()) {
      stream.getTracks().forEach((track) => track.stop());
    }
    this.pendingRemoteStreams.clear();
  }

  private otherParticipantIds(call: CallSession): string[] {
    const currentUserId = this.currentUserId();
    return (call.participantUserIds ?? []).filter((userId) => userId && userId !== currentUserId);
  }

  private callParticipantIds(call: CallSession): string[] {
    const currentUserId = this.currentUserId();
    return [...new Set([call.initiatorUserId, ...(call.participantUserIds ?? [])])]
      .filter((userId) => userId && userId !== currentUserId);
  }

  private initials(value: string | null | undefined): string {
    return (value || 'Nivra')
      .split(/\s|,|-/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'N';
  }

  private currentUserId(): string | null {
    return this.auth.session()?.user.id ?? null;
  }

  private currentDeviceId(): string | null {
    return this.auth.session()?.device.id ?? null;
  }

  private conversationForCall(call: CallSession | null | undefined) {
    if (!call?.conversationId) {
      return null;
    }
    return this.chat.conversations().find((conversation) => conversation.id === call.conversationId) ?? null;
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
    const accountKey = this.localAccountKey();
    if (accountKey) {
      void this.historyStore.putCalls(accountKey, items.slice(0, 80)).catch(() => undefined);
    }
  }

  private async loadPersistentHistory(): Promise<void> {
    const accountKeys = await this.localAccountKeys();
    if (!accountKeys.length) {
      return;
    }
    const groups = await Promise.all(accountKeys.map((accountKey) => this.historyStore.calls(accountKey).catch(() => [])));
    const merged = this.uniqueHistory([...this.history(), ...groups.flat()]);
    if (merged.length) {
      this.history.set(merged);
      this.saveHistory(merged);
    }
  }

  private uniqueHistory(items: CallSession[]): CallSession[] {
    const map = new Map<string, CallSession>();
    for (const item of items) {
      if (!item?.id) {
        continue;
      }
      const previous = map.get(item.id);
      if (!previous || Date.parse(item.startedAt || '') >= Date.parse(previous.startedAt || '')) {
        map.set(item.id, item);
      }
    }
    return [...map.values()]
      .sort((left, right) => Date.parse(right.startedAt || '') - Date.parse(left.startedAt || ''))
      .slice(0, 80);
  }

  private localAccountKey(): string | null {
    return this.auth.session()?.user.id ?? null;
  }

  private async localAccountKeys(): Promise<string[]> {
    const userId = this.auth.session()?.user.id;
    if (!userId) {
      return [];
    }
    return this.historyStore.accountKeysForUser(userId).catch(() => [userId]);
  }

  private startRingingTone(phase: CallPhase): void {
    if (!['calling', 'ringing'].includes(phase)) {
      return;
    }
    const nextPhase = phase as 'calling' | 'ringing';
    if (this.ringToneInterval !== null && this.ringTonePhase === nextPhase) {
      return;
    }
    this.stopRingingTone();
    this.ringTonePhase = nextPhase;
    const playPulse = () => {
      try {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
          return;
        }
        this.ringAudioContext ??= new AudioContextCtor();
        const context = this.ringAudioContext;
        void context.resume?.();
        const pattern = nextPhase === 'calling'
          ? [{ offset: 0, duration: .48, frequency: 420 }, { offset: .62, duration: .42, frequency: 420 }]
          : [{ offset: 0, duration: .32, frequency: 720 }, { offset: .42, duration: .32, frequency: 860 }];
        for (const pulse of pattern) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const startAt = context.currentTime + pulse.offset;
          oscillator.type = nextPhase === 'calling' ? 'sine' : 'triangle';
          oscillator.frequency.setValueAtTime(pulse.frequency, startAt);
          gain.gain.setValueAtTime(0.0001, startAt);
          gain.gain.exponentialRampToValueAtTime(nextPhase === 'calling' ? 0.042 : 0.052, startAt + 0.035);
          gain.gain.exponentialRampToValueAtTime(0.0001, startAt + pulse.duration);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(startAt);
          oscillator.stop(startAt + pulse.duration + 0.02);
        }
      } catch {
        // Browsers can block autoplay for incoming calls; the visual ringing state still works.
      }
    };
    playPulse();
    this.ringToneInterval = window.setInterval(playPulse, nextPhase === 'calling' ? 2200 : 1800);
  }

  private stopRingingTone(): void {
    if (this.ringToneInterval !== null) {
      window.clearInterval(this.ringToneInterval);
      this.ringToneInterval = null;
    }
    void this.ringAudioContext?.close().catch(() => undefined);
    this.ringAudioContext = null;
    this.ringTonePhase = null;
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
    if (this.isGroupCall(call) && call.initiatorUserId !== this.currentUserId()) {
      this.addHistory({ ...call, status: 'Missed', endedAt });
      this.cleanup({ remember: false });
      return;
    }
    this.timedOutCallIds.add(call.id);
    try {
      const ended = await firstValueFrom(this.api.post<CallSession>(`/calls/${encodeURIComponent(call.id)}/end`, {}));
      const missedCall = {
        ...ended,
        status: 'Missed',
        endedAt: ended.endedAt || endedAt,
      };
      await this.recordCallSystemOnce(missedCall, 'missed-call');
      this.addHistory(missedCall);
    } catch {
      const missedCall = {
        ...call,
        status: 'Missed',
        endedAt,
      };
      await this.recordCallSystemOnce(missedCall, 'missed-call');
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

  private async receiveGroupCallStarted(payload: unknown): Promise<void> {
    const value = payload as Partial<GroupCallRoom> & Partial<CallSession> & { call?: CallSession };
    const baseCall = value.call ?? (value.id ? value as CallSession : null);
    if (!baseCall?.id) {
      return;
    }
    const conversationId = value.conversationId || value.groupId || baseCall.conversationId || baseCall.groupId || null;
    const call = this.withGroupRoomMetadata({
      ...baseCall,
      conversationId: baseCall.conversationId || conversationId,
      groupId: baseCall.groupId || value.groupId || conversationId,
      roomId: baseCall.roomId || value.roomId || baseCall.id,
      participantUserIds: baseCall.participantUserIds || value.participantUserIds || [],
      isGroupRoom: true,
    }, conversationId, true);
    this.rememberGroupRoom(call);
    await this.receiveIncoming(call);
  }

  private withGroupRoomMetadata(call: CallSession, conversationId: string | null, groupCall: boolean): CallSession {
    if (!groupCall) {
      return call;
    }
    const resolvedConversationId = call.conversationId || conversationId || call.groupId || null;
    return {
      ...call,
      conversationId: resolvedConversationId,
      groupId: call.groupId || resolvedConversationId,
      roomId: call.roomId || call.id,
      isGroupRoom: true,
    };
  }

  private rememberGroupRoom(call: CallSession | null | undefined): void {
    if (!call || !this.isGroupCall(call) || !call.conversationId) {
      return;
    }
    const room: GroupCallRoom = {
      roomId: call.roomId || call.id,
      groupId: call.groupId || call.conversationId,
      conversationId: call.conversationId,
      call,
      participantUserIds: call.participantUserIds ?? [],
      joinedParticipantIds: call.joinedParticipantIds ?? [],
      startedAt: call.startedAt || new Date().toISOString(),
      endedAt: call.endedAt ?? null,
    };
    this.activeGroupRooms.update((rooms) => ({ ...rooms, [room.conversationId]: room }));
  }

  private forgetGroupRoom(call: CallSession | null | undefined): void {
    const conversationId = call?.conversationId || call?.groupId;
    if (!conversationId) {
      return;
    }
    this.activeGroupRooms.update((rooms) => {
      if (!rooms[conversationId]) {
        return rooms;
      }
      const next = { ...rooms };
      delete next[conversationId];
      return next;
    });
  }

  private isGroupConversationId(conversationId: string | null | undefined): boolean {
    if (!conversationId) {
      return false;
    }
    const conversation = this.chat.conversations().find((item) => item.id === conversationId);
    return String(conversation?.type || '').toLowerCase() === 'group';
  }

  private async recordCallSystemOnce(
    call: CallSession,
    event: 'call-rejected' | 'call-ended' | 'missed-call' | 'call-failed',
    durationMs = 0,
  ): Promise<void> {
    if (!call?.id || this.systemLoggedCallIds.has(`${call.id}:${event}`)) {
      return;
    }
    this.systemLoggedCallIds.add(`${call.id}:${event}`);
    await this.chat.recordCallSystemMessage(call, event, durationMs).catch(() => undefined);
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
