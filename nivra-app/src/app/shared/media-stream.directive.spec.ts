import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaStreamDirective } from './media-stream.directive';

@Component({ standalone: true, imports: [MediaStreamDirective], template: '<video [appMediaStream]="stream" muted></video>' })
class Host {
  stream = new MediaStream();
}

describe('live media playback recovery', () => {
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
