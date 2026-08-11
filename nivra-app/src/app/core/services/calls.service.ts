import { DestroyRef, Injectable, NgZone, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Room, RoomEvent, type AudioCaptureOptions } from 'livekit-client';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CallPhase, CallSession, CallSignalEvent, GroupCallRoom, PublicKeyDirectory, RecipientCipherRequest } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NativeDeviceService, type NativeCallActionEvent } from './native-device.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

interface PeerState {
  connection: RTCPeerConnection;
  pendingIce: RTCIceCandidate[];
  iceRestartAttempts: number;
  disconnectTimer: number | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  negotiationQueued: boolean;
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

interface WebRtcIceConfigResponse {
  iceServers?: Array<{
    urls: string | string[];
    username?: string | null;
    credential?: string | null;
  }>;
  relayOnly?: boolean;
}

interface LiveKitTrackLike {
  mediaStreamTrack?: MediaStreamTrack;
  source?: unknown;
}

interface LiveKitPublicationLike {
  source?: unknown;
  track?: LiveKitTrackLike | null;
}

const CALL_RING_TIMEOUT_MS = 45_000;
const MAX_ICE_RESTART_ATTEMPTS = 3;
const CALL_SIGNAL_POLL_MS = 1_500;
const ICE_CONFIG_MAX_AGE_MS = 4 * 60_000;
const CONNECTION_RECOVERY_DELAY_MS = 10_000;
const CONNECTION_FAILURE_DELAY_MS = 30_000;
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];
const CALL_AUDIO_PROCESSING: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const CALL_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48_000 },
};
const CALL_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: 'user',
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30, max: 30 },
};

@Injectable({ providedIn: 'root' })
export class CallsService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly crypto = inject(CryptoService);
  private readonly historyStore = inject(LocalHistoryService);
  private readonly nativeDevice = inject(NativeDeviceService);
  private readonly realtime = inject(SignalrService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
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
  private connectedUiReconcileTimers: number[] = [];
  private screenShareStream: MediaStream | null = null;
  private cameraTrackBeforeScreenShare: MediaStreamTrack | null = null;
  private readonly screenShareAudioTrackIds = new Set<string>();
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private iceTransportPolicy: RTCIceTransportPolicy = 'all';
  private iceConfigPromise: Promise<void> | null = null;
  private iceConfigLoadedAt = 0;
  private signalPollTimer: number | null = null;
  private signalPollInFlight = false;
  private readonly processedSignalIds = new Set<string>();
  private connectionRecoveryTimer: number | null = null;
  private connectionFailureTimer: number | null = null;
  private networkRecoveryInFlight = false;
  private groupMigrationCallId: string | null = null;
  private groupMigrationPromise: Promise<void> | null = null;
  private readonly onlineHandler = () => {
    void this.recoverAfterNetworkChange();
  };
  private readonly connectionChangeHandler = () => {
    void this.recoverAfterNetworkChange();
  };
  private readonly visibilityChangeHandler = () => {
    if (document.visibilityState === 'visible') {
      const call = this.activeCall();
      if (call?.id) {
        void this.pollPersistedSignals(call.id);
      }
      const directPeersHealthy = !this.isGroupCall(call) &&
        this.peers.size > 0 &&
        [...this.peers.values()].every((peer) => this.peerConnectionLooksConnected(peer.connection));
      if (this.phase() !== 'connected' || (!this.isGroupCall(call) && !directPeersHealthy)) {
        void this.recoverAfterNetworkChange();
      }
    }
  };

  readonly activeCall = signal<CallSession | null>(null);
  readonly phase = signal<CallPhase>('idle');
  readonly localStream = signal<MediaStream | null>(null);
  readonly remoteStreams = signal<Record<string, MediaStream>>({});
  readonly remoteStates = signal<Record<string, Record<string, unknown>>>({});
  readonly muted = signal(false);
  readonly cameraOff = signal(false);
  readonly speaker = signal(true);
  readonly screenSharing = signal(false);
  readonly mediaUpgradeInFlight = signal(false);
  readonly activeScreenShareStreamId = signal<string | null>(null);
  readonly error = signal('');
  readonly history = signal<CallSession[]>(this.loadHistory());
  readonly activeGroupRooms = signal<Record<string, GroupCallRoom>>({});
  readonly remoteEntries = computed(() => Object.entries(this.remoteStreams()));

  constructor() {
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event.type === 'call.started' || event.type === 'incomingCall') {
        void this.receiveIncoming(event.payload as CallSession);
      }
      if (event.type === 'call.updated') {
        void this.applyActiveCallUpdate(event.payload as CallSession);
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

    void this.nativeDevice.onNativeCallAction((event) => {
      void this.handleNativeCallAction(event);
    }).catch(() => undefined);

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

    effect(() => {
      const callId = this.activeCall()?.id ?? null;
      untracked(() => {
        if (callId) {
          this.startSignalPolling(callId);
        } else {
          this.stopSignalPolling();
        }
      });
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
      this.networkInformation()?.addEventListener?.('change', this.connectionChangeHandler);
    }
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.networkInformation()?.removeEventListener?.('change', this.connectionChangeHandler);
    }
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
      if (!groupCall) {
        await this.loadIceConfiguration();
      }
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
    void this.nativeDevice.clearIncomingCall(call.id);
    if (this.isGroupCall(call)) {
      this.setConnectingPhase();
      this.clearRingTimeout();
      this.stopRingingTone();
      await this.realtime.callAnsweredElsewhere(call.id).catch(() => undefined);
      await this.connectLiveKitRoom(call);
      return;
    }
    await this.loadIceConfiguration();
    await this.prepareMedia(call.type === 'Video');
    this.setConnectingPhase();
    this.clearRingTimeout();
    this.stopRingingTone();
    await Promise.all(this.otherParticipantIds(call).map((userId) =>
      this.sendCallSignal(call, userId, 'accepted', { accepted: true }).catch(() => undefined)));
    await this.realtime.callAnsweredElsewhere(call.id).catch(() => undefined);
    await this.establishCallPeers();
    await this.flushPendingCallSignals();
    this.scheduleConnectedUiReconcile(call.id);
  }

  async decline(): Promise<void> {
    const call = this.activeCall();
    if (!call) {
      return;
    }
    void this.nativeDevice.clearIncomingCall(call.id);
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
    void this.nativeDevice.clearIncomingCall(callId);
    const activeBeforeEnd = this.activeCall();
    if (
      activeBeforeEnd?.id === callId &&
      this.isGroupCall(activeBeforeEnd) &&
      this.hasRemoteGroupParticipants()
    ) {
      await this.leaveGroupCallLocally(activeBeforeEnd);
      return;
    }
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
      this.setConnectingPhase();
      this.clearRingTimeout();
      this.addHistory(normalized);
      await this.connectLiveKitRoom(normalized);
      return;
    }
    await this.loadIceConfiguration();
    await this.prepareMedia(normalized.type === 'Video');
    this.rememberGroupRoom(normalized);
    this.activeCall.set(normalized);
    this.setConnectingPhase();
    this.clearRingTimeout();
    this.addHistory(normalized);
    await Promise.all(this.otherParticipantIds(normalized).map((userId) =>
      this.sendCallSignal(normalized, userId, 'accepted', { accepted: true, rejoined: true }).catch(() => undefined)));
    await this.establishCallPeers();
    await this.flushPendingCallSignals();
    this.scheduleConnectedUiReconcile(normalized.id);
  }

  async toggleMute(): Promise<void> {
    const next = !this.muted();
    const call = this.activeCall();
    try {
      if (this.isGroupCall(call) && this.liveKitRoom) {
        await (this.liveKitRoom.localParticipant as unknown as {
          setMicrophoneEnabled: (enabled: boolean, options?: AudioCaptureOptions) => Promise<unknown>;
        }).setMicrophoneEnabled(!next, CALL_AUDIO_PROCESSING);
        this.syncLiveKitLocalTracks();
      } else if (!next && !this.localStream()?.getAudioTracks().some((track) => track.readyState === 'live')) {
        await this.restoreDirectMediaTrack('audio');
      }
      this.muted.set(next);
      this.localStream()?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      this.error.set('');
      this.broadcastControl('muted', next);
    } catch {
      this.error.set('No se pudo reactivar el microfono. Revisa el permiso del dispositivo.');
    }
  }

  async toggleCamera(): Promise<void> {
    const call = this.activeCall();
    if (call && call.type !== 'Video') {
      await this.enableVideo();
      return;
    }
    const next = !this.cameraOff();
    if (next && this.screenSharing()) {
      await this.stopScreenShare();
    }
    try {
      if (this.isGroupCall(call) && this.liveKitRoom) {
        await (this.liveKitRoom.localParticipant as unknown as {
          setCameraEnabled: (enabled: boolean) => Promise<unknown>;
        }).setCameraEnabled(!next);
        this.syncLiveKitLocalTracks();
      } else if (!next && !this.localStream()?.getVideoTracks().some((track) => track.readyState === 'live')) {
        await this.restoreDirectMediaTrack('video');
      }
      this.cameraOff.set(next);
      this.localStream()?.getVideoTracks().forEach((track) => {
        track.enabled = !next;
      });
      this.error.set('');
      this.broadcastControl('camera', next ? 'off' : 'on');
    } catch {
      this.cameraOff.set(true);
      this.error.set('No se pudo reactivar la camara. Revisa el permiso del dispositivo.');
    }
  }

  async enableVideo(): Promise<void> {
    const call = this.activeCall();
    if (!call || this.mediaUpgradeInFlight()) {
      return;
    }
    if (call.type === 'Video') {
      if (this.cameraOff()) {
        await this.toggleCamera();
      }
      return;
    }
    if (!['connecting', 'connected'].includes(this.phase())) {
      this.error.set('Espera a que la llamada conecte antes de activar el video.');
      return;
    }

    this.mediaUpgradeInFlight.set(true);
    this.error.set('');
    const groupCall = this.isGroupCall(call);
    try {
      if (groupCall) {
        const participant = this.liveKitRoom?.localParticipant as unknown as {
          setCameraEnabled?: (enabled: boolean) => Promise<unknown>;
        } | undefined;
        if (typeof participant?.setCameraEnabled !== 'function') {
          throw new Error('La sala aun no esta lista para publicar video.');
        }
        await participant.setCameraEnabled(true);
        this.syncLiveKitLocalTracks();
      } else {
        await this.restoreDirectMediaTrack('video', false);
      }

      const response = await firstValueFrom(this.api.patch<CallSession>(
        `/calls/${encodeURIComponent(call.id)}/type`,
        { type: 'Video' },
      ));
      const updated = {
        ...call,
        ...response,
        type: 'Video',
      } as CallSession;
      this.activeCall.set(updated);
      this.cameraOff.set(false);
      this.rememberGroupRoom(updated);
      this.addHistory(updated);

      if (!groupCall) {
        this.broadcastControl('media-mode', { type: 'Video', video: true });
        await this.renegotiateDirectPeers(true);
      }
    } catch (error) {
      if (groupCall) {
        const participant = this.liveKitRoom?.localParticipant as unknown as {
          setCameraEnabled?: (enabled: boolean) => Promise<unknown>;
        } | undefined;
        if (typeof participant?.setCameraEnabled === 'function') {
          await participant.setCameraEnabled(false).catch(() => undefined);
        }
        this.syncLiveKitLocalTracks();
      } else {
        await this.removeDirectVideoTrack();
      }
      this.cameraOff.set(true);
      this.error.set(error instanceof Error ? error.message : 'No se pudo activar el video en esta llamada.');
    } finally {
      this.mediaUpgradeInFlight.set(false);
    }
  }

  toggleSpeaker(): void {
    this.speaker.update((value) => !value);
  }

  canOfferScreenShare(): boolean {
    const call = this.activeCall();
    if (!call || call.type !== 'Video' || this.isNativePlatform()) {
      return false;
    }
    if (this.isGroupCall(call)) {
      const participant = this.liveKitRoom?.localParticipant as unknown as { setScreenShareEnabled?: (enabled: boolean, options?: unknown) => Promise<unknown> } | undefined;
      return typeof participant?.setScreenShareEnabled === 'function' || Boolean(this.displayMediaApi());
    }
    return Boolean(this.displayMediaApi());
  }

  canShareScreen(): boolean {
    const call = this.activeCall();
    if (!call || call.type !== 'Video' || !['connecting', 'connected'].includes(this.phase())) {
      return false;
    }
    return this.canOfferScreenShare();
  }

  async toggleScreenShare(): Promise<void> {
    if (this.screenSharing()) {
      await this.stopScreenShare();
    } else {
      await this.startScreenShare();
    }
  }

  async retryConnection(): Promise<void> {
    const call = this.activeCall();
    if (!call || this.phase() === 'ringing' || this.networkRecoveryInFlight) {
      return;
    }
    if (this.isGroupCall(call)) {
      this.setConnectingPhase();
      this.error.set('');
      await this.connectLiveKitRoom(call).catch((error) => {
        this.phase.set('failed');
        this.error.set(error instanceof Error ? error.message : 'No se pudo reconectar la sala.');
      });
      return;
    }

    this.networkRecoveryInFlight = true;
    this.error.set('');
    this.setConnectingPhase();
    try {
      await this.loadIceConfiguration(true);
      if (!this.localStream()) {
        await this.prepareMedia(call.type === 'Video');
      }
      await Promise.all(this.otherParticipantIds(call).map((userId) =>
        this.sendCallSignal(call, userId, 'accepted', { accepted: true, recovery: true }).catch(() => undefined)));
      await this.establishCallPeers();
      for (const [userId, peer] of this.peers.entries()) {
        peer.iceRestartAttempts = 0;
        peer.connection.setConfiguration({
          iceServers: this.iceServers,
          iceTransportPolicy: this.iceTransportPolicy,
        });
        await this.restartIceForPeer(userId, this.shouldCreateOfferTo(userId));
      }
      await this.pollPersistedSignals(call.id);
      this.scheduleConnectedUiReconcile(call.id);
    } catch (error) {
      this.phase.set('failed');
      this.error.set(error instanceof Error ? error.message : 'No se pudo reintentar la conexion.');
    } finally {
      this.networkRecoveryInFlight = false;
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

  async refreshActiveGroupRoom(conversationId: string | null | undefined): Promise<GroupCallRoom | null> {
    const id = conversationId?.trim();
    if (!id || !this.isGroupConversationId(id)) {
      return null;
    }

    try {
      const call = await firstValueFrom(this.api.get<CallSession | null>(`/calls/active/${encodeURIComponent(id)}`));
      if (!call || call.status === 'Ended' || call.endedAt) {
        this.forgetGroupRoom({ id: '', conversationId: id, groupId: id } as CallSession);
        return null;
      }
      const normalized = this.withGroupRoomMetadata(call, id, true);
      this.rememberGroupRoom(normalized);
      return this.activeGroupRoomForConversation(id);
    } catch {
      return this.activeGroupRoomForConversation(id);
    }
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
    this.setConnectingPhase();
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
    if (this.isNativePlatform()) {
      return;
    }

    if (this.isGroupCall(call) && this.liveKitRoom) {
      const participant = this.liveKitRoom.localParticipant as unknown as {
        setScreenShareEnabled?: (enabled: boolean, options?: unknown) => Promise<unknown>;
      };
      if (typeof participant.setScreenShareEnabled === 'function') {
        try {
          await participant.setScreenShareEnabled(true, { audio: true });
        } catch (error) {
          this.error.set(error instanceof Error ? error.message : 'No se pudo iniciar la pantalla compartida.');
          return;
        }
        this.screenSharing.set(true);
        this.broadcastControl('screen', 'on');
        this.syncLiveKitLocalTracks();
        return;
      }
    }

    const getDisplayMedia = this.displayMediaApi();
    if (!getDisplayMedia) {
      return;
    }

    let displayStream: MediaStream | null = null;
    try {
      displayStream = await getDisplayMedia({ video: true, audio: true });
    } catch {
      this.error.set('No se pudo iniciar la captura de pantalla.');
      return;
    }
    const screenTrack = displayStream?.getVideoTracks()[0];
    if (!displayStream || !screenTrack) {
      this.error.set('No se pudo iniciar la captura de pantalla.');
      return;
    }

    screenTrack.contentHint = 'detail';
    this.screenShareStream = displayStream;
    this.cameraTrackBeforeScreenShare = this.localStream()?.getVideoTracks()[0] ?? null;
    await this.replaceOutgoingVideoTrack(screenTrack);
    await this.addOutgoingScreenAudioTracks(displayStream);
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
        setScreenShareEnabled?: (enabled: boolean, options?: unknown) => Promise<unknown>;
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

    await this.removeOutgoingScreenAudioTracks();
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
    if (typeof navigator === 'undefined' || this.isNativePlatform()) {
      return null;
    }
    const devices = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
    };
    return typeof devices?.getDisplayMedia === 'function'
      ? devices.getDisplayMedia.bind(devices)
      : null;
  }

  private async replaceOutgoingVideoTrack(track: MediaStreamTrack): Promise<void> {
    let requiresNegotiation = false;
    for (const peer of this.peers.values()) {
      const stream = this.screenShareStream ?? this.localStream() ?? new MediaStream([track]);
      requiresNegotiation = await this.setOutgoingTrack(peer.connection, 'video', track, stream)
        || requiresNegotiation;
    }
    if (requiresNegotiation) {
      await this.renegotiateDirectPeers();
    }
  }

  private async addOutgoingScreenAudioTracks(displayStream: MediaStream): Promise<void> {
    const audioTracks = displayStream.getAudioTracks();
    if (!audioTracks.length) {
      return;
    }
    let changed = false;
    audioTracks.forEach((track) => this.screenShareAudioTrackIds.add(track.id));
    for (const peer of this.peers.values()) {
      const existingTrackIds = new Set(peer.connection.getSenders().map((sender) => sender.track?.id).filter(Boolean));
      audioTracks.forEach((track) => {
        if (!existingTrackIds.has(track.id)) {
          try {
            const sender = peer.connection.addTrack(track, displayStream);
            void this.tuneOutgoingSender(sender);
            changed = true;
          } catch {
            this.screenShareAudioTrackIds.delete(track.id);
          }
        }
      });
    }
    if (changed) {
      await this.renegotiateDirectPeers();
    }
  }

  private async removeOutgoingScreenAudioTracks(): Promise<void> {
    if (!this.screenShareAudioTrackIds.size) {
      return;
    }
    let changed = false;
    for (const peer of this.peers.values()) {
      peer.connection.getSenders()
        .filter((sender) => sender.track?.id && this.screenShareAudioTrackIds.has(sender.track.id))
        .forEach((sender) => {
          peer.connection.removeTrack(sender);
          changed = true;
        });
    }
    this.screenShareAudioTrackIds.clear();
    if (changed) {
      await this.renegotiateDirectPeers();
    }
  }

  private publishLocalScreenTrack(screenTrack: MediaStreamTrack): void {
    const current = this.localStream();
    const audioTracks = (current?.getAudioTracks() ?? []).filter((track) => !this.screenShareAudioTrackIds.has(track.id));
    const tracks = [...audioTracks, screenTrack];
    this.localStream.set(new MediaStream(tracks.filter((track, index) => tracks.findIndex((item) => item.id === track.id) === index)));
  }

  private publishLocalCameraTrack(cameraTrack: MediaStreamTrack): void {
    const current = this.localStream();
    const audioTracks = (current?.getAudioTracks() ?? []).filter((track) => !this.screenShareAudioTrackIds.has(track.id));
    this.localStream.set(new MediaStream([...audioTracks, cameraTrack]));
  }

  private async connectLiveKitRoom(call: CallSession): Promise<void> {
    const credentials = await this.liveKitCredentialsForCall(call).catch((error) => {
      this.error.set(error instanceof Error ? error.message : 'No se pudo obtener el token LiveKit.');
      return null;
    });
    if (!credentials?.serverUrl || !credentials.token) {
      this.phase.set('failed');
      this.rememberGroupRoom(call);
      return;
    }
    this.disconnectLiveKitRoom();
    const room = new Room({
      audioCaptureDefaults: CALL_AUDIO_PROCESSING,
      adaptiveStream: true,
      dynacast: true,
    });
    this.liveKitRoom = room;
    room.on(RoomEvent.TrackSubscribed, (track: unknown, publication: unknown, participant: { identity?: string }) => {
      this.addLiveKitRemoteTrack(participant?.identity || crypto.randomUUID(), track, publication);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: unknown, publication: unknown, participant: { identity?: string }) => {
      this.removeLiveKitRemoteTrack(participant?.identity || '', track, publication);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      this.refreshLiveKitRemoteStreams();
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant: { identity?: string }) => {
      if (participant?.identity) {
        this.removeRemoteStream(participant.identity);
      }
    });
    room.on(RoomEvent.LocalTrackPublished, () => this.syncLiveKitLocalTracks());
    room.on(RoomEvent.LocalTrackUnpublished, () => this.syncLiveKitLocalTracks());
    room.on(RoomEvent.SignalReconnecting, () => {
      if (this.activeCall()?.id === call.id) {
        this.setConnectingPhase();
      }
    });
    room.on(RoomEvent.Reconnecting, () => {
      if (this.activeCall()?.id === call.id) {
        this.setConnectingPhase();
      }
    });
    room.on(RoomEvent.Reconnected, () => {
      if (this.activeCall()?.id === call.id) {
        this.refreshLiveKitRemoteStreams();
        this.syncLiveKitLocalTracks();
        this.setConnectedPhase();
        this.error.set('');
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.activeCall()?.id === call.id) {
        this.clearConnectionWatchdog();
        this.phase.set('failed');
        this.error.set('La sala perdio la conexion. Puedes intentar unirte de nuevo.');
      }
    });
    await this.withTimeout(
      room.connect(credentials.serverUrl, credentials.token),
      20_000,
      'La sala esta tardando demasiado en conectar.',
    );
    await (room.localParticipant as unknown as {
      setMicrophoneEnabled: (enabled: boolean, options?: AudioCaptureOptions) => Promise<unknown>;
      setCameraEnabled: (enabled: boolean) => Promise<unknown>;
    }).setMicrophoneEnabled(true, CALL_AUDIO_PROCESSING);
    if (call.type === 'Video') {
      await (room.localParticipant as unknown as {
        setCameraEnabled: (enabled: boolean) => Promise<unknown>;
      }).setCameraEnabled(true).catch(() => {
        this.cameraOff.set(true);
        this.error.set('La camara no esta disponible. La llamada continuara con audio.');
      });
    }
    this.syncLiveKitLocalTracks();
    this.refreshLiveKitRemoteStreams();
    this.setConnectedPhase();
    if (!this.cameraOff()) {
      this.error.set('');
    }
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

    const callCredentials = await firstValueFrom(
      this.api.get<LiveKitRoomTokenResponse>(`/calls/${encodeURIComponent(call.id)}/room-token`),
    ).catch(() => null);
    if (callCredentials?.serverUrl && callCredentials.token) {
      return callCredentials;
    }

    const groupId = call.groupId || call.conversationId;
    if (!groupId || !this.isGroupConversationId(groupId)) {
      throw new Error('No se pudo resolver la sala segura para esta llamada.');
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

  private addLiveKitRemoteTrack(participantId: string, track: unknown, publication?: unknown): void {
    const mediaTrack = (track as LiveKitTrackLike).mediaStreamTrack;
    if (!participantId || !mediaTrack) {
      return;
    }
    const streamId = this.liveKitStreamId(participantId, track, publication);
    this.zone.run(() => {
      const stream = this.remoteStreams()[streamId] ?? new MediaStream();
      if (!stream.getTracks().some((item) => item.id === mediaTrack.id)) {
        stream.addTrack(mediaTrack);
      }
      this.remoteStreams.update((items) => ({ ...items, [streamId]: stream }));
      if (mediaTrack.kind === 'video' && this.isLiveKitScreenShare(track, publication)) {
        this.activeScreenShareStreamId.set(streamId);
      }
      if (this.isLiveKitScreenShareAudio(track, publication)) {
        this.activeScreenShareStreamId.update((current) => current ?? streamId);
      }
    });
  }

  private removeLiveKitRemoteTrack(participantId: string, track: unknown, publication?: unknown): void {
    const mediaTrack = (track as LiveKitTrackLike).mediaStreamTrack;
    if (!participantId || !mediaTrack) {
      return;
    }
    const streamId = this.liveKitStreamId(participantId, track, publication);
    this.zone.run(() => {
      const stream = this.remoteStreams()[streamId];
      stream?.removeTrack(mediaTrack);
      if (this.activeScreenShareStreamId() === streamId && (!stream || !stream.getVideoTracks().length)) {
        this.activeScreenShareStreamId.set(null);
      }
      if (!stream || !stream.getTracks().length) {
        this.remoteStreams.update((items) => {
          const next = { ...items };
          delete next[streamId];
          return next;
        });
      } else {
        this.remoteStreams.update((items) => ({ ...items, [streamId]: stream }));
      }
    });
  }

  private refreshLiveKitRemoteStreams(): void {
    const participants = (this.liveKitRoom as unknown as {
      remoteParticipants?: Map<string, { identity?: string; trackPublications?: Map<string, LiveKitPublicationLike> }>;
    } | null)?.remoteParticipants;

    const next: Record<string, MediaStream> = {};
    let screenShareId: string | null = null;
    for (const participant of participants?.values() ?? []) {
      const participantId = participant.identity || crypto.randomUUID();
      for (const publication of participant.trackPublications?.values() ?? []) {
        const track = publication.track;
        const mediaTrack = track?.mediaStreamTrack;
        if (!mediaTrack) {
          continue;
        }
        const streamId = this.liveKitStreamId(participantId, track, publication);
        next[streamId] ??= new MediaStream();
        if (!next[streamId].getTracks().some((item) => item.id === mediaTrack.id)) {
          next[streamId].addTrack(mediaTrack);
        }
        if (mediaTrack.kind === 'video' && this.isLiveKitScreenShare(track, publication)) {
          screenShareId = streamId;
        }
        if (!screenShareId && this.isLiveKitScreenShareAudio(track, publication)) {
          screenShareId = streamId;
        }
      }
    }

    this.zone.run(() => {
      this.remoteStreams.set(next);
      if (screenShareId || this.activeScreenShareStreamId()) {
        this.activeScreenShareStreamId.set(screenShareId);
      }
    });
  }

  private liveKitStreamId(participantId: string, track: unknown, publication?: unknown): string {
    return this.isLiveKitScreenShare(track, publication)
      ? this.screenShareStreamId(participantId)
      : participantId;
  }

  private screenShareStreamId(participantId: string): string {
    return `${participantId}:screen`;
  }

  private isLiveKitScreenShare(track: unknown, publication?: unknown): boolean {
    const source = this.liveKitTrackSource(track, publication);
    return source.includes('screen') || source.includes('share');
  }

  private isLiveKitScreenShareAudio(track: unknown, publication?: unknown): boolean {
    const mediaTrack = (track as LiveKitTrackLike | null)?.mediaStreamTrack;
    const source = this.liveKitTrackSource(track, publication);
    return mediaTrack?.kind === 'audio' && source.includes('screen') && (source.includes('audio') || source.includes('share'));
  }

  private liveKitTrackSource(track: unknown, publication?: unknown): string {
    const source = (publication as LiveKitPublicationLike | null)?.source
      ?? (track as LiveKitTrackLike | null)?.source
      ?? '';
    return String(source).toLowerCase();
  }

  private syncLiveKitLocalTracks(): void {
    const localParticipant = this.liveKitRoom?.localParticipant as unknown as {
      trackPublications?: Map<string, { source?: unknown; track?: { mediaStreamTrack?: MediaStreamTrack; source?: unknown } | null }>;
    } | undefined;
    const tracks = [...(localParticipant?.trackPublications?.values() ?? [])]
      .filter((publication) => !this.isLiveKitScreenShareAudio(publication.track, publication))
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

  async inviteToCall(contactId: string): Promise<void> {
    const call = this.activeCall();
    const targetUserId = contactId.trim();
    if (!call?.id || !targetUserId || targetUserId === this.currentUserId()) {
      return;
    }
    this.error.set('');
    try {
      const response = await firstValueFrom(this.api.post<CallSession>(`/calls/${encodeURIComponent(call.id)}/invite`, {
        userId: targetUserId,
      }));
      const normalized = this.withGroupRoomMetadata(response, response.conversationId ?? call.conversationId ?? call.groupId ?? null, this.isGroupCall(response) || this.isGroupCall(call));
      const participantUserIds = [...new Set([...(call.participantUserIds ?? []), ...(normalized.participantUserIds ?? []), targetUserId])];
      const updated = {
        ...call,
        ...normalized,
        participantUserIds,
      };
      await this.applyActiveCallUpdate(updated);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo invitar al contacto a la llamada.');
      throw error;
    }
  }

  private async applyActiveCallUpdate(nextCall: CallSession): Promise<void> {
    const current = this.activeCall();
    if (!current?.id || !nextCall?.id || current.id !== nextCall.id) {
      return;
    }

    const wasGroupCall = this.isGroupCall(current);
    const participantUserIds = [...new Set([
      ...(current.participantUserIds ?? []),
      ...(nextCall.participantUserIds ?? []),
    ])];
    const candidate = {
      ...current,
      ...nextCall,
      participantUserIds,
    } as CallSession;
    const updated = this.withGroupRoomMetadata(
      candidate,
      candidate.conversationId ?? candidate.groupId ?? null,
      this.isGroupCall(candidate),
    );

    this.activeCall.set(updated);
    this.rememberGroupRoom(updated);
    this.addHistory(updated);
    if (updated.type === 'Video' && !this.localStream()?.getVideoTracks().some((track) => track.readyState === 'live')) {
      this.cameraOff.set(true);
    }

    if (!wasGroupCall && this.isGroupCall(updated) && this.phase() !== 'ringing') {
      await this.migrateDirectCallToGroupRoom(updated);
    }
  }

  private async migrateDirectCallToGroupRoom(call: CallSession): Promise<void> {
    if (this.groupMigrationCallId === call.id && this.groupMigrationPromise) {
      return this.groupMigrationPromise;
    }
    if (this.liveKitRoom || !this.isGroupCall(call)) {
      return;
    }

    const previousPhase = this.phase();
    const previousLocal = this.localStream();
    const previousRemoteStreams = this.remoteStreams();
    const previousRemoteTracks = Object.values(previousRemoteStreams).flatMap((stream) => stream.getTracks());
    this.groupMigrationCallId = call.id;
    this.setConnectingPhase();
    this.groupMigrationPromise = (async () => {
      try {
        await this.connectLiveKitRoom(call);
        if (this.activeCall()?.id !== call.id) {
          this.disconnectLiveKitRoom();
          return;
        }
        if (!this.liveKitRoom || this.phase() === 'failed') {
          throw new Error(this.error() || 'No se pudo migrar la llamada a la sala grupal.');
        }

        this.closePeerConnections();
        const activeTrackIds = new Set([
          ...(this.localStream()?.getTracks() ?? []),
          ...Object.values(this.remoteStreams()).flatMap((stream) => stream.getTracks()),
        ].map((track) => track.id));
        previousLocal?.getTracks()
          .filter((track) => !activeTrackIds.has(track.id))
          .forEach((track) => track.stop());
        previousRemoteTracks
          .filter((track) => !activeTrackIds.has(track.id))
          .forEach((track) => track.stop());
      } catch (error) {
        const failedLocal = this.localStream();
        const failedRemoteTracks = Object.values(this.remoteStreams()).flatMap((stream) => stream.getTracks());
        this.disconnectLiveKitRoom();
        const previousTrackIds = new Set([
          ...(previousLocal?.getTracks() ?? []),
          ...previousRemoteTracks,
        ].map((track) => track.id));
        failedLocal?.getTracks()
          .filter((track) => !previousTrackIds.has(track.id))
          .forEach((track) => track.stop());
        failedRemoteTracks
          .filter((track) => !previousTrackIds.has(track.id))
          .forEach((track) => track.stop());
        this.localStream.set(previousLocal);
        this.remoteStreams.set(previousRemoteStreams);
        if ([...this.peers.values()].some((peer) => this.peerConnectionLooksConnected(peer.connection))) {
          this.setConnectedPhase();
        } else {
          this.phase.set(previousPhase);
        }
        this.error.set(error instanceof Error ? error.message : 'No se pudo preparar la sala grupal.');
      } finally {
        this.groupMigrationCallId = null;
        this.groupMigrationPromise = null;
      }
    })();
    return this.groupMigrationPromise;
  }

  clearInactiveCallUi(): void {
    const phase = this.phase();
    const terminal = ['idle', 'ended', 'missed', 'rejected'].includes(phase);
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
    const participants = new Set([
      call.initiatorUserId,
      ...(call.participantUserIds ?? []),
    ].filter(Boolean));
    return Boolean(
      call.isGroupRoom ||
      call.groupId ||
      participants.size > 2 ||
      (call.conversationId && this.isGroupConversationId(call.conversationId))
    );
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
      await this.applyActiveCallUpdate(normalized);
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
    if (this.phase() === 'ringing') {
      void this.nativeDevice.showIncomingCall({
        callId: normalized.id,
        callerName: this.callTitle(normalized),
        callerUserId: normalized.initiatorUserId,
        callType: normalized.type,
        conversationId: normalized.conversationId ?? normalized.groupId ?? '',
      });
    }
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
    void this.nativeDevice.clearIncomingCall(call.id);
    if (['ringing', 'calling', 'connecting'].includes(this.phase())) {
      this.cleanup({ remember: false });
      this.addHistory({ ...call, status: 'Active' });
    }
  }

  private async handleNativeCallAction(event: NativeCallActionEvent): Promise<void> {
    const action = event.action;
    const callId = event.callId || '';
    if (!action || !callId) {
      return;
    }
    await this.nativeDevice.clearIncomingCall(callId).catch(() => undefined);
    if (action === 'open') {
      await this.router.navigateByUrl('/app/calls');
      return;
    }
    if (action === 'answer') {
      await this.router.navigateByUrl('/app/calls');
      if (this.activeCall()?.id === callId) {
        await this.accept();
        return;
      }
      await this.rejoin(callId).catch((error) => {
        this.error.set(error instanceof Error ? error.message : 'No se pudo contestar la llamada.');
      });
      return;
    }
    if (action === 'reject') {
      if (this.activeCall()?.id === callId) {
        await this.decline();
        return;
      }
      await this.rejectIncomingCallById(callId);
    }
  }

  private async rejectIncomingCallById(callId: string): Promise<void> {
    const call = await firstValueFrom(this.api.get<CallSession>(`/calls/${encodeURIComponent(callId)}`)).catch(() => null);
    if (!call || call.endedAt || call.status === 'Ended') {
      return;
    }
    const normalized = this.withGroupRoomMetadata(call, call.conversationId ?? call.groupId ?? null, this.isGroupCall(call));
    this.activeCall.set(normalized);
    this.phase.set('ringing');
    await this.decline();
  }

  private async prepareMedia(withVideo: boolean): Promise<MediaStream> {
    this.stopLocalMedia();
    this.muted.set(false);
    this.cameraOff.set(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no expone microfono/camara.');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: CALL_AUDIO_CONSTRAINTS,
        video: withVideo ? CALL_VIDEO_CONSTRAINTS : false,
      });
    } catch {
      if (!withVideo) {
        throw new Error('Permite el microfono para la llamada.');
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO_CONSTRAINTS, video: false });
        this.cameraOff.set(true);
        this.error.set('La camara no esta disponible. La llamada continuara con audio.');
      } catch {
        throw new Error('Permite camara y microfono para la videollamada.');
      }
    }
    this.prepareLocalTracks(stream);
    this.localStream.set(stream);
    return stream;
  }

  private loadIceConfiguration(force = false): Promise<void> {
    if (force || (this.iceConfigLoadedAt && Date.now() - this.iceConfigLoadedAt >= ICE_CONFIG_MAX_AGE_MS)) {
      this.iceConfigPromise = null;
    }
    this.iceConfigPromise ??= firstValueFrom(this.api.get<WebRtcIceConfigResponse>('/calls/ice-config'))
      .then((response) => {
        const servers = (response?.iceServers ?? [])
          .map((server): RTCIceServer | null => {
            const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
              .map((url) => String(url || '').trim())
              .filter((url) => /^(stuns?|turns?):/i.test(url));
            if (!urls.length) {
              return null;
            }
            return {
              urls,
              ...(server.username ? { username: server.username } : {}),
              ...(server.credential ? { credential: server.credential } : {}),
            };
          })
          .filter((server): server is RTCIceServer => Boolean(server));
        this.iceServers = servers.length ? servers : DEFAULT_ICE_SERVERS;
        const hasRelay = this.iceServers.some((server) =>
          (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url)));
        this.iceTransportPolicy = response?.relayOnly && hasRelay ? 'relay' : 'all';
        this.iceConfigLoadedAt = Date.now();
      })
      .catch(() => {
        this.iceServers = DEFAULT_ICE_SERVERS;
        this.iceTransportPolicy = 'all';
        this.iceConfigLoadedAt = Date.now();
      });
    return this.iceConfigPromise;
  }

  private async handleCallSignal(signal: CallSignalEvent): Promise<void> {
    const call = this.activeCall();
    const signalType = (signal.signalType || '').toLowerCase();
    if (!signal.callId || !call || signal.callId !== call.id) {
      if (signal.callId) {
        const signalId = this.callSignalId(signal);
        if (!signalId || !this.pendingSignals.some((pending) => this.callSignalId(pending) === signalId)) {
          this.pendingSignals.push(signal);
        }
      }
      return;
    }
    const signalId = this.callSignalId(signal);
    if (signalId && this.processedSignalIds.has(signalId)) {
      return;
    }
    if (signalId) {
      this.rememberProcessedSignal(signalId);
    }

    if (signalType === 'accepted') {
      if (this.phase() === 'ringing') {
        this.pendingSignals.push(signal);
        return;
      }
      this.setConnectingPhase();
      this.clearRingTimeout();
      this.stopRingingTone();
      await this.loadIceConfiguration(true);
      if (!this.localStream()) {
        await this.prepareMedia(call.type === 'Video');
      }
      await this.establishAcceptedCallPeer(signal.fromUserId);
      this.scheduleConnectedUiReconcile(call.id);
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

    if (signalType === 'ice-restart-request') {
      if (this.phase() !== 'ringing' && this.shouldCreateOfferTo(signal.fromUserId)) {
        await this.loadIceConfiguration();
        await this.restartIceForPeer(signal.fromUserId, true);
      }
      return;
    }

    if (signalType === 'renegotiate-request') {
      if (this.phase() !== 'ringing' && this.shouldCreateOfferTo(signal.fromUserId)) {
        await this.createAndSendOffer(signal.fromUserId).catch(() => undefined);
      }
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

    if (signalType === 'media-mode') {
      const decoded = await this.decodeCallSignalPayload(signal);
      const payload = decoded?.payload as { type?: string; video?: boolean } | undefined;
      if (payload?.type === 'Video' || payload?.video === true) {
        await this.applyActiveCallUpdate({ ...call, type: 'Video' });
      }
      return;
    }

    if (signalType === 'muted' || signalType === 'camera' || signalType === 'screen') {
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
      iceServers: this.iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
      iceCandidatePoolSize: 4,
    });
    this.peers.set(userId, {
      connection,
      pendingIce: [],
      iceRestartAttempts: 0,
      disconnectTimer: null,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      negotiationQueued: false,
    });
    this.attachLocalTracks(connection);

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        const call = this.activeCall();
        if (call) {
          void this.sendCallSignal(call, userId, 'ice', { candidate: event.candidate.toJSON() }).catch(() => undefined);
        }
      }
    };
    connection.onicecandidateerror = (event) => {
      const error = event as RTCPeerConnectionIceErrorEvent;
      this.updateRemoteCallState(userId, 'iceError', {
        code: error.errorCode,
        text: error.errorText,
        url: error.url,
      });
    };
    connection.onnegotiationneeded = () => {
      this.queuePeerNegotiation(userId, connection);
    };
    connection.ontrack = (event) => {
      const stream = this.pendingRemoteStreams.get(userId) || this.remoteStreams()[userId] || new MediaStream();
      const incomingTracks = event.streams?.length
        ? event.streams.flatMap((incoming) => incoming.getTracks())
        : [event.track].filter((track): track is MediaStreamTrack => Boolean(track));
      for (const track of incomingTracks) {
        if (!stream.getTracks().some((item) => item.id === track.id)) {
          stream.addTrack(track);
        }
      }
      this.pendingRemoteStreams.set(userId, stream);
      event.track.onunmute = () => this.publishRemoteStreamIfConnected(userId, connection);
      event.track.onended = () => {
        stream.removeTrack(event.track);
        if (!this.streamHasLiveTracks(stream)) {
          this.removeRemoteStream(userId);
        }
      };
      this.publishRemoteStreamIfConnected(userId, connection);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') {
        this.resetPeerRecovery(userId);
        void this.tuneOutgoingSenders(connection);
        this.setConnectedPhase();
        this.publishRemoteStreamIfConnected(userId, connection);
      }
      if (connection.connectionState === 'failed') {
        void this.restartIceForPeer(userId);
      }
      if (connection.connectionState === 'closed') {
        this.removeRemoteStream(userId);
      }
    };
    connection.oniceconnectionstatechange = () => {
      this.handlePeerIceState(userId, connection);
    };

    return connection;
  }

  private shouldCreateOfferTo(userId: string): boolean {
    const currentUserId = this.currentUserId();
    return Boolean(currentUserId && String(currentUserId) < String(userId));
  }

  private async createAndSendOffer(userId: string, iceRestart = false): Promise<void> {
    const call = this.activeCall();
    const connection = this.ensurePeerConnection(userId);
    const peer = this.peers.get(userId);
    if (!call || !connection || !peer || connection.signalingState !== 'stable' || peer.makingOffer) {
      return;
    }
    peer.makingOffer = true;
    try {
      const offer = await connection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.type === 'Video',
        iceRestart,
      });
      if (connection.signalingState !== 'stable') {
        return;
      }
      await connection.setLocalDescription(offer);
      await this.sendCallSignal(call, userId, 'offer', { description: connection.localDescription });
    } finally {
      peer.makingOffer = false;
    }
  }

  private queuePeerNegotiation(userId: string, connection: RTCPeerConnection): void {
    const peer = this.peers.get(userId);
    if (!peer || peer.negotiationQueued || connection.connectionState === 'closed') {
      return;
    }
    peer.negotiationQueued = true;
    queueMicrotask(() => {
      void (async () => {
        try {
          const call = this.activeCall();
          const currentPeer = this.peers.get(userId);
          if (
            !call ||
            !currentPeer ||
            currentPeer.connection !== connection ||
            this.isGroupCall(call) ||
            this.phase() === 'ringing'
          ) {
            return;
          }
          if (connection.signalingState !== 'stable' || currentPeer.makingOffer) {
            return;
          }
          if (this.shouldCreateOfferTo(userId)) {
            await this.createAndSendOffer(userId);
          } else {
            await this.sendCallSignal(call, userId, 'renegotiate-request', {});
          }
        } catch {
          this.error.set('No se pudo actualizar el video de la llamada. Intenta activar la cámara nuevamente.');
        } finally {
          const currentPeer = this.peers.get(userId);
          if (currentPeer?.connection === connection) {
            currentPeer.negotiationQueued = false;
          }
        }
      })();
    });
  }

  private async renegotiateDirectPeers(forceLocalOffer = false): Promise<void> {
    const call = this.activeCall();
    if (!call || this.isGroupCall(call)) {
      return;
    }
    for (const userId of this.otherParticipantIds(call)) {
      const peer = this.peers.get(userId);
      if (!peer || peer.connection.connectionState === 'closed' || peer.negotiationQueued) {
        continue;
      }
      peer.negotiationQueued = true;
      try {
        if ((forceLocalOffer || this.shouldCreateOfferTo(userId)) && peer.connection.signalingState === 'stable') {
          await this.createAndSendOffer(userId).catch(() => undefined);
        } else {
          await this.sendCallSignal(call, userId, 'renegotiate-request', {}).catch(() => undefined);
        }
      } finally {
        const currentPeer = this.peers.get(userId);
        if (currentPeer === peer) {
          currentPeer.negotiationQueued = false;
        }
      }
    }
  }

  private handlePeerIceState(userId: string, connection: RTCPeerConnection): void {
    const state = connection.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      this.resetPeerRecovery(userId);
      this.publishRemoteStreamIfConnected(userId, connection);
      return;
    }
    if (state === 'disconnected') {
      const peer = this.peers.get(userId);
      if (!peer || peer.disconnectTimer !== null) {
        return;
      }
      peer.disconnectTimer = window.setTimeout(() => {
        peer.disconnectTimer = null;
        if (connection.iceConnectionState === 'disconnected') {
          void this.restartIceForPeer(userId);
        }
      }, 4_000);
      return;
    }
    if (state === 'failed') {
      void this.restartIceForPeer(userId);
    }
    if (state === 'closed') {
      this.removeRemoteStream(userId);
    }
  }

  private async restartIceForPeer(userId: string, forceOffer = false): Promise<void> {
    const call = this.activeCall();
    const peer = this.peers.get(userId);
    if (!call || !peer || peer.connection.connectionState === 'closed') {
      return;
    }
    this.clearPeerDisconnectTimer(peer);
    if (peer.iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
      this.removeRemoteStream(userId);
      this.error.set('La red no pudo recuperar el video. Revisa tu conexion o configura un servidor TURN.');
      return;
    }
    peer.iceRestartAttempts += 1;
    if (this.phase() === 'connected' && this.remoteEntries().length <= 1) {
      this.phase.set('connecting');
    }

    if ((forceOffer || this.shouldCreateOfferTo(userId)) && peer.connection.signalingState === 'stable') {
      await this.createAndSendOffer(userId, true).catch(() => undefined);
      return;
    }
    await this.sendCallSignal(call, userId, 'ice-restart-request', {
      attempt: peer.iceRestartAttempts,
    }).catch(() => undefined);
  }

  private resetPeerRecovery(userId: string): void {
    const peer = this.peers.get(userId);
    if (!peer) {
      return;
    }
    this.clearPeerDisconnectTimer(peer);
    peer.iceRestartAttempts = 0;
  }

  private clearPeerDisconnectTimer(peer: PeerState): void {
    if (peer.disconnectTimer !== null) {
      window.clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }
  }

  private async handleWebRtcSignal(signal: CallSignalEvent): Promise<void> {
    const signalType = (signal.signalType || '').toLowerCase();
    const payload = (await this.decodeCallSignalPayload(signal))?.payload as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } | undefined;
    if (!signal.fromUserId || !payload) {
      return;
    }
    const call = this.activeCall();
    await this.loadIceConfiguration();
    if (!this.localStream() && call) {
      await this.prepareMedia(call.type === 'Video');
    }
    const connection = this.ensurePeerConnection(signal.fromUserId);
    const peer = this.peers.get(signal.fromUserId);
    if (!connection || !peer || !call) {
      return;
    }

    if (signalType === 'offer' && payload.description) {
      const readyForOffer = !peer.makingOffer &&
        (connection.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
      const offerCollision = !readyForOffer;
      peer.ignoreOffer = !this.isPolitePeer(signal.fromUserId) && offerCollision;
      if (peer.ignoreOffer) {
        return;
      }
      if (offerCollision) {
        await connection.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit).catch(() => undefined);
      }
      await this.setRemoteDescriptionAndFlush(signal.fromUserId, connection, payload.description);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.sendCallSignal(call, signal.fromUserId, 'answer', { description: connection.localDescription });
      this.setConnectingPhase();
      this.clearRingTimeout();
      this.scheduleConnectedUiReconcile(call.id);
      return;
    }

    if (signalType === 'answer' && payload.description) {
      peer.ignoreOffer = false;
      peer.isSettingRemoteAnswerPending = true;
      try {
        if (connection.signalingState !== 'stable') {
          await this.setRemoteDescriptionAndFlush(signal.fromUserId, connection, payload.description);
          this.setConnectingPhase();
          this.clearRingTimeout();
          this.scheduleConnectedUiReconcile(call.id);
        }
      } finally {
        peer.isSettingRemoteAnswerPending = false;
      }
      return;
    }

    if (signalType === 'ice' && payload.candidate) {
      if (peer.ignoreOffer) {
        return;
      }
      await this.addOrQueueRemoteIceCandidate(signal.fromUserId, payload.candidate);
      this.scheduleConnectedUiReconcile(call.id);
    }
  }

  private isPolitePeer(userId: string): boolean {
    const currentUserId = this.currentUserId();
    return Boolean(currentUserId && String(currentUserId) > String(userId));
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

  private startSignalPolling(callId: string): void {
    this.stopSignalPolling();
    void this.pollPersistedSignals(callId);
    this.signalPollTimer = window.setInterval(() => {
      void this.pollPersistedSignals(callId);
    }, CALL_SIGNAL_POLL_MS);
  }

  private stopSignalPolling(): void {
    if (this.signalPollTimer !== null) {
      window.clearInterval(this.signalPollTimer);
      this.signalPollTimer = null;
    }
    this.signalPollInFlight = false;
  }

  private async pollPersistedSignals(callId: string): Promise<void> {
    if (this.signalPollInFlight || this.activeCall()?.id !== callId) {
      return;
    }
    this.signalPollInFlight = true;
    try {
      const signals = await firstValueFrom(
        this.api.get<CallSignalEvent[]>(`/calls/${encodeURIComponent(callId)}/signals`),
      );
      for (const signal of signals ?? []) {
        if (this.activeCall()?.id !== callId) {
          break;
        }
        await this.handleCallSignal({
          ...signal,
          signalId: signal.signalId || signal.id,
        });
      }
    } catch {
      // SignalR remains the fast path. Polling retries while the call is active.
    } finally {
      this.signalPollInFlight = false;
    }
  }

  private callSignalId(signal: CallSignalEvent | null | undefined): string {
    return String(signal?.signalId || signal?.id || '').trim();
  }

  private rememberProcessedSignal(signalId: string): void {
    this.processedSignalIds.add(signalId);
    if (this.processedSignalIds.size <= 1_000) {
      return;
    }
    const oldest = this.processedSignalIds.values().next().value as string | undefined;
    if (oldest) {
      this.processedSignalIds.delete(oldest);
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

  private broadcastControl(signalType: 'muted' | 'camera' | 'screen' | 'media-mode', payload: unknown): void {
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

  private prepareLocalTracks(stream: MediaStream): void {
    stream.getTracks().forEach((track) => {
      if (track.kind === 'video') {
        track.contentHint = 'motion';
      } else if (track.kind === 'audio') {
        track.contentHint = 'speech';
      }
      track.onended = () => {
        if (!this.activeCall()) {
          return;
        }
        if (track.kind === 'video') {
          this.cameraOff.set(true);
          this.error.set('La camara se detuvo. Puedes activarla otra vez desde la llamada.');
        } else {
          this.muted.set(true);
          this.error.set('El microfono se detuvo. Puedes activarlo otra vez desde la llamada.');
        }
      };
    });
  }

  private async restoreDirectMediaTrack(kind: 'audio' | 'video', renegotiate = true): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este dispositivo no permite recuperar audio o video.');
    }
    const captured = await navigator.mediaDevices.getUserMedia({
      audio: kind === 'audio' ? CALL_AUDIO_CONSTRAINTS : false,
      video: kind === 'video' ? CALL_VIDEO_CONSTRAINTS : false,
    });
    const track = kind === 'audio' ? captured.getAudioTracks()[0] : captured.getVideoTracks()[0];
    if (!track) {
      captured.getTracks().forEach((item) => item.stop());
      throw new Error(kind === 'audio' ? 'No se encontro el microfono.' : 'No se encontro la camara.');
    }
    this.prepareLocalTracks(captured);
    const stream = this.localStream() ?? new MediaStream();
    stream.getTracks()
      .filter((item) => item.kind === kind && item.id !== track.id)
      .forEach((item) => {
        stream.removeTrack(item);
        item.onended = null;
        item.stop();
      });
    stream.addTrack(track);
    this.localStream.set(stream);

    let requiresNegotiation = false;
    for (const peer of this.peers.values()) {
      requiresNegotiation = await this.setOutgoingTrack(peer.connection, kind, track, stream)
        || requiresNegotiation;
    }
    if (requiresNegotiation && renegotiate) {
      await this.renegotiateDirectPeers();
    }
  }

  private async removeDirectVideoTrack(): Promise<void> {
    const stream = this.localStream();
    const videoTracks = stream?.getVideoTracks() ?? [];
    videoTracks.forEach((track) => {
      stream?.removeTrack(track);
      track.onended = null;
      track.stop();
    });
    await Promise.all([...this.peers.values()].map(async (peer) => {
      const sender = this.senderForKind(peer.connection, 'video');
      if (sender?.track) {
        await sender.replaceTrack(null).catch(() => undefined);
      }
    }));
    const remainingTracks = stream?.getTracks() ?? [];
    this.localStream.set(remainingTracks.length ? new MediaStream(remainingTracks) : null);
  }

  private senderForKind(connection: RTCPeerConnection, kind: 'audio' | 'video'): RTCRtpSender | null {
    return connection.getSenders().find((sender) => sender.track?.kind === kind)
      ?? this.transceiverForKind(connection, kind)?.sender
      ?? null;
  }

  private transceiverForKind(connection: RTCPeerConnection, kind: 'audio' | 'video'): RTCRtpTransceiver | null {
    return connection.getTransceivers().find((transceiver) =>
      transceiver.sender.track?.kind === kind || transceiver.receiver.track.kind === kind) ?? null;
  }

  private async setOutgoingTrack(
    connection: RTCPeerConnection,
    kind: 'audio' | 'video',
    track: MediaStreamTrack,
    stream: MediaStream,
  ): Promise<boolean> {
    const transceiver = this.transceiverForKind(connection, kind);
    const sender = connection.getSenders().find((candidate) => candidate.track?.kind === kind)
      ?? transceiver?.sender
      ?? null;
    if (!sender) {
      const created = connection.addTrack(track, stream);
      await this.tuneOutgoingSender(created);
      return true;
    }

    const previousTrack = sender.track;
    await sender.replaceTrack(track);
    await this.tuneOutgoingSender(sender);
    if (!transceiver || previousTrack) {
      return false;
    }

    if (transceiver.direction === 'recvonly') {
      transceiver.direction = 'sendrecv';
      return true;
    }
    if (transceiver.direction === 'inactive') {
      transceiver.direction = 'sendonly';
      return true;
    }
    return false;
  }

  private attachLocalTracks(connection: RTCPeerConnection): void {
    const stream = this.localStream();
    if (!stream) {
      return;
    }
    const existingTrackIds = new Set(connection.getSenders().map((sender) => sender.track?.id).filter(Boolean));
    stream.getTracks().forEach((track) => {
      if (!existingTrackIds.has(track.id)) {
        const sender = connection.addTrack(track, stream);
        void this.tuneOutgoingSender(sender);
      }
    });
  }

  private async tuneOutgoingSenders(connection: RTCPeerConnection): Promise<void> {
    await Promise.all(connection.getSenders().map((sender) => this.tuneOutgoingSender(sender)));
  }

  private async tuneOutgoingSender(sender: RTCRtpSender): Promise<void> {
    const track = sender.track;
    if (!track || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
      return;
    }
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) {
      return;
    }
    parameters.encodings.forEach((encoding) => {
      if (track.kind === 'video') {
        const isScreenTrack = this.screenShareStream?.getVideoTracks().some((item) => item.id === track.id) === true;
        encoding.maxBitrate = isScreenTrack ? 3_000_000 : 2_500_000;
        encoding.maxFramerate = 30;
      } else {
        encoding.maxBitrate = 128_000;
      }
    });
    if (track.kind === 'video') {
      (parameters as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference = 'balanced';
    }
    await sender.setParameters(parameters).catch(() => undefined);
  }

  private hasTurnServer(): boolean {
    return this.iceServers.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls])
        .some((url) => /^turns?:/i.test(String(url || ''))));
  }

  private networkInformation(): (EventTarget & { effectiveType?: string; type?: string }) | null {
    if (typeof navigator === 'undefined') {
      return null;
    }
    return ((navigator as Navigator & {
      connection?: EventTarget & { effectiveType?: string; type?: string };
      mozConnection?: EventTarget & { effectiveType?: string; type?: string };
      webkitConnection?: EventTarget & { effectiveType?: string; type?: string };
    }).connection
      ?? (navigator as Navigator & { mozConnection?: EventTarget }).mozConnection
      ?? (navigator as Navigator & { webkitConnection?: EventTarget }).webkitConnection
      ?? null) as (EventTarget & { effectiveType?: string; type?: string }) | null;
  }

  private async recoverAfterNetworkChange(): Promise<void> {
    const call = this.activeCall();
    if (!call || ['ringing', 'calling', 'idle', 'ended', 'rejected'].includes(this.phase()) || navigator.onLine === false) {
      return;
    }
    if (this.isGroupCall(call)) {
      if (this.phase() === 'failed') {
        await this.retryConnection();
      }
      return;
    }
    await this.retryConnection();
  }

  private publishRemoteStreamIfConnected(userId: string, connection: RTCPeerConnection): void {
    const stream = this.pendingRemoteStreams.get(userId);
    if (!stream || !this.peerConnectionLooksConnected(connection)) {
      return;
    }
    this.remoteStreams.update((items) => ({ ...items, [userId]: stream }));
    this.setConnectedPhase();
  }

  private setConnectingPhase(): void {
    if (this.phase() !== 'connected') {
      this.phase.set('connecting');
    }
    this.scheduleConnectionWatchdog(this.activeCall()?.id);
  }

  private setConnectedPhase(): void {
    if (!this.activeCall()) {
      return;
    }
    if (this.phase() !== 'connected') {
      this.phase.set('connected');
    }
    this.clearConnectedUiReconcileTimers();
    this.clearConnectionWatchdog();
    this.clearRingTimeout();
    this.stopRingingTone();
  }

  private scheduleConnectionWatchdog(callId: string | null | undefined): void {
    if (!callId || this.connectionRecoveryTimer !== null || this.connectionFailureTimer !== null) {
      return;
    }
    this.connectionRecoveryTimer = window.setTimeout(() => {
      this.connectionRecoveryTimer = null;
      if (this.activeCall()?.id === callId && this.phase() === 'connecting') {
        void this.retryConnection();
      }
    }, CONNECTION_RECOVERY_DELAY_MS);
    this.connectionFailureTimer = window.setTimeout(() => {
      this.connectionFailureTimer = null;
      if (this.activeCall()?.id === callId && this.phase() === 'connecting') {
        this.phase.set('failed');
        this.error.set(this.hasTurnServer()
          ? 'No se pudo completar la conexion. Toca Reintentar para negociar una ruta nueva.'
          : 'Esta red parece requerir TURN. Configura el relay de produccion y toca Reintentar.');
      }
    }, CONNECTION_FAILURE_DELAY_MS);
  }

  private clearConnectionWatchdog(): void {
    if (this.connectionRecoveryTimer !== null) {
      window.clearTimeout(this.connectionRecoveryTimer);
      this.connectionRecoveryTimer = null;
    }
    if (this.connectionFailureTimer !== null) {
      window.clearTimeout(this.connectionFailureTimer);
      this.connectionFailureTimer = null;
    }
  }

  private scheduleConnectedUiReconcile(callId: string | null | undefined): void {
    if (!callId) {
      return;
    }
    this.clearConnectedUiReconcileTimers();
    [0, 80, 220, 600, 1200, 2400].forEach((delay) => {
      const timer = window.setTimeout(() => this.reconcileConnectedUi(callId), delay);
      this.connectedUiReconcileTimers.push(timer);
    });
  }

  private reconcileConnectedUi(callId: string): void {
    const call = this.activeCall();
    if (!call || call.id !== callId) {
      return;
    }
    let connected = Object.values(this.remoteStreams()).some((stream) => this.streamHasLiveTracks(stream));
    for (const [userId, peer] of this.peers.entries()) {
      if (this.peerConnectionLooksConnected(peer.connection)) {
        this.publishRemoteStreamIfConnected(userId, peer.connection);
        connected = true;
      }
    }
    if (connected) {
      this.setConnectedPhase();
    }
  }

  private peerConnectionLooksConnected(connection: RTCPeerConnection): boolean {
    return connection.connectionState === 'connected'
      || connection.iceConnectionState === 'connected'
      || connection.iceConnectionState === 'completed';
  }

  private streamHasLiveTracks(stream: MediaStream | null | undefined): boolean {
    return Boolean(stream?.getTracks().some((track) => track.readyState === 'live'));
  }

  private hasRemoteGroupParticipants(): boolean {
    if (this.remoteEntries().length > 0) {
      return true;
    }
    const participants = (this.liveKitRoom as unknown as {
      remoteParticipants?: { size?: number; forEach?: (callback: (value: unknown) => void) => void };
    } | null)?.remoteParticipants;
    if (!participants) {
      return false;
    }
    if (typeof participants.size === 'number') {
      return participants.size > 0;
    }
    let count = 0;
    participants.forEach?.(() => {
      count += 1;
    });
    return count > 0;
  }

  private clearConnectedUiReconcileTimers(): void {
    this.connectedUiReconcileTimers.forEach((timer) => window.clearTimeout(timer));
    this.connectedUiReconcileTimers = [];
  }

  private async leaveGroupCallLocally(call: CallSession): Promise<void> {
    const endedAt = new Date().toISOString();
    this.phase.set('ended');
    await Promise.all(this.otherParticipantIds(call).map((userId) =>
      this.sendCallSignal(call, userId, 'left', { left: true, at: endedAt }).catch(() => undefined)));
    this.addHistory({ ...call, status: 'Ended', endedAt });
    this.cleanup({ remember: false });
  }

  private cleanup(options: { remember?: boolean; historyStatus?: string } = {}): void {
    const call = this.activeCall();
    if (call?.id) {
      void this.nativeDevice.clearIncomingCall(call.id);
    }
    this.clearRingTimeout();
    this.stopRingingTone();
    this.clearConnectedUiReconcileTimers();
    this.clearConnectionWatchdog();
    this.stopSignalPolling();
    this.groupMigrationCallId = null;
    this.groupMigrationPromise = null;
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
    this.processedSignalIds.clear();
    this.activeCall.set(null);
    this.phase.set('idle');
    this.remoteStates.set({});
    this.muted.set(false);
    this.cameraOff.set(false);
    this.screenSharing.set(false);
    this.mediaUpgradeInFlight.set(false);
    this.activeScreenShareStreamId.set(null);
    this.speaker.set(true);
    this.error.set('');
    if (!this.auth.session()?.user.id) {
      this.activeGroupRooms.set({});
    }
  }

  private stopLocalMedia(): void {
    const stream = this.localStream();
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.enabled = false;
      track.stop();
    });
    this.localStream.set(null);
  }

  private closePeerConnections(): void {
    for (const peer of this.peers.values()) {
      this.clearPeerDisconnectTimer(peer);
      this.closePeerConnection(peer.connection);
      peer.pendingIce.splice(0);
    }
    this.peers.clear();
  }

  private closePeerConnectionForUser(userId: string): void {
    const peer = this.peers.get(userId);
    if (peer) {
      this.clearPeerDisconnectTimer(peer);
      this.closePeerConnection(peer.connection);
      peer.pendingIce.splice(0);
    }
    this.peers.delete(userId);
    this.removeRemoteStream(userId);
  }

  private removeRemoteStream(userId: string): void {
    this.pendingRemoteStreams.get(userId)?.getTracks().forEach((track) => track.stop());
    this.pendingRemoteStreams.delete(userId);
    const streamIds = [userId, this.screenShareStreamId(userId)];
    streamIds.forEach((streamId) => {
      this.remoteStreams()[streamId]?.getTracks().forEach((track) => track.stop());
    });
    this.zone.run(() => {
      this.remoteStreams.update((items) => {
        const next = { ...items };
        streamIds.forEach((streamId) => delete next[streamId]);
        return next;
      });
      if (this.activeScreenShareStreamId() && streamIds.includes(this.activeScreenShareStreamId()!)) {
        this.activeScreenShareStreamId.set(null);
      }
    });
  }

  private closePeerConnection(connection: RTCPeerConnection): void {
    connection.onicecandidate = null;
    connection.onicecandidateerror = null;
    connection.onnegotiationneeded = null;
    connection.ontrack = null;
    connection.onconnectionstatechange = null;
    connection.oniceconnectionstatechange = null;
    connection.getReceivers?.().forEach((receiver) => receiver.track?.stop());
    connection.close();
  }

  private stopRemoteMedia(): void {
    Object.values(this.remoteStreams()).forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    this.remoteStreams.set({});
    this.activeScreenShareStreamId.set(null);
  }

  private stopPendingRemoteMedia(): void {
    for (const stream of this.pendingRemoteStreams.values()) {
      stream.getTracks().forEach((track) => track.stop());
    }
    this.pendingRemoteStreams.clear();
  }

  private isNativePlatform(): boolean {
    return Capacitor.isNativePlatform?.() === true;
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: number | null = null;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
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
