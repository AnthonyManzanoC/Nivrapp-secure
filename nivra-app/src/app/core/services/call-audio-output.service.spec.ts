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

  it('plays microphone and screen audio independently and removes only the ended share', () => {
    const screen = context.createMediaStreamDestination().stream;
    service.sync({ peer: new MediaStream([...stream.getAudioTracks(), ...screen.getAudioTracks()]), duplicate: screen }, false);
    expect(document.querySelectorAll('audio[aria-hidden="true"]').length).toBe(2);
    screen.getTracks().forEach(track => track.stop());
    service.sync({ peer: stream }, false);
    expect(document.querySelectorAll('audio[aria-hidden="true"]').length).toBe(1);
    expect(stream.getAudioTracks()[0].readyState).toBe('live');
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

  describe('browser output routing', () => {
    let descriptor: PropertyDescriptor | undefined;
    let sink: jasmine.Spy;
    let devices: MediaDeviceInfo[];
    beforeEach(() => {
      descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'setSinkId');
      sink = jasmine.createSpy('setSinkId').and.resolveTo();
      Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, value: sink });
      devices = [{ kind: 'audiooutput', deviceId: 'headset', label: 'Auriculares', groupId: '' } as MediaDeviceInfo,
        { kind: 'audioinput', deviceId: 'microphone', label: 'Micrófono', groupId: '' } as MediaDeviceInfo];
      spyOn(navigator.mediaDevices, 'enumerateDevices').and.callFake(async () => devices);
    });
    afterEach(() => {
      if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', descriptor);
      else delete (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId;
    });

    it('lists only real audio outputs and switches every remote track without muting or stopping it', async () => {
      service.setCallSession('call');
      await service.refreshRoutes();
      service.sync({ peer: stream }, true);
      const output = document.querySelector('audio[aria-hidden="true"]') as HTMLAudioElement;
      const track = stream.getAudioTracks()[0];
      const stop = spyOn(track, 'stop');
      expect(service.availableRoutes().map(route => route.id)).toEqual(['default', 'headset']);
      expect(await service.selectRoute('headset')).toBeTrue();
      expect(service.selectedRouteId()).toBe('headset');
      expect(sink.calls.all().some(call => call.object === output && call.args[0] === 'headset')).toBeTrue();
      expect(output.muted).toBeTrue();
      expect(track.enabled).toBeTrue();
      expect(stop).not.toHaveBeenCalled();
    });

    it('keeps the selected sink on a remote track arriving later', async () => {
      service.setCallSession('call');
      await service.refreshRoutes();
      await service.selectRoute('headset');
      sink.calls.reset();
      service.sync({ peer: stream }, false);
      await Promise.resolve();
      expect(sink).toHaveBeenCalledWith('headset');
      expect(service.selectedRouteId()).toBe('headset');
    });

    it('moves playback to the system output when the selected device disappears', async () => {
      service.setCallSession('call');
      await service.refreshRoutes();
      service.sync({ peer: stream }, false);
      await service.selectRoute('headset');
      devices = [];
      await service.refreshRoutes();
      expect(service.selectedRouteId()).toBe('default');
      expect(sink).toHaveBeenCalledWith('');
      expect(service.routeBusy()).toBeFalse();
    });

    it('preserves the prior selection and reports failure when the platform rejects a sink', async () => {
      service.setCallSession('call');
      await service.refreshRoutes();
      sink.and.rejectWith(new DOMException('private device details', 'NotAllowedError'));
      expect(await service.selectRoute('headset')).toBeFalse();
      expect(service.selectedRouteId()).toBe('default');
      expect(service.routeBusy()).toBeFalse();
      expect(service.routeError()).not.toContain('private device');
    });

    it('does not apply an old permission completion to outputs of a replacement call', async () => {
      service.setCallSession('old');
      await service.refreshRoutes();
      let finish!: () => void;
      sink.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));
      const selection = service.selectRoute('headset');
      await Promise.resolve();
      service.setCallSession(null);
      service.sync({}, false);
      service.setCallSession('new');
      service.sync({ peer: stream }, false);
      const replacement = document.querySelector('audio[aria-hidden="true"]');
      finish();
      expect(await selection).toBeFalse();
      expect(sink.calls.all().some(call => call.object === replacement)).toBeFalse();
      expect(service.selectedRouteId()).toBe('default');
    });

    it('exposes only system output when sink selection is unsupported', async () => {
      Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, value: undefined });
      service.setCallSession('call');
      await service.refreshRoutes();
      expect(service.routingSupported()).toBeFalse();
      expect(service.availableRoutes().map(route => route.id)).toEqual(['default']);
      expect(await service.selectRoute('headset')).toBeFalse();
    });
  });

  describe('native communication routing lifecycle', () => {
    let bridge: any;
    let listener: (state: any) => void;
    let current: any;
    const routes = [{ id: 'ear', kind: 'earpiece', label: 'Auricular del teléfono' },
      { id: 'bt', kind: 'bluetooth', label: 'Bluetooth' }];
    beforeEach(() => {
      current = { callId: '', supported: true, routes, selectedRouteId: 'ear', pendingRouteId: '', bluetoothPermission: true };
      bridge = {
        addListener: jasmine.createSpy().and.callFake(async (_name: string, callback: (state: any) => void) => {
          listener = callback; return { remove: jasmine.createSpy().and.resolveTo() };
        }),
        configureCallAudio: jasmine.createSpy().and.callFake(async (options: any) => {
          current = { ...current, callId: options.active ? options.callId : '', pendingRouteId: '' }; return current;
        }),
        getCallAudioRoutes: jasmine.createSpy().and.callFake(async () => current),
        selectCallAudioRoute: jasmine.createSpy().and.callFake(async (options: any) => {
          current = { ...current, pendingRouteId: options.routeId }; return current;
        }),
      };
      Object.defineProperty(service, 'native', { value: true });
      Object.defineProperty(service, 'nativeBridge', { value: bridge });
    });

    it('keeps actual route selected while Bluetooth connects and adopts the acknowledged change', async () => {
      service.setCallSession('voice');
      await service.refreshRoutes();
      service.sync({ peer: stream }, true);
      expect(await service.selectRoute('bt')).toBeTrue();
      expect(service.selectedRouteId()).toBe('ear');
      expect(service.routeBusy()).toBeTrue();
      listener({ ...current, selectedRouteId: 'bt', pendingRouteId: '' });
      expect(service.selectedRouteId()).toBe('bt');
      expect(service.routeBusy()).toBeFalse();
      expect((document.querySelector('audio[aria-hidden="true"]') as HTMLAudioElement).muted).toBeTrue();
      expect(stream.getAudioTracks()[0].enabled).toBeTrue();
    });

    it('releases the old native session before starting the next and ignores old device events', async () => {
      service.setCallSession('old');
      await service.refreshRoutes();
      service.setCallSession('new', true);
      await service.refreshRoutes();
      expect(bridge.configureCallAudio.calls.allArgs()).toEqual([
        [{ callId: 'old', active: true, video: false }], [{ callId: 'old', active: false, video: false }],
        [{ callId: 'new', active: true, video: true }],
      ]);
      listener({ ...current, callId: 'old', selectedRouteId: 'bt' });
      expect(service.selectedRouteId()).toBe('ear');
      service.setCallSession(null);
      await (service as any).nativeQueue;
      expect(bridge.configureCallAudio).toHaveBeenCalledWith({ callId: 'new', active: false, video: false });
    });

    it('updates video preference on the same call without releasing the selected route', async () => {
      service.setCallSession('call');
      await service.refreshRoutes();
      service.setCallSession('call', true);
      await service.refreshRoutes();
      expect(bridge.configureCallAudio.calls.allArgs()).toEqual([
        [{ callId: 'call', active: true, video: false }], [{ callId: 'call', active: true, video: true }],
      ]);
    });

    it('ignores delayed snapshots for the same call after a newer route has been acknowledged', async () => {
      service.setCallSession('call');
      await service.refreshRoutes();
      listener({ ...current, revision: 9, selectedRouteId: 'bt', pendingRouteId: '' });
      listener({ ...current, revision: 8, selectedRouteId: 'ear', pendingRouteId: 'bt' });
      expect(service.selectedRouteId()).toBe('bt');
      expect(service.routeBusy()).toBeFalse();
    });

    it('requests Bluetooth permission only for the explicit refresh action and clears a rejected selection', async () => {
      service.setCallSession('call');
      await service.refreshRoutes();
      expect(bridge.getCallAudioRoutes).toHaveBeenCalledWith({ requestPermission: false });
      await service.refreshRoutes(true);
      expect(bridge.getCallAudioRoutes).toHaveBeenCalledWith({ requestPermission: true });
      bridge.selectCallAudioRoute.and.rejectWith(new Error('private native info'));
      expect(await service.selectRoute('bt')).toBeFalse();
      expect(service.routeBusy()).toBeFalse();
      expect(service.selectedRouteId()).toBe('ear');
      expect(service.routeError()).not.toContain('private native');
    });
  });
});
