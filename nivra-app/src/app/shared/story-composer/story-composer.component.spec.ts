import { SimpleChange, signal } from '@angular/core';
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
