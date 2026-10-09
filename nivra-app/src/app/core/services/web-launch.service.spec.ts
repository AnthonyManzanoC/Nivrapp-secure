import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { NIVRA_VERSION } from '../release';
import { WEB_LAUNCH_RUNTIME, WEB_LAUNCH_TIMEOUT_MS, WebLaunchRuntime, WebLaunchService } from './web-launch.service';

describe('WebLaunchService', () => {
  let saved: Map<string, string>;
  let runtime: WebLaunchRuntime;
  let fetchVersion: jasmine.Spy;
  let reload: jasmine.Spy;
  const newer = `${Number(NIVRA_VERSION.split('.')[0]) + 1}.0.0`;

  beforeEach(() => {
    saved = new Map();
    fetchVersion = jasmine.createSpy('fetchVersion').and.resolveTo({ version: NIVRA_VERSION });
    reload = jasmine.createSpy('reload');
    runtime = {
      isWeb: true,
      storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } },
      now: () => new Date(2026, 9, 9, 8), sensitiveRoute: () => false, fetchVersion, reload,
    };
    TestBed.configureTestingModule({ providers: [{ provide: WEB_LAUNCH_RUNTIME, useValue: runtime }] });
  });

  it('checks only once per local day across page launches without a minimum delay', async () => {
    const first = TestBed.inject(WebLaunchService);
    await first.start();
    expect(first.checking()).toBeFalse();
    const nextLaunch = TestBed.runInInjectionContext(() => new WebLaunchService());
    await nextLaunch.start();
    expect(fetchVersion).toHaveBeenCalledTimes(1);
    runtime.now = () => new Date(2026, 9, 10, 1);
    await TestBed.runInInjectionContext(() => new WebLaunchService()).start();
    expect(fetchVersion).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('coalesces overlapping checks and releases the screen after a timeout', fakeAsync(() => {
    fetchVersion.and.returnValue(new Promise(() => undefined));
    const service = TestBed.inject(WebLaunchService);
    const first = service.start();
    expect(service.start()).toBe(first);
    expect(service.checking()).toBeTrue();
    tick(WEB_LAUNCH_TIMEOUT_MS); flushMicrotasks();
    expect(service.checking()).toBeFalse();
    expect(fetchVersion).toHaveBeenCalledTimes(1);
    expect((fetchVersion.calls.mostRecent().args[0] as AbortSignal).aborted).toBeTrue();
    expect(reload).not.toHaveBeenCalled();
  }));

  it('reloads for a newer release and prevents a stale cached page from looping', async () => {
    fetchVersion.and.resolveTo({ version: newer });
    await TestBed.inject(WebLaunchService).start();
    await TestBed.runInInjectionContext(() => new WebLaunchService()).start();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps a call or upload running when a newer release is available', async () => {
    fetchVersion.and.resolveTo({ version: newer });
    await TestBed.inject(WebLaunchService).start(() => false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('continues offline without reloading or holding the screen', async () => {
    fetchVersion.and.rejectWith(new TypeError('Offline'));
    const service = TestBed.inject(WebLaunchService);
    await service.start();
    expect(service.checking()).toBeFalse();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not automatically reload when persistent storage is unavailable', async () => {
    runtime.storage = { getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Denied'); } };
    fetchVersion.and.resolveTo({ version: newer });
    await TestBed.inject(WebLaunchService).start();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not check packaged native or desktop apps', async () => {
    runtime.isWeb = false;
    await TestBed.inject(WebLaunchService).start();
    expect(fetchVersion).not.toHaveBeenCalled();
  });

  it('waits until leaving login or recovery instead of interrupting that flow', async () => {
    runtime.sensitiveRoute = () => true;
    const service = TestBed.inject(WebLaunchService);
    await service.start();
    expect(fetchVersion).not.toHaveBeenCalled();
    runtime.sensitiveRoute = () => false;
    await service.start();
    expect(fetchVersion).toHaveBeenCalledTimes(1);
  });

  it('does not reload after entering login or recovery while a check is pending', async () => {
    let complete!: (release: unknown) => void;
    fetchVersion.and.returnValue(new Promise(resolve => complete = resolve));
    const pending = TestBed.inject(WebLaunchService).start();
    runtime.sensitiveRoute = () => true;
    complete({ version: newer });
    await pending;
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores malformed versions and a lower version during a deployment', async () => {
    fetchVersion.and.resolveTo({ version: 'https://untrusted.test' });
    await TestBed.inject(WebLaunchService).start();
    runtime.now = () => new Date(2026, 9, 10);
    fetchVersion.and.resolveTo({ version: '0.1.0' });
    await TestBed.runInInjectionContext(() => new WebLaunchService()).start();
    expect(reload).not.toHaveBeenCalled();
  });
});
