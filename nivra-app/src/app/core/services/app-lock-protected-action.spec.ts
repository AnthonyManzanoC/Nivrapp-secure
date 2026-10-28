import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AccountLockPolicy, AccountLockPolicyService } from './account-lock-policy.service';
import { AppLockService } from './app-lock.service';
import { AuthService } from './auth.service';
import { PlatformUnlockService } from './platform-unlock.service';
import { privateChatLockStorageKey, writePrivateChatLocks } from './private-chat-lock-metadata';

describe('fresh authentication for protected chats', () => {
  const firstAccount = 'protected-action-first';
  const secondAccount = 'protected-action-second';
  const accountSession = (userId = firstAccount, deviceId = 'trusted-device') => ({ user: { id: userId }, device: { id: deviceId, isTrusted: true, revokedAt: null } });
  const session = signal<any>(null);
  const generation = signal(1);
  const policy = signal<AccountLockPolicy | null>(null);
  const unresolved = signal(false);
  let envelope: AccountLockPolicy['pinEnvelope'];
  let service: AppLockService;
  let platform: { availability: jasmine.Spy; verify: jasmine.Spy; cancel: jasmine.Spy };
  let originalStorage: Array<[string, string | null]>;

  beforeAll(async () => {
    const cryptoOnly = Object.create(AppLockService.prototype) as any;
    envelope = await cryptoOnly.createPinEnvelope('5082', firstAccount);
  });
  beforeEach(async () => {
    const keys = [firstAccount, secondAccount].flatMap(account => [`nivra.appLock.v1.${account}`, `nivra.appLock.attempts.v1.${account}`, privateChatLockStorageKey(account)]);
    originalStorage = keys.map(key => [key, localStorage.getItem(key)]);
    keys.forEach(key => localStorage.removeItem(key));
    session.set(accountSession()); generation.set(1); unresolved.set(false);
    policy.set({ userId: firstAccount, revision: 1, enabled: true, pinEnvelope: envelope, updatedAt: '2026-10-27T00:00:00Z' });
    platform = {
      availability: jasmine.createSpy('availability').and.resolveTo({ available: false, enrolled: false, label: 'Verificación del dispositivo' }),
      verify: jasmine.createSpy('verify').and.resolveTo(true), cancel: jasmine.createSpy('cancel'),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session, sessionGeneration: generation, isAuthenticated: () => !!session() } },
      { provide: AccountLockPolicyService, useValue: { policy, unresolved, syncing: signal(false), syncError: signal('') } },
      { provide: PlatformUnlockService, useValue: platform },
    ] });
    service = TestBed.inject(AppLockService); TestBed.flushEffects(); await Promise.resolve();
    service.unlock(); platform.cancel.calls.reset();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    originalStorage.forEach(([key, value]) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
  });

  it('requires the actual account PIN even when the app is already unlocked, without changing its lock cycle', async () => {
    const cycle = service.lockCycle();
    expect(service.isLocked()).toBeFalse();
    expect(await service.verifyProtectedAction('5083')).toBeFalse();
    expect(await service.verifyProtectedAction('5082')).toBeTrue();
    expect(service.isLocked()).toBeFalse(); expect(service.lockCycle()).toBe(cycle);
    expect(service.busy()).toBeFalse();
    expect(localStorage.getItem(`nivra.appLock.v1.${firstAccount}`)).not.toContain('5082');
  });

  it('rejects an absent PIN and unresolved, disabled, untrusted or globally locked contexts before crypto', async () => {
    const verify = spyOn<any>(service, 'verifyPinEnvelope').and.resolveTo(true);
    expect(await service.verifyProtectedAction(undefined)).toBeFalse();
    expect(await service.verifyProtectedAction('12')).toBeFalse();
    unresolved.set(true); expect(await service.verifyProtectedAction('5082')).toBeFalse(); unresolved.set(false);
    policy.set({ ...policy()!, enabled: false, revision: 2, pinEnvelope: null });
    expect(await service.verifyProtectedAction('5082')).toBeFalse();
    policy.set({ userId: firstAccount, revision: 1, enabled: true, pinEnvelope: envelope, updatedAt: null });
    session.set({ ...accountSession(), device: { ...accountSession().device, isTrusted: false } });
    expect(await service.verifyProtectedAction('5082')).toBeFalse();
    session.set(accountSession()); service.lock();
    expect(await service.verifyProtectedAction('5082')).toBeFalse();
    expect(verify).not.toHaveBeenCalled(); expect(service.isLocked()).toBeTrue();
  });

  it('allows only one costly verification at a time', async () => {
    let finish!: (valid: boolean) => void;
    const verify = spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    service.canUseBiometric.set(true);
    const pending = service.verifyProtectedAction('5082');
    expect(await service.verifyProtectedAction('5082')).toBeFalse();
    expect(await service.verifyProtectedActionWithBiometrics()).toBeFalse();
    expect(verify).toHaveBeenCalledTimes(1); expect(platform.verify).not.toHaveBeenCalled();
    finish(true); expect(await pending).toBeTrue(); expect(service.busy()).toBeFalse();
  });

  it('invalidates a successful PIN result when the account changes before effects run', async () => {
    let finish!: (valid: boolean) => void;
    spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = service.verifyProtectedAction('5082');
    session.set(accountSession(secondAccount, 'other-device')); generation.update(value => value + 1);
    finish(true); expect(await pending).toBeFalse();
    expect(service.isLocked()).toBeFalse();
  });

  it('invalidates an old success across A to B to A even when the visible user and device are unchanged', async () => {
    let finish!: (valid: boolean) => void;
    spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = service.verifyProtectedAction('5082');
    generation.update(value => value + 2);
    finish(true); expect(await pending).toBeFalse();
  });

  it('does not grant access when the shared PIN policy changes during verification, even before applying its effect', async () => {
    let finish!: (valid: boolean) => void;
    spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = service.verifyProtectedAction('5082');
    policy.set({ ...policy()!, revision: 2 });
    finish(true); expect(await pending).toBeFalse();
    TestBed.flushEffects(); expect(service.isLocked()).toBeTrue();
  });

  it('does not grant access when a new global lock starts during verification', async () => {
    let finish!: (valid: boolean) => void;
    spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = service.verifyProtectedAction('5082');
    service.lock(); finish(true);
    expect(await pending).toBeFalse(); expect(service.isLocked()).toBeTrue();
    expect(platform.cancel).toHaveBeenCalledTimes(1);
  });

  it('shares PIN cooldowns with the app lock and does not bypass a cooldown with biometrics', async () => {
    let now = 1800000000000; spyOn(Date, 'now').and.callFake(() => now);
    const verify = spyOn<any>(service, 'verifyPinEnvelope').and.resolveTo(false);
    service.canUseBiometric.set(true);
    for (let attempt = 0; attempt < 5; attempt++) expect(await service.verifyProtectedAction('0000')).toBeFalse();
    expect(service.pinRetrySeconds()).toBe(30);
    expect(await service.verifyProtectedActionWithBiometrics()).toBeFalse();
    expect(await service.verifyProtectedAction('5082')).toBeFalse();
    expect(platform.verify).not.toHaveBeenCalled(); expect(verify).toHaveBeenCalledTimes(5);
    now += 30_001; verify.and.resolveTo(true);
    const cycle = service.lockCycle();
    expect(await service.verifyProtectedAction('5082')).toBeTrue();
    expect(service.pinRetrySeconds()).toBe(0); expect(service.lockCycle()).toBe(cycle);
    expect(localStorage.getItem(`nivra.appLock.attempts.v1.${firstAccount}`)).toBeNull();
  });

  it('requests a fresh platform prompt and rejects cancellation without unlocking the app', async () => {
    service.canUseBiometric.set(true); const cycle = service.lockCycle();
    platform.verify.and.resolveTo(false);
    expect(await service.verifyProtectedActionWithBiometrics('Abrir conversación privada')).toBeFalse();
    expect(platform.verify).toHaveBeenCalledOnceWith(firstAccount, 'Abrir conversación privada');
    platform.verify.and.resolveTo(true);
    expect(await service.verifyProtectedActionWithBiometrics()).toBeTrue();
    expect(platform.verify).toHaveBeenCalledTimes(2);
    expect(service.isLocked()).toBeFalse(); expect(service.lockCycle()).toBe(cycle);
  });

  it('cancels only its own platform prompt and discards its late success', async () => {
    let finish!: (valid: boolean) => void;
    service.canUseBiometric.set(true);
    platform.verify.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const cycle = service.lockCycle();
    const pending = service.verifyProtectedActionWithBiometrics();
    service.cancelProtectedActionVerification();
    expect(platform.cancel).toHaveBeenCalledTimes(1); expect(service.busy()).toBeFalse();
    finish(true); expect(await pending).toBeFalse();
    expect(service.isLocked()).toBeFalse(); expect(service.lockCycle()).toBe(cycle);
  });

  it('does not cancel an unrelated global unlock or release a newer protected prompt', async () => {
    const completions: Array<(valid: boolean) => void> = [];
    spyOn<any>(service, 'verifyPinEnvelope').and.callFake(() => new Promise<boolean>(resolve => completions.push(resolve)));
    service.lock(); platform.cancel.calls.reset();
    const globalUnlock = service.unlockWithPin('5082');
    service.cancelProtectedActionVerification();
    expect(platform.cancel).not.toHaveBeenCalled(); expect(service.busy()).toBeTrue();
    completions[0](true); expect(await globalUnlock).toBeTrue();
    const old = service.verifyProtectedAction('5082'); service.cancelProtectedActionVerification();
    const fresh = service.verifyProtectedAction('5082');
    completions[1](true); expect(await old).toBeFalse(); expect(service.busy()).toBeTrue();
    completions[2](true); expect(await fresh).toBeTrue(); expect(service.busy()).toBeFalse();
  });

  it('prevents replacing or disabling the account PIN while this account has protected chats', async () => {
    const before = localStorage.getItem(`nivra.appLock.v1.${firstAccount}`);
    writePrivateChatLocks(firstAccount, ['private-chat']);
    await expectAsync(service.disable()).toBeRejectedWithError(/Quita primero la protección/);
    await expectAsync(service.enableSharedPin('9021')).toBeRejectedWithError(/PIN actual/);
    expect(localStorage.getItem(`nivra.appLock.v1.${firstAccount}`)).toBe(before);
    expect(await service.verifyProtectedAction('5082')).toBeTrue();
  });

  it('fails closed on unreadable chat protection metadata before changing the shared PIN', async () => {
    localStorage.setItem(privateChatLockStorageKey(firstAccount), '{bad-json');
    await expectAsync(service.disable()).toBeRejectedWithError(/Quita primero la protección/);
    await expectAsync(service.enableSharedPin('9021')).toBeRejectedWithError(/Quita primero la protección/);
  });
});
