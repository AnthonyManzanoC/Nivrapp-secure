import { signal } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { CallsPage } from './calls.page';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { ChatService } from '../../core/services/chat.service';
import { TranslateService } from '../../core/services/translate.service';
import { CALL_CAMERA_FAILURE_MESSAGES } from '../../core/services/call-media-capture';

describe('call video presentation', () => {
  let page: CallsPage;
  let calls: any;

  const fakeTrack = (muted: boolean) => Object.assign(new EventTarget(), {
    kind: 'video', readyState: 'live', enabled: true, muted,
  });
  const fakeStream = (tracks: EventTarget[]) => Object.assign(new EventTarget(), {
    getVideoTracks: () => tracks,
  }) as unknown as MediaStream;

  beforeEach(() => {
    calls = {
      activeCall: signal({ id: 'call', type: 'Video', initiatorUserId: 'me', participantUserIds: ['peer'] }),
      phase: signal('connected'), localStream: signal(null), remoteEntries: signal([]),
      activeScreenShareStreamId: signal(null), cameraOff: signal(false), remoteStates: signal({}),
      screenSharing: signal(false), isGroupCall: jasmine.createSpy().and.returnValue(false),
      mediaUpgradeRequested: signal(false), mediaUpgradeAwaitingPeer: signal(false),
      mediaUpgradeNotice: signal(''), games: { panelOpen: signal(false) },
      error: signal(''), mediaUpgradeInFlight: signal(false), toggleCamera: jasmine.createSpy().and.resolveTo(),
      acceptVideoUpgrade: jasmine.createSpy().and.resolveTo(),
      declineVideoUpgrade: jasmine.createSpy(), clearInactiveCallUi: jasmine.createSpy(),
      canEndGroupForEveryone: jasmine.createSpy().and.returnValue(false),
      end: jasmine.createSpy().and.resolveTo(), endGroupForEveryone: jasmine.createSpy().and.resolveTo(),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: CallsService, useValue: calls },
      { provide: AuthService, useValue: { session: signal({ user: { id: 'me' } }) } },
      { provide: ChatService, useValue: { contacts: signal([]), conversations: signal([]) } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    page = TestBed.runInInjectionContext(() => new CallsPage());
    TestBed.flushEffects();
  });

  afterEach(() => page.ionViewWillLeave());

  it('keeps the peer placeholder visible while own camera is already streaming', () => {
    const local = fakeStream([fakeTrack(false)]);
    calls.localStream.set(local);
    expect(page.mainVideoStream()).toBeNull();
    expect(page.mainVideoParticipantId()).toBe('peer');
    expect(page.pipVideoStream()).toBe(local);
    expect(page.pipVideoParticipantId()).toBe('me');
  });

  it('gives the room initiator distinct leave and end-for-everyone actions', async () => {
    calls.isGroupCall.and.returnValue(true);
    calls.canEndGroupForEveryone.and.returnValue(true);
    await page.endActive();
    expect(page.exitModalOpen).toBeTrue();
    expect(calls.end).not.toHaveBeenCalled();
    expect(calls.endGroupForEveryone).not.toHaveBeenCalled();
    await page.leaveActive();
    expect(calls.end).toHaveBeenCalledWith('call');
    expect(calls.endGroupForEveryone).not.toHaveBeenCalled();
    expect(page.exitModalOpen).toBeFalse();
  });

  it('ends a room for everyone only after choosing that explicit action', async () => {
    calls.isGroupCall.and.returnValue(true);
    calls.canEndGroupForEveryone.and.returnValue(true);
    await page.endActive();
    await page.endForEveryone();
    expect(calls.endGroupForEveryone).toHaveBeenCalledTimes(1);
    expect(calls.end).not.toHaveBeenCalled();
  });

  it('closes the exit choice when the call changes and does not terminate the next room', async () => {
    calls.isGroupCall.and.returnValue(true);
    calls.canEndGroupForEveryone.and.returnValue(true);
    await page.endActive();
    calls.activeCall.set({ id: 'next-call', type: 'Voice' });
    TestBed.flushEffects();
    expect(page.exitModalOpen).toBeFalse();
    await page.endForEveryone();
    expect(calls.endGroupForEveryone).not.toHaveBeenCalled();
  });

  it('refreshes a reused remote stream when its video track starts receiving', () => {
    const track = fakeTrack(true);
    const stream = fakeStream([track]);
    calls.remoteEntries.set([['peer', stream]]);
    TestBed.flushEffects();
    const revision = (page as any).videoTrackRevision();
    expect(page.hasVideoTrack(stream)).toBeFalse();
    track.muted = false;
    track.dispatchEvent(new Event('unmute'));
    expect((page as any).videoTrackRevision()).toBeGreaterThan(revision);
    expect(page.hasVideoTrack(stream)).toBeTrue();
    expect(page.mainVideoStream()).toBe(stream);
    track.readyState = 'ended';
    track.dispatchEvent(new Event('ended'));
    expect(page.hasVideoTrack(stream)).toBeFalse();
  });

  it('removes old track listeners after the remote stream is replaced', () => {
    const track = fakeTrack(true);
    calls.remoteEntries.set([['peer', fakeStream([track])]]);
    TestBed.flushEffects();
    calls.remoteEntries.set([]);
    TestBed.flushEffects();
    const revision = (page as any).videoTrackRevision();
    track.dispatchEvent(new Event('unmute'));
    expect((page as any).videoTrackRevision()).toBe(revision);
  });

  it('shows camera-off feedback even when the receiver still has a live track', () => {
    const stream = fakeStream([fakeTrack(false)]);
    calls.remoteStates.set({ peer: { camera: 'off' } });
    expect(page.videoParticipantHasVideo(stream, 'peer')).toBeFalse();
    expect(page.videoFallbackStatus('peer')).toBe('Su cámara está apagada');
    expect(page.videoParticipantHasVideo(stream, 'peer:screen')).toBeTrue();
    calls.cameraOff.set(true);
    expect(page.videoParticipantHasVideo(stream, 'me')).toBeFalse();
    expect(page.videoParticipantHasVideo(stream, 'me:screen')).toBeTrue();
  });

  it('keeps direct screen sharing visible when the camera is off', () => {
    const stream = fakeStream([fakeTrack(false)]);
    calls.cameraOff.set(true);
    calls.screenSharing.set(true);
    calls.remoteStates.set({ peer: { camera: 'off', screen: 'on' } });
    expect(page.videoParticipantHasVideo(stream, 'me')).toBeTrue();
    expect(page.videoParticipantHasVideo(stream, 'peer')).toBeTrue();
    expect(page.videoFallbackStatus('peer')).toBe('Conectando la pantalla compartida…');
    calls.screenSharing.set(false);
    calls.remoteStates.set({ peer: { camera: 'off', screen: 'off' } });
    expect(page.videoParticipantHasVideo(stream, 'me')).toBeFalse();
    expect(page.videoParticipantHasVideo(stream, 'peer')).toBeFalse();
  });

  it('keeps group camera and screen tiles independent', () => {
    const stream = fakeStream([fakeTrack(false)]);
    calls.isGroupCall.and.returnValue(true);
    calls.remoteStates.set({ peer: { camera: 'off', screen: 'on' } });
    expect(page.videoParticipantHasVideo(stream, 'peer')).toBeFalse();
    expect(page.videoParticipantHasVideo(stream, 'peer:screen')).toBeTrue();
  });

  it('allows connected group participants to reactivate media without a published stream', () => {
    calls.isGroupCall.and.returnValue(true);
    expect(page.canControlLocalMedia()).toBeTrue();
    calls.phase.set('connecting');
    expect(page.canControlLocalMedia()).toBeFalse();
    calls.phase.set('connected');
    calls.isGroupCall.and.returnValue(false);
    expect(page.canControlLocalMedia()).toBeFalse();
  });

  it('shows a camera retry only for recoverable camera feedback in an active video call', async () => {
    calls.cameraOff.set(true);
    calls.error.set(CALL_CAMERA_FAILURE_MESSAGES.unavailable.fallback);
    expect(page.canRetryCamera()).toBeTrue();
    await page.retryCamera();
    expect(calls.toggleCamera).toHaveBeenCalledTimes(1);
    calls.mediaUpgradeRequested.set(true);
    expect(page.canRetryCamera()).toBeFalse(); // The existing consent prompt provides its own action.
    calls.mediaUpgradeRequested.set(false);
    calls.error.set('La conexión de la sala se perdió.');
    expect(page.canRetryCamera()).toBeFalse();
  });

  it('localizes camera diagnostics without replacing unrelated connection errors', () => {
    const translation = spyOn(TestBed.inject(TranslateService), 'instant').and.returnValue('Camera access was denied. Audio continues.');
    calls.error.set(CALL_CAMERA_FAILURE_MESSAGES.permission.fallback);
    expect(page.callErrorText()).toBe('Camera access was denied. Audio continues.');
    expect(translation).toHaveBeenCalledWith('CALLS.CAMERA_PERMISSION_ERROR', CALL_CAMERA_FAILURE_MESSAGES.permission.fallback);
    calls.error.set('La conexión de la sala se perdió.');
    expect(page.callErrorText()).toBe('La conexión de la sala se perdió.');
  });

  it('keeps call controls visible through connection and camera consent', fakeAsync(() => {
    calls.phase.set('connecting');
    page.revealCallChrome();
    tick(6000);
    expect(page.controlsVisible).toBeTrue();
    calls.phase.set('connected');
    calls.mediaUpgradeRequested.set(true);
    page.revealCallChrome();
    tick(6000);
    expect(page.controlsVisible).toBeTrue();
    page.declineVideoUpgrade();
    expect(calls.declineVideoUpgrade).toHaveBeenCalledTimes(1);
  }));
});
