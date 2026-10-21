import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppLockService } from './app-lock.service';
import { AuthService } from './auth.service';

describe('AppLockService account and verification boundaries', () => {
  const firstAccount = 'app-lock-test-first';
  const secondAccount = 'app-lock-test-second';
  const session = signal<{ user: { id: string } } | null>(null);
  const settingsKey = (account: string) => `nivra.appLock.v1.${account}`;
  const attemptsKey = (account: string) => `nivra.appLock.attempts.v1.${account}`;
  let originalStorage: Array<[string, string | null]>;
  let service: AppLockService;
  const savedPin = {
    enabled: true, mode: 'pin', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    pin: { v: 1, alg: 'PBKDF2-SHA256+A256GCM', iterations: 240000, salt: '', iv: '', ciphertext: '' },
  };

  beforeEach(() => {
    const keys = [firstAccount, secondAccount].flatMap(account => [settingsKey(account), attemptsKey(account)]);
    originalStorage = keys.map(key => [key, localStorage.getItem(key)]);
    keys.forEach(key => localStorage.removeItem(key));
    localStorage.setItem(settingsKey(firstAccount), JSON.stringify(savedPin));
    localStorage.setItem(settingsKey(secondAccount), JSON.stringify(savedPin));
    session.set({ user: { id: firstAccount } });
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session() } },
    ] });
    service = TestBed.inject(AppLockService);
    TestBed.flushEffects();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    originalStorage.forEach(([key, value]) => value === null
      ? localStorage.removeItem(key) : localStorage.setItem(key, value));
  });

  it('keeps existing PIN envelope crypto and account binding without storing the PIN', async () => {
    await service.enableWebPin('5082');
    const envelope = JSON.parse(localStorage.getItem(settingsKey(firstAccount))!);
    expect(envelope.pin.alg).toBe('PBKDF2-SHA256+A256GCM');
    expect(envelope.pin.iterations).toBe(240000);
    expect(localStorage.getItem(settingsKey(firstAccount))).not.toContain('5082');
    service.lock();
    expect(await service.unlockWithPin('5083')).toBeFalse();
    expect(service.isLocked()).toBeTrue();
    expect(await service.unlockWithPin('5082')).toBeTrue();
    expect(service.isLocked()).toBeFalse();
    localStorage.setItem(settingsKey(secondAccount), JSON.stringify(envelope));
    session.set({ user: { id: secondAccount } });
    TestBed.flushEffects();
    expect(service.isLocked()).toBeTrue();
    expect(await service.unlockWithPin('5082')).toBeFalse();
  });

  it('runs only one PIN derivation at a time even when the service is called directly', async () => {
    let finish!: (valid: boolean) => void;
    const verify = spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const first = service.unlockWithPin('1234');
    expect(service.busy()).toBeTrue();
    expect(await service.unlockWithPin('1234')).toBeFalse();
    expect(verify).toHaveBeenCalledTimes(1);
    finish(true);
    expect(await first).toBeTrue();
    expect(service.busy()).toBeFalse();
  });

  it('discards a previous account result and does not release the new account verification', async () => {
    const finishes: Array<(valid: boolean) => void> = [];
    spyOn<any>(service, 'verifyPinEnvelope').and.callFake(() => new Promise<boolean>(resolve => finishes.push(resolve)));
    const previousAttempt = service.unlockWithPin('1234');
    session.set({ user: { id: secondAccount } });
    TestBed.flushEffects();
    expect(service.isLocked()).toBeTrue();
    const newAttempt = service.unlockWithPin('9876');
    finishes[0](true);
    expect(await previousAttempt).toBeFalse();
    expect(service.isLocked()).toBeTrue();
    expect(service.busy()).toBeTrue();
    finishes[1](true);
    expect(await newAttempt).toBeTrue();
    expect(service.isLocked()).toBeFalse();
  });

  it('discards an old successful result after the lock was closed and opened again', async () => {
    let finish!: (valid: boolean) => void;
    spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = service.unlockWithPin('1234');
    service.unlock();
    service.lock();
    finish(true);
    expect(await pending).toBeFalse();
    expect(service.isLocked()).toBeTrue();
    expect(service.busy()).toBeFalse();
  });

  it('cannot save a PIN setup started in another account', async () => {
    let finish!: (envelope: unknown) => void;
    spyOn<any>(service, 'createPinEnvelope').and.returnValue(new Promise(resolve => finish = resolve));
    const pending = service.enableWebPin('1234');
    session.set({ user: { id: secondAccount } });
    TestBed.flushEffects();
    finish(savedPin.pin);
    await expectAsync(pending).toBeRejectedWithError('La cuenta cambio. Vuelve a configurar Modo Seguro.');
    expect(JSON.parse(localStorage.getItem(settingsKey(firstAccount))!)).toEqual(savedPin);
    expect(JSON.parse(localStorage.getItem(settingsKey(secondAccount))!)).toEqual(savedPin);
    expect(service.isLocked()).toBeTrue();
  });

  it('persists a 30 second wait after five failures and allows verification when it expires', async () => {
    let now = 1800000000000;
    spyOn(Date, 'now').and.callFake(() => now);
    const verify = spyOn<any>(service, 'verifyPinEnvelope').and.resolveTo(false);
    for (let attempt = 0; attempt < 5; attempt++) expect(await service.unlockWithPin('0000')).toBeFalse();
    expect(service.pinRetrySeconds()).toBe(30);
    expect(await service.unlockWithPin('1234')).toBeFalse();
    expect(verify).toHaveBeenCalledTimes(5);
    const reopened = TestBed.runInInjectionContext(() => new AppLockService());
    TestBed.flushEffects();
    expect(reopened.isLocked()).toBeTrue();
    expect(reopened.pinRetrySeconds()).toBe(30);
    const reopenedVerify = spyOn<any>(reopened, 'verifyPinEnvelope').and.resolveTo(true);
    expect(await reopened.unlockWithPin('1234')).toBeFalse();
    expect(reopenedVerify).not.toHaveBeenCalled();
    now += 30001;
    expect(await reopened.unlockWithPin('1234')).toBeTrue();
    expect(reopened.pinRetrySeconds()).toBe(0);
    expect(localStorage.getItem(attemptsKey(firstAccount))).toBeNull();
    reopened.ngOnDestroy();
  });

  it('separates account cooldowns and rejects malformed PINs before expensive crypto', async () => {
    const verify = spyOn<any>(service, 'verifyPinEnvelope').and.resolveTo(false);
    expect(await service.unlockWithPin('12')).toBeFalse();
    expect(verify).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 5; attempt++) await service.unlockWithPin('0000');
    session.set({ user: { id: secondAccount } });
    TestBed.flushEffects();
    expect(service.pinRetrySeconds()).toBe(0);
    expect(await service.unlockWithPin('1111')).toBeFalse();
    session.set({ user: { id: firstAccount } });
    TestBed.flushEffects();
    expect(service.pinRetrySeconds()).toBeGreaterThan(0);
  });

  it('increases repeated failure waits while capping them at five minutes', async () => {
    let now = 1800000000000;
    spyOn(Date, 'now').and.callFake(() => now);
    spyOn<any>(service, 'verifyPinEnvelope').and.resolveTo(false);
    const expectedWaits = new Map([[5, 30], [10, 60], [15, 120], [20, 240], [25, 300], [30, 300]]);
    for (let attempt = 1; attempt <= 30; attempt++) {
      now += service.pinRetrySeconds() * 1000 + 1;
      expect(await service.unlockWithPin('0000')).toBeFalse();
      if (expectedWaits.has(attempt)) expect(service.pinRetrySeconds()).toBe(expectedWaits.get(attempt)!);
    }
  });

  it('also invalidates a pending biometric success when the account changes', async () => {
    for (const account of [firstAccount, secondAccount]) {
      localStorage.setItem(settingsKey(account), JSON.stringify({ ...savedPin, mode: 'biometric', pin: undefined }));
    }
    service.isNativePlatform.set(true);
    session.set({ user: { id: firstAccount } });
    TestBed.flushEffects();
    let finish!: () => void;
    const authenticate = spyOn<any>(service, 'authenticateBiometrics').and.returnValue(new Promise<void>(resolve => finish = resolve));
    const pending = service.unlockWithBiometrics();
    expect(await service.unlockWithBiometrics()).toBeFalse();
    expect(authenticate).toHaveBeenCalledTimes(1);
    session.set({ user: { id: secondAccount } });
    TestBed.flushEffects();
    finish();
    expect(await pending).toBeFalse();
    expect(service.isLocked()).toBeTrue();
  });
});
