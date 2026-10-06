import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { CallsService } from './calls.service';
import { AuthService } from './auth.service';
import { CallAudioOutputService } from './call-audio-output.service';
import { CallGameSessionService } from './call-game-session.service';
import { GroupCallCryptoService } from './group-call-crypto.service';
import { NativeScreenShareService } from './native-screen-share.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NativeDeviceService } from './native-device.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { CallSession } from '../models/nivra.models';

describe('call session isolation', () => {
  let service: CallsService;
  let api: { post: jasmine.Spy; get: jasmine.Spy; patch: jasmine.Spy };
  const invitation: CallSession = {
    id: 'incoming', initiatorUserId: 'peer', participantUserIds: ['me', 'peer'],
    type: 'Voice', status: 'Ringing', startedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    api = {
      post: jasmine.createSpy().and.returnValue(of(invitation)),
      get: jasmine.createSpy().and.returnValue(of(invitation)),
      patch: jasmine.createSpy().and.returnValue(of({ ...invitation, type: 'Video', status: 'Active' })),
    };
    TestBed.configureTestingModule({ providers: [
      CallsService,
      { provide: AuthService, useValue: { session: signal({ user: { id: 'me' }, device: { id: 'shared-device' } }) } },
      { provide: NivraApiService, useValue: api },
      { provide: Router, useValue: { navigateByUrl: jasmine.createSpy() } },
      { provide: ChatService, useValue: { conversations: signal([]) } },
      { provide: CryptoService, useValue: {} },
      { provide: LocalHistoryService, useValue: { accountKeysForUser: async () => [], calls: async () => [], putCalls: async () => undefined } },
      { provide: NativeDeviceService, useValue: {
        onNativeCallAction: () => Promise.resolve(null), clearIncomingCall: () => Promise.resolve(),
        showIncomingCall: () => Promise.resolve(),
        setActiveCall: () => Promise.resolve(false),
      } },
      { provide: SignalrService, useValue: { events$: new Subject() } },
      { provide: CallAudioOutputService, useValue: { sync: jasmine.createSpy(), resume: jasmine.createSpy().and.resolveTo(), playbackBlocked: signal(false) } },
      { provide: CallGameSessionService, useValue: { configure: jasmine.createSpy(), reset: jasmine.createSpy(), transport: { detachPeer: jasmine.createSpy() } } },
      { provide: GroupCallCryptoService, useValue: { updateRoster: jasmine.createSpy().and.resolveTo(), clear: jasmine.createSpy(), isMediaKeySignal: () => false } },
      { provide: NativeScreenShareService, useValue: { stop: jasmine.createSpy().and.resolveTo(), supported: () => false } },
    ] });
    service = TestBed.inject(CallsService);
    spyOn<any>(service, 'addHistory');
    spyOn<any>(service, 'startRingingTone');
    spyOn<any>(service, 'scheduleRingTimeout');
  });

  afterEach(() => service.ngOnDestroy());

  it('restores sendrecv when replacing a track on a receive-only transceiver', async () => {
    const sender = { track: { kind: 'video' }, replaceTrack: jasmine.createSpy().and.resolveTo() };
    const transceiver = { sender, receiver: { track: { kind: 'video' } }, direction: 'recvonly' };
    const connection = { getSenders: () => [sender], getTransceivers: () => [transceiver] };
    spyOn<any>(service, 'tuneOutgoingSender').and.resolveTo();
    const renegotiate = await (service as any).setOutgoingTrack(connection, 'video', {}, new MediaStream());
    expect(renegotiate).toBeTrue();
    expect(transceiver.direction).toBe('sendrecv');
  });

  it('publishes a new remote stream reference when video arrives during a voice call', () => {
    const canvas = document.createElement('canvas');
    const video = canvas.captureStream().getVideoTracks()[0];
    const stream = new MediaStream();
    let receivers: Array<{track: MediaStreamTrack}> = [];
    const connection = { connectionState: 'connected', getReceivers: () => receivers };
    (service as any).peers.set('peer', { connection });
    (service as any).pendingRemoteStreams.set('peer', stream);
    spyOn<any>(service, 'setConnectedPhase');
    (service as any).publishRemoteStreamIfConnected('peer', connection);
    const initial = service.remoteStreams()['peer'];
    receivers = [{track: video}]; // No new ontrack event: reused receiver after renegotiation.
    (service as any).publishRemoteStreamIfConnected('peer', connection);
    expect(service.remoteStreams()['peer']).not.toBe(initial);
    expect(service.remoteStreams()['peer'].getVideoTracks()).toEqual([video]);
    video.stop();
    (service as any).peers.clear();
  });

  it('retains renegotiation requested while an earlier offer is pending', async () => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connected');
    const connection = { connectionState: 'connected', signalingState: 'have-local-offer' };
    const peer = { connection, negotiationQueued: false, makingOffer: false, negotiationPending: false };
    (service as any).peers.set('peer', peer);
    const offer = spyOn<any>(service, 'createAndSendOffer').and.resolveTo();
    (service as any).queuePeerNegotiation('peer', connection);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(peer.negotiationPending).toBeTrue();
    expect(offer).not.toHaveBeenCalled();
    connection.signalingState = 'stable';
    (service as any).queuePeerNegotiation('peer', connection);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(offer).toHaveBeenCalledTimes(1);
    expect(peer.negotiationPending).toBeFalse();
    (service as any).peers.clear();
  });

  it('does not open a second outgoing call from a broadcast to the same device', async () => {
    await (service as any).receiveIncoming({ ...invitation, initiatorUserId: 'me', initiatorDeviceId: 'shared-device' });
    expect(service.activeCall()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('closes a losing tab locally even when its device id matches', () => {
    service.activeCall.set(invitation);
    service.phase.set('connected');
    (service as any).handleAnsweredElsewhere({ callId: invitation.id, answeredByUserId: 'me',
      answeredByDeviceId: 'shared-device', answeredBySessionId: 'another-tab' });
    expect(service.activeCall()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('never starts media after an answer ownership conflict', async () => {
    api.post.and.returnValue(throwError(() => ({ status: 409, error: { code: 'call_owned_elsewhere' } })));
    const media = spyOn<any>(service, 'prepareMedia');
    service.activeCall.set(invitation);
    service.phase.set('ringing');
    await service.accept();
    expect(media).not.toHaveBeenCalled();
    expect(service.activeCall()).toBeNull();
    expect(api.post.calls.count()).toBe(1);
    expect(api.post.calls.first().args[0]).toContain('/claim');
  });

  it('does not terminate a room when an unanswered device times out', async () => {
    service.activeCall.set(invitation);
    service.phase.set('ringing');
    await (service as any).handleRingTimeout(invitation.id);
    expect(api.post).not.toHaveBeenCalled();
    expect(service.activeCall()).toBeNull();
  });

  it('defers incoming SDP until accepting without marking it consumed', async () => {
    service.activeCall.set(invitation);
    service.phase.set('ringing');
    const offer = { callId: invitation.id, fromUserId: 'peer', signalId: 'offer-1', signalType: 'offer' };
    await (service as any).handleCallSignal(offer);
    await (service as any).handleCallSignal(offer);
    expect((service as any).pendingSignals.length).toBe(1);
    expect((service as any).processedSignalIds.has('offer-1')).toBeFalse();
    const handle = spyOn<any>(service, 'handleWebRtcSignal').and.resolveTo();
    service.phase.set('connecting');
    await (service as any).flushPendingCallSignals();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('ignores media signaling addressed to another tab', async () => {
    service.activeCall.set(invitation);
    service.phase.set('connecting');
    const handle = spyOn<any>(service, 'handleWebRtcSignal');
    await (service as any).handleCallSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'offer', targetClientSessionId: 'other-tab' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('stops local resources immediately even if hanging up cannot reach the server', async () => {
    const response = new Subject<CallSession>();
    api.post.and.returnValue(response);
    service.activeCall.set(invitation);
    service.phase.set('connected');
    const ending = service.end();
    expect(service.activeCall()).toBeNull();
    response.error({ status: 0 });
    await ending;
    expect(service.phase()).toBe('idle');
    expect(service.error()).toContain('No se pudo confirmar');
  });

  it('keeps a just-answered call when the server refuses its late ring timeout', async () => {
    const outgoing = { ...invitation, initiatorUserId: 'me' };
    api.post.and.returnValue(of({ ...outgoing, status: 'Active' }));
    service.activeCall.set(outgoing);
    service.phase.set('calling');
    await (service as any).handleRingTimeout(invitation.id);
    expect(service.activeCall()?.id).toBe(invitation.id);
    expect(service.phase()).toBe('connecting');
    expect(api.post.calls.first().args[1].reason).toBe('timeout');
  });

  it('discards microphone permission results that arrive after hanging up', async () => {
    let grant!: (stream: MediaStream) => void;
    spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValue(new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const stop = jasmine.createSpy('stop');
    const capture = (service as any).prepareMedia(false) as Promise<MediaStream>;
    service.releaseLocalResources();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expectAsync(capture).toBeRejected();
    expect(stop).toHaveBeenCalled();
    expect(service.localStream()).toBeNull();
  });

  it('transfers a call only after the explicit continue-here action', async () => {
    service.resumableCall.set(invitation);
    expect(api.post).not.toHaveBeenCalled();
    const reconnect = spyOn(service, 'retryConnection').and.resolveTo();
    await service.resumeHere();
    expect(api.post.calls.first().args[0]).toBe('/calls/incoming/resume');
    expect(service.activeCall()?.id).toBe(invitation.id);
    expect(reconnect).toHaveBeenCalled();
  });

  it('asks for receiver consent when a direct voice call upgrades to video', async () => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connected');
    const capture = spyOn(navigator.mediaDevices, 'getUserMedia');
    spyOn<any>(service, 'decodeCallSignalPayload').and.resolveTo({ payload: { type: 'Video', action: 'request', requestId: 'upgrade-1' } });
    await (service as any).handleCallSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'media-mode' });
    expect(service.activeCall()?.type).toBe('Video');
    expect(service.mediaUpgradeRequested()).toBeTrue();
    expect(service.cameraOff()).toBeTrue();
    expect(capture).not.toHaveBeenCalled();
  });

  it('publishes the receiver camera and renegotiates after accepting video', async () => {
    service.activeCall.set({ ...invitation, type: 'Video', status: 'Active' });
    service.phase.set('connected');
    service.cameraOff.set(true);
    service.mediaUpgradeRequested.set(true);
    (service as any).incomingVideoRequestId = 'upgrade-1';
    const stream = document.createElement('canvas').captureStream();
    const capture = spyOn<any>(service, 'restoreDirectMediaTrack').and.callFake(async () => service.localStream.set(stream));
    const renegotiate = spyOn<any>(service, 'renegotiateDirectPeers').and.resolveTo();
    const broadcast = spyOn<any>(service, 'broadcastControl');
    await service.acceptVideoUpgrade();
    expect(capture).toHaveBeenCalledWith('video', false);
    expect(renegotiate).toHaveBeenCalledWith(true);
    expect(service.cameraOff()).toBeFalse();
    expect(service.mediaUpgradeRequested()).toBeFalse();
    expect(broadcast).toHaveBeenCalledWith('media-mode', { type: 'Video', video: true, action: 'accepted', requestId: 'upgrade-1' });
    expect(broadcast).toHaveBeenCalledWith('camera', 'on');
  });

  it('declines a video request without ending audio or capturing a camera', () => {
    const call = { ...invitation, type: 'Video', status: 'Active' };
    service.activeCall.set(call);
    service.phase.set('connected');
    service.mediaUpgradeRequested.set(true);
    const stream = new MediaStream();
    service.localStream.set(stream);
    const capture = spyOn(navigator.mediaDevices, 'getUserMedia');
    const broadcast = spyOn<any>(service, 'broadcastControl');
    service.declineVideoUpgrade();
    expect(service.activeCall()).toBe(call);
    expect(service.localStream()).toBe(stream);
    expect(service.phase()).toBe('connected');
    expect(service.mediaUpgradeRequested()).toBeFalse();
    expect(capture).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('media-mode', jasmine.objectContaining({ action: 'declined' }));
  });

  it('bounds video-response waiting without failing the active audio call', fakeAsync(() => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connected');
    (service as any).beginAwaitingVideoResponse(invitation.id, 'upgrade-1');
    tick(30_000);
    expect(service.mediaUpgradeAwaitingPeer()).toBeFalse();
    expect(service.mediaUpgradeNotice()).toContain('audio');
    expect(service.phase()).toBe('connected');
    expect(service.activeCall()?.id).toBe(invitation.id);
    expect(service.error()).toBe('');
    service.releaseLocalResources();
  }));

  it('ignores a late response belonging to a different video request', async () => {
    service.activeCall.set({ ...invitation, status: 'Active', type: 'Video' });
    service.phase.set('connected');
    (service as any).beginAwaitingVideoResponse(invitation.id, 'current-request');
    spyOn<any>(service, 'decodeCallSignalPayload').and.resolveTo({ payload: { type: 'Video', action: 'declined', requestId: 'old-request' } });
    await (service as any).handleCallSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'media-mode' });
    expect(service.mediaUpgradeAwaitingPeer()).toBeTrue();
    expect(service.mediaUpgradeNotice()).toBe('');
  });

  it('recognizes an accepted video response even after the waiting notice expires', fakeAsync(() => {
    service.activeCall.set({ ...invitation, status: 'Active', type: 'Video' });
    service.phase.set('connected');
    (service as any).beginAwaitingVideoResponse(invitation.id, 'upgrade-1');
    tick(30_000);
    expect(service.mediaUpgradeNotice()).not.toBe('');
    spyOn<any>(service, 'decodeCallSignalPayload').and.resolveTo({ payload: { type: 'Video', action: 'accepted', requestId: 'upgrade-1' } });
    void (service as any).handleCallSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'media-mode' });
    flushMicrotasks();
    expect(service.mediaUpgradeNotice()).toBe('');
    expect(service.remoteStates()['peer']['camera']).toBe('on');
    expect(service.phase()).toBe('connected');
    service.releaseLocalResources();
  }));

  it('discards an upgrade camera permission granted after the call ends', async () => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    let grant!: (stream: MediaStream) => void;
    spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValue(new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const stop = jasmine.createSpy('stop');
    const capture = (service as any).restoreDirectMediaTrack('video', false) as Promise<void>;
    service.releaseLocalResources();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expectAsync(capture).toBeRejected();
    expect(stop).toHaveBeenCalled();
    expect(service.localStream()).toBeNull();
  });

  it('does not restore an ended call when the video type update arrives late', async () => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connected');
    spyOn<any>(service, 'restoreDirectMediaTrack').and.resolveTo();
    const response = new Subject<CallSession>();
    api.patch.and.returnValue(response);
    const upgrading = service.enableVideo();
    await Promise.resolve();
    service.releaseLocalResources();
    response.next({ ...invitation, type: 'Video', status: 'Active' });
    response.complete();
    await upgrading;
    expect(service.activeCall()).toBeNull();
    expect(service.mediaUpgradeAwaitingPeer()).toBeFalse();
  });

  it('publishes group video locally without asking every room member to enable cameras', async () => {
    service.activeCall.set({ ...invitation, isGroupRoom: true, status: 'Active' });
    service.phase.set('connected');
    const camera = jasmine.createSpy().and.resolveTo();
    (service as any).liveKitRoom = { localParticipant: { setCameraEnabled: camera } };
    spyOn<any>(service, 'syncLiveKitLocalTracks');
    const broadcast = spyOn<any>(service, 'broadcastControl');
    await service.enableVideo();
    expect(camera).toHaveBeenCalledWith(true);
    expect(service.activeCall()?.type).toBe('Video');
    expect(service.mediaUpgradeAwaitingPeer()).toBeFalse();
    expect(broadcast).not.toHaveBeenCalled();
    (service as any).liveKitRoom = null;
  });

  it('stops the connecting sound when the connection fails', () => {
    const tone = (service as any).startRingingTone as jasmine.Spy;
    const stop = spyOn<any>(service, 'stopRingingTone');
    TestBed.tick();
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connecting');
    TestBed.tick();
    expect(tone).toHaveBeenCalledWith('connecting');
    stop.calls.reset();
    service.phase.set('failed');
    TestBed.tick();
    expect(stop).toHaveBeenCalled();
  });

  for (const decision of ['pending', 'declined']) {
    it(`keeps the camera off when a ${decision} direct video request migrates to a group`, async () => {
      const direct = { ...invitation, type: 'Video', status: 'Active' };
      service.activeCall.set(direct);
      service.phase.set('connected');
      service.cameraOff.set(true);
      service.mediaUpgradeRequested.set(true);
      spyOn<any>(service, 'broadcastControl');
      if (decision === 'declined') service.declineVideoUpgrade();
      const camera = jasmine.createSpy().and.resolveTo();
      const room = { localParticipant: { setCameraEnabled: camera, setMicrophoneEnabled: jasmine.createSpy().and.resolveTo() } };
      const connect = spyOn<any>(service, 'connectLiveKitRoom').and.callFake(async (call: CallSession, preserve: boolean) => {
        (service as any).liveKitRoom = room;
        await (service as any).publishLiveKitLocalMedia(room, call, preserve);
      });
      await (service as any).applyActiveCallUpdate({ ...direct, isGroupRoom: true, conversationId: 'group-1' });
      expect(connect).toHaveBeenCalledWith(jasmine.objectContaining({ isGroupRoom: true }), true);
      expect(camera).not.toHaveBeenCalled();
      expect(service.cameraOff()).toBeTrue();
      expect(service.mediaUpgradeRequested()).toBeFalse();
      (service as any).liveKitRoom = null;
    });
  }

  it('serializes repeated camera taps while the camera permission is pending', async () => {
    service.activeCall.set({ ...invitation, type: 'Video', status: 'Active' });
    service.phase.set('connected');
    service.cameraOff.set(true);
    let finishCapture!: () => void;
    const capture = spyOn<any>(service, 'restoreDirectMediaTrack').and.returnValue(new Promise<void>((resolve) => { finishCapture = resolve; }));
    spyOn<any>(service, 'broadcastControl');
    const firstTap = service.toggleCamera();
    await service.toggleCamera();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(service.mediaUpgradeInFlight()).toBeTrue();
    finishCapture();
    await firstTap;
    expect(service.mediaUpgradeInFlight()).toBeFalse();
    expect(service.cameraOff()).toBeFalse();
  });

  it('continues the connecting tone when acceptance follows an earlier active-call update', async () => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connecting');
    service.localStream.set(new MediaStream());
    spyOn<any>(service, 'loadIceConfiguration').and.resolveTo();
    spyOn<any>(service, 'establishAcceptedCallPeer').and.resolveTo();
    spyOn<any>(service, 'scheduleConnectedUiReconcile');
    const stop = spyOn<any>(service, 'stopRingingTone');
    await (service as any).handleCallSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'accepted' });
    expect((service as any).startRingingTone).toHaveBeenCalledWith('connecting');
    expect(stop).not.toHaveBeenCalled();
    expect(service.phase()).toBe('connecting');
  });

  it('shows the camera as enabled after explicitly starting or answering a group video call', async () => {
    const call = { ...invitation, type: 'Video', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.cameraOff.set(true); // A server refresh arrived before local publication.
    const camera = jasmine.createSpy().and.resolveTo();
    const room = { localParticipant: { setCameraEnabled: camera, setMicrophoneEnabled: jasmine.createSpy().and.resolveTo() } };
    (service as any).liveKitRoom = room;
    await (service as any).publishLiveKitLocalMedia(room, call, false);
    expect(camera).toHaveBeenCalledWith(true);
    expect(service.cameraOff()).toBeFalse();
    (service as any).liveKitRoom = null;
  });

  it('shows the camera as disabled when joining an audio-only group', async () => {
    const call = { ...invitation, type: 'Voice', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.cameraOff.set(false);
    const camera = jasmine.createSpy().and.resolveTo();
    const room = { localParticipant: { setCameraEnabled: camera, setMicrophoneEnabled: jasmine.createSpy().and.resolveTo() } };
    (service as any).liveKitRoom = room;
    await (service as any).publishLiveKitLocalMedia(room, call, false);
    expect(camera).not.toHaveBeenCalled();
    expect(service.cameraOff()).toBeTrue();
    (service as any).liveKitRoom = null;
  });

  it('ignores group camera publication results belonging to a call that already closed', async () => {
    const call = { ...invitation, type: 'Video', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.cameraOff.set(true);
    let finishCapture!: () => void;
    const camera = jasmine.createSpy().and.returnValue(new Promise<void>((resolve) => { finishCapture = resolve; }));
    const room = { localParticipant: { setCameraEnabled: camera, setMicrophoneEnabled: jasmine.createSpy().and.resolveTo() } };
    (service as any).liveKitRoom = room;
    const publication = (service as any).publishLiveKitLocalMedia(room, call, false);
    await Promise.resolve();
    service.activeCall.set(null);
    (service as any).liveKitRoom = null;
    finishCapture();
    await publication;
    expect(service.cameraOff()).toBeTrue();
  });
});
