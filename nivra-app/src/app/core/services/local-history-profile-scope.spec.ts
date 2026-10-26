import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { IDBPDatabase, deleteDB, openDB } from 'idb';
import { LocalHistoryService } from './local-history.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

describe('profile cache viewer isolation', () => {
  let service: LocalHistoryService;
  let db: IDBPDatabase;
  let databaseName: string;
  const privateProfile = { userId: 'peer', alias: 'peer', phone: '+573001234567', profilePhotoDataUrl: 'contacts-only-photo' };

  beforeEach(async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    TestBed.configureTestingModule({ providers: [LocalHistoryService, {
      provide: NativeSecureVaultService, useValue: { requiresProtection: () => false },
    }] });
    service = TestBed.inject(LocalHistoryService);
    databaseName = `nivra-profile-scope-${crypto.randomUUID()}`;
    db = await openDB(databaseName, 1, { upgrade(database) {
      database.createObjectStore('profilesStore', { keyPath: 'userId' });
      const scoped = database.createObjectStore('profilesByAccount', { keyPath: ['accountKey', 'userId'] });
      scoped.createIndex('byAccount', 'accountKey');
    } });
    spyOn<any>(service, 'open').and.resolveTo(db);
  }, 15_000);

  afterEach(async () => {
    try { db?.close(); if (databaseName) await deleteDB(databaseName); }
    finally { TestBed.resetTestingModule(); }
  }, 15_000);

  it('does not show account A contact-only fields to account B before any network response', async () => {
    await service.putProfiles('account-A', [privateProfile]);
    expect(await service.profiles('account-B')).toEqual([]);
    expect(await service.profiles('account-B', ['peer'])).toEqual([]);
    const visible = await service.profiles('account-A', ['peer']);
    expect(visible[0].userId).toBe('peer');
    expect(visible[0].profilePhotoDataUrl).toBe('contacts-only-photo');
    expect((visible[0] as any).accountKey).toBeUndefined();
  });

  it('stores independent authoritative visibility for the same person in two accounts', async () => {
    await service.putProfiles('account-A', [privateProfile]);
    await service.putProfiles('account-B', [{ userId: 'peer', alias: 'peer', phone: null, profilePhotoDataUrl: null }]);
    expect((await service.profiles('account-A'))[0].profilePhotoDataUrl).toBe('contacts-only-photo');
    expect((await service.profiles('account-B'))[0].profilePhotoDataUrl).toBeNull();
    expect((await service.profiles('account-B'))[0].phone).toBeNull();
    expect((await db.getAll('profilesByAccount')).length).toBe(2);
  });

  it('quarantines legacy ownerless profiles without deleting or reassigning them', async () => {
    await db.put('profilesStore', privateProfile);
    expect(await service.profiles('account-A')).toEqual([]);
    expect(await service.profiles('account-B', ['peer'])).toEqual([]);
    await service.putProfiles('account-B', [{ userId: 'peer', alias: 'peer', profilePhotoDataUrl: null }]);
    expect(await db.get('profilesStore', 'peer')).toEqual(privateProfile);
    expect((await service.profiles('account-B'))[0].profilePhotoDataUrl).toBeNull();
  });

  it('uses compound keys without collisions between account and person identifiers', async () => {
    await service.putProfiles('a:b', [{ userId: 'c', profilePhotoDataUrl: 'first-photo' }]);
    await service.putProfiles('a', [{ userId: 'b:c', profilePhotoDataUrl: 'second-photo' }]);
    expect((await service.profiles('a:b', ['c']))[0].profilePhotoDataUrl).toBe('first-photo');
    expect((await service.profiles('a', ['b:c']))[0].profilePhotoDataUrl).toBe('second-photo');
  });

  it('does not read or write a profile cache without an explicit viewer account', async () => {
    await db.put('profilesStore', privateProfile);
    await service.putProfiles('', [privateProfile]);
    expect(await service.profiles('')).toEqual([]);
    expect((service as any).open).not.toHaveBeenCalled();
    expect(await db.getAll('profilesByAccount')).toEqual([]);
  });

  it('keeps a pending write bound to its captured account when another account writes first', async () => {
    let resume!: (database: IDBPDatabase) => void;
    ((service as any).open as jasmine.Spy).and.returnValue(new Promise<IDBPDatabase>(resolve => { resume = resolve; }));
    const pendingA = service.putProfiles('account-A', [privateProfile]);
    ((service as any).open as jasmine.Spy).and.resolveTo(db);
    await service.putProfiles('account-B', [{ userId: 'peer', profilePhotoDataUrl: null }]);
    resume(db);
    await pendingA;
    expect((await service.profiles('account-A'))[0].profilePhotoDataUrl).toBe('contacts-only-photo');
    expect((await service.profiles('account-B'))[0].profilePhotoDataUrl).toBeNull();
  });
});
