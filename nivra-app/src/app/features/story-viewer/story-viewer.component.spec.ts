import { ElementRef, SimpleChange, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StoryViewerComponent } from './story-viewer.component';
import { SocialService } from '../../core/services/social.service';

describe('story playback lifecycle', () => {
  let player: StoryViewerComponent;
  let social: any;
  let visibility: jasmine.Spy;
  const advance = (frames = 1) => {
    for (let i = 0; i < frames; i++) { (player as any).lastTick = performance.now() - 80; (player as any).tick(); }
  };
  const media = (kind = 'video') => {
    const element = document.createElement(kind) as HTMLMediaElement;
    let paused = true;
    Object.defineProperty(element, 'paused', { get: () => paused });
    Object.defineProperty(element, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(element, 'duration', { value: 20, configurable: true });
    Object.defineProperty(element, 'currentTime', { value: 6, writable: true, configurable: true });
    spyOn(element, 'play').and.callFake(async () => { paused = false; });
    spyOn(element, 'pause').and.callFake(() => { paused = true; });
    player.payload = { type: 'media', media: { mime: kind + '/mp4' } as any };
    player.storyMedia = new ElementRef(element);
    player.loadedMedia({ target: element } as unknown as Event);
    return element;
  };

  beforeEach(() => {
    visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    social = {
      storyReadyId: signal('one'), storyOpenError: signal(''), storyOpening: signal(false),
      viewStory: jasmine.createSpy('viewStory').and.resolveTo(), ensureStoryMedia: jasmine.createSpy('ensureStoryMedia').and.resolveTo(null),
      deleteStory: jasmine.createSpy('deleteStory').and.resolveTo(),
    };
    TestBed.configureTestingModule({ providers: [{ provide: SocialService, useValue: social }] });
    player = TestBed.runInInjectionContext(() => new StoryViewerComponent());
    player.story = { id: 'one', owner: { id: 'friend' } } as any;
    player.payload = { type: 'text', text: 'Hello' };
    player.queue = [player.story];
    player.ngOnChanges({ story: new SimpleChange(undefined, player.story, true) });
    TestBed.flushEffects();
  });
  afterEach(() => player.ngOnDestroy());

  it('waits for authorization/decryption and image load instead of consuming a blank slide', () => {
    social.storyReadyId.set('');
    advance(90);
    expect(player.localProgress).toBe(0);
    social.storyReadyId.set('one');
    player.payload = { type: 'media', media: { mime: 'image/jpeg' } as any };
    advance(90);
    expect(player.localProgress).toBe(0);
    player.loadedImage(); advance(10);
    expect(player.localProgress).toBeGreaterThan(0);
  });
  it('advances text only once after its visible reading time', () => {
    spyOn(player.mediaEnded, 'emit');
    advance(100);
    expect(player.mediaEnded.emit).toHaveBeenCalledTimes(1);
    expect(player.localProgress).toBe(100);
  });
  it('pauses time while hidden, reading a reply, displaying activity, or reacting', () => {
    visibility.and.returnValue('hidden'); advance(80);
    visibility.and.returnValue('visible');
    player.focusReply(true); advance(80); player.focusReply(false);
    player.paused = true; advance(80); player.paused = false;
    player.reactionsOpen = true; advance(80);
    expect(player.localProgress).toBe(0);
    player.reactionsOpen = false; advance(5);
    expect(player.localProgress).toBeGreaterThan(0);
  });
  it('uses actual video time and never advances on a wall clock while buffering', () => {
    const video = media();
    advance(100);
    expect(player.localProgress).toBe(30);
    Object.defineProperty(video, 'readyState', { value: 1 });
    advance(100);
    expect(player.localProgress).toBe(30);
  });
  it('pauses the actual media for activity, focus, and background and resumes it', () => {
    const video = media();
    player.paused = true; player.ngOnChanges({}); expect(video.pause).toHaveBeenCalled();
    player.paused = false; player.ngOnChanges({});
    player.focusReply(true); expect(video.pause).toHaveBeenCalledTimes(2);
    player.focusReply(false);
    visibility.and.returnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    expect(video.pause).toHaveBeenCalledTimes(3);
    visibility.and.returnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
    expect(video.play).toHaveBeenCalledTimes(4);
  });
  it('requires an explicit gesture for audio if autoplay is refused', async () => {
    const audio = media('audio');
    (audio.play as jasmine.Spy).and.rejectWith(new DOMException('blocked', 'NotAllowedError'));
    audio.pause(); player.ngOnChanges({});
    await Promise.resolve(); await Promise.resolve();
    expect(player.needsPlay).toBeTrue();
    expect(player.muted).toBeFalse();
    (audio.play as jasmine.Spy).and.resolveTo();
    await player.playFromGesture();
    expect(player.needsPlay).toBeFalse();
  });
  it('falls back to muted video without enabling audio without a gesture', async () => {
    const video = media();
    video.pause();
    (video.play as jasmine.Spy).and.returnValues(Promise.reject(new DOMException('blocked', 'NotAllowedError')), Promise.resolve());
    player.ngOnChanges({});
    await Promise.resolve(); await Promise.resolve();
    expect(video.muted).toBeTrue(); expect(player.muted).toBeTrue();
    (video.play as jasmine.Spy).and.resolveTo();
    player.toggleMute(); expect(video.muted).toBeFalse();
  });
  it('ignores late play rejections after destruction and stops playing media', async () => {
    const video = media();
    let reject!: (reason: unknown) => void;
    (video.play as jasmine.Spy).and.returnValue(new Promise((_resolve, fail) => reject = fail));
    video.pause(); player.ngOnChanges({});
    player.ngOnDestroy();
    reject(new Error('late'));
    await Promise.resolve();
    expect(player.needsPlay).toBeFalse();
    expect(video.paused).toBeTrue();
  });
  it('keeps media errors recoverable without advancing', () => {
    media(); player.failedMedia(); advance(100);
    expect(player.localProgress).toBe(0);
    player.retryMedia();
    expect(player.mediaFailed).toBeFalse();
  });
  it('pauses for the share confirmation and publishes only after the explicit second action', () => {
    spyOn(player.repost, 'emit');
    player.showRepost(); advance(100);
    expect(player.localProgress).toBe(0);
    expect(player.repost.emit).not.toHaveBeenCalled();
    player.confirmRepost();
    expect(player.repost.emit).toHaveBeenCalledTimes(1);
  });
  it('does not steal keyboard shortcuts from message fields', () => {
    const field = document.createElement('input');
    spyOn(player.next, 'emit');
    player.onKey({ key: 'ArrowRight', target: field } as any);
    expect(player.next.emit).not.toHaveBeenCalled();
    player.onKey({ key: 'ArrowRight', target: document.body, preventDefault: () => undefined } as any);
    expect(player.next.emit).toHaveBeenCalledTimes(1);
  });
  it('cannot delete another user’s story', async () => {
    await player.deleteOwnStory();
    expect(social.deleteStory).not.toHaveBeenCalled();
  });
});
