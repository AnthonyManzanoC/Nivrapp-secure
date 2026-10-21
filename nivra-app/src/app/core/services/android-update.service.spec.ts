import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { ANDROID_UPDATE_RUNTIME, AndroidUpdateService, androidReleaseFromFeed, validAndroidRelease, validUpdateFeedResponseUrl } from './android-update.service';
import { NativeDeviceService, type AndroidRelease } from './native-device.service';

describe('AndroidUpdateService', () => {
  const release: AndroidRelease = { version: '4.1.0', versionCode: 28, sha256: 'a'.repeat(64), size: 80000000,
    url: 'https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.0-debug.apk' };
  const feed = { schemaVersion: 1, version: release.version, publishedAt: '2026-10-21T12:00:00.000Z', android: release,
    windows: { version: '4.1.0', url: 'https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.0-Setup.exe', sha256: 'b'.repeat(64), size: 100000000 } };
  let fetchRelease: jasmine.Spy;
  let saved: Map<string, string>;
  let now: number;
  let onAppStateChange: jasmine.Spy;
  let native: { downloadAppUpdate: jasmine.Spy; installAppUpdate: jasmine.Spy; setAppUpdateAllowed: jasmine.Spy; onAppUpdateState: jasmine.Spy; getAppUpdateState: jasmine.Spy };
  beforeEach(() => {
    saved = new Map();
    now = new Date(2026, 9, 21, 10).getTime();
    onAppStateChange = jasmine.createSpy().and.resolveTo({ remove: async () => undefined });
    fetchRelease = jasmine.createSpy().and.resolveTo(feed);
    native = { downloadAppUpdate: jasmine.createSpy().and.resolveTo({ phase: 'downloading', progress: 0 }),
      installAppUpdate: jasmine.createSpy().and.resolveTo({ phase: 'ready', progress: 100 }),
      setAppUpdateAllowed: jasmine.createSpy().and.resolveTo(),
      onAppUpdateState: jasmine.createSpy().and.resolveTo({ remove: async () => undefined }),
      getAppUpdateState: jasmine.createSpy().and.resolveTo({ phase: 'idle', progress: 0 }) };
    TestBed.configureTestingModule({ providers: [{ provide: NativeDeviceService, useValue: native },
      { provide: ANDROID_UPDATE_RUNTIME, useValue: { supported: true, installedBuild: async () => 27, fetchRelease, onAppStateChange,
        now: () => now, storage: { getItem: (key: string) => saved.get(key) ?? null,
          setItem: (key: string, value: string) => saved.set(key, value) } } }] });
  });
  it('rejects a downgrade, a modified URL, unsafe size and malformed digest', () => {
    expect(validAndroidRelease(release, 27)).toBeTrue();
    expect(validAndroidRelease(release, 28)).toBeFalse();
    for (const patch of [{ url: release.url + '?redirect=elsewhere' }, { url: 'http://localhost/app.apk' },
      { sha256: 'xyz' }, { size: 300000000 }, { versionCode: 28.1 }, { version: '../4.1.0' },
      { url: 'https://nivrapp-secure.vercel.app.evil.test/downloads/Nivra-4.1.0-debug.apk' }]) {
      expect(validAndroidRelease({ ...release, ...patch }, 27)).toBeFalse();
    }
  });
  it('validates the permanent feed envelope and never passes unrelated fields to native code', () => {
    expect(androidReleaseFromFeed({ ...feed, android: { ...release, extra: 'discard' } })).toEqual(release);
    for (const patch of [{ schemaVersion: 2 }, { version: '4.2.0' }, { publishedAt: 'yesterday' }, { android: null }]) {
      expect(androidReleaseFromFeed({ ...feed, ...patch })).toBeNull();
    }
    expect(androidReleaseFromFeed(release)).toBeNull();
    const future = { ...release, version: '9.0.0', versionCode: 90, url: 'https://nivrapp-secure.vercel.app/downloads/Nivra-9.0.0-debug.apk' };
    expect(androidReleaseFromFeed({ ...feed, version: future.version, android: future })).toEqual(future);
  });
  it('accepts only the exact public feed as the final feed response', () => {
    expect(validUpdateFeedResponseUrl('https://nivrapp-secure.vercel.app/updates/latest.json')).toBeTrue();
    for (const url of ['https://nivrapp-secure.vercel.app/updates/other.json', 'https://nivrapp-secure.vercel.app/updates/latest.json?redirect=x',
      'https://release-assets.githubusercontent.com/asset?signature=signed', 'https://release-assets.githubusercontent.com.evil.test/asset',
      'https://user:pass@objects.githubusercontent.com/asset', 'http://objects.githubusercontent.com/asset']) {
      expect(validUpdateFeedResponseUrl(url)).toBeFalse();
    }
  });
  it('checks every six hours, coalesces checks and allows a manual check', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    const pending = updates.check();
    expect(updates.check()).toBe(pending);
    await pending; await updates.check();
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    expect(updates.release()?.versionCode).toBe(28);
    await updates.check(true);
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    now += 6 * 60 * 60 * 1000;
    await updates.check();
    expect(fetchRelease).toHaveBeenCalledTimes(3);
  });
  it('a failed or malformed response does not claim to be up to date', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    fetchRelease.and.resolveTo(null);
    await updates.check(true);
    expect(updates.checkResult()).toBe('error');
    expect(saved.get('nivra.androidUpdate.checkedAt')).toBeUndefined();
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

  it('coalesces download taps before the native bridge reports progress', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    await updates.check(true);
    updates.safe.set(true);
    let complete!: () => void;
    native.setAppUpdateAllowed.and.returnValue(new Promise<void>(resolve => complete = resolve));
    const first = updates.download();
    await updates.download();
    expect(updates.startingDownload()).toBeTrue();
    complete(); await first;
    expect(native.downloadAppUpdate).toHaveBeenCalledTimes(1);
    expect(updates.startingDownload()).toBeFalse();
  });

  it('keeps an in-progress verified download bound to the release displayed to the user', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    await updates.check(true);
    updates.state.set({ phase: 'ready', progress: 100 });
    await updates.check(true);
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    expect(updates.release()).toEqual(release);
  });

  it('offers a later release even after an earlier release was dismissed in the same session', async () => {
    const updates = TestBed.inject(AndroidUpdateService);
    await updates.check(true);
    updates.dismiss();
    const next = { ...release, version: '4.2.0', versionCode: 29, url: 'https://nivrapp-secure.vercel.app/downloads/Nivra-4.2.0-debug.apk' };
    fetchRelease.and.resolveTo({ ...feed, version: next.version, android: next });
    now += 6 * 60 * 60 * 1000;
    await updates.check();
    expect(updates.release()?.versionCode).toBe(29);
    expect(updates.dismissed()).toBeFalse();
  });

  it('rechecks long-running foreground sessions and removes its interval and listeners on destroy', fakeAsync(() => {
    const remove = jasmine.createSpy().and.resolveTo();
    const removeNative = jasmine.createSpy().and.resolveTo();
    onAppStateChange.and.resolveTo({ remove });
    native.onAppUpdateState.and.resolveTo({ remove: removeNative });
    const updates = TestBed.inject(AndroidUpdateService);
    updates.start(); flushMicrotasks();
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    now += 6 * 60 * 60 * 1000;
    tick(6 * 60 * 60 * 1000); flushMicrotasks();
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    TestBed.resetTestingModule(); flushMicrotasks();
    now += 6 * 60 * 60 * 1000;
    tick(6 * 60 * 60 * 1000); flushMicrotasks();
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(removeNative).toHaveBeenCalledTimes(1);
  }));

  it('checks on return to the foreground and avoids background interval requests', fakeAsync(() => {
    const updates = TestBed.inject(AndroidUpdateService);
    updates.start(); flushMicrotasks();
    const foreground = onAppStateChange.calls.mostRecent().args[0] as (active: boolean) => void;
    foreground(false);
    now += 6 * 60 * 60 * 1000;
    tick(6 * 60 * 60 * 1000); flushMicrotasks();
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    foreground(true); flushMicrotasks();
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    foreground(false); foreground(true); flushMicrotasks();
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    TestBed.resetTestingModule(); flushMicrotasks();
  }));
});
