import { CALL_CAMERA_PREFERENCES, captureCallMedia } from './call-media-capture';

describe('call camera capture recovery', () => {
  const preferred = { audio: false, video: CALL_CAMERA_PREFERENCES };

  for (const name of ['OverconstrainedError', 'NotReadableError', 'AbortError']) {
    it(`retries a ${name} once with the default camera without reacquiring audio`, async () => {
      const stream = new MediaStream();
      const capture = jasmine.createSpy().and.returnValues(
        Promise.reject(new DOMException('capture unavailable', name)), Promise.resolve(stream));
      expect(await captureCallMedia(capture, preferred, () => true)).toBe(stream);
      expect(capture.calls.count()).toBe(2);
      expect(capture.calls.mostRecent().args[0]).toEqual({ audio: false, video: true });
    });
  }

  for (const name of ['NotAllowedError', 'SecurityError', 'NotFoundError']) {
    it(`does not repeatedly request permission or probe devices after ${name}`, async () => {
      const capture = jasmine.createSpy().and.rejectWith(new DOMException('capture unavailable', name));
      await expectAsync(captureCallMedia(capture, preferred, () => true)).toBeRejected();
      expect(capture.calls.count()).toBe(1);
    });
  }

  it('does not retry microphone-only failures as camera requests', async () => {
    const capture = jasmine.createSpy().and.rejectWith(new DOMException('audio unavailable', 'NotReadableError'));
    await expectAsync(captureCallMedia(capture, { audio: true, video: false }, () => true)).toBeRejected();
    expect(capture.calls.count()).toBe(1);
  });

  it('does not start another capture after the call closes during the first request', async () => {
    let reject!: (error: unknown) => void;
    let current = true;
    const capture = jasmine.createSpy().and.returnValue(new Promise<MediaStream>((_, fail) => { reject = fail; }));
    const pending = captureCallMedia(capture, preferred, () => current);
    current = false;
    reject(new DOMException('device temporarily blocked', 'NotReadableError'));
    await expectAsync(pending).toBeRejected();
    expect(capture.calls.count()).toBe(1);
  });

  it('stops a fallback permission grant that arrives after hangup', async () => {
    let grant!: (stream: MediaStream) => void;
    let current = true;
    const stop = jasmine.createSpy();
    const capture = jasmine.createSpy().and.returnValues(
      Promise.reject(new DOMException('constraints unavailable', 'OverconstrainedError')),
      new Promise<MediaStream>(resolve => { grant = resolve; }));
    const pending = captureCallMedia(capture, preferred, () => current);
    await Promise.resolve();
    current = false;
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expectAsync(pending).toBeRejected();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('limits an unavailable camera to two attempts', async () => {
    const capture = jasmine.createSpy().and.rejectWith(new DOMException('camera in use', 'NotReadableError'));
    await expectAsync(captureCallMedia(capture, preferred, () => true)).toBeRejected();
    expect(capture.calls.count()).toBe(2);
  });
});
