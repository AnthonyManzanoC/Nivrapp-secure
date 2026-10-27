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

  function peer(state: RTCPeerConnectionState = 'connected') {
    const connection = { connectionState: state, iceConnectionState: state,
      signalingState: 'stable', remoteDescription: null,
      getReceivers: () => [], getSenders: () => [], close: jasmine.createSpy('close') };
    return { connection, pendingIce: [], iceRestartAttempts: 0, disconnectTimer: null,
      makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false, negotiationQueued: false };
  }

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
      { provide: ChatService, useValue: { conversations: signal([]), participantDisplayName: (id: string) => id } },
      { provide: CryptoService, useValue: {} },
      { provide: LocalHistoryService, useValue: { accountKeysForUser: async () => [], calls: async () => [], putCalls: async () => undefined } },
      { provide: NativeDeviceService, useValue: {
        onNativeCallAction: () => Promise.resolve(null), clearIncomingCall: () => Promise.resolve(),
        showIncomingCall: () => Promise.resolve(),
        setActiveCall: () => Promise.resolve(false),
      } },
      { provide: SignalrService, useValue: { events$: new Subject() } },
      { provide: CallAudioOutputService, useValue: { sync: jasmine.createSpy(), setCallSession: jasmine.createSpy(), resume: jasmine.createSpy().and.resolveTo(), playbackBlocked: signal(false) } },
      { provide: CallGameSessionService, useValue: { configure: jasmine.createSpy(), reset: jasmine.createSpy(), transport: { detachPeer: jasmine.createSpy(), attachDirect: jasmine.createSpy() } } },
      { provide: GroupCallCryptoService, useValue: { updateRoster: jasmine.createSpy().and.resolveTo(), clear: jasmine.createSpy(), isMediaKeySignal: () => false } },
      { provide: NativeScreenShareService, useValue: { stop: jasmine.createSpy().and.resolveTo(), supported: () => false } },
    ] });
    service = TestBed.inject(CallsService);
    spyOn<any>(service, 'addHistory');
    spyOn<any>(service, 'startRingingTone');
    spyOn<any>(service, 'scheduleRingTimeout');
  });

  afterEach(() => service.ngOnDestroy());

  it('shows transport failure instead of the old server Active status while retry is available', () => {
    const call = { ...invitation, status: 'Active' };
    service.activeCall.set(call); service.phase.set('failed');
    expect(service.callStatusLabel(call)).toBe('Sin conexión');
  });

  it('discards a delayed local call history instead of merging it into the next account', async () => {
    TestBed.flushEffects(); await Promise.resolve();
    const history = TestBed.inject(LocalHistoryService);
    spyOn(history, 'accountKeysForUser').and.resolveTo(['me']);
    let finish!: (calls: CallSession[]) => void;
    spyOn(history, 'calls').and.returnValue(new Promise(resolve => { finish = resolve; }));
    const write = spyOn(history, 'putCalls').and.resolveTo();
    const pending = (service as any).loadPersistentHistory();
    await Promise.resolve(); await Promise.resolve();
    (service as any).auth.session.set({ user: { id: 'other-account' }, device: { id: 'other-device' } });
    const own = { ...invitation, id: 'other-account-call' };
    service.history.set([own]);
    finish([invitation]); await pending;
    expect(service.history()).toEqual([own]);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects an old history read after leaving and returning to the same account', async () => {
    TestBed.flushEffects(); await Promise.resolve();
    const generation = signal(1);
    (service as any).auth.sessionGeneration = generation;
    const history = TestBed.inject(LocalHistoryService);
    spyOn(history, 'accountKeysForUser').and.resolveTo(['me']);
    let finish!: (calls: CallSession[]) => void;
    spyOn(history, 'calls').and.returnValue(new Promise(resolve => { finish = resolve; }));
    const write = spyOn(history, 'putCalls').and.resolveTo();
    const pending = (service as any).loadPersistentHistory();
    await Promise.resolve(); await Promise.resolve();
    generation.set(3);
    service.history.set([]);
    finish([invitation]); await pending;
    expect(service.history()).toEqual([]); expect(write).not.toHaveBeenCalled();
  });

  it('releases the former account call and recovery state when logout activates another saved account', () => {
    TestBed.flushEffects();
    const old = { ...invitation, id: 'old-account-call' };
    service.activeCall.set(old); service.resumableCall.set(old); service.history.set([old]);
    (service as any).auth.session.set({ user: { id: 'other-account' }, device: { id: 'other-device' } });
    TestBed.flushEffects();
    expect(service.activeCall()).toBeNull(); expect(service.resumableCall()).toBeNull();
    expect(service.history().some(call => call.id === old.id)).toBeFalse();
    expect(localStorage.getItem('nivra.callRecoveryHint') || '').not.toContain('old-account-call');
  });

  it('owns communication routing only after capture and releases it when the call ends', () => {
    const audio = TestBed.inject(CallAudioOutputService);
    service.activeCall.set(invitation);
    service.phase.set('ringing');
    TestBed.flushEffects();
    expect(audio.setCallSession).not.toHaveBeenCalledWith(invitation.id, false);
    const track = { readyState: 'live', enabled: true, stop: jasmine.createSpy() };
    service.localStream.set({ getAudioTracks: () => [track], getVideoTracks: () => [], getTracks: () => [track] } as unknown as MediaStream);
    service.phase.set('connected');
    TestBed.flushEffects();
    expect(audio.setCallSession).toHaveBeenCalledWith(invitation.id, false);
    service.activeCall.set({ ...invitation, type: 'Video' });
    TestBed.flushEffects();
    expect(audio.setCallSession).toHaveBeenCalledWith(invitation.id, true);
    (service as any).cleanup({ remember: false });
    expect(audio.setCallSession).toHaveBeenCalledWith(null);
  });

  it('keeps listen mute independent from microphone mute and communication route ownership', () => {
    const track = { readyState: 'live', enabled: true, stop: jasmine.createSpy() };
    service.localStream.set({ getAudioTracks: () => [track], getVideoTracks: () => [], getTracks: () => [track] } as unknown as MediaStream);
    service.activeCall.set(invitation);
    service.phase.set('connected');
    TestBed.flushEffects();
    const audio = TestBed.inject(CallAudioOutputService);
    (audio.setCallSession as jasmine.Spy).calls.reset();
    service.toggleOutputMute();
    TestBed.flushEffects();
    expect(service.speaker()).toBeFalse();
    expect(service.muted()).toBeFalse();
    expect(track.enabled).toBeTrue();
    expect(audio.setCallSession).not.toHaveBeenCalled();
    expect(audio.sync).toHaveBeenCalledWith({}, true);
  });

  it('reloads active rooms and call state after reconnecting on a replacement API', () => {
    const rooms = spyOn(service, 'refreshActiveGroupRooms').and.resolveTo();
    const state = spyOn<any>(service, 'pollPersistedSignals').and.resolveTo();
    service.activeCall.set(invitation);
    const realtime = TestBed.inject(SignalrService).events$;
    realtime.next({ type: 'connected', payload: null });
    realtime.next({ type: 'reconnected', payload: null });
    expect(rooms).toHaveBeenCalledTimes(2);
    expect(state.calls.allArgs()).toEqual([[invitation.id], [invitation.id]]);
  });

  it('clears a late transport failure when the real peer connects without hanging up its media', fakeAsync(() => {
    service.activeCall.set(invitation); service.phase.set('connecting');
    spyOn(service, 'retryConnection').and.resolveTo();
    (service as any).scheduleConnectionWatchdog(invitation.id);
    tick(30_000); flushMicrotasks();
    expect(service.phase()).toBe('failed'); expect(service.error()).toContain('No se pudo conectar');
    const connected = peer(); (service as any).peers.set('peer', connected);
    (service as any).reconcileHealthyConnection(invitation);
    expect(service.phase()).toBe('connected'); expect(service.error()).toBe('');
    expect(connected.connection.close).not.toHaveBeenCalled();
  }));

  it('keeps a camera-permission warning when healthy audio supersedes a connection warning', () => {
    service.activeCall.set(invitation); service.phase.set('failed');
    (service as any).setConnectionError('Transport failed');
    service.error.set('Permite la cámara; el audio continúa.');
    (service as any).peers.set('peer', peer());
    (service as any).reconcileHealthyConnection(invitation);
    expect(service.phase()).toBe('connected');
    expect(service.error()).toBe('Permite la cámara; el audio continúa.');
  });

  it('checks a healthy transport before either watchdog retries or fails a stale connecting label', fakeAsync(() => {
    service.activeCall.set(invitation); service.phase.set('connecting');
    const reconnect = spyOn(service, 'retryConnection').and.resolveTo();
    (service as any).peers.set('peer', peer());
    (service as any).scheduleConnectionWatchdog(invitation.id);
    tick(30_000); flushMicrotasks();
    expect(reconnect).not.toHaveBeenCalled();
    expect(service.phase()).toBe('connected'); expect(service.error()).toBe('');
  }));

  it('does not mistake a cached live video track for a connected transport', () => {
    service.activeCall.set(invitation); service.phase.set('connecting');
    const stream = document.createElement('canvas').captureStream();
    service.remoteStreams.set({ peer: stream });
    (service as any).peers.set('peer', peer('failed'));
    (service as any).reconcileConnectedUi(invitation.id);
    expect(service.phase()).toBe('connecting');
  });

  it('starts the connection deadline after slow answer preparation instead of timing out a permission prompt', fakeAsync(() => {
    service.activeCall.set(invitation); service.phase.set('ringing');
    let grant!: () => void;
    spyOn<any>(service, 'prepareMedia').and.callFake(async () => {
      await new Promise<void>(resolve => grant = resolve);
      const stream = new MediaStream(); service.localStream.set(stream); return stream;
    });
    spyOn<any>(service, 'loadIceConfiguration').and.resolveTo();
    spyOn<any>(service, 'broadcastControl').and.resolveTo();
    spyOn<any>(service, 'sendCallSignal').and.resolveTo();
    spyOn<any>(service, 'establishCallPeers').and.resolveTo();
    spyOn<any>(service, 'flushPendingCallSignals').and.resolveTo();
    spyOn<any>(service, 'scheduleConnectedUiReconcile');
    const retry = spyOn(service, 'retryConnection').and.resolveTo();
    void service.accept(); flushMicrotasks(); tick(31_000); flushMicrotasks();
    expect(service.phase()).toBe('connecting'); expect(service.error()).toBe('');
    expect(retry).not.toHaveBeenCalled();
    grant(); flushMicrotasks();
    tick(29_999); flushMicrotasks(); expect(service.phase()).toBe('connecting');
    tick(1); flushMicrotasks(); expect(service.phase()).toBe('failed');
  }));

  it('coalesces forced ICE refreshes while credentials are already loading', async () => {
    const response = new Subject<any>(); api.get.and.returnValue(response);
    const first = (service as any).loadIceConfiguration();
    expect((service as any).loadIceConfiguration(true)).toBe(first);
    expect((service as any).loadIceConfiguration(true)).toBe(first);
    expect(api.get).toHaveBeenCalledOnceWith('/calls/ice-config');
    response.next({ iceServers: [{ urls: 'turn:relay.example.test', username: 'fresh', credential: 'key' }] }); response.complete();
    await first;
    expect((service as any).iceServers[0].username).toBe('fresh');
  });

  it('does not install ICE credentials returned for the previous account', async () => {
    const previous = new Subject<any>(); const current = new Subject<any>();
    api.get.and.returnValues(previous, current);
    const oldRequest = (service as any).loadIceConfiguration();
    (service as any).auth.session.set({ user: { id: 'other' }, device: { id: 'other-device' } });
    const newRequest = (service as any).loadIceConfiguration();
    previous.next({ iceServers: [{ urls: 'turn:old.example.test', username: 'old' }] }); previous.complete();
    await oldRequest;
    expect((service as any).iceServers.some((server: RTCIceServer) => server.username === 'old')).toBeFalse();
    current.next({ iceServers: [{ urls: 'turn:new.example.test', username: 'new' }] }); current.complete();
    await newRequest; expect((service as any).iceServers[0].username).toBe('new');
  });

  it('coalesces repeated accepted events during preparation into one peer negotiation', async () => {
    service.activeCall.set(invitation); service.phase.set('connecting'); service.localStream.set(new MediaStream());
    let finish!: () => void;
    const ice = spyOn<any>(service, 'loadIceConfiguration').and.returnValue(new Promise<void>(resolve => finish = resolve));
    const establish = spyOn<any>(service, 'establishAcceptedCallPeer').and.resolveTo();
    spyOn<any>(service, 'scheduleConnectedUiReconcile');
    const events = Array.from({ length: 10 }, (_, index) => (service as any).handleCallSignal({
      callId: invitation.id, fromUserId: 'peer', signalId: `accepted-${index}`, signalType: 'accepted' }));
    expect(ice).toHaveBeenCalledTimes(1); finish(); await Promise.all(events);
    expect(establish).toHaveBeenCalledTimes(1);
  });

  it('does not replace the pending offer again when acceptance is delivered more than once', async () => {
    service.activeCall.set(invitation); service.phase.set('connecting'); service.localStream.set(new MediaStream());
    const original = peer('connecting'); const negotiated = peer('connecting');
    (service as any).peers.set('peer', original);
    spyOn<any>(service, 'establishCallPeers').and.callFake(async () => (service as any).peers.set('peer', negotiated));
    await (service as any).establishAcceptedCallPeer('peer');
    await (service as any).establishAcceptedCallPeer('peer');
    expect(original.connection.close).toHaveBeenCalledTimes(1);
    expect(negotiated.connection.close).not.toHaveBeenCalled();
    expect((service as any).peers.get('peer')).toBe(negotiated);
  });

  it('ignores acceptance recovery and exhausted-restart alarms once its peer is healthy', async () => {
    service.activeCall.set(invitation); service.phase.set('connected');
    const connected = peer(); connected.iceRestartAttempts = 3; (service as any).peers.set('peer', connected);
    const ice = spyOn<any>(service, 'loadIceConfiguration');
    await (service as any).handleCallSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'accepted' });
    await (service as any).restartIceForPeer('peer');
    expect(ice).not.toHaveBeenCalled(); expect(connected.connection.close).not.toHaveBeenCalled();
    expect(service.phase()).toBe('connected'); expect(service.error()).toBe('');
  });

  it('keeps a peer that recovers while a manual retry is awaiting ICE credentials', async () => {
    service.activeCall.set(invitation); service.phase.set('connecting'); service.localStream.set(new MediaStream());
    let finish!: () => void;
    spyOn<any>(service, 'loadIceConfiguration').and.returnValue(new Promise<void>(resolve => finish = resolve));
    const restart = spyOn<any>(service, 'restartIceForPeer').and.resolveTo();
    const retry = service.retryConnection();
    const connected = peer(); (service as any).peers.set('peer', connected);
    finish(); await retry;
    expect(restart).not.toHaveBeenCalled(); expect(connected.connection.close).not.toHaveBeenCalled();
    expect(service.phase()).toBe('connected'); expect(service.error()).toBe('');
  });

  it('does not apply an old retry failure or clear the next call recovery flag', async () => {
    service.activeCall.set(invitation); service.phase.set('connecting'); service.localStream.set(new MediaStream());
    let fail!: (reason: unknown) => void;
    spyOn<any>(service, 'loadIceConfiguration').and.returnValue(new Promise<void>((_resolve, reject) => fail = reject));
    const retry = service.retryConnection();
    service.releaseLocalResources();
    service.activeCall.set({ ...invitation, id: 'next-call' }); service.phase.set('connected');
    service.error.set('Next camera notice'); (service as any).networkRecoveryInFlight = true;
    fail(new Error('Old request failed')); await retry;
    expect(service.phase()).toBe('connected'); expect(service.error()).toBe('Next camera notice');
    expect((service as any).networkRecoveryInFlight).toBeTrue();
  });

  it('does not dismiss the new account call when an old claim later reports an ownership conflict', async () => {
    TestBed.flushEffects();
    const response = new Subject<CallSession>(); api.post.and.returnValue(response);
    const capture = spyOn<any>(service, 'prepareMedia');
    service.activeCall.set(invitation); service.phase.set('ringing');
    const answer = service.accept();
    (service as any).auth.session.set({ user: { id: 'other-account' }, device: { id: 'other-device' } });
    TestBed.flushEffects();
    const next = { ...invitation, id: 'new-account-call' };
    service.activeCall.set(next); service.phase.set('ringing'); service.resumableCall.set(next);
    response.error({ status: 409, error: { code: 'call_owned_elsewhere' } }); await answer;
    expect(service.activeCall()).toBe(next); expect(service.resumableCall()).toBe(next);
    expect(service.phase()).toBe('ringing'); expect(capture).not.toHaveBeenCalled();
  });

  it('coalesces cold answer lookup and preserves the ownership returned by its claim', async () => {
    const response = new Subject<CallSession>(); api.get.and.returnValue(response);
    const owner = { deviceId: 'shared-device', clientSessionId: (service as any).callSignalSessionId };
    api.post.and.returnValue(of({ ...invitation, status: 'Active', participantSessions: { me: owner } }));
    spyOn<any>(service, 'loadIceConfiguration').and.resolveTo();
    spyOn<any>(service, 'prepareMedia').and.resolveTo(new MediaStream());
    spyOn<any>(service, 'sendCallSignal').and.resolveTo();
    spyOn<any>(service, 'establishCallPeers').and.resolveTo();
    spyOn<any>(service, 'flushPendingCallSignals').and.resolveTo();
    spyOn<any>(service, 'scheduleConnectedUiReconcile');
    const first = service.rejoin(invitation.id, true);
    expect(service.rejoin(invitation.id, true)).toBe(first);
    response.next(invitation); response.complete(); await first;
    expect(api.get).toHaveBeenCalledOnceWith('/calls/incoming'); expect(api.post).toHaveBeenCalledTimes(1);
    expect(service.activeCall()?.participantSessions?.['me']).toEqual(owner);
  });

  it('ignores a queued connection callback from a peer replaced in the same call', () => {
    service.activeCall.set(invitation); service.phase.set('connecting');
    const old = (service as any).ensurePeerConnection('peer') as RTCPeerConnection;
    const callback = old.onconnectionstatechange!;
    (service as any).closePeerConnectionForUser('peer');
    (service as any).peers.set('peer', peer('connecting'));
    Object.defineProperty(old, 'connectionState', { get: () => 'connected' });
    Object.defineProperty(old, 'iceConnectionState', { get: () => 'connected' });
    callback.call(old, new Event('connectionstatechange'));
    expect(service.phase()).toBe('connecting');
  });

  it('discards decrypted SDP that finishes after the same call is reopened', async () => {
    service.activeCall.set(invitation); service.phase.set('connecting');
    let finish!: (decoded: unknown) => void;
    spyOn<any>(service, 'decodeCallSignalPayload').and.returnValue(new Promise(resolve => finish = resolve));
    const ensure = spyOn<any>(service, 'ensurePeerConnection');
    const pending = (service as any).handleWebRtcSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'offer' });
    service.releaseLocalResources(); service.activeCall.set(invitation); service.phase.set('connected');
    finish({ payload: { description: { type: 'offer', sdp: 'old' } } }); await pending;
    expect(ensure).not.toHaveBeenCalled(); expect(service.phase()).toBe('connected');
  });

  it('opens the exact incoming notification as ringing without claiming or capturing media', async () => {
    const capture = spyOn<any>(service, 'prepareMedia');
    await service.handleNotificationCallAction({ action: 'open', callId: invitation.id,
      recipientUserId: 'me', recipientDeviceId: 'shared-device' });
    expect(api.get).toHaveBeenCalledOnceWith('/calls/incoming');
    expect(service.activeCall()?.id).toBe(invitation.id); expect(service.phase()).toBe('ringing');
    expect(api.post).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });

  it('does not accept a caller-self notification as an incoming call on its second installation', async () => {
    api.get.and.returnValue(of({ ...invitation, initiatorUserId: 'me' }));
    const capture = spyOn<any>(service, 'prepareMedia');
    await service.handleNotificationCallAction({ action: 'answer', callId: invitation.id,
      recipientUserId: 'me', recipientDeviceId: 'shared-device' });
    expect(service.activeCall()).toBeNull(); expect(api.post).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });

  it('does not post signaling encrypted before an account transition', async () => {
    service.activeCall.set(invitation);
    let finish!: (ciphertext: string) => void;
    spyOn<any>(service, 'encryptCallSignalForUser').and.returnValue(new Promise<string>(resolve => finish = resolve));
    const sending = (service as any).sendCallSignal(invitation, 'peer', 'offer', { description: {} });
    (service as any).auth.session.set({ user: { id: 'other-account' }, device: { id: 'other-device' } });
    finish('synthetic-ciphertext'); await sending;
    expect(api.post).not.toHaveBeenCalled();
  });

  it('ignores a native answer addressed to a different account before clearing or loading the call', async () => {
    const clear = spyOn(TestBed.inject(NativeDeviceService), 'clearIncomingCall').and.resolveTo();
    const answer = spyOn(service, 'accept').and.resolveTo();
    const rejoin = spyOn(service, 'rejoin').and.resolveTo();
    await (service as any).handleNativeCallAction({ action: 'answer', callId: invitation.id,
      recipientUserId: 'previous-account', recipientDeviceId: 'shared-device' });
    expect(clear).not.toHaveBeenCalled();
    expect(TestBed.inject(Router).navigateByUrl).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
  });

  it('ignores a native answer addressed to another device of the same account', async () => {
    const clear = spyOn(TestBed.inject(NativeDeviceService), 'clearIncomingCall').and.resolveTo();
    await (service as any).handleNativeCallAction({ action: 'answer', callId: invitation.id,
      recipientUserId: 'me', recipientDeviceId: 'previous-device' });
    expect(clear).not.toHaveBeenCalled();
    expect(TestBed.inject(Router).navigateByUrl).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('still answers a matching native invitation and supports earlier events without recipient fields', async () => {
    service.activeCall.set(invitation);
    const answer = spyOn(service, 'accept').and.resolveTo();
    await (service as any).handleNativeCallAction({ action: 'answer', callId: invitation.id,
      recipientUserId: 'me', recipientDeviceId: 'shared-device' });
    await (service as any).handleNativeCallAction({ action: 'answer', callId: invitation.id });
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it('abandons a native action if the account changes while dismissing its notification', async () => {
    let dismiss!: () => void;
    spyOn(TestBed.inject(NativeDeviceService), 'clearIncomingCall').and.returnValue(new Promise<void>(resolve => dismiss = resolve));
    const answer = spyOn(service, 'accept').and.resolveTo();
    const rejoin = spyOn(service, 'rejoin').and.resolveTo();
    const action = (service as any).handleNativeCallAction({ action: 'answer', callId: invitation.id,
      recipientUserId: 'me', recipientDeviceId: 'shared-device' });
    (service as any).auth.session.set({ user: { id: 'other-account' }, device: { id: 'other-device' } });
    dismiss();
    await action;
    expect(TestBed.inject(Router).navigateByUrl).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('does not claim a shared group after the native answer lookup crosses an account change', fakeAsync(() => {
    const response = new Subject<CallSession>();
    api.get.and.returnValue(response);
    const action = (service as any).handleNativeCallAction({ action: 'answer', callId: invitation.id,
      recipientUserId: 'me', recipientDeviceId: 'shared-device' });
    flushMicrotasks();
    expect(api.get).toHaveBeenCalledWith('/calls/incoming');
    (service as any).auth.session.set({ user: { id: 'other-account' }, device: { id: 'other-device' } });
    response.next({ ...invitation, conversationId: 'shared-group', isGroupRoom: true });
    response.complete();
    flushMicrotasks();
    expect(api.post).not.toHaveBeenCalled();
    expect(service.activeCall()).toBeNull();
    void action;
  }));

  it('does not reject a previous device invitation after its call lookup finishes', async () => {
    const response = new Subject<CallSession>();
    api.get.and.returnValue(response);
    const reject = (service as any).rejectIncomingCallById(invitation.id);
    (service as any).auth.session.set({ user: { id: 'me' }, device: { id: 'new-device' } });
    response.next(invitation);
    response.complete();
    await reject;
    expect(api.post).not.toHaveBeenCalled();
    expect(service.activeCall()).toBeNull();
  });

  it('refreshes ICE credentials without changing immutable negotiated configuration', async () => {
    const connection = new RTCPeerConnection({ iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle' });
    connection.addTransceiver('audio');
    await connection.setLocalDescription(await connection.createOffer());
    // This is the exact browser exception seen after a network recovery on 1.2.8.
    expect(() => connection.setConfiguration({ iceServers: [], iceTransportPolicy: 'all' }))
      .toThrowError(/configuration/i);
    const original = connection.getConfiguration();
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connected');
    service.localStream.set(new MediaStream());
    (service as any).peers.set('peer', { connection, iceRestartAttempts: 1, pendingIce: [], disconnectTimer: null });
    (service as any).iceServers = [{ urls: 'turn:relay.example.test:3478', username: 'renewed', credential: 'renewed-key' }];
    (service as any).iceTransportPolicy = 'relay';
    spyOn<any>(service, 'loadIceConfiguration').and.resolveTo();
    spyOn<any>(service, 'sendCallSignal').and.resolveTo();
    spyOn<any>(service, 'establishCallPeers').and.resolveTo();
    spyOn<any>(service, 'pollPersistedSignals').and.resolveTo();
    spyOn<any>(service, 'scheduleConnectedUiReconcile');
    const restart = spyOn<any>(service, 'restartIceForPeer').and.resolveTo();
    await service.retryConnection();
    const refreshed = connection.getConfiguration();
    expect(service.error()).toBe('');
    expect(refreshed.iceCandidatePoolSize).toBe(4);
    expect(refreshed.bundlePolicy).toBe(original.bundlePolicy);
    expect(refreshed.certificates).toEqual(original.certificates);
    expect(refreshed.iceTransportPolicy).toBe('relay');
    expect(refreshed.iceServers?.[0].username).toBe('renewed');
    expect(restart).toHaveBeenCalledWith('peer', true);
  });

  it('restores sendrecv when replacing a track on a receive-only transceiver', async () => {
    const sender = { track: { kind: 'video' }, replaceTrack: jasmine.createSpy().and.resolveTo() };
    const transceiver = { sender, receiver: { track: { kind: 'video' } }, direction: 'recvonly' };
    const connection = { getSenders: () => [sender], getTransceivers: () => [transceiver] };
    spyOn<any>(service, 'tuneOutgoingSender').and.resolveTo();
    const renegotiate = await (service as any).setOutgoingTrack(connection, 'video', {}, new MediaStream());
    expect(renegotiate).toBeTrue();
    expect(transceiver.direction).toBe('sendrecv');
  });

  it('restores incoming video when a legacy camera transceiver was send-only', async () => {
    const sender = { track: { kind: 'video' }, replaceTrack: jasmine.createSpy().and.resolveTo() };
    const transceiver = { sender, receiver: { track: { kind: 'video' } }, direction: 'sendonly' };
    const connection = { getSenders: () => [sender], getTransceivers: () => [transceiver] };
    spyOn<any>(service, 'tuneOutgoingSender').and.resolveTo();
    expect(await (service as any).setOutgoingTrack(connection, 'video', {}, new MediaStream())).toBeTrue();
    expect(transceiver.direction).toBe('sendrecv');
  });

  it('reuses an owned live camera when upgrading voice instead of opening it twice', async () => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connected');
    const stream = document.createElement('canvas').captureStream();
    const video = stream.getVideoTracks()[0];
    video.enabled = false;
    service.localStream.set(stream);
    const capture = spyOn(navigator.mediaDevices, 'getUserMedia');
    spyOn<any>(service, 'broadcastControl').and.resolveTo();
    spyOn<any>(service, 'renegotiateDirectPeers').and.resolveTo();
    await service.enableVideo();
    expect(capture).not.toHaveBeenCalled();
    expect(service.localStream()?.getVideoTracks()[0]).toBe(video);
    expect(video.enabled).toBeTrue();
    expect(video.readyState).toBe('live');
    expect(service.cameraOff()).toBeFalse();
  });

  it('stops a newly acquired camera after publication fails while retaining microphone audio', async () => {
    service.activeCall.set({ ...invitation, type: 'Video', status: 'Active' });
    service.phase.set('connected');
    service.cameraOff.set(true);
    const context = new AudioContext();
    const microphone = context.createMediaStreamDestination().stream.getAudioTracks()[0];
    const camera = document.createElement('canvas').captureStream().getVideoTracks()[0];
    service.localStream.set(new MediaStream([microphone]));
    spyOn<any>(service, 'restoreDirectMediaTrack').and.callFake(async () => {
      service.localStream.set(new MediaStream([microphone, camera]));
      throw new DOMException('publication failed', 'InvalidModificationError');
    });
    const broadcast = spyOn<any>(service, 'broadcastControl').and.resolveTo();
    spyOn(console, 'warn');
    try {
      await service.toggleCamera();
      expect(camera.readyState).toBe('ended');
      expect(microphone.readyState).toBe('live');
      expect(service.localStream()?.getAudioTracks()).toEqual([microphone]);
      expect(service.localStream()?.getVideoTracks()).toEqual([]);
      expect(service.phase()).toBe('connected');
      expect(broadcast).toHaveBeenCalledWith('camera', 'off');
    } finally {
      await context.close();
    }
  });

  it('keeps a newly attached camera bidirectional before the voice type update reaches the server', async () => {
    service.activeCall.set({ ...invitation, status: 'Active' });
    service.phase.set('connected');
    const capture = document.createElement('canvas').captureStream();
    service.localStream.set(capture);
    (service as any).iceServers = [];
    spyOn<any>(service, 'sendCallSignal').and.resolveTo();
    const connection = (service as any).ensurePeerConnection('peer') as RTCPeerConnection;
    await (service as any).createAndSendOffer('peer');
    expect(connection.getTransceivers()[0].direction).toBe('sendrecv');
    expect(connection.localDescription?.sdp).toContain('a=sendrecv');
    expect(connection.localDescription?.sdp).not.toContain('a=sendonly');
  });

  it('still negotiates a video receiver when a video call has no local camera', async () => {
    service.activeCall.set({ ...invitation, type: 'Video', status: 'Active' });
    service.phase.set('connected');
    service.localStream.set(new MediaStream());
    (service as any).iceServers = [];
    spyOn<any>(service, 'sendCallSignal').and.resolveTo();
    const connection = (service as any).ensurePeerConnection('peer') as RTCPeerConnection;
    await (service as any).createAndSendOffer('peer');
    expect(connection.getTransceivers()[0].direction).toBe('recvonly');
    expect(connection.localDescription?.sdp).toContain('m=video');
    expect(connection.localDescription?.sdp).toContain('a=recvonly');
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
    expect(renegotiate).toHaveBeenCalledWith();
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

  for (const name of ['NotAllowedError', 'NotReadableError', 'InvalidModificationError']) {
    it(`keeps audio active and explains a ${name} camera failure without exposing a browser exception`, async () => {
      service.activeCall.set({ ...invitation, type: 'Video', status: 'Active' });
      service.phase.set('connected');
      service.mediaUpgradeRequested.set(true);
      service.localStream.set(new MediaStream());
      spyOn<any>(service, 'restoreDirectMediaTrack').and.rejectWith(new DOMException('Internal browser details', name));
      spyOn(console, 'warn');
      await service.acceptVideoUpgrade();
      expect(service.phase()).toBe('connected');
      expect(service.activeCall()?.id).toBe(invitation.id);
      expect(service.cameraOff()).toBeTrue();
      expect(service.error()).toContain('audio continúa');
      expect(service.error()).not.toContain('Internal browser details');
      expect(service.error()).not.toContain('RTCPeerConnection');
    });
  }

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

  it('does not overwrite a new call stream when old camera sender removal finishes late', async () => {
    service.activeCall.set({ ...invitation, type: 'Video', status: 'Active' });
    const camera = document.createElement('canvas').captureStream().getVideoTracks()[0];
    service.localStream.set(new MediaStream([camera]));
    let removed!: () => void;
    const replace = jasmine.createSpy().and.returnValue(new Promise<void>(resolve => { removed = resolve; }));
    const connection = { getSenders: () => [{ track: camera, replaceTrack: replace }], getTransceivers: () => [] };
    (service as any).peers.set('peer', { connection });
    const removing = (service as any).removeDirectVideoTrack();
    expect(camera.readyState).toBe('ended');
    (service as any).mediaGeneration++;
    (service as any).peers.clear();
    const nextStream = document.createElement('canvas').captureStream();
    service.activeCall.set({ ...invitation, id: 'next-call', type: 'Video', status: 'Active' });
    service.localStream.set(nextStream);
    removed();
    await removing;
    expect(service.localStream()).toBe(nextStream);
    expect(nextStream.getVideoTracks()[0].readyState).toBe('live');
    expect(service.activeCall()?.id).toBe('next-call');
  });

  it('does not publish old camera feedback when a microphone fallback is granted after a new call starts', async () => {
    let granted!: (stream: MediaStream) => void;
    const fallback = new Promise<MediaStream>(resolve => { granted = resolve; });
    spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValues(
      Promise.reject(new DOMException('camera absent', 'NotFoundError')), fallback);
    const pending = (service as any).prepareMedia(true);
    await Promise.resolve(); await Promise.resolve();
    (service as any).mediaGeneration++;
    const nextStream = document.createElement('canvas').captureStream();
    service.activeCall.set({ ...invitation, id: 'next-call', type: 'Video', status: 'Active' });
    service.localStream.set(nextStream);
    service.cameraOff.set(false);
    service.error.set('Next call status');
    const stopped = jasmine.createSpy('stopLateMicrophone');
    granted({ getTracks: () => [{ stop: stopped }] } as unknown as MediaStream);
    await expectAsync(pending).toBeRejected();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(service.localStream()).toBe(nextStream);
    expect(service.cameraOff()).toBeFalse();
    expect(service.error()).toBe('Next call status');
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

  it('recovers a group camera with a modest resolution without replacing the microphone or room', async () => {
    const call = { ...invitation, type: 'Video', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.phase.set('connected');
    const camera = jasmine.createSpy().and.returnValues(
      Promise.reject(new DOMException('capture unavailable', 'NotReadableError')), Promise.resolve());
    const microphone = jasmine.createSpy();
    const room = { localParticipant: { setCameraEnabled: camera, setMicrophoneEnabled: microphone } };
    (service as any).liveKitRoom = room;
    await (service as any).setLiveKitCameraEnabled(room, true, call.id);
    expect(camera.calls.count()).toBe(2);
    expect(camera.calls.mostRecent().args).toEqual([true, { resolution: { width: 640, height: 360, frameRate: 24 } }]);
    expect(microphone).not.toHaveBeenCalled();
    expect((service as any).liveKitRoom).toBe(room);
    expect(service.phase()).toBe('connected');
    (service as any).liveKitRoom = null;
  });

  it('does not retry a denied group camera permission', async () => {
    const call = { ...invitation, type: 'Video', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    const camera = jasmine.createSpy().and.rejectWith(new DOMException('permission denied', 'NotAllowedError'));
    const room = { localParticipant: { setCameraEnabled: camera } };
    (service as any).liveKitRoom = room;
    await expectAsync((service as any).setLiveKitCameraEnabled(room, true, call.id)).toBeRejected();
    expect(camera.calls.count()).toBe(1);
    (service as any).liveKitRoom = null;
  });

  it('restarts an interrupted group camera publication before enabling it', async () => {
    const call = { ...invitation, type: 'Video', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    const restart = jasmine.createSpy().and.resolveTo();
    const camera = jasmine.createSpy().and.resolveTo();
    const microphone = jasmine.createSpy();
    const room = { localParticipant: {
      setCameraEnabled: camera, setMicrophoneEnabled: microphone,
      getTrackPublication: () => ({ track: { mediaStreamTrack: { readyState: 'ended' }, restartTrack: restart } }),
    } };
    (service as any).liveKitRoom = room;
    await (service as any).setLiveKitCameraEnabled(room, true, call.id);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(camera).toHaveBeenCalledWith(true);
    expect(microphone).not.toHaveBeenCalled();
    (service as any).liveKitRoom = null;
  });

  it('turns off a late camera grant on its old group room without changing the next room', async () => {
    const call = { ...invitation, type: 'Video', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    let grant!: () => void;
    const camera = jasmine.createSpy().and.returnValues(new Promise<void>(resolve => { grant = resolve; }), Promise.resolve());
    const oldRoom = { localParticipant: { setCameraEnabled: camera } };
    (service as any).liveKitRoom = oldRoom;
    const publication = (service as any).setLiveKitCameraEnabled(oldRoom, true, call.id);
    const nextCamera = jasmine.createSpy();
    const nextRoom = { localParticipant: { setCameraEnabled: nextCamera } };
    service.activeCall.set({ ...call, id: 'next-call' });
    (service as any).liveKitRoom = nextRoom;
    grant();
    await publication;
    expect(camera).toHaveBeenCalledWith(false);
    expect(nextCamera).not.toHaveBeenCalled();
    expect((service as any).liveKitRoom).toBe(nextRoom);
    expect(service.activeCall()?.id).toBe('next-call');
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

  it('coalesces an answer and early offer capture and reconciles camera state after a claim update', async () => {
    const call = { ...invitation, type: 'Video', status: 'Active' };
    service.activeCall.set(call);
    service.phase.set('connecting');
    let resolveCapture!: (stream: MediaStream) => void;
    const capture = spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValue(new Promise<MediaStream>(resolve => resolveCapture = resolve));
    const camera = document.createElement('canvas').captureStream().getVideoTracks()[0];
    const context = new AudioContext();
    const microphone = context.createMediaStreamDestination().stream.getAudioTracks()[0];
    const stream = new MediaStream([microphone, camera]);
    try {
      const answerCapture = (service as any).prepareMedia(true);
      const earlyOfferCapture = (service as any).prepareMedia(true);
      expect(earlyOfferCapture).toBe(answerCapture);
      await (service as any).applyActiveCallUpdate(call);
      resolveCapture(stream);
      await Promise.all([answerCapture, earlyOfferCapture]);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(service.cameraOff()).toBeFalse();
      expect(service.localStream()?.getVideoTracks()).toEqual([camera]);
      expect(camera.readyState).toBe('live');
      expect(service.muted()).toBeFalse();
    } finally { await context.close(); }
  });

  it('preserves camera intent when a group microphone publication temporarily changes local UI state', async () => {
    const call = { ...invitation, type: 'Video', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.cameraOff.set(false);
    const camera = jasmine.createSpy().and.resolveTo();
    const room = { localParticipant: {
      setCameraEnabled: camera,
      setMicrophoneEnabled: jasmine.createSpy().and.callFake(async () => service.cameraOff.set(true)),
    } };
    (service as any).liveKitRoom = room;
    await (service as any).publishLiveKitLocalMedia(room, call, true);
    expect(camera).toHaveBeenCalledWith(true);
    expect(service.cameraOff()).toBeFalse();
    (service as any).liveKitRoom = null;
  });

  it('reconciles local room camera UI with muted and unmuted publications', () => {
    const track = document.createElement('canvas').captureStream().getVideoTracks()[0];
    const publication = { source: 'camera', isMuted: false, track: { mediaStreamTrack: track } };
    (service as any).liveKitRoom = { localParticipant: { trackPublications: new Map([['camera', publication]]) } };
    service.cameraOff.set(true);
    (service as any).syncLiveKitLocalTracks();
    expect(service.cameraOff()).toBeFalse();
    publication.isMuted = true;
    (service as any).syncLiveKitLocalTracks();
    expect(service.cameraOff()).toBeTrue();
    publication.isMuted = false;
    (service as any).syncLiveKitLocalTracks();
    expect(service.cameraOff()).toBeFalse();
    (service as any).liveKitRoom = null;
  });

  it('leaves an initiated group without ending the room or writing a final chat log', async () => {
    const call = { ...invitation, conversationId: 'group', initiatorUserId: 'me', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.phase.set('connected');
    const continuing = { ...call, participantSessions: { peer: { deviceId: 'peer-device', clientSessionId: 'peer-tab' } } };
    api.post.and.returnValue(of(continuing));
    spyOn<any>(service, 'sendCallSignal').and.resolveTo();
    const summary = spyOn<any>(service, 'recordCallSystemOnce').and.resolveTo();
    await service.end();
    expect(api.post).toHaveBeenCalledWith('/calls/incoming/leave', jasmine.any(Object));
    expect(api.post.calls.allArgs().some(args => args[0].endsWith('/end'))).toBeFalse();
    expect(service.activeCall()).toBeNull();
    expect(service.activeGroupRoomForConversation('group')?.call.status).toBe('Active');
    expect(summary).not.toHaveBeenCalled();
  });

  it('only explicitly ends a group for everyone from its initiating session', async () => {
    const call = { ...invitation, conversationId: 'group', initiatorUserId: 'peer', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.phase.set('connected');
    await service.endGroupForEveryone();
    expect(api.post).not.toHaveBeenCalled();
    const ownCall = { ...call, initiatorUserId: 'me' };
    service.activeCall.set(ownCall);
    const ended = { ...ownCall, status: 'Ended', endedAt: new Date().toISOString(), participantSessions: {} };
    api.post.and.returnValue(of(ended));
    spyOn<any>(service, 'recordCallSystemOnce').and.resolveTo();
    await service.endGroupForEveryone();
    expect(api.post).toHaveBeenCalledWith('/calls/incoming/end', jasmine.objectContaining({ reason: 'end-for-all' }));
    expect(service.activeCall()).toBeNull();
    expect(service.activeGroupRoomForConversation('group')).toBeNull();
  });

  it('keeps the local room active if ending it for everyone fails', async () => {
    const call = { ...invitation, conversationId: 'group', initiatorUserId: 'me', isGroupRoom: true, status: 'Active' };
    service.activeCall.set(call);
    service.phase.set('connected');
    api.post.and.returnValue(throwError(() => new Error('Server unavailable')));
    await service.endGroupForEveryone();
    expect(service.activeCall()?.id).toBe(call.id);
    expect(service.phase()).toBe('connected');
    expect(service.error()).toContain('Server unavailable');
  });

  it('does not remove a newer group room when an older ended event arrives late', () => {
    const older = { ...invitation, conversationId: 'group', isGroupRoom: true, startedAt: '2026-10-09T10:00:00Z' };
    const newer = { ...older, id: 'newer', startedAt: '2026-10-09T10:05:00Z' };
    (service as any).rememberGroupRoom(newer);
    (service as any).forgetGroupRoom({ ...older, status: 'Ended' });
    (service as any).rememberGroupRoom(older);
    expect(service.activeGroupRoomForConversation('group')?.call.id).toBe('newer');
  });

  it('discards an active-room lookup after the account or device changes', async () => {
    spyOn<any>(service, 'isGroupConversationId').and.returnValue(true);
    const response = new Subject<CallSession>();
    api.get.and.returnValue(response);
    const lookup = service.refreshActiveGroupRoom('group');
    (service as any).auth.session.set({ user: { id: 'other-account' }, device: { id: 'other-device' } });
    response.next({ ...invitation, conversationId: 'group', isGroupRoom: true });
    response.complete();
    expect(await lookup).toBeNull();
    expect(service.activeGroupRoomForConversation('group')).toBeNull();
  });

  it('does not restore a room from an HTTP snapshot after a newer ended event', async () => {
    spyOn<any>(service, 'isGroupConversationId').and.returnValue(true);
    const call = { ...invitation, conversationId: 'group', isGroupRoom: true };
    (service as any).rememberGroupRoom(call);
    const response = new Subject<CallSession>();
    api.get.and.returnValue(response);
    const lookup = service.refreshActiveGroupRoom('group');
    (service as any).forgetGroupRoom(call);
    response.next(call); response.complete();
    expect(await lookup).toBeNull();
    expect(service.activeGroupRoomForConversation('group')).toBeNull();
  });

  it('invalidates an initial room lookup when its end arrives before it was cached', async () => {
    spyOn<any>(service, 'isGroupConversationId').and.returnValue(true);
    const call = { ...invitation, conversationId: 'group', isGroupRoom: true };
    const response = new Subject<CallSession>();
    api.get.and.returnValue(response);
    const lookup = service.refreshActiveGroupRoom('group');
    (service as any).forgetGroupRoom({ ...call, status: 'Ended' });
    response.next(call); response.complete();
    expect(await lookup).toBeNull();
    expect(service.activeGroupRoomForConversation('group')).toBeNull();
  });

  it('does not claim a group room that ended between displaying and tapping Join', async () => {
    spyOn<any>(service, 'isGroupConversationId').and.returnValue(true);
    api.get.and.returnValue(of(null));
    const call = { ...invitation, conversationId: 'group', isGroupRoom: true };
    await service.joinGroupRoom({ roomId: call.id, groupId: 'group', conversationId: 'group', call, participantUserIds: call.participantUserIds, startedAt: call.startedAt });
    expect(api.post).not.toHaveBeenCalled();
    expect(service.activeCall()).toBeNull();
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
