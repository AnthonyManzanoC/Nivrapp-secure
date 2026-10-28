import { ChatDetailPage } from './chat-detail.page';

describe('Chat voice recording lifecycle', () => {
  let page: ChatDetailPage;
  let internal: any;
  let getUserMedia: jasmine.Spy;
  let sendFile: jasmine.Spy;
  let now: number;
  let scope: { user: { id: string }; device: { id: string } };
  let originalRecorder: typeof MediaRecorder;
  const stream = () => {
    const stop = jasmine.createSpy('stop track');
    return { value: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
  };
  class Recorder {
    static bytes = 512;
    static instances: Recorder[] = [];
    static isTypeSupported(): boolean { return true; }
    state: RecordingState = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { Recorder.instances.push(this); }
    start(): void { this.state = 'recording'; }
    stop(): void {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array(Recorder.bytes)], { type: this.mimeType }) });
      this.onstop?.();
    }
    pause(): void { this.state = 'paused'; }
    resume(): void { this.state = 'recording'; }
  }

  beforeEach(() => {
    originalRecorder = window.MediaRecorder;
    window.MediaRecorder = Recorder as unknown as typeof MediaRecorder;
    Recorder.bytes = 512;
    Recorder.instances = [];
    now = 10000;
    spyOn(Date, 'now').and.callFake(() => now);
    spyOn(window, 'requestAnimationFrame').and.returnValue(1);
    getUserMedia = spyOn(navigator.mediaDevices, 'getUserMedia');
    sendFile = jasmine.createSpy('sendFile').and.resolveTo({ id: 'voice' });
    scope = { user: { id: 'me' }, device: { id: 'phone' } };
    page = Object.create(ChatDetailPage.prototype);
    internal = page;
    Object.assign(page, {
      auth: { session: () => scope }, chat: { sendFile, uploading: () => false },
      privateChats: { relock: jasmine.createSpy('relock') },
      conversation: () => ({ id: 'chat' }), canSendMessages: () => true, isBlocked: () => false,
      appSettings: { settings: () => ({ pauseMediaOnRecord: false }) },
      nativeDevice: { setAudioFocus: jasmine.createSpy('focus').and.resolveTo() },
      cdr: { detectChanges: jasmine.createSpy('detectChanges') },
      currentPolicy: () => ({ ttlSeconds: null }), scrollBottom: jasmine.createSpy('scrollBottom'),
      destroyed: false, composerGeneration: 0, sending: false, attachmentError: '', notice: '',
      voiceGeneration: 0, voiceContext: null, voiceRecorder: null, voiceStream: null, voiceChunks: [],
      voiceStarting: false, voiceMode: 'idle', recordingVoice: false, voiceTimer: null, voiceStartPromise: null,
      voiceStopPromise: null, voiceStartedAt: 0, voicePausedDurationMs: 0, voicePauseStartedAt: 0,
      voicePaused: false, voiceElapsedSeconds: 0, voiceSlideX: 0,
      pendingAttachmentFiles: [], pendingAttachmentDraftSeed: '', groupRoomRefreshTimer: null,
      tr: (_key: string, fallback: string) => fallback,
    });
  });

  afterEach(async () => {
    await page.cancelVoiceNote();
    window.MediaRecorder = originalRecorder;
  });

  it('discards a released gesture without waiting for a pending permission dialog', async () => {
    let grant!: (value: MediaStream) => void;
    getUserMedia.and.returnValue(new Promise(resolve => grant = resolve));
    internal.beginVoiceHold();
    const pending = internal.voiceStartPromise;
    expect(page.voiceStarting).toBeTrue();
    await internal.finishVoiceHold();
    expect(page.voiceMode).toBe('idle');
    const microphone = stream();
    grant(microphone.value);
    await pending;
    expect(microphone.stop).toHaveBeenCalled();
    expect(Recorder.instances.length).toBe(0);
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('sends one valid recording after a real hold and releases the microphone', async () => {
    const microphone = stream();
    getUserMedia.and.resolveTo(microphone.value);
    internal.beginVoiceHold();
    await internal.voiceStartPromise;
    now += 1500;
    await internal.finishVoiceHold();
    expect(sendFile).toHaveBeenCalledOnceWith(jasmine.objectContaining({ id: 'chat' }), jasmine.any(File), jasmine.objectContaining({ voiceNote: true, mode: 'document' }));
    expect(microphone.stop).toHaveBeenCalled();
    expect(page.voiceMode).toBe('idle');
    expect(page.sending).toBeFalse();
  });

  for (const invalid of ['short', 'tiny', 'empty'] as const) {
    it(`discards ${invalid} recordings instead of sending audio0`, async () => {
      getUserMedia.and.resolveTo(stream().value);
      internal.beginVoiceHold();
      await internal.voiceStartPromise;
      now += invalid === 'short' ? 100 : 1600;
      Recorder.bytes = invalid === 'tiny' ? 4 : invalid === 'empty' ? 0 : 512;
      await internal.finishVoiceHold();
      expect(sendFile).not.toHaveBeenCalled();
      expect(page.recordingVoice).toBeFalse();
      expect(page.sending).toBeFalse();
    });
  }

  it('does not let an old permission response stop a newer recording', async () => {
    let grantOld!: (value: MediaStream) => void;
    getUserMedia.and.returnValue(new Promise(resolve => grantOld = resolve));
    internal.beginVoiceHold();
    const oldPending = internal.voiceStartPromise;
    await internal.finishVoiceHold();
    const fresh = stream();
    getUserMedia.and.resolveTo(fresh.value);
    internal.beginVoiceHold();
    await internal.voiceStartPromise;
    const old = stream();
    grantOld(old.value);
    await oldPending;
    expect(old.stop).toHaveBeenCalled();
    expect(fresh.stop).not.toHaveBeenCalled();
    expect(page.recordingVoice).toBeTrue();
    now += 1200;
    await internal.finishVoiceHold();
    expect(sendFile).toHaveBeenCalledTimes(1);
  });

  it('does not lock or send while permission is still pending', async () => {
    let grant!: (value: MediaStream) => void;
    getUserMedia.and.returnValue(new Promise(resolve => grant = resolve));
    internal.beginVoiceHold();
    const pending = internal.voiceStartPromise;
    internal.handleVoiceMove(0, -100);
    expect(page.voiceMode).toBe('holding');
    await page.sendLockedVoiceNote();
    expect(sendFile).not.toHaveBeenCalled();
    await internal.finishVoiceHold();
    grant(stream().value);
    await pending;
    expect(page.recordingVoice).toBeFalse();
  });

  it('releases a late microphone grant after leaving the view', async () => {
    let grant!: (value: MediaStream) => void;
    getUserMedia.and.returnValue(new Promise(resolve => grant = resolve));
    internal.beginVoiceHold();
    const pending = internal.voiceStartPromise;
    page.ionViewWillLeave();
    const microphone = stream();
    grant(microphone.value);
    await pending;
    expect(microphone.stop).toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
    expect(page.privateChats.relock).toHaveBeenCalledTimes(1);
  });

  it('does not record into a different account after permission resolves', async () => {
    let grant!: (value: MediaStream) => void;
    getUserMedia.and.returnValue(new Promise(resolve => grant = resolve));
    internal.beginVoiceHold();
    const pending = internal.voiceStartPromise;
    scope = { user: { id: 'other' }, device: { id: 'other' } };
    const microphone = stream();
    grant(microphone.value);
    await pending;
    expect(microphone.stop).toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('prevents double send while a locked recording stops', async () => {
    getUserMedia.and.resolveTo(stream().value);
    internal.beginVoiceHold();
    await internal.voiceStartPromise;
    internal.handleVoiceMove(0, -100);
    now += 1600;
    await Promise.all([page.sendLockedVoiceNote(), page.sendLockedVoiceNote()]);
    expect(sendFile).toHaveBeenCalledTimes(1);
  });

  it('excludes paused time from minimum duration validation', async () => {
    getUserMedia.and.resolveTo(stream().value);
    internal.beginVoiceHold();
    await internal.voiceStartPromise;
    internal.handleVoiceMove(0, -100);
    now += 100;
    page.toggleVoicePause();
    now += 10000;
    await page.sendLockedVoiceNote();
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('does not send if the conversation changes while MediaRecorder is stopping', async () => {
    getUserMedia.and.resolveTo(stream().value);
    internal.beginVoiceHold();
    await internal.voiceStartPromise;
    const recorder = Recorder.instances[0];
    spyOn(recorder, 'stop').and.callFake(() => undefined);
    now += 1200;
    const pending = internal.finishVoiceHold();
    ++internal.composerGeneration;
    recorder.ondataavailable?.({ data: new Blob([new Uint8Array(512)]) });
    recorder.onstop?.();
    await pending;
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('releases late native audio focus without requesting a microphone after cancellation', async () => {
    let grantFocus!: () => void;
    const focus = jasmine.createSpy('focus').and.callFake((active: boolean) => active ? new Promise<void>(resolve => grantFocus = resolve) : Promise.resolve());
    Object.assign(page, { appSettings: { settings: () => ({ pauseMediaOnRecord: true }) }, nativeDevice: { setAudioFocus: focus } });
    internal.beginVoiceHold();
    const pending = internal.voiceStartPromise;
    await internal.finishVoiceHold();
    grantFocus();
    await pending;
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(focus.calls.mostRecent().args).toEqual([false, 'record']);
  });

  it('discards a live recording when the app loses focus', async () => {
    const microphone = stream();
    getUserMedia.and.resolveTo(microphone.value);
    internal.beginVoiceHold();
    await internal.voiceStartPromise;
    now += 1500;
    page.cancelVoiceOnBlur();
    await Promise.resolve();
    expect(microphone.stop).toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
  });
});
