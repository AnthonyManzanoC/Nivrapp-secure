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
      history: signal([]), start: jasmine.createSpy().and.resolveTo(), inviteToCall: jasmine.createSpy().and.resolveTo(),
      phase: signal('connected'), localStream: signal(null), remoteEntries: signal([]),
      activeScreenShareStreamId: signal(null), cameraOff: signal(false), remoteStates: signal({}),
      screenSharing: signal(false), isGroupCall: jasmine.createSpy().and.returnValue(false),
      mediaUpgradeRequested: signal(false), mediaUpgradeAwaitingPeer: signal(false),
      mediaUpgradeNotice: signal(''), games: { panelOpen: signal(false) },
      error: signal(''), mediaUpgradeInFlight: signal(false), toggleCamera: jasmine.createSpy().and.resolveTo(),
      acceptVideoUpgrade: jasmine.createSpy().and.resolveTo(),
      declineVideoUpgrade: jasmine.createSpy(), clearInactiveCallUi: jasmine.createSpy(),
      canEndGroupForEveryone: jasmine.createSpy().and.returnValue(false),
      speaker: signal(true), muted: signal(false), toggleOutputMute: jasmine.createSpy(),
      audioOutput: {
        refreshRoutes: jasmine.createSpy().and.resolveTo(), selectRoute: jasmine.createSpy().and.resolveTo(true),
        availableRoutes: signal([{ id: 'ear', label: 'Auricular', kind: 'earpiece' }, { id: 'bt', label: 'Bluetooth', kind: 'bluetooth' }]),
        selectedRouteId: signal('ear'),
      },
      end: jasmine.createSpy().and.resolveTo(), endGroupForEveryone: jasmine.createSpy().and.resolveTo(),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: CallsService, useValue: calls },
      { provide: AuthService, useValue: { session: signal({ user: { id: 'me' } }) } },
      { provide: ChatService, useValue: { contacts: signal([]), conversations: signal([]), createDirectConversation: jasmine.createSpy(), participantDisplayName: (id: string) => id, conversationTitle: (conversation: any) => conversation.title } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    page = TestBed.runInInjectionContext(() => new CallsPage());
    TestBed.flushEffects();
  });

  afterEach(() => page.ionViewWillLeave());

  it('does not start a pending contact call after switching accounts', async () => {
    calls.activeCall.set(null); TestBed.flushEffects();
    let finish!: (value: any) => void;
    (TestBed.inject(ChatService).createDirectConversation as jasmine.Spy).and.returnValue(new Promise(resolve => finish = resolve));
    const pending = page.startContactCall({ userId: 'peer' } as any, 'Voice');
    (TestBed.inject(AuthService).session as any).set({ user: { id: 'other' } });
    finish({ id: 'old-account-chat' }); await pending;
    expect(calls.start).not.toHaveBeenCalled();
  });

  it('cancels pending contact starts on leaving the page and allows retry after a creation error', async () => {
    calls.activeCall.set(null); TestBed.flushEffects();
    const create = TestBed.inject(ChatService).createDirectConversation as jasmine.Spy;
    create.and.rejectWith(new Error('offline'));
    await page.startContactCall({ userId: 'peer' } as any, 'Video');
    expect(page.callBusyId).toBe(''); expect(calls.error()).toContain('No se pudo iniciar');
    let finish!: (value: any) => void;
    create.and.returnValue(new Promise(resolve => finish = resolve));
    const pending = page.startContactCall({ userId: 'peer' } as any, 'Voice');
    page.ionViewWillLeave(); finish({ id: 'chat' }); await pending;
    expect(calls.start).not.toHaveBeenCalled();
  });

  it('never reopens a dismissed participant sheet after a failed invitation', async () => {
    let fail!: (error: Error) => void;
    calls.inviteToCall.and.returnValue(new Promise((_resolve, reject) => fail = reject));
    page.openInviteModal();
    const pending = page.inviteToCall({ userId: 'peer2' } as any);
    page.closeInviteModal(); fail(new Error('offline')); await pending;
    expect(page.inviteModalOpen).toBeFalse(); expect(page.callBusyId).toBe('');
  });

  it('never shows rejoin for missed, rejected, ended or failed calls', () => {
    calls.activeCall.set(null);
    for (const status of ['Missed', 'Rejected', 'Ended', 'Failed', 'Ringing']) {
      expect(page.canRejoin({ id: 'past', status } as any)).toBeFalse();
    }
    expect(page.canRejoin({ id: 'ongoing', status: 'Active' } as any)).toBeTrue();
    expect(page.canRejoin({ id: 'ended', status: 'Active', endedAt: '2026-11-02' } as any)).toBeFalse();
  });

  it('filters accent-insensitive local history, orders newest first and renders in bounded pages', () => {
    const chat = TestBed.inject(ChatService);
    (chat.conversations as any).set([{ id: 'chat', title: 'Sofía', participants: [] }]);
    calls.history.set(Array.from({ length: 81 }, (_, i) => ({ id: String(i), conversationId: 'chat', startedAt: new Date(i * 60000).toISOString(), status: i % 2 ? 'Missed' : 'Ended', type: i % 2 ? 'Voice' : 'Video' })));
    page.callQuery = 'sofia';
    expect(page.filteredHistory().length).toBe(81);
    expect(page.visibleHistory().length).toBe(40);
    expect(page.visibleHistory()[0].id).toBe('80');
    page.showMoreHistory(); expect(page.visibleHistory().length).toBe(80);
    page.setHistoryFilter('missed'); expect(page.filteredHistory().length).toBe(40);
    expect(page.filteredHistory().every(call => call.status === 'Missed')).toBeTrue();
    page.setHistoryFilter('video'); expect(page.filteredHistory().length).toBe(41);
    page.callQuery = 'no-match'; expect(page.visibleHistory()).toEqual([]);
  });

  it('reuses the sorted agenda until contacts change rather than sorting on every playback update', () => {
    const chat = TestBed.inject(ChatService);
    (chat.contacts as any).set([{ userId: 'peer', displayName: 'Sofía' }]);
    const build = spyOn<any>(page, 'buildAgendaContacts').and.callThrough();
    page.filteredCallContacts(); page.filteredCallContacts();
    calls.remoteEntries.set([]); page.filteredCallContacts();
    expect(build).toHaveBeenCalledTimes(1);
    (chat.contacts as any).set([{ userId: 'next', displayName: 'Ana' }]);
    expect(page.filteredCallContacts()[0].userId).toBe('next');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('keeps voice controls and keyboard-focused video controls visible', fakeAsync(() => {
    calls.activeCall.set({ id: 'call', type: 'Voice' });
    page.revealCallChrome(); tick(6000); expect(page.controlsVisible).toBeTrue();
    calls.activeCall.set({ id: 'call', type: 'Video' });
    page.onControlsFocus(true); tick(6000); expect(page.controlsVisible).toBeTrue();
    page.onControlsFocus(false); tick(5000); expect(page.controlsVisible).toBeFalse();
    page.revealCallChrome(); expect(page.controlsVisible).toBeTrue();
    page.ionViewWillLeave(); tick(6000); expect(page.controlsVisible).toBeTrue();
  }));

  it('rechecks pending controls hide when games or camera consent opens', fakeAsync(() => {
    page.revealCallChrome(); calls.games.panelOpen.set(true); tick(6000);
    expect(page.controlsVisible).toBeTrue();
    calls.games.panelOpen.set(false); page.revealCallChrome(); calls.mediaUpgradeRequested.set(true); tick(6000);
    expect(page.controlsVisible).toBeTrue();
  }));

  it('opens a route choice without muting playback or microphone and refreshes real devices', async () => {
    await page.openAudioRoutes();
    expect(page.audioRoutesOpen).toBeTrue();
    expect(calls.audioOutput.refreshRoutes).toHaveBeenCalledOnceWith();
    expect(calls.toggleOutputMute).not.toHaveBeenCalled();
    expect(calls.muted()).toBeFalse();
    expect(page.audioRouteIcon()).toBe('call-outline');
    await page.selectAudioRoute('bt');
    expect(calls.audioOutput.selectRoute).toHaveBeenCalledOnceWith('bt');
    expect(calls.speaker()).toBeTrue();
  });

  it('closes the route choice and refuses an old selection after the call changes', async () => {
    await page.openAudioRoutes();
    calls.activeCall.set({ id: 'new-call', type: 'Voice' });
    TestBed.flushEffects();
    expect(page.audioRoutesOpen).toBeFalse();
    await page.selectAudioRoute('bt');
    expect(calls.audioOutput.selectRoute).not.toHaveBeenCalled();
  });

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
