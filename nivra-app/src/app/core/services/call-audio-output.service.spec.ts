import { CallAudioOutputService } from './call-audio-output.service';

describe('CallAudioOutputService', () => {
  let service: CallAudioOutputService;
  let context: AudioContext;
  let stream: MediaStream;
  let play: jasmine.Spy;

  beforeEach(() => {
    context = new AudioContext();
    stream = context.createMediaStreamDestination().stream;
    play = spyOn(HTMLMediaElement.prototype, 'play').and.returnValue(Promise.resolve());
    spyOn(HTMLMediaElement.prototype, 'pause');
    service = new CallAudioOutputService();
  });

  afterEach(async () => {
    service.ngOnDestroy();
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
  });

  it('keeps one audio element across view changes and does not double playback', () => {
    service.sync({ participant: stream }, false);
    const output = document.querySelector('audio[aria-hidden="true"]') as HTMLAudioElement;
    const view = document.createElement('video');
    view.srcObject = stream;
    view.remove();
    service.sync({ participant: stream }, false);
    expect(document.querySelectorAll('audio[aria-hidden="true"]').length).toBe(1);
    expect(document.querySelector('audio[aria-hidden="true"]')).toBe(output);
    expect((output.srcObject as MediaStream).getAudioTracks()[0]).toBe(stream.getAudioTracks()[0]);
  });

  it('releases elements without stopping remote tracks and honors the audio toggle', () => {
    const stop = spyOn(stream.getAudioTracks()[0], 'stop');
    service.sync({ participant: stream }, true);
    expect((document.querySelector('audio[aria-hidden="true"]') as HTMLAudioElement).muted).toBeTrue();
    service.sync({}, false);
    expect(document.querySelector('audio[aria-hidden="true"]')).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it('offers recovery when autoplay needs a user gesture', async () => {
    play.and.callFake(() => Promise.reject(new DOMException('User activation needed', 'NotAllowedError')));
    service.sync({ participant: stream }, false);
    await service.resume();
    expect(service.playbackBlocked()).toBeTrue();
    play.and.returnValue(Promise.resolve());
    await service.resume();
    expect(service.playbackBlocked()).toBeFalse();
  });

  it('ignores an old play completion after the participant output is replaced', async () => {
    let finishOld!: () => void;
    play.and.returnValue(new Promise<void>((resolve) => { finishOld = resolve; }));
    service.sync({ participant: stream }, false);
    service.sync({}, false);
    play.and.callFake(() => Promise.reject(new DOMException('User activation needed', 'NotAllowedError')));
    service.sync({ participant: stream }, false);
    await service.resume();
    expect(service.playbackBlocked()).toBeTrue();
    finishOld();
    await Promise.resolve();
    expect(service.playbackBlocked()).toBeTrue();
  });
});
