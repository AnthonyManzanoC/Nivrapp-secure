import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaStreamDirective } from './media-stream.directive';

@Component({ standalone: true, imports: [MediaStreamDirective], template: '<video [appMediaStream]="stream" muted></video>' })
class Host {
  stream = new MediaStream();
}

describe('live media playback recovery', () => {
  it('detaches removed tracks immediately and does not stop a capture owned by the call', () => {
    TestBed.configureTestingModule({ imports: [Host] });
    const play = spyOn(HTMLMediaElement.prototype, 'play').and.resolveTo();
    const fixture = TestBed.createComponent(Host);
    const track = document.createElement('canvas').captureStream().getVideoTracks()[0];
    const stream = fixture.componentInstance.stream;
    stream.addTrack(track); fixture.detectChanges();
    stream.removeTrack(track); stream.dispatchEvent(new Event('removetrack'));
    play.calls.reset(); track.dispatchEvent(new Event('unmute'));
    expect(play).not.toHaveBeenCalled();
    stream.addTrack(track); stream.dispatchEvent(new Event('addtrack'));
    fixture.destroy();
    expect(track.readyState).toBe('live');
    play.calls.reset(); track.dispatchEvent(new Event('unmute'));
    expect(play).not.toHaveBeenCalled(); track.stop();
  });

  it('resumes on visibility restoration and never responds to a replaced stream', () => {
    TestBed.configureTestingModule({ imports: [Host] });
    const play = spyOn(HTMLMediaElement.prototype, 'play').and.resolveTo();
    const visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    const fixture = TestBed.createComponent(Host); fixture.detectChanges();
    const old = fixture.componentInstance.stream;
    fixture.componentInstance.stream = new MediaStream(); fixture.detectChanges();
    play.calls.reset(); old.dispatchEvent(new Event('addtrack'));
    expect(play).not.toHaveBeenCalled();
    visibility.and.returnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    expect(play).not.toHaveBeenCalled();
    visibility.and.returnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
    expect(play).toHaveBeenCalledTimes(1); fixture.destroy();
  });

  it('retries when metadata arrives and removes listeners on destroy without stopping the stream', () => {
    TestBed.configureTestingModule({ imports: [Host] });
    const play = spyOn(HTMLMediaElement.prototype, 'play').and.resolveTo();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    expect(video.srcObject).toBe(fixture.componentInstance.stream);
    expect(video.muted).toBeTrue();
    expect(video.playsInline).toBeTrue();
    play.calls.reset();
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(play).toHaveBeenCalledTimes(1);
    fixture.destroy();
    play.calls.reset();
    video.dispatchEvent(new Event('canplay'));
    expect(play).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });
});
