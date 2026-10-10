import { TestBed } from '@angular/core/testing';
import { ANDROID_UPDATE_RUNTIME, AndroidUpdateService, validAndroidRelease } from './android-update.service';
import { NativeDeviceService, type AndroidRelease } from './native-device.service';

describe('AndroidUpdateService', () => {
  const release: AndroidRelease = { version: '2.1.0', versionCode: 22, sha256: 'a'.repeat(64), size: 80000000,
    url: 'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v2.1.0/Nivra-2.1.0-debug.apk' };
  let fetchRelease: jasmine.Spy;
  let saved: Map<string, string>;
  let native: { downloadAppUpdate: jasmine.Spy; installAppUpdate: jasmine.Spy; setAppUpdateAllowed: jasmine.Spy };
  beforeEach(() => {
    saved = new Map();
    fetchRelease = jasmine.createSpy().and.resolveTo(release);
    native = { downloadAppUpdate: jasmine.createSpy().and.resolveTo({ phase: 'downloading', progress: 0 }),
      installAppUpdate: jasmine.createSpy().and.resolveTo({ phase: 'ready', progress: 100 }),
      setAppUpdateAllowed: jasmine.createSpy().and.resolveTo() };
    TestBed.configureTestingModule({ providers: [{ provide: NativeDeviceService, useValue: native },
      { provide: ANDROID_UPDATE_RUNTIME, useValue: { supported: true, installedBuild: async () => 21, fetchRelease,
        now: () => new Date(2026, 9, 9, 10).getTime(), storage: { getItem: (key: string) => saved.get(key) ?? null,
          setItem: (key: string, value: string) => saved.set(key, value) } } }] });
  });
  it('rejects a downgrade, a modified URL, unsafe size and malformed digest', () => {
    expect(validAndroidRelease(release, 21)).toBeTrue();
    expect(validAndroidRelease(release, 22)).toBeFalse();
    for (const patch of [{ url: release.url + '?redirect=elsewhere' }, { url: 'http://localhost/app.apk' },
      { sha256: 'xyz' }, { size: 300000000 }, { versionCode: 22.1 }, { version: '../2.1.0' }]) {
      expect(validAndroidRelease({ ...release, ...patch }, 21)).toBeFalse();
    }
  });
  it('checks once per day, coalesces checks and allows a manual check', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    const pending = updates.check();
    expect(updates.check()).toBe(pending);
    await pending; await updates.check();
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    expect(updates.release()?.versionCode).toBe(22);
    await updates.check(true);
    expect(fetchRelease).toHaveBeenCalledTimes(2);
  });
  it('a failed or malformed response does not claim to be up to date', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    fetchRelease.and.resolveTo(null);
    await updates.check(true);
    expect(updates.checkResult()).toBe('error');
    expect(saved.get('nivra.androidUpdate.checkedDay')).toBeUndefined();
  });
  it('never downloads automatically and gates the prompt and installer during a call or lock', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    await updates.check(true);
    expect(native.downloadAppUpdate).not.toHaveBeenCalled();
    expect(updates.show()).toBeFalse();
    await updates.download();
    expect(native.downloadAppUpdate).not.toHaveBeenCalled();
    updates.safe.set(true);
    expect(!!updates.show()).toBeTrue();
    await updates.download();
    expect(native.downloadAppUpdate).toHaveBeenCalledWith(release);
    updates.state.set({ phase: 'ready', progress: 100 });
    updates.safe.set(false); await updates.install();
    expect(native.installAppUpdate).not.toHaveBeenCalled();
    updates.safe.set(true); await updates.install();
    expect(native.installAppUpdate).toHaveBeenCalledTimes(1);
  });
  it('does not offer installation for an incomplete or failed download', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    updates.safe.set(true); await updates.install();
    expect(native.installAppUpdate).not.toHaveBeenCalled();
  });
  it('invalidates native installation when a call starts during the bridge handoff', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    updates.safe.set(true); updates.state.set({ phase: 'ready', progress: 100 });
    let complete!: () => void;
    native.setAppUpdateAllowed.and.returnValue(new Promise<void>(resolve => complete = resolve));
    const pending = updates.install();
    updates.safe.set(false); complete(); await pending;
    expect(native.installAppUpdate).not.toHaveBeenCalled();
    native.setAppUpdateAllowed.and.resolveTo(); TestBed.flushEffects();
    expect(native.setAppUpdateAllowed).toHaveBeenCalledWith(false);
  });
});
