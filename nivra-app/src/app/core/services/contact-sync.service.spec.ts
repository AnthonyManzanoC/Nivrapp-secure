import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { AuthSession, ContactHashSyncResponse } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { ContactSyncService } from './contact-sync.service';
import { CryptoService } from './crypto.service';
import { NativeDeviceService } from './native-device.service';
import { NivraApiService } from './nivra-api.service';

describe('contact sync account and device boundaries', () => {
  let service: ContactSyncService;
  let session: ReturnType<typeof signal<AuthSession | null>>;
  let post: jasmine.Spy;
  let hash: jasmine.Spy;
  let read: jasmine.Spy;
  let fresh: jasmine.Spy;
  const alice = 'contact-scope-fixture-alice', bob = 'contact-scope-fixture-bob';
  const account = (id = alice, device = 'fixture-phone') => ({ user: { id, alias: id, phone: '+573001234567' }, device: { id: device } }) as AuthSession;
  const keys = (id: string) => [`nivra.contactHashes.${id}`, `nivra.contactPhones.${id}`, `nivra.radar.contactJoined.${id}`];
  const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
  beforeEach(() => {
    [...keys(alice), ...keys(bob)].forEach(key => localStorage.removeItem(key));
    session = signal<AuthSession | null>(account());
    post = jasmine.createSpy('post').and.returnValue(of({ stored: 1 }));
    hash = jasmine.createSpy('hash').and.resolveTo('a'.repeat(64));
    read = jasmine.createSpy('device contacts').and.resolveTo([{ tel: ['+573009999999'] }]);
    fresh = jasmine.createSpy('fresh session').and.resolveTo(true);
    TestBed.configureTestingModule({ providers: [
      ContactSyncService, { provide: NivraApiService, useValue: { post } },
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session(), ensureFreshSession: fresh } },
      { provide: CryptoService, useValue: { phoneContactHash: hash } },
      { provide: NativeDeviceService, useValue: { native: true, readDeviceContacts: read } },
    ] });
    service = TestBed.inject(ContactSyncService);
  });
  afterEach(() => { TestBed.resetTestingModule(); [...keys(alice), ...keys(bob)].forEach(key => localStorage.removeItem(key)); });

  it('does not submit or cache old phone hashes after the account changes during hashing', async () => {
    let finish!: (value: string) => void;
    hash.and.returnValue(new Promise<string>(resolve => finish = resolve));
    const syncing = service.syncContactPhones(['+573009999999']);
    session.set(account(bob)); finish('a'.repeat(64));
    await expectAsync(syncing).toBeRejectedWithError(/cuenta o el dispositivo cambió/);
    expect(post).not.toHaveBeenCalled();
    expect(localStorage.getItem(`nivra.contactHashes.${bob}`)).toBeNull();
    expect(localStorage.getItem(`nivra.contactPhones.${bob}`)).toBeNull();
  });

  it('rechecks the device after refreshing credentials before sending contact hashes', async () => {
    fresh.and.callFake(async () => { session.set(account(alice, 'different-device')); return true; });
    await expectAsync(service.syncContactPhones(['+573009999999'])).toBeRejectedWithError(/cuenta o el dispositivo cambió/);
    expect(post).not.toHaveBeenCalled();
  });

  it('discards a permission dialog result instead of assigning selected contacts to a new account', async () => {
    let finish!: (value: { tel: string[] }[]) => void;
    read.and.returnValue(new Promise(resolve => finish = resolve));
    const picking = service.pickAndSyncDeviceContacts();
    session.set(account(bob)); finish([{ tel: ['+573009999999'] }]);
    await expectAsync(picking).toBeRejectedWithError(/cuenta o el dispositivo cambió/);
    expect(post).not.toHaveBeenCalled();
    expect(localStorage.getItem(`nivra.contactPhones.${bob}`)).toBeNull();
    expect(service.lastDeviceContactCount()).toBe(0);
  });

  it('does not persist a late POST response or clear a new account synchronization indicator', async () => {
    const first = new Subject<ContactHashSyncResponse>(); const second = new Subject<ContactHashSyncResponse>();
    post.and.returnValues(first, second);
    const oldSync = service.syncContactPhones(['+573009999999']); await settle();
    session.set(account(bob)); TestBed.flushEffects();
    const newSync = service.syncContactPhones(['+573008888888']); await settle();
    expect(service.syncing()).toBeTrue();
    first.next({ submitted: 1, stored: 1 }); first.complete();
    await expectAsync(oldSync).toBeRejectedWithError(/cuenta o el dispositivo cambió/);
    expect(service.syncing()).toBeTrue();
    expect(localStorage.getItem(`nivra.contactHashes.${alice}`)).toBeNull();
    second.next({ submitted: 1, stored: 1 }); second.complete(); await newSync;
    expect(service.syncing()).toBeFalse();
    expect(JSON.parse(localStorage.getItem(`nivra.contactPhones.${bob}`)!)).toEqual(['+573008888888']);
  });

  it('coalesces startup and world background scans and never requests permission implicitly', async () => {
    let finish!: (value: { tel: string[] }[]) => void;
    read.and.returnValue(new Promise(resolve => finish = resolve));
    const first = service.syncCachedContactsInBackground(); const second = service.syncCachedContactsInBackground();
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledOnceWith(jasmine.objectContaining({ requestPermission: false }));
    finish([{ tel: ['+573009999999'] }]); await first;
    expect(post).toHaveBeenCalledTimes(1);
    expect(service.lastSyncedCount()).toBe(1);
  });

  it('does not fall back to another account cached agenda when an old native scan completes', async () => {
    localStorage.setItem(`nivra.contactPhones.${bob}`, JSON.stringify(['+573008888888']));
    let finish!: (value: { tel: string[] }[]) => void;
    read.and.returnValue(new Promise(resolve => finish = resolve));
    const scanning = service.syncCachedContactsInBackground();
    session.set(account(bob)); finish([{ tel: ['+573009999999'] }]); await scanning;
    expect(post).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(`nivra.contactPhones.${bob}`)!)).toEqual(['+573008888888']);
  });

  it('preserves a valid same-account sync when only session tokens refresh', async () => {
    let finish!: (value: string) => void;
    hash.and.returnValue(new Promise<string>(resolve => finish = resolve));
    const syncing = service.syncContactPhones(['+573009999999']);
    session.set({ ...account(), tokens: { accessToken: 'fixture-new-token', refreshToken: 'fixture-refresh' } } as AuthSession); TestBed.flushEffects();
    finish('a'.repeat(64)); await syncing;
    expect(post).toHaveBeenCalledOnceWith('/push-tokens/sync-contacts', ['a'.repeat(64)]);
    expect(service.lastDeviceContactCount()).toBe(1);
  });
});
