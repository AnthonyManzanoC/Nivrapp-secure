import { ElementRef, SimpleChange, signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { StoryComposerComponent } from './story-composer.component';

describe('Story composer draft, privacy and capture lifecycle', () => {
  let composer: StoryComposerComponent;
  let social: any;
  let auth: any;
  let chat: any;
  const track = () => ({ stop: jasmine.createSpy('stop') });
  const streamWith = (...tracks: any[]) => ({ getTracks: () => tracks, getAudioTracks: () => [], addTrack: jasmine.createSpy('addTrack'), removeTrack: jasmine.createSpy('removeTrack') } as unknown as MediaStream);

  beforeEach(() => {
    social = {
      publishing: signal(false), publishingStatus: signal(''), storyDeliveryWarning: signal(''),
      publishStory: jasmine.createSpy('publishStory').and.resolveTo(),
    };
    auth = { session: signal({ user: { id: 'me', alias: 'maria', allowStoryReposts: false }, device: { id: 'phone' } }) };
    chat = {
      conversations: signal([]), isGroup: (item: any) => item.type === 'Group',
      conversationTitle: (item: any) => item.title || 'Grupo',
    };
    TestBed.configureTestingModule({ providers: [
      { provide: SocialService, useValue: social },
      { provide: AuthService, useValue: auth },
      { provide: ChatService, useValue: chat },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    composer = TestBed.runInInjectionContext(() => new StoryComposerComponent());
    composer.isOpen = true;
    composer.ngOnChanges({ isOpen: new SimpleChange(false, true, true) });
  });

  afterEach(() => composer.ngOnDestroy());

  it('opens without requesting camera access or publishing and respects the profile repost default', () => {
    expect(composer.mode).toBe('choose');
    expect(composer.cameraStream).toBeNull();
    expect(composer.allowReposts).toBeFalse();
    expect(social.publishStory).not.toHaveBeenCalled();
  });

  const musicBuffer = () => ({ duration: 40, sampleRate: 22050, numberOfChannels: 2, length: 40 * 22050,
    getChannelData: () => new Float32Array(40 * 22050) } as unknown as AudioBuffer);

  function prepareMusicDecoder() {
    spyOn<any>(composer, 'probeMusic').and.resolveTo();
    const context = { decodeAudioData: jasmine.createSpy('decodeAudioData').and.resolveTo(musicBuffer()), close: jasmine.createSpy('close').and.resolveTo() };
    const constructor = spyOn(window, 'AudioContext').and.returnValue(context as unknown as AudioContext);
    return { context, constructor };
  }

  it('selects a bounded local soundtrack without publishing, decodes at 22.05 kHz and uploads only the selected fifteen seconds', async () => {
    composer.selectFile(new File(['image'], 'photo.jpg', { type: 'image/jpeg' })); composer.imageLoading = false;
    const decoder = prepareMusicDecoder();
    await composer.selectMusic(new File(['source-song'], 'Mi canción.mp3', { type: 'audio/mpeg' }));
    expect(decoder.constructor).toHaveBeenCalledOnceWith({ sampleRate: 22050 });
    expect(composer.musicTitle).toBe('Mi canción'); expect(composer.musicTotal).toBe(40);
    expect(social.publishStory).not.toHaveBeenCalled();
    composer.updateMusicWindow(20, 15);
    await composer.publish();
    const published = social.publishStory.calls.mostRecent().args[0].music;
    expect(published.sourceStartSeconds).toBe(20); expect(published.durationSeconds).toBe(15);
    expect(published.file.type).toBe('audio/wav'); expect(published.file.size).toBe(661544);
    expect(decoder.context.close).toHaveBeenCalled();
  });

  it('rejects oversized and overlong sources without clearing the photo or decoding them', async () => {
    const photo = new File(['image'], 'photo.jpg', { type: 'image/jpeg' }); composer.selectFile(photo);
    const probe = spyOn<any>(composer, 'probeMusic').and.rejectWith(new Error('Elige un audio mono o estéreo de hasta 5 minutos.'));
    const context = spyOn(window, 'AudioContext');
    const huge = new File(['source'], 'huge.mp3', { type: 'audio/mpeg' }); spyOnProperty(huge, 'size', 'get').and.returnValue(12 * 1024 * 1024 + 1);
    await composer.selectMusic(huge); expect(probe).not.toHaveBeenCalled();
    await composer.selectMusic(new File(['long'], 'long.mp3', { type: 'audio/mpeg' }));
    expect(context).not.toHaveBeenCalled(); expect(composer.file).toBe(photo);
    expect(composer.musicLoading).toBeFalse(); expect(composer.musicError).toContain('5 minutos');
  });

  it('rejects multichannel decoded sources and releases the bounded decoder', async () => {
    composer.selectFile(new File(['image'], 'photo.jpg', { type: 'image/jpeg' }));
    const decoder = prepareMusicDecoder();
    decoder.context.decodeAudioData.and.resolveTo({ ...musicBuffer(), numberOfChannels: 6 });
    await composer.selectMusic(new File(['surround'], 'surround.mp3', { type: 'audio/mpeg' }));
    expect(composer.musicUrl).toBe(''); expect(composer.musicError).toContain('mono o estéreo');
    expect(decoder.context.close).toHaveBeenCalled();
  });

  it('closes a previous decoder before starting a replacement song', async () => {
    composer.selectFile(new File(['image'], 'photo.jpg', { type: 'image/jpeg' }));
    const decoder = prepareMusicDecoder(); let finishClose!: () => void;
    const previous = { close: jasmine.createSpy('previous.close').and.returnValue(new Promise<void>(done => finishClose = done)) };
    (composer as any).musicContext = previous;
    const selecting = composer.selectMusic(new File(['new-song'], 'new.mp3', { type: 'audio/mpeg' }));
    expect(previous.close).toHaveBeenCalledTimes(1); expect(decoder.constructor).not.toHaveBeenCalled();
    finishClose(); await selecting; expect(decoder.constructor).toHaveBeenCalledTimes(1);
  });

  it('keeps a late decode from attaching music to a closed or replaced draft', async () => {
    composer.selectFile(new File(['image'], 'photo.jpg', { type: 'image/jpeg' }));
    const decoder = prepareMusicDecoder();
    let resolve!: (buffer: AudioBuffer) => void;
    let started!: () => void;
    const decoding = new Promise<void>(done => started = done);
    decoder.context.decodeAudioData.and.callFake(() => new Promise<AudioBuffer>(done => { resolve = done; started(); }));
    const selected = composer.selectMusic(new File(['song'], 'song.mp3', { type: 'audio/mpeg' }));
    await decoding;
    composer.discardAndClose(); resolve(musicBuffer()); await selected;
    expect(composer.musicUrl).toBe(''); expect(composer.musicLoading).toBeFalse(); expect(composer.file).toBeNull();
  });

  it('pauses the actual preview on visibility loss, mutes it on demand and revokes the music URL on removal', async () => {
    composer.selectFile(new File(['image'], 'photo.jpg', { type: 'image/jpeg' })); prepareMusicDecoder();
    await composer.selectMusic(new File(['song'], 'song.mp3', { type: 'audio/mpeg' }));
    const audio = document.createElement('audio'); spyOn(audio, 'play').and.resolveTo(); const pause = spyOn(audio, 'pause');
    (composer as any).draftMusic = new ElementRef(audio);
    await composer.toggleMusicPreview(); expect(composer.musicPlaying).toBeTrue();
    composer.toggleMusicMute(); expect(audio.muted).toBeTrue();
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    expect(pause).toHaveBeenCalled(); expect(composer.musicPlaying).toBeFalse();
    const url = composer.musicUrl; const revoke = spyOn(URL, 'revokeObjectURL'); composer.removeMusic();
    expect(revoke).toHaveBeenCalledWith(url); expect(composer.file).not.toBeNull();
  });

  it('waits for the media clock through buffering instead of cutting the preview at its wall-clock duration', fakeAsync(() => {
    composer.selectFile(new File(['image'], 'photo.jpg', { type: 'image/jpeg' }));
    (composer as any).musicBuffer = musicBuffer(); composer.musicTotal = 40; composer.musicStart = 3; composer.musicLength = 5;
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'currentTime', { value: 3, writable: true });
    spyOn(audio, 'play').and.resolveTo(); const pause = spyOn(audio, 'pause');
    (composer as any).draftMusic = new ElementRef(audio);
    void composer.toggleMusicPreview(); flushMicrotasks();
    audio.currentTime = 6.75; tick(5000);
    expect(composer.musicPlaying).toBeTrue(); expect(pause).not.toHaveBeenCalled();
    audio.currentTime = 8; tick(250);
    expect(composer.musicPlaying).toBeFalse(); expect(pause).toHaveBeenCalledTimes(1);
  }));

  it('closes and clears the private draft when the active account changes', () => {
    composer.selectFile(new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));
    const closed = spyOn(composer.closed, 'emit');
    auth.session.set({ user: { id: 'another' }, device: { id: 'another-device' } }); TestBed.flushEffects();
    expect(composer.file).toBeNull(); expect(composer.musicUrl).toBe(''); expect(closed).toHaveBeenCalledTimes(1);
  });

  it('previews a chosen file without publishing and keeps captions when replacing media', () => {
    const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
    const preview = spyOn(URL, 'createObjectURL').and.returnValues('blob:first', 'blob:second');
    const revoke = spyOn(URL, 'revokeObjectURL');
    composer.text = 'Un momento';
    expect(composer.selectFile(file)).toBeTrue();
    expect(composer.mode).toBe('edit');
    expect(composer.previewUrl).toBe('blob:first');
    expect(social.publishStory).not.toHaveBeenCalled();
    composer.selectFile(new File(['audio'], 'song.ogg', { type: 'audio/ogg' }));
    expect(composer.mediaKind).toBe('audio');
    expect(composer.text).toBe('Un momento');
    expect(preview).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:first');
  });

  it('rejects unsupported, empty and oversized media without clearing the valid draft', () => {
    const file = new File(['audio'], 'audio.ogg', { type: 'audio/ogg' });
    composer.selectFile(file);
    expect(composer.selectFile(new File(['no'], 'doc.txt', { type: 'text/plain' }))).toBeFalse();
    expect(composer.selectFile(new File([], 'empty.jpg', { type: 'image/jpeg' }))).toBeFalse();
    const huge = new File(['image'], 'large.jpg', { type: 'image/jpeg' });
    spyOnProperty(huge, 'size', 'get').and.returnValue(256 * 1024 * 1024 + 1);
    expect(composer.selectFile(huge)).toBeFalse();
    expect(composer.file).toBe(file);
    expect(social.publishStory).not.toHaveBeenCalled();
  });

  it('asks to discard an unpublished draft and releases URLs and tracks on confirmation', () => {
    const stop = track();
    const revoke = spyOn(URL, 'revokeObjectURL');
    composer.selectFile(new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));
    const url = composer.previewUrl;
    composer.cameraStream = streamWith(stop);
    const close = spyOn(composer.closed, 'emit');
    composer.requestClose();
    expect(composer.confirmingDiscard).toBeTrue();
    expect(close).not.toHaveBeenCalled();
    composer.discardAndClose();
    expect(stop.stop).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(url);
    expect(composer.file).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    composer.onDismissed();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops a camera permission result arriving after the modal closes', async () => {
    let resolve!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((done) => resolve = done);
    const getMedia = spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValue(permission);
    const open = composer.openCamera();
    const capturedTrack = track();
    composer.requestClose();
    resolve(streamWith(capturedTrack));
    await open;
    expect(getMedia).toHaveBeenCalledOnceWith(jasmine.objectContaining({ audio: false }));
    expect(capturedTrack.stop).toHaveBeenCalledTimes(1);
    expect(composer.cameraStream).toBeNull();
  });

  it('stops the previous camera before switching facing direction and does not request a microphone', async () => {
    const firstTrack = track();
    const secondTrack = track();
    const getMedia = spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValues(
      Promise.resolve(streamWith(firstTrack)), Promise.resolve(streamWith(secondTrack)),
    );
    await composer.openCamera();
    await composer.switchCamera();
    expect(firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(composer.facing).toBe('user');
    expect(getMedia.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ audio: false, video: jasmine.objectContaining({ facingMode: { ideal: 'user' } }) }));
    composer.leaveCamera();
    expect(secondTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('shows an actionable permission message and keeps the app usable', async () => {
    spyOn(navigator.mediaDevices, 'getUserMedia').and.rejectWith(new DOMException('denied', 'NotAllowedError'));
    await composer.openCamera();
    expect(composer.error).toContain('Permite el acceso');
    expect(composer.cameraBusy).toBeFalse();
    composer.leaveCamera();
    composer.chooseText();
    expect(composer.mode).toBe('edit');
  });

  it('stops a microphone permission result after leaving the camera without starting recording', async () => {
    if (!composer.recordingSupported) return;
    let resolve!: (stream: MediaStream) => void;
    const cameraTrack = track();
    const audioTrack = track();
    const cameraStream = streamWith(cameraTrack);
    composer.cameraStream = cameraStream;
    composer.mode = 'camera';
    const microphone = new Promise<MediaStream>((done) => resolve = done);
    spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValue(microphone);
    const start = composer.startRecording();
    composer.leaveCamera();
    resolve({ getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] } as unknown as MediaStream);
    await start;
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(cameraTrack.stop).toHaveBeenCalledTimes(1);
    expect(cameraStream.addTrack).not.toHaveBeenCalled();
    expect(composer.recording).toBeFalse();
  });

  it('finishes a recording at 60 seconds into an unpublished video preview and releases capture', fakeAsync(() => {
    if (!composer.recordingSupported) return;
    const cameraTrack = track();
    const audioTrack = track();
    const captureTracks = [cameraTrack];
    composer.cameraStream = {
      getTracks: () => captureTracks,
      getAudioTracks: () => captureTracks.filter((item) => item === audioTrack),
      addTrack: (item: any) => captureTracks.push(item),
      removeTrack: () => undefined,
    } as unknown as MediaStream;
    composer.mode = 'camera';
    spyOn(navigator.mediaDevices, 'getUserMedia').and.resolveTo({ getAudioTracks: () => [audioTrack], getTracks: () => [audioTrack] } as unknown as MediaStream);
    const recorder: any = { state: 'inactive', mimeType: 'video/webm', ondataavailable: null, onstop: null, onerror: null };
    recorder.start = jasmine.createSpy('start').and.callFake(() => recorder.state = 'recording');
    recorder.stop = jasmine.createSpy('stop').and.callFake(() => {
      recorder.state = 'inactive';
      recorder.ondataavailable?.({ data: new Blob(['video'], { type: 'video/webm' }) });
      recorder.onstop?.();
    });
    spyOn(window, 'MediaRecorder').and.returnValue(recorder as MediaRecorder);
    (window.MediaRecorder as any).isTypeSupported = () => true;
    void composer.startRecording();
    flushMicrotasks();
    expect(composer.recording).toBeTrue();
    tick(60_000);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(composer.mode).toBe('edit');
    expect(composer.mediaKind).toBe('video');
    expect(composer.recording).toBeFalse();
    expect(cameraTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
    expect(social.publishStory).not.toHaveBeenCalled();
  }));

  it('publishes only on explicit action and preserves contact visibility and lifetime options', async () => {
    composer.chooseText();
    composer.text = '  Mi historia  ';
    composer.visibility = 'MutualContacts';
    composer.durationSeconds = 3600;
    composer.viewOnce = true;
    const published = spyOn(composer.published, 'emit');
    await composer.publish();
    expect(social.publishStory).toHaveBeenCalledOnceWith({
      text: 'Mi historia', file: null, visibility: 'MutualContacts', durationSeconds: 3600,
      viewOnce: true, allowReposts: false, targetType: 'contacts', targetId: null, allowedUserIds: [],
    });
    expect(published).toHaveBeenCalledWith('Historia publicada.');
  });

  it('publishes group stories only to active members with selected-users visibility', async () => {
    chat.conversations.set([{ id: 'group', title: 'Familia', type: 'Group', participants: [
      { userId: 'me' }, { userId: 'friend' }, { userId: 'removed', removedAt: '2026-01-01' },
    ] }]);
    composer.chooseText();
    composer.text = 'Solo familia';
    composer.audience = 'group';
    composer.visibility = 'PublicWorld';
    await composer.publish();
    expect(social.publishStory).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      visibility: 'SelectedUsers', targetType: 'group', targetId: 'group', allowedUserIds: ['me', 'friend'],
    }));
  });

  it('never falls back to contacts when the selected group membership disappears', async () => {
    composer.chooseText();
    composer.text = 'Solo familia';
    composer.audience = 'missing-group';
    await composer.publish();
    expect(social.publishStory).not.toHaveBeenCalled();
    expect(composer.error).toBe('Grupo no disponible');
    expect(composer.text).toBe('Solo familia');
  });

  it('keeps the draft and suppresses concurrent publication after a network failure', async () => {
    let reject!: (error: Error) => void;
    social.publishStory.and.returnValue(new Promise<void>((_resolve, fail) => reject = fail));
    composer.chooseText();
    composer.text = 'Conservar';
    const first = composer.publish();
    await Promise.resolve();
    await composer.publish();
    expect(social.publishStory).toHaveBeenCalledTimes(1);
    reject(new Error('offline'));
    await first;
    expect(composer.text).toBe('Conservar');
    expect(composer.error).toContain('Conservamos');
    expect(composer.busy).toBeFalse();
  });

  it('shows the actionable encryption reason when a story audience has no active device keys', async () => {
    social.publishStory.and.rejectWith(new Error('Ningun destinatario tiene un dispositivo cifrado activo. Pideles abrir Nivra e intenta de nuevo.'));
    composer.chooseText();
    composer.text = 'Conservar';

    await composer.publish();

    expect(composer.error).toContain('Ningún destinatario tiene un dispositivo cifrado activo');
    expect(composer.error).toContain('Pídeles abrir Nivra');
    expect(composer.text).toBe('Conservar');
    expect(composer.busy).toBeFalse();
  });

  it('keeps a failed upload recoverable without displaying server details or duplicate publication', async () => {
    social.publishStory.and.rejectWith({ status: 500, error: { detail: 'storage password and internal exception' } });
    composer.chooseText();
    composer.text = 'Conservar el borrador';
    await composer.publish();
    expect(composer.publicationFailed).toBeTrue();
    expect(composer.text).toBe('Conservar el borrador');
    expect(composer.error).toContain('Reintenta');
    expect(composer.error).not.toContain('HTTP');
    expect(composer.error).not.toContain('password');
    social.publishStory.and.resolveTo();
    await composer.publish();
    expect(social.publishStory).toHaveBeenCalledTimes(2);
    expect(composer.publicationFailed).toBeFalse();
  });

  it('fits the original image after the view turn measures the editor stage', async () => {
    composer.imageWidth = 1200;
    composer.imageHeight = 600;
    const element = document.createElement('div');
    spyOn(element, 'getBoundingClientRect').and.returnValue({ width: 320, height: 320 } as DOMRect);
    composer.draftPreview = { nativeElement: element };
    await Promise.resolve();
    expect(composer.imagePreviewTransform()).toContain('width: 100%; height: 50%');
    composer.rotateImage();
    expect(composer.imagePreviewTransform()).toContain('rotate(90deg)');
  });

  it('encodes rotation and vertical crop into the actual published image', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    canvas.getContext('2d')!.fillRect(0, 0, 80, 40);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    composer.selectFile(new File([blob], 'photo.png', { type: 'image/png' }));
    composer.imageLoading = false;
    composer.rotateImage();
    composer.imageCrop = true;
    await composer.publish();
    const edited = social.publishStory.calls.mostRecent().args[0].file as File;
    expect(edited.type).toBe('image/jpeg');
    expect(edited.name).toBe('photo-story.jpg');
    const image = new Image();
    const url = URL.createObjectURL(edited);
    image.src = url;
    await image.decode();
    expect(image.naturalWidth).toBe(40);
    expect(image.naturalHeight).toBe(71);
    URL.revokeObjectURL(url);
  });

  it('does not publish a draft after the device changes during image preparation', async () => {
    composer.chooseText();
    composer.text = 'Borrador privado';
    spyOn<any>(composer, 'editedImageFile').and.callFake(async () => {
      auth.session.set({ ...auth.session(), device: { id: 'another-device' } });
      return null;
    });
    await composer.publish();
    expect(social.publishStory).not.toHaveBeenCalled();
  });

  it('does not send a draft after leaving the composer during preparation', async () => {
    composer.chooseText();
    composer.text = 'Borrador privado';
    spyOn<any>(composer, 'editedImageFile').and.callFake(async () => {
      composer.ngOnDestroy();
      return null;
    });
    await composer.publish();
    expect(social.publishStory).not.toHaveBeenCalled();
  });

  it('checks current group membership again after preparing the media', async () => {
    chat.conversations.set([{ id: 'group', type: 'Group', participants: [{ userId: 'me' }] }]);
    composer.chooseText();
    composer.text = 'Solo familia';
    composer.audience = 'group';
    spyOn<any>(composer, 'editedImageFile').and.callFake(async () => {
      chat.conversations.set([]);
      return null;
    });
    await composer.publish();
    expect(social.publishStory).not.toHaveBeenCalled();
    expect(composer.error).toBe('Grupo no disponible');
  });

  it('does not emit an old publication into another account', async () => {
    composer.chooseText();
    composer.text = 'Borrador privado';
    const published = spyOn(composer.published, 'emit');
    social.publishStory.and.callFake(async () => auth.session.set({ ...auth.session(), user: { id: 'other' } }));
    await composer.publish();
    expect(published).not.toHaveBeenCalled();
  });
});
