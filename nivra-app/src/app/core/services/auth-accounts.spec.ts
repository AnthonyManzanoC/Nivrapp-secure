import { computed, signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { AuthSession } from '../models/nivra.models';
import { AccountSessionsSnapshot } from './account-sessions.service';
import { AuthService } from './auth.service';

describe('two saved authenticated accounts', () => {
  const account = (id: string): AuthSession => ({
    user: { id, alias: id, displayName: id, privacySettings: {} },
    device: { id: `device-${id}`, userId: id, isTrusted: true },
    tokens: { accessToken: `access-${id}`, refreshToken: `refresh-${id}` },
  } as AuthSession);
  function harness(initial = ['alice', 'bob']) {
    let snapshot: AccountSessionsSnapshot = { revision: 1, activeUserId: initial[0] ?? null, sessions: initial.map(account) };
    const copy = <T>(value: T): T => structuredClone(value);
    const registry = {
      load: jasmine.createSpy('load').and.callFake(async () => copy(snapshot)),
      upsert: jasmine.createSpy('upsert').and.callFake(async (auth: AuthSession, activate: boolean, guard: () => boolean) => {
        if (!guard()) return null;
        const existing = snapshot.sessions.findIndex(item => item.user.id === auth.user.id);
        if (existing < 0) { if (snapshot.sessions.length >= 2) throw new Error('limit'); snapshot.sessions.push(copy(auth)); }
        else snapshot.sessions[existing] = copy(auth);
        if (activate) snapshot.activeUserId = auth.user.id;
        snapshot.revision++; return copy(snapshot);
      }),
      activate: jasmine.createSpy('activate').and.callFake(async (id: string, guard: () => boolean, deviceId?: string) => {
        if (!guard() || !snapshot.sessions.some(auth => auth.user.id === id && (!deviceId || auth.device.id === deviceId))) return null;
        snapshot.activeUserId = id; snapshot.revision++; return copy(snapshot);
      }),
      remove: jasmine.createSpy('remove').and.callFake(async (id: string, guard: () => boolean, deviceId?: string) => {
        if (!guard() || !snapshot.sessions.some(auth => auth.user.id === id && (!deviceId || auth.device.id === deviceId))) return null;
        snapshot.sessions = snapshot.sessions.filter(auth => auth.user.id !== id);
        if (snapshot.activeUserId === id) snapshot.activeUserId = snapshot.sessions[0]?.user.id ?? null;
        snapshot.revision++; return copy(snapshot);
      }),
      rotateTokens: jasmine.createSpy('rotate').and.callFake(async (id: string, device: string, previous: string, tokens: AuthSession['tokens'], guard: () => boolean) => {
        const existing = snapshot.sessions.find(auth => auth.user.id === id && auth.device.id === device && auth.tokens.refreshToken === previous);
        if (!existing || !guard()) return null;
        existing.tokens = copy(tokens); snapshot.revision++; return copy(snapshot);
      }),
    };
    const session = signal<AuthSession | null>(initial.length ? account(initial[0]) : null);
    const navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    const clearSecret = jasmine.createSpy('clearSecret').and.resolveTo();
    const fetch = jasmine.createSpy('fetch').and.resolveTo(new Response('{}', { status: 200 }));
    const service: any = Object.assign(Object.create(AuthService.prototype), {
      session, accessToken: computed(() => session()?.tokens.accessToken ?? ''), isAuthenticated: computed(() => !!session()),
      accountSessions: registry, sessionWriteEpoch: 0, sessionGeneration: signal(0), authIntentEpoch: 0, accountOperationEpoch: 0,
      savedAccounts: () => snapshot.sessions.map(auth => ({ id: auth.user.id })),
      sessionRestoreComplete: true, destroyed: false, addingReturnUserId: null,
      addingAccount: signal(false), accountsBusy: signal(false), accountError: signal(''), busy: signal(false), pendingPhoneAlias: signal(null),
      deviceIdentityError: signal(''), deviceIdentityNeedsRelink: signal(false),
      launchCache: { clear: jasmine.createSpy('clear') }, router: { navigateByUrl: navigate },
      api: { fetch }, secureVault: { clearSecret }, allowAccountActivation: async () => true,
      stopAuthenticationTransports: async () => undefined, nativeFirebaseSignOut: async () => undefined,
      protectedSessionRestorePromise: null, authRefreshPromise: null, refreshBackoffUntil: 0,
    });
    return { service, registry, navigate, clearSecret, fetch, snapshot: () => copy(snapshot), replace: (next: AccountSessionsSnapshot) => snapshot = next };
  }

  it('switches to the existing slot without using login or replacing either refresh token', async () => {
    const test = harness();
    expect(await test.service.switchAccount('bob')).toBeTrue();
    expect(test.service.session().user.id).toBe('bob');
    expect(test.snapshot().sessions.map(auth => auth.tokens.refreshToken)).toEqual(['refresh-alice', 'refresh-bob']);
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.navigate).toHaveBeenCalledWith('/app/chats', { replaceUrl: true });
    expect(test.service.sessionGeneration()).toBeGreaterThan(0);
  });

  it('restores the registry active pointer before adopting any legacy account', async () => {
    const test = harness();
    const snapshot = test.snapshot(); snapshot.activeUserId = 'bob'; test.replace(snapshot);
    test.service.session.set(null); test.service.sessionRestoreComplete = false;
    const legacy = spyOn(test.service, 'readPlainSession').and.returnValue(account('alice'));
    const adopt = spyOn(test.service, 'adoptSession').and.callThrough();
    await test.service.restoreProtectedSession();
    expect(test.service.session().user.id).toBe('bob');
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('treats an empty registry as authoritative and preserves unreadable registries', async () => {
    const test = harness([]); test.service.sessionRestoreComplete = false;
    const legacy = spyOn(test.service, 'readPlainSession').and.returnValue(account('alice'));
    await test.service.restoreProtectedSession();
    expect(test.service.session()).toBeNull(); expect(legacy).not.toHaveBeenCalled();
    test.service.sessionRestoreComplete = false;
    test.registry.load.and.rejectWith(new Error('ciphertext locked'));
    await test.service.restoreProtectedSession();
    expect(test.service.accountError()).toContain('Sus datos se han conservado');
    expect(test.service.sessionRestoreComplete).toBeFalse();
    expect(test.registry.upsert).not.toHaveBeenCalled();
  });

  it('migrates a legacy browser session into the registry without writing plaintext credentials', async () => {
    const test = harness([]); test.service.sessionRestoreComplete = false;
    test.registry.load.and.resolveTo(null);
    spyOn(test.service, 'readProtectedSessionEnvelope').and.returnValue(null);
    spyOn(test.service, 'readPlainSession').and.returnValue(account('alice'));
    const read = spyOn(localStorage, 'getItem').and.returnValue(null);
    const write = spyOn(localStorage, 'setItem');
    await test.service.restoreProtectedSession();
    expect(test.service.session().user.id).toBe('alice');
    expect(test.registry.upsert).toHaveBeenCalledWith(account('alice'), true, jasmine.any(Function));
    expect(write).not.toHaveBeenCalled(); expect(read).toHaveBeenCalled();
  });

  it('keeps the first slot while adding and restores it on cancel without restoring over the add form', async () => {
    const test = harness(['alice']);
    await test.service.beginAddAccount();
    expect(test.service.session()).toBeNull();
    expect(test.service.addingAccount()).toBeTrue();
    expect(test.snapshot().sessions.map(auth => auth.user.id)).toEqual(['alice']);
    await test.service.restoreProtectedSession();
    expect(test.service.session()).toBeNull();
    await test.service.cancelAddAccount();
    expect(test.service.session().user.id).toBe('alice');
    expect(test.service.addingAccount()).toBeFalse();
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it('rejects adding a third account without leaving the current account', async () => {
    const test = harness();
    await expectAsync(test.service.beginAddAccount()).toBeRejectedWithError(/hasta dos/);
    expect(test.service.session().user.id).toBe('alice');
    expect(test.snapshot().sessions.length).toBe(2);
    expect(test.service.accountsBusy()).toBeFalse();
  });

  it('logs out only the active slot and opens the retained account with its own credentials', async () => {
    const test = harness();
    await test.service.logout();
    expect(test.snapshot().sessions.map(auth => auth.user.id)).toEqual(['bob']);
    expect(test.service.session().user.id).toBe('bob');
    expect(test.clearSecret).not.toHaveBeenCalled();
    const request = test.fetch.calls.first().args[1] as RequestInit;
    expect(request.headers).toEqual(jasmine.objectContaining({ Authorization: 'Bearer access-alice', 'X-Nivra-Device-Id': 'device-alice' }));
  });

  it('returns to welcome after closing the final account without erasing shared device keys', async () => {
    const test = harness(['alice']);
    test.service.onboarding = { restart: jasmine.createSpy('restart') };
    await test.service.logout();
    expect(test.service.session()).toBeNull();
    expect(test.service.onboarding.restart).toHaveBeenCalledTimes(1);
    expect(test.navigate).toHaveBeenCalledWith('/welcome', { replaceUrl: true });
    expect(test.clearSecret).not.toHaveBeenCalled();
  });

  it('removes the inactive slot without navigating or changing the active session', async () => {
    const test = harness();
    await test.service.removeAccount('bob');
    expect(test.service.session().user.id).toBe('alice');
    expect(test.navigate).not.toHaveBeenCalled();
    expect(test.clearSecret).not.toHaveBeenCalled();
    expect(test.snapshot().sessions.map(auth => auth.user.id)).toEqual(['alice']);
  });

  it('does not let a deferred signed-out logout clear a subsequently activated account', async () => {
    const test = harness(); test.service.session.set(null);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => release = resolve);
    test.service.stopAuthenticationTransports = jasmine.createSpy('stop').and.returnValues(waiting, Promise.resolve());
    const logout = test.service.logout(true);
    expect(await test.service.switchAccount('bob')).toBeTrue();
    release(); await logout;
    expect(test.service.session().user.id).toBe('bob');
    expect(test.navigate.calls.mostRecent().args[0]).toBe('/app/chats');
  });

  it('does not use or remove a new device slot on a delayed old device notification', async () => {
    const test = harness();
    const snapshot = test.snapshot(); snapshot.sessions[1].device.id = 'bob-new-device'; test.replace(snapshot);
    expect(await test.service.switchToStoredAccount('bob', 'device-bob')).toBeFalse();
    await test.service.removeStoredAccount('bob', 'device-bob');
    expect(test.registry.remove).not.toHaveBeenCalled();
    expect(test.service.session().user.id).toBe('alice');
  });

  it('rotates only tokens across Alice to Bob to Alice while preserving the new profile and generation', async () => {
    const test = harness();
    let finish!: (value: Response) => void;
    test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const pending = test.service.refreshToken();
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(test.fetch).toHaveBeenCalledTimes(1);
    await test.service.switchAccount('bob'); await test.service.switchAccount('alice');
    test.service.session.set({ ...test.service.session(), user: { ...test.service.session().user, displayName: 'Current profile' } });
    const generation = test.service.sessionGeneration();
    finish(new Response(JSON.stringify({ accessToken: 'obsolete-access', refreshToken: 'obsolete-refresh' })));
    expect(await pending).toBeFalse();
    expect(test.service.session().tokens.accessToken).toBe('obsolete-access');
    expect(test.service.session().user.displayName).toBe('Current profile');
    expect(test.service.sessionGeneration()).toBe(generation);
    expect(test.snapshot().sessions[0].tokens.refreshToken).toBe('obsolete-refresh');
  });

  it('retains the rotated inactive credential without changing the current account', async () => {
    const test = harness();
    let finish!: (value: Response) => void;
    test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const pending = test.service.refreshToken();
    for (let step = 0; step < 8; step++) await Promise.resolve();
    await test.service.switchAccount('bob');
    finish(new Response(JSON.stringify({ accessToken: 'new-alice', refreshToken: 'new-refresh-alice' })));
    expect(await pending).toBeFalse();
    expect(test.service.session().user.id).toBe('bob');
    expect(test.service.session().tokens.refreshToken).toBe('refresh-bob');
    expect(test.snapshot().sessions[0].tokens.refreshToken).toBe('new-refresh-alice');
    await test.service.switchAccount('alice');
    expect(test.service.session().tokens.refreshToken).toBe('new-refresh-alice');
  });

  it('never restores a removed slot when its successful refresh arrives later', async () => {
    const test = harness();
    let finish!: (value: Response) => void;
    test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const pending = test.service.refreshToken();
    for (let step = 0; step < 8; step++) await Promise.resolve();
    await test.service.removeStoredAccount('alice', 'device-alice');
    finish(new Response(JSON.stringify({ accessToken: 'late-alice', refreshToken: 'late-refresh-alice' })));
    expect(await pending).toBeFalse();
    expect(test.snapshot().sessions.map(auth => auth.user.id)).toEqual(['bob']);
    expect(test.service.session().user.id).toBe('bob');
  });

  it('coalesces an old refresh and a new active caller for the same exact credential', async () => {
    const test = harness();
    let finish!: (value: Response) => void;
    test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const old = test.service.refreshToken();
    for (let step = 0; step < 8; step++) await Promise.resolve();
    await test.service.switchAccount('bob'); await test.service.switchAccount('alice');
    const current = test.service.refreshToken();
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(test.fetch).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ accessToken: 'new-alice', refreshToken: 'new-refresh-alice' })));
    expect(await old).toBeFalse(); expect(await current).toBeTrue();
    expect(test.service.session().tokens.refreshToken).toBe('new-refresh-alice');
  });

  it('persists a refresh only into the active slot and keeps the other token intact', async () => {
    const test = harness();
    test.fetch.and.resolveTo(new Response(JSON.stringify({ accessToken: 'rotated-alice', refreshToken: 'rotated-refresh' })));
    expect(await test.service.refreshToken()).toBeTrue();
    expect(test.snapshot().sessions[0].tokens.accessToken).toBe('rotated-alice');
    expect(test.snapshot().sessions[1].tokens.refreshToken).toBe('refresh-bob');
  });

  it('discards a late password login after canceling the add-account form', async () => {
    const test = harness(['alice']);
    await test.service.beginAddAccount();
    const login = new Subject<unknown>();
    test.service.api.post = jasmine.createSpy('post').and.returnValues(of({ alias: 'bob', userId: 'bob' }), login);
    test.service.deviceProfile = async () => ({ name: 'Fixture', hardwareId: 'fixture' });
    test.service.crypto = { prepareDeviceKeys: async () => ({ keyBundle: {} }), saveDeviceKeys: jasmine.createSpy('save') };
    const pending = test.service.loginWithAlias('bob', 'synthetic-password', 'login');
    for (let step = 0; step < 6; step++) await Promise.resolve();
    await test.service.cancelAddAccount();
    login.next(account('bob')); login.complete(); await pending;
    expect(test.service.session().user.id).toBe('alice');
    expect(test.service.crypto.saveDeviceKeys).not.toHaveBeenCalled();
    expect(test.snapshot().sessions.map(auth => auth.user.id)).toEqual(['alice']);
  });

  it('coalesces inactive desktop refreshes using only that slot credential without adopting its session', async () => {
    const test = harness(); const state = test.snapshot(); state.sessions[1].tokens.accessTokenExpiresAt = '2000-01-01T00:00:00Z'; test.replace(state);
    let finish!: (value: Response) => void; test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const active = test.service.session();
    const first = test.service.getFreshStoredSessionCredentials('bob', 'device-bob');
    const second = test.service.getFreshStoredSessionCredentials('bob', 'device-bob');
    for (let step = 0; step < 12; step++) await Promise.resolve();
    expect(test.fetch).toHaveBeenCalledTimes(1); expect(JSON.parse(test.fetch.calls.first().args[1].body).refreshToken).toBe('refresh-bob');
    finish(new Response(JSON.stringify({ accessToken: 'fresh-bob', refreshToken: 'fresh-refresh-bob' })));
    expect((await first).tokens.accessToken).toBe('fresh-bob'); expect((await second).tokens.refreshToken).toBe('fresh-refresh-bob');
    expect(test.service.session()).toBe(active); expect(test.snapshot().sessions[0].tokens.refreshToken).toBe('refresh-alice');
    expect(test.navigate).not.toHaveBeenCalled();
  });

  it('reconciles shared desktop rotation before an active caller retries with the newly selected account', async () => {
    const test = harness(); const state = test.snapshot(); state.sessions[1].tokens.accessTokenExpiresAt = '2000-01-01T00:00:00Z'; test.replace(state);
    let finish!: (value: Response) => void; test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const desktop = test.service.getFreshStoredSessionCredentials('bob', 'device-bob');
    for (let step = 0; step < 12; step++) await Promise.resolve();
    await test.service.switchAccount('bob'); const current = test.service.refreshToken();
    for (let step = 0; step < 12; step++) await Promise.resolve();
    expect(test.fetch).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ accessToken: 'fresh-bob', refreshToken: 'fresh-refresh-bob' })));
    await desktop; expect(await current).toBeTrue(); expect(test.service.session().tokens.accessToken).toBe('fresh-bob');
    expect(test.service.session().user.id).toBe('bob');
  });

  it('does not restore a removed inactive slot after its desktop refresh completes', async () => {
    const test = harness(); const state = test.snapshot(); state.sessions[1].tokens.accessTokenExpiresAt = '2000-01-01T00:00:00Z'; test.replace(state);
    let finish!: (value: Response) => void; test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const desktop = test.service.getFreshStoredSessionCredentials('bob', 'device-bob');
    for (let step = 0; step < 12; step++) await Promise.resolve();
    await test.service.removeStoredAccount('bob', 'device-bob');
    finish(new Response(JSON.stringify({ accessToken: 'late-bob', refreshToken: 'late-refresh-bob' })));
    expect(await desktop).toBeNull(); expect(test.snapshot().sessions.map(auth => auth.user.id)).toEqual(['alice']);
    expect(test.service.session().user.id).toBe('alice');
  });

  it('does not apply an old desktop FORCE_WIPE to a replacement credential', async () => {
    const test = harness(); const state = test.snapshot(); state.sessions[1].tokens.accessTokenExpiresAt = '2000-01-01T00:00:00Z'; test.replace(state);
    let finish!: (value: Response) => void; test.fetch.and.returnValue(new Promise<Response>(resolve => finish = resolve));
    const desktop = test.service.getFreshStoredSessionCredentials('bob', 'device-bob');
    for (let step = 0; step < 12; step++) await Promise.resolve();
    const replacement = test.snapshot(); replacement.sessions[1].tokens = { accessToken: 'replacement', refreshToken: 'replacement-refresh' }; test.replace(replacement);
    finish(new Response('{}', { status: 401, headers: { 'X-Nivra-Action': 'FORCE_WIPE' } }));
    expect((await desktop).tokens.refreshToken).toBe('replacement-refresh'); expect(test.service.session().user.id).toBe('alice');
  });
});
