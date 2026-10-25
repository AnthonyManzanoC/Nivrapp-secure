import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { AccountLockPolicy, AccountLockPolicyService, validSharedPin } from './account-lock-policy.service';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

describe('Account lock policy synchronization', () => {
  const alice = 'lock-policy-alice', bob = 'lock-policy-bob';
  const envelope = { v: 1 as const, alg: 'PBKDF2-SHA256+A256GCM' as const, iterations: 240000,
    salt: btoa('s'.repeat(16)), iv: btoa('i'.repeat(12)), ciphertext: btoa('c'.repeat(96)) };
  const policy = (userId = alice, revision = 1, enabled = true): AccountLockPolicy => ({ userId, revision, enabled,
    pinEnvelope: enabled ? envelope : null, updatedAt: '2026-10-24T00:00:00Z' });
  let session: ReturnType<typeof signal<any>>;
  let events: Subject<any>, api: { get: jasmine.Spy; put: jasmine.Spy }, service: AccountLockPolicyService;
  let storage: Array<[string, string | null]>;
  beforeEach(() => {
    storage = [alice, bob].map(user => [`nivra.accountLock.v1.${user}`, localStorage.getItem(`nivra.accountLock.v1.${user}`)]);
    storage.forEach(([key]) => localStorage.removeItem(key));
    session = signal({ user: { id: alice }, device: { id: 'phone' } }); events = new Subject();
    api = { get: jasmine.createSpy('get').and.returnValue(of(policy(alice, 0, false))), put: jasmine.createSpy('put') };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } }, { provide: NivraApiService, useValue: api },
      { provide: SignalrService, useValue: { events$: events } },
    ] });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    storage.forEach(([key, value]) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
  });
  async function start(): Promise<void> { service = TestBed.inject(AccountLockPolicyService); TestBed.flushEffects(); await service.refresh(); }

  it('keeps cached protection during a network error and never regresses its revision', async () => {
    localStorage.setItem(`nivra.accountLock.v1.${alice}`, JSON.stringify(policy(alice, 4)));
    api.get.and.returnValue(throwError(() => ({ status: 0 })));
    await start().catch(() => undefined);
    expect(service.policy()?.revision).toBe(4); expect(service.policy()?.enabled).toBeTrue();
    api.get.and.returnValue(of(policy(alice, 2, false))); await service.refresh(true);
    expect(service.policy()?.revision).toBe(4); expect(service.policy()?.enabled).toBeTrue();
  });
  it('coalesces concurrent refreshes and ignores another account response', async () => {
    const pending = new Subject<AccountLockPolicy>(); api.get.and.returnValue(pending);
    service = TestBed.inject(AccountLockPolicyService); TestBed.flushEffects();
    const first = service.refresh(true), second = service.refresh(true);
    expect(first).toBe(second); expect(api.get).toHaveBeenCalledTimes(1);
    session.set({ user: { id: bob }, device: { id: 'web' } });
    api.get.and.returnValue(of(policy(bob, 0, false))); TestBed.flushEffects();
    pending.next(policy(alice, 8)); pending.complete(); await first; await service.refresh();
    expect(service.policy()?.userId).toBe(bob); expect(localStorage.getItem(`nivra.accountLock.v1.${alice}`)).toBeNull();
  });
  it('refreshes on the account event and persists a remote disable as a revisioned tombstone', async () => {
    await start(); api.get.and.returnValue(of(policy(alice, 3, false)));
    events.next({ type: 'account.app-lock.updated', payload: { revision: 3 } }); await service.refresh();
    expect(service.policy()?.revision).toBe(3); expect(service.policy()?.enabled).toBeFalse();
    expect(JSON.parse(localStorage.getItem(`nivra.accountLock.v1.${alice}`)!).revision).toBe(3);
  });
  it('sends only the encrypted verifier with a compare-and-swap revision', async () => {
    await start(); api.put.and.returnValue(of(policy(alice, 1)));
    await service.save(true, envelope);
    expect(api.put).toHaveBeenCalledWith('/account/app-lock', { revision: 0, enabled: true, pinEnvelope: envelope });
    expect(service.policy()?.revision).toBe(1);
    expect(JSON.stringify(api.put.calls.mostRecent().args)).not.toContain('plaintext');
  });
  it('does not roll back another device change when a concurrent save conflicts', async () => {
    await start(); api.put.and.callFake(() => {
      api.get.and.returnValue(of(policy(alice, 6)));
      return throwError(() => ({ status: 409 }));
    });
    await expectAsync(service.save(false, null)).toBeRejectedWithError(/otro dispositivo/);
    expect(service.policy()?.revision).toBe(6); expect(service.policy()?.enabled).toBeTrue();
  });
  it('requires the user to review a remote policy change discovered just before writing', async () => {
    await start(); api.get.and.returnValue(of(policy(alice, 4)));
    await expectAsync(service.save(false, null)).toBeRejectedWithError(/otro dispositivo/);
    expect(api.put).not.toHaveBeenCalled(); expect(service.policy()?.revision).toBe(4);
  });
  it('rejects malformed or cross-account policies without replacing its cache', async () => {
    await start(); api.get.and.returnValue(of(policy(bob, 5)));
    await expectAsync(service.refresh(true)).toBeRejected(); expect(service.policy()?.userId).toBe(alice);
    api.get.and.returnValue(of({ ...policy(), pinEnvelope: { ...envelope, iterations: 2147483647 } }));
    await expectAsync(service.refresh(true)).toBeRejected(); expect(service.policy()?.revision).toBe(0);
    expect(validSharedPin({ ...envelope, iv: 'plaintext' })).toBeFalse();
  });
});
