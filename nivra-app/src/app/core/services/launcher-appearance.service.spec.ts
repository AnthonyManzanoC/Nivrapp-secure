import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import {
  LAUNCHER_APPEARANCE_RUNTIME, LAUNCHER_APPEARANCE_TIMEOUT_MS, LAUNCHER_ICON_IDS,
  LauncherAppearanceRuntime, LauncherAppearanceService, LauncherIconId,
} from './launcher-appearance.service';

describe('LauncherAppearanceService', () => {
  let runtime: LauncherAppearanceRuntime;
  let getState: jasmine.Spy;
  let setIcon: jasmine.Spy;

  beforeEach(() => {
    getState = jasmine.createSpy('getState').and.resolveTo({ supported: true, icon: 'original', scope: 'os-user' });
    setIcon = jasmine.createSpy('setIcon').and.callFake(async icon => ({ supported: true, icon, scope: 'os-user' }));
    runtime = { platform: 'windows', bridge: { getState, setIcon } };
    TestBed.configureTestingModule({ providers: [{ provide: LAUNCHER_APPEARANCE_RUNTIME, useValue: runtime }] });
  });

  it('reads native preference on entry and shares a single pending refresh', async () => {
    getState.and.resolveTo({ supported: true, icon: 'emerald', scope: 'os-user' });
    const service = TestBed.inject(LauncherAppearanceService);
    expect(service.busy()).toBeTrue();
    const first = service.refresh();
    expect(service.refresh()).toBe(first);
    await first;
    expect(service.platform()).toBe('windows');
    expect(service.current()).toBe('emerald');
    expect(service.supported()).toBeTrue();
    expect(service.busy()).toBeFalse();
    expect(service.error()).toBeNull();
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('supports all three bundled variants without using URLs or local storage', async () => {
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    for (const icon of LAUNCHER_ICON_IDS) {
      expect(await service.selectIcon(icon)).toBeTrue();
      expect(service.current()).toBe(icon);
    }
    expect(setIcon.calls.allArgs()).toEqual([['emerald'], ['ivory']]);
    expect(await service.selectIcon('ivory')).toBeTrue();
    expect(setIcon).toHaveBeenCalledTimes(2);
  });

  it('keeps the old preference until native success and prevents overlapping mutations', async () => {
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    let complete!: (value: unknown) => void;
    setIcon.and.returnValue(new Promise(resolve => { complete = resolve; }));
    const first = service.selectIcon('emerald');
    expect(service.current()).toBe('original');
    expect(service.busy()).toBeTrue();
    expect(await service.selectIcon('ivory')).toBeFalse();
    await service.refresh();
    expect(setIcon).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledTimes(1);
    complete({ supported: true, icon: 'emerald' });
    expect(await first).toBeTrue();
    expect(service.current()).toBe('emerald');
  });

  it('retains the prior selection and sanitizes native mutation errors', async () => {
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    setIcon.and.rejectWith(new Error('C:\\private\\profile\\error'));
    expect(await service.selectIcon('ivory')).toBeFalse();
    expect(service.current()).toBe('original');
    expect(service.error()).toBe('failed');
    expect(service.busy()).toBeFalse();
    setIcon.and.resolveTo({ supported: true, icon: 'ivory' });
    expect(await service.selectIcon('ivory')).toBeTrue();
    expect(service.error()).toBeNull();
  });

  it('does not report success when the native response selects a different or malformed icon', async () => {
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    for (const response of [null, { supported: true, icon: 'original' }, { supported: false, icon: 'emerald' }, { supported: true, icon: '../icon' }]) {
      setIcon.and.resolveTo(response);
      expect(await service.selectIcon('emerald')).toBeFalse();
      expect(service.current()).toBe('original');
      expect(service.error()).toBe('failed');
    }
  });

  it('rejects untrusted icon values before invoking a native action', async () => {
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    for (const value of ['../icon', 'https://bad.test/icon.ico', 'C:\\icon.ico', '', null, {}]) {
      expect(await service.selectIcon(value as LauncherIconId)).toBeFalse();
    }
    expect(setIcon).not.toHaveBeenCalled();
    expect(service.current()).toBe('original');
  });

  it('keeps web unsupported and performs no native calls', async () => {
    runtime.platform = 'unsupported'; runtime.bridge = null;
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    expect(service.platform()).toBe('unsupported');
    expect(service.supported()).toBeFalse();
    expect(service.error()).toBeNull();
    expect(getState).not.toHaveBeenCalled();
    expect(setIcon).not.toHaveBeenCalled();
  });

  it('identifies an old Windows client while leaving unavailable actions disabled', async () => {
    runtime.bridge = null;
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    expect(service.platform()).toBe('windows');
    expect(service.supported()).toBeFalse();
    expect(service.error()).toBe('unavailable');
    expect(await service.selectIcon('emerald')).toBeFalse();
    expect(setIcon).not.toHaveBeenCalled();
  });

  it('treats unsupported or malformed native state as unavailable and permits recovery', async () => {
    runtime.platform = 'android';
    getState.and.resolveTo({ supported: true, icon: 'https://bad.test/icon.png' });
    const service = TestBed.inject(LauncherAppearanceService);
    await service.refresh();
    expect(service.platform()).toBe('android');
    expect(service.supported()).toBeFalse();
    expect(service.error()).toBe('unavailable');
    getState.and.resolveTo({ supported: true, icon: 'ivory', scope: 'installation' });
    await service.refresh();
    expect(service.supported()).toBeTrue();
    expect(service.current()).toBe('ivory');
  });

  it('releases a stalled native read and ignores its late completion', fakeAsync(() => {
    let complete!: (value: unknown) => void;
    getState.and.returnValue(new Promise(resolve => { complete = resolve; }));
    const service = TestBed.inject(LauncherAppearanceService);
    tick(LAUNCHER_APPEARANCE_TIMEOUT_MS); flushMicrotasks();
    expect(service.busy()).toBeFalse();
    expect(service.error()).toBe('unavailable');
    complete({ supported: true, icon: 'emerald' }); flushMicrotasks();
    expect(service.current()).toBe('original');
    expect(service.supported()).toBeFalse();
    getState.and.resolveTo({ supported: true, icon: 'ivory' });
    void service.refresh(); flushMicrotasks();
    expect(service.current()).toBe('ivory');
    expect(service.supported()).toBeTrue();
  }));

  it('releases a stalled native selection without changing its displayed preference', fakeAsync(() => {
    const service = TestBed.inject(LauncherAppearanceService);
    flushMicrotasks();
    setIcon.and.returnValue(new Promise(() => undefined));
    let result: boolean | undefined;
    void service.selectIcon('emerald').then(value => { result = value; });
    tick(LAUNCHER_APPEARANCE_TIMEOUT_MS); flushMicrotasks();
    expect(result).toBeFalse();
    expect(service.busy()).toBeFalse();
    expect(service.error()).toBe('failed');
    expect(service.current()).toBe('original');
  }));
});
