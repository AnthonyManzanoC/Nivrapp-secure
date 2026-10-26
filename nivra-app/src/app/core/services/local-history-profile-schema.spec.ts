import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { IDBPDatabase, deleteDB, openDB } from 'idb';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

describe('shared profile schema upgrade ordering', () => {
  let databaseName: string;
  const opened: IDBPDatabase[] = [];
  const legacy = { userId: 'peer', profilePhotoDataUrl: 'legacy-ownerless-photo' };
  const retainedKey = { id: 'retained-device-key', userId: 'account-A', encryptedMaterial: 'untouched-fixture' };

  beforeEach(async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    TestBed.configureTestingModule({ providers: [CryptoService, LocalHistoryService, {
      provide: NativeSecureVaultService, useValue: { requiresProtection: () => false },
    }] });
    databaseName = `nivra-profile-upgrade-${crypto.randomUUID()}`;
    const old = await openDB(databaseName, 12, { upgrade(database) {
      database.createObjectStore('profilesStore', { keyPath: 'userId' });
      database.createObjectStore('deviceKeys', { keyPath: 'id' });
    } });
    await old.put('profilesStore', legacy);
    await old.put('deviceKeys', retainedKey);
    old.close();
    const actualOpen = indexedDB.open.bind(indexedDB);
    // Run both real service upgrade callbacks against a unique fixture database.
    // The application's NivraDB is never opened, created or deleted by this test.
    spyOn(indexedDB, 'open').and.callFake((name: string, version?: number) =>
      actualOpen(name === 'NivraDB' ? databaseName : name, version));
  }, 15_000);

  afterEach(async () => {
    try {
      for (const db of opened.splice(0)) db.close();
      if (databaseName) await deleteDB(databaseName);
    } finally { TestBed.resetTestingModule(); }
  }, 15_000);

  for (const first of ['crypto', 'history'] as const) {
    it(`creates the same v13 scoped store when ${first} opens first and preserves legacy records`, async () => {
      const cryptoService = TestBed.inject(CryptoService);
      const history = TestBed.inject(LocalHistoryService);
      const services = first === 'crypto' ? [cryptoService, history] : [history, cryptoService];
      for (const service of services) opened.push(await (service as any).open());
      expect(opened.map(db => db.version)).toEqual([13, 13]);
      const store = opened[0].transaction('profilesByAccount').objectStore('profilesByAccount');
      expect(store.keyPath).toEqual(['accountKey', 'userId']);
      expect(store.index('byAccount').keyPath).toBe('accountKey');
      expect(await opened[0].get('profilesStore', 'peer')).toEqual(legacy);
      expect(await opened[0].get('deviceKeys', retainedKey.id)).toEqual(retainedKey);
      expect(await history.profiles('account-A')).toEqual([]);
      await history.putProfiles('account-A', [{ userId: 'peer', profilePhotoDataUrl: 'authorized-A' }]);
      expect((await history.profiles('account-A'))[0].profilePhotoDataUrl).toBe('authorized-A');
      expect(await history.profiles('account-B')).toEqual([]);
    });
  }
});
