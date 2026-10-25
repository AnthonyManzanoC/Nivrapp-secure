import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AccountLockPolicy, AccountLockPolicyService } from './account-lock-policy.service';
import { AppLockService } from './app-lock.service';
import { AuthService } from './auth.service';
import { PlatformUnlockService } from './platform-unlock.service';

describe('Shared app lock and device capabilities', () => {
  const alice = 'shared-lock-alice', bob = 'shared-lock-bob';
  let session: ReturnType<typeof signal<any>>, policy: ReturnType<typeof signal<AccountLockPolicy | null>>;
  let service: AppLockService, platform: any, shared: any;
  let saved: Array<[string, string | null]>;
  beforeEach(() => {
    const keys = [alice, bob].flatMap(user => [`nivra.appLock.v1.${user}`, `nivra.appLock.attempts.v1.${user}`]);
    saved = keys.map(key => [key, localStorage.getItem(key)]); keys.forEach(key => localStorage.removeItem(key));
    session = signal({ user: { id: alice, displayName: 'Alice' }, device: { id: 'phone' } }); policy = signal(null);
    shared = { policy, unresolved: signal(false), syncing: signal(false), syncError: signal(''), refresh: async () => undefined,
      save: jasmine.createSpy('save').and.callFake(async (enabled: boolean, pinEnvelope: any) => ({ userId: session().user.id,
        revision: (policy()?.revision ?? 0) + 1, enabled, pinEnvelope, updatedAt: new Date().toISOString() })) };
    platform = { availability: jasmine.createSpy('available').and.resolveTo({ available: false, enrolled: false, label: 'Verificación del dispositivo' }),
      enroll: jasmine.createSpy('enroll').and.resolveTo(true), verify: jasmine.createSpy('verify').and.resolveTo(true),
      verifyLegacyDeviceCredential: jasmine.createSpy('legacy').and.resolveTo(true), cancel: jasmine.createSpy('cancel') };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session() } },
      { provide: AccountLockPolicyService, useValue: shared }, { provide: PlatformUnlockService, useValue: platform },
    ] });
    service = TestBed.inject(AppLockService); service.isNativePlatform.set(false); TestBed.flushEffects();
  });
  afterEach(() => { TestBed.resetTestingModule(); saved.forEach(([key, value]) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value)); });

  it('creates an account PIN on Android and keeps it usable if biometrics are unavailable', async () => {
    service.isNativePlatform.set(true); await service.enableSharedPin('5082');
    expect(shared.save).toHaveBeenCalled(); expect(service.isShared()).toBeTrue(); expect(service.hasPinFallback()).toBeTrue();
    expect(service.unlockMode()).toBe('pin'); service.lock(); expect(await service.unlockWithPin('5082')).toBeTrue();
    expect(platform.verify).not.toHaveBeenCalled(); expect(JSON.stringify(shared.save.calls.mostRecent().args)).not.toContain('5082');
  });
  it('a second installation imports the same verifier and accepts the common PIN offline', async () => {
    await service.enableSharedPin('5082');
    const value = shared.save.calls.mostRecent().returnValue; const result = await value;
    service.ngOnDestroy(); localStorage.removeItem(`nivra.appLock.v1.${alice}`);
    policy.set(result);
    const another = TestBed.runInInjectionContext(() => new AppLockService()); TestBed.flushEffects();
    expect(another.isLocked()).toBeTrue(); expect(await another.unlockWithPin('5082')).toBeTrue(); another.ngOnDestroy();
  });
  it('remote PIN revisions relock the current screen and reject an old in-flight success', async () => {
    await service.enableSharedPin('5082'); service.lock();
    let complete!: (value: boolean) => void;
    spyOn<any>(service, 'verifyPinEnvelope').and.returnValue(new Promise<boolean>(resolve => complete = resolve));
    const pending = service.unlockWithPin('5082');
    const old = await shared.save.calls.mostRecent().returnValue;
    policy.set({ ...old, revision: old.revision + 1 }); TestBed.flushEffects();
    complete(true); expect(await pending).toBeFalse(); expect(service.isLocked()).toBeTrue();
  });
  it('never removes working local protection when saving shared settings fails', async () => {
    await service.enableSharedPin('5082');
    shared.save.and.rejectWith(new Error('Offline')); await expectAsync(service.disable()).toBeRejected();
    expect(service.isEnabled()).toBeTrue(); service.lock(); expect(await service.unlockWithPin('5082')).toBeTrue();
  });
  it('applies a concurrent remote change even if its effect ran during a failed local configuration', async () => {
    await service.enableSharedPin('5082');
    const old = await shared.save.calls.mostRecent().returnValue;
    shared.save.and.callFake(async () => {
      policy.set({ ...old, revision: 3 }); TestBed.flushEffects();
      throw new Error('Modo Seguro cambió en otro dispositivo.');
    });
    await expectAsync(service.disable()).toBeRejected();
    expect(service.isEnabled()).toBeTrue(); expect(service.isLocked()).toBeTrue();
    expect(JSON.parse(localStorage.getItem(`nivra.appLock.v1.${alice}`)!).policyRevision).toBe(3);
  });
  it('honors remote disable and rejects a foreign account policy', async () => {
    await service.enableSharedPin('5082'); service.lock();
    policy.set({ userId: bob, enabled: false, revision: 10, pinEnvelope: null, updatedAt: null }); TestBed.flushEffects();
    expect(service.isLocked()).toBeTrue(); expect(service.isEnabled()).toBeTrue();
    policy.set({ userId: alice, enabled: false, revision: 10, pinEnvelope: null, updatedAt: null }); TestBed.flushEffects();
    expect(service.isLocked()).toBeFalse(); expect(service.isEnabled()).toBeFalse();
  });
  it('offers OS verification only after local enrollment and retains the common PIN alternative', async () => {
    await service.enableSharedPin('5082');
    platform.availability.and.resolveTo({ available: true, enrolled: true, label: 'Verificación del dispositivo' });
    await service.refreshBiometryAvailability(); service.lock(); expect(service.unlockMode()).toBe('biometric');
    service.usePin(); expect(service.unlockMode()).toBe('pin'); expect(await service.unlockWithPin('5082')).toBeTrue();
    expect(platform.verify).not.toHaveBeenCalled();
  });
  it('requires the current common PIN before enrolling the PC and handles OS cancellation', async () => {
    await service.enableSharedPin('5082');
    await expectAsync(service.enrollPlatformUnlock('0000')).toBeRejectedWithError('PIN incorrecto.'); expect(platform.enroll).not.toHaveBeenCalled();
    platform.enroll.and.resolveTo(false); await expectAsync(service.enrollPlatformUnlock('5082')).toBeRejectedWithError(/No se pudo activar/);
    expect(service.hasPinFallback()).toBeTrue(); expect(service.busy()).toBeFalse();
  });
  it('guards unknown account policy before private content is shown', () => {
    shared.unresolved.set(true); expect(service.isContentLocked()).toBeTrue(); expect(service.isEnabled()).toBeFalse();
    shared.unresolved.set(false); expect(service.isContentLocked()).toBeFalse();
  });
});
