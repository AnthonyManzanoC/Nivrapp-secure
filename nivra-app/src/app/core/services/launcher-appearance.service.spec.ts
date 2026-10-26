import { DOCUMENT } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import {
  LAUNCHER_APPEARANCE_RUNTIME, LAUNCHER_APPEARANCE_TIMEOUT_MS, LAUNCHER_ICON_IDS,
  AccountAppearance, LauncherAppearanceRuntime, LauncherAppearanceService, LauncherIconId,
} from './launcher-appearance.service';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

describe('account launcher appearance synchronization', () => {
  const accountA = 'launcher-spec-A';
  const accountB = 'launcher-spec-B';
  let runtime: LauncherAppearanceRuntime;
  let getState: jasmine.Spy;
  let setIcon: jasmine.Spy;
  let api: { get: jasmine.Spy; put: jasmine.Spy };
  let events: Subject<{ type: string; payload: unknown }>;
  let session: ReturnType<typeof signal<any>>;
  let server: Map<string, AccountAppearance>;
  let physical: LauncherIconId;
  let page: Document;
  const cacheKey = (account: string) => `nivra.launcher.account.v1.${encodeURIComponent(account)}`;
  const settle = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };

  beforeEach(() => {
    localStorage.removeItem(cacheKey(accountA)); localStorage.removeItem(cacheKey(accountB));
    session = signal<any>({ user: { id: accountA }, device: { id: 'device-A' } });
    events = new Subject();
    server = new Map([[accountA, { icon: 'original', revision: 0 }], [accountB, { icon: 'ivory', revision: 4 }]]);
    physical = 'original';
    getState = jasmine.createSpy('getState').and.callFake(async () => ({ supported: true, icon: physical }));
    setIcon = jasmine.createSpy('setIcon').and.callFake(async (icon: LauncherIconId) => {
      physical = icon; return { supported: true, icon };
    });
    runtime = { platform: 'windows', bridge: { getState, setIcon } };
    api = {
      get: jasmine.createSpy('get').and.callFake(() => of(server.get(session()?.user.id)!)),
      put: jasmine.createSpy('put').and.callFake((_path: string, body: { icon: LauncherIconId; expectedRevision: number }) => {
        const preference = { icon: body.icon, revision: body.expectedRevision + 1 };
        server.set(session()?.user.id, preference); return of(preference);
      }),
    };
    page = document.implementation.createHTMLDocument('Launcher fixture');
    const base = page.createElement('base'); base.href = 'https://nivra.example/'; page.head.append(base);
    TestBed.configureTestingModule({ providers: [
      { provide: DOCUMENT, useValue: page }, { provide: LAUNCHER_APPEARANCE_RUNTIME, useValue: runtime },
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session() } },
      { provide: NivraApiService, useValue: api }, { provide: SignalrService, useValue: { events$: events } },
    ] });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem(cacheKey(accountA)); localStorage.removeItem(cacheKey(accountB));
  });

  it('reads the account preference on startup and shares a single pending refresh', async () => {
    server.set(accountA, { icon: 'emerald', revision: 3 });
    const service = TestBed.inject(LauncherAppearanceService);
    const first = service.refresh(); expect(service.refresh()).toBe(first);
    await first;
    expect(service.accountId()).toBe(accountA);
    expect(service.current()).toBe('emerald'); expect(service.revision()).toBe(3);
    expect(service.synced()).toBeTrue(); expect(service.supported()).toBeTrue();
    expect(getState).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledOnceWith('/account/appearance');
    expect(setIcon).toHaveBeenCalledOnceWith('emerald');
  });

  it('saves the three allowlisted variants with CAS and skips an already confirmed preference', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    for (const icon of LAUNCHER_ICON_IDS) {
      expect(await service.selectIcon(icon)).toBeTrue(); expect(service.current()).toBe(icon);
    }
    expect(api.put.calls.allArgs()).toEqual([
      ['/account/appearance', { icon: 'emerald', expectedRevision: 0 }],
      ['/account/appearance', { icon: 'ivory', expectedRevision: 1 }],
    ]);
    expect(setIcon.calls.allArgs()).toEqual([['emerald'], ['ivory']]);
    expect(await service.selectIcon('ivory')).toBeTrue(); expect(api.put).toHaveBeenCalledTimes(2);
  });

  it('does not change a device icon until the server confirms the account write', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    const response = new Subject<AccountAppearance>(); api.put.and.returnValue(response);
    const pending = service.selectIcon('emerald');
    expect(service.current()).toBe('original'); expect(setIcon).not.toHaveBeenCalled();
    expect(await service.selectIcon('ivory')).toBeFalse();
    response.next({ icon: 'emerald', revision: 1 });
    expect(await pending).toBeTrue(); expect(service.current()).toBe('emerald');
    expect(service.busy()).toBeFalse(); expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous selection when account synchronization fails and does not expose raw errors', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    api.put.and.returnValue(throwError(() => new Error('C:\\private\\account\\failure')));
    expect(await service.selectIcon('ivory')).toBeFalse();
    expect(service.current()).toBe('original'); expect(service.error()).toBe('sync');
    expect(setIcon).not.toHaveBeenCalled(); expect(service.busy()).toBeFalse();
  });

  it('retains a saved account preference after native failure and retries applying without another write', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    setIcon.and.rejectWith(new Error('native secret path'));
    expect(await service.selectIcon('ivory')).toBeFalse();
    expect(service.current()).toBe('original'); expect(service.error()).toBe('failed');
    expect(service.revision()).toBe(1); expect(service.synced()).toBeTrue();
    setIcon.and.resolveTo({ supported: true, icon: 'ivory' });
    expect(await service.selectIcon('ivory')).toBeTrue(); expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('does not report native success for malformed or mismatched confirmations', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    for (const result of [null, { supported: false, icon: 'emerald' }, { supported: true, icon: 'original' }, { supported: true, icon: '../icon' }]) {
      setIcon.and.resolveTo(result);
      expect(await service.selectIcon('emerald')).toBeFalse();
      expect(service.current()).toBe('original'); expect(service.error()).toBe('failed');
    }
  });

  it('rejects untrusted icon values before calling the server or native bridge', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    for (const value of ['../icon', 'https://bad.test/icon.ico', 'C:\\icon.ico', '', null, {}]) {
      expect(await service.selectIcon(value as LauncherIconId)).toBeFalse();
    }
    expect(api.put).not.toHaveBeenCalled(); expect(setIcon).not.toHaveBeenCalled();
  });

  it('rejects malformed server policies instead of applying server-provided paths or invalid revisions', async () => {
    api.get.and.returnValue(of({ icon: 'https://bad.test/icon.png', revision: 1 }));
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    expect(service.synced()).toBeFalse(); expect(service.revision()).toBeNull(); expect(setIcon).not.toHaveBeenCalled();
    for (const response of [{ icon: 'ivory', revision: -1 }, { icon: 'ivory', revision: 1.5 }, { icon: 'ivory', revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      api.get.and.returnValue(of(response)); await service.refresh();
      expect(service.current()).toBe('original'); expect(service.error()).toBe('sync');
    }
  });

  it('resolves a CAS conflict by reading the newer account preference without overwriting it', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    server.set(accountA, { icon: 'ivory', revision: 7 });
    api.put.and.returnValue(throwError(() => ({ status: 409 })));
    expect(await service.selectIcon('emerald')).toBeFalse();
    expect(service.current()).toBe('ivory'); expect(service.revision()).toBe(7);
    expect(service.error()).toBe('conflict'); expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('ignores a delayed GET from account A after switching to account B', async () => {
    const old = new Subject<AccountAppearance>();
    api.get.and.callFake(() => session()?.user.id === accountA ? old : of(server.get(accountB)!));
    const service = TestBed.inject(LauncherAppearanceService);
    const pendingA = service.refresh(); await settle();
    session.set({ user: { id: accountB }, device: { id: 'device-B' } });
    await service.refresh(); old.next({ icon: 'emerald', revision: 99 }); await pendingA;
    expect(service.accountId()).toBe(accountB); expect(service.current()).toBe('ivory');
    expect(service.revision()).toBe(4); expect(localStorage.getItem(cacheKey(accountA))).toBeNull();
  });

  it('discards a successful write response from an account that has since signed out', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    const response = new Subject<AccountAppearance>(); api.put.and.returnValue(response);
    const pending = service.selectIcon('emerald');
    session.set(null); await service.refresh();
    response.next({ icon: 'emerald', revision: 1 });
    expect(await pending).toBeFalse(); expect(service.accountId()).toBeNull(); expect(setIcon).not.toHaveBeenCalled();
    expect(page.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toContain('launcher-original.png');
  });

  it('never imports a device-local or another account cached preference as the current account setting', async () => {
    physical = 'emerald';
    localStorage.setItem(cacheKey(accountA), JSON.stringify({ userId: accountB, icon: 'emerald', revision: 88 }));
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    expect(service.current()).toBe('original'); expect(service.revision()).toBe(0);
    expect(api.put).not.toHaveBeenCalled(); expect(setIcon).toHaveBeenCalledOnceWith('original');
  });

  it('restores only the signed-in account cached choice offline and marks synchronization unconfirmed', async () => {
    localStorage.setItem(cacheKey(accountA), JSON.stringify({ userId: accountA, icon: 'emerald', revision: 2 }));
    api.get.and.returnValue(throwError(() => ({ status: 0 })));
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    expect(service.current()).toBe('emerald'); expect(service.revision()).toBe(2);
    expect(service.synced()).toBeFalse(); expect(service.error()).toBe('sync'); expect(api.put).not.toHaveBeenCalled();
  });

  it('lets an authoritative GET repair an implausible future revision in the local cache', async () => {
    localStorage.setItem(cacheKey(accountA), JSON.stringify({ userId: accountA, icon: 'emerald', revision: 999 }));
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    expect(service.revision()).toBe(0); expect(service.current()).toBe('original'); expect(service.synced()).toBeTrue();
    expect(await service.selectIcon('ivory')).toBeTrue();
    expect(api.put).toHaveBeenCalledOnceWith('/account/appearance', { icon: 'ivory', expectedRevision: 0 });
  });

  it('updates the bundled web favicon without invoking a native bridge', async () => {
    runtime.platform = 'web'; runtime.bridge = null;
    server.set(accountA, { icon: 'emerald', revision: 3 });
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    expect(service.platform()).toBe('web'); expect(service.supported()).toBeTrue();
    expect(page.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toBe('https://nivra.example/assets/brand/launcher-emerald.png');
    expect(page.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href).toBe('https://nivra.example/assets/brand/manifest-emerald.webmanifest');
    expect(getState).not.toHaveBeenCalled(); expect(setIcon).not.toHaveBeenCalled();
    expect(await service.selectIcon('ivory')).toBeTrue();
    expect(page.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toContain('launcher-ivory.png');
    expect(page.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href).toContain('manifest-ivory.webmanifest');
  });

  it('treats appearance events as authorized refresh hints and ignores their untrusted payload', async () => {
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    server.set(accountA, { icon: 'ivory', revision: 2 });
    events.next({ type: 'account.appearanceChanged', payload: { icon: '../malicious', revision: 999 } });
    await service.refresh();
    expect(service.current()).toBe('ivory'); expect(service.revision()).toBe(2);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('does not lose an appearance event received while an older GET is in flight', async () => {
    const old = new Subject<AccountAppearance>(); api.get.and.returnValues(old, of({ icon: 'ivory', revision: 2 }));
    const service = TestBed.inject(LauncherAppearanceService); const pending = service.refresh(); await settle();
    events.next({ type: 'account.appearanceChanged', payload: null });
    old.next({ icon: 'emerald', revision: 1 }); await pending; await settle();
    expect(api.get).toHaveBeenCalledTimes(2); expect(service.current()).toBe('ivory'); expect(service.revision()).toBe(2);
  });

  it('keeps an old Windows client unavailable without bypassing its missing native bridge', async () => {
    runtime.bridge = null;
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    expect(service.supported()).toBeFalse(); expect(service.error()).toBe('unavailable');
    expect(await service.selectIcon('ivory')).toBeFalse(); expect(api.put).not.toHaveBeenCalled();
  });

  it('contains a malformed native capability and recovers with a later valid read', async () => {
    runtime.platform = 'android'; getState.and.resolveTo({ supported: true, icon: 'https://bad.test/icon.png' });
    const service = TestBed.inject(LauncherAppearanceService); await service.refresh();
    expect(service.supported()).toBeFalse(); expect(service.error()).toBe('unavailable');
    getState.and.resolveTo({ supported: true, icon: 'original' }); await service.refresh();
    expect(service.supported()).toBeTrue(); expect(service.error()).toBeNull();
  });

  it('releases a stalled native read and ignores its late completion', fakeAsync(() => {
    let complete!: (value: unknown) => void;
    getState.and.returnValue(new Promise(resolve => { complete = resolve; }));
    const service = TestBed.inject(LauncherAppearanceService);
    tick(LAUNCHER_APPEARANCE_TIMEOUT_MS); flushMicrotasks();
    expect(service.busy()).toBeFalse(); expect(service.error()).toBe('unavailable');
    complete({ supported: true, icon: 'emerald' }); flushMicrotasks();
    expect(service.current()).toBe('original'); expect(service.supported()).toBeFalse();
    TestBed.resetTestingModule();
  }));

  it('releases a stalled native mutation while retaining the confirmed account preference for retry', fakeAsync(() => {
    const service = TestBed.inject(LauncherAppearanceService); flushMicrotasks();
    setIcon.and.returnValue(new Promise(() => undefined));
    let result: boolean | undefined; void service.selectIcon('emerald').then(value => { result = value; });
    flushMicrotasks(); tick(LAUNCHER_APPEARANCE_TIMEOUT_MS); flushMicrotasks();
    expect(result).toBeFalse(); expect(service.current()).toBe('original');
    expect(service.revision()).toBe(1); expect(service.error()).toBe('failed'); expect(service.busy()).toBeFalse();
    TestBed.resetTestingModule();
  }));

  it('restores account B if an uncancellable account A native action completes after its timeout', fakeAsync(() => {
    const service = TestBed.inject(LauncherAppearanceService); flushMicrotasks();
    let finishA!: (value: unknown) => void;
    setIcon.and.callFake((icon: LauncherIconId) => {
      if (icon === 'emerald') return new Promise(resolve => { finishA = resolve; });
      physical = icon; return Promise.resolve({ supported: true, icon });
    });
    let resultA: boolean | undefined;
    void service.selectIcon('emerald').then(result => { resultA = result; }); flushMicrotasks();
    session.set({ user: { id: accountB }, device: { id: 'device-B' } });
    void service.refresh(); flushMicrotasks();
    tick(LAUNCHER_APPEARANCE_TIMEOUT_MS); flushMicrotasks();
    expect(resultA).toBeFalse(); expect(service.current()).toBe('ivory'); expect(physical).toBe('ivory');
    physical = 'emerald'; finishA({ supported: true, icon: 'emerald' }); flushMicrotasks();
    expect(service.accountId()).toBe(accountB); expect(service.current()).toBe('ivory'); expect(physical).toBe('ivory');
    expect(setIcon.calls.allArgs()).toEqual([['emerald'], ['ivory'], ['ivory']]);
    expect(api.put).toHaveBeenCalledTimes(1);
    TestBed.resetTestingModule();
  }));
});
