import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { deleteDB, IDBPDatabase, openDB } from 'idb';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { DeviceWipeService } from './device-wipe.service';
import { LocalHistoryService } from './local-history.service';
import { NativeDeviceService } from './native-device.service';
import { NativeSecureVaultService } from './native-secure-vault.service';
import { acknowledgeWebPushAccountWipe, markWebPushAccountWipe, pendingWebPushAccountWipes, savePushAccountScopes } from './push-account-scopes';

describe('account wipe storage isolation', () => {
  let databaseName: string; let db: IDBPDatabase; let history: LocalHistoryService; let keys: CryptoService;
  let clearSecret: jasmine.Spy;
  beforeEach(async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    clearSecret = jasmine.createSpy('clearSecret').and.resolveTo();
    TestBed.configureTestingModule({ providers: [LocalHistoryService, CryptoService, {
      provide: NativeSecureVaultService, useValue: { requiresProtection: () => false, clearSecret },
    }] });
    history = TestBed.inject(LocalHistoryService); keys = TestBed.inject(CryptoService);
    databaseName = `nivra-account-wipe-${crypto.randomUUID()}`;
    db = await openDB(databaseName, 1, { upgrade(database) {
      for (const name of ['messages', 'conversations', 'contacts', 'calls', 'stories']) database.createObjectStore(name, { keyPath: 'key' });
      for (const name of ['syncWatermarks', 'localVaultKeys']) database.createObjectStore(name, { keyPath: 'accountKey' });
      database.createObjectStore('profilesByAccount', { keyPath: ['accountKey', 'userId'] });
      database.createObjectStore('profilesStore', { keyPath: 'userId' });
      database.createObjectStore('deviceKeys', { keyPath: 'id' });
    } });
    spyOn<any>(history, 'open').and.resolveTo(db); spyOn<any>(keys, 'open').and.resolveTo(db);
  });
  afterEach(async () => { db?.close(); if (databaseName) await deleteDB(databaseName); TestBed.resetTestingModule(); });

  it('cleans A history, profiles, keys and cursors while preserving B and ambiguous legacy data', async () => {
    for (const name of ['messages', 'conversations', 'contacts', 'calls', 'stories']) {
      for (const accountKey of ['alice', 'bob', 'unknown-legacy']) await db.put(name, { key: accountKey, accountKey, ciphertext: `${accountKey}-private` });
    }
    for (const name of ['localVaultKeys', 'syncWatermarks']) {
      for (const accountKey of ['alice', 'bob', JSON.stringify(['message-sync-v2', 'alice', 'phone-a'])]) await db.put(name, { accountKey, keyEnvelope: accountKey });
    }
    await db.put('profilesByAccount', { accountKey: 'alice', userId: 'peer', profilePhotoDataUrl: 'a-only' });
    await db.put('profilesByAccount', { accountKey: 'bob', userId: 'peer', profilePhotoDataUrl: 'b-only' });
    await db.put('profilesStore', { userId: 'legacy-peer', profilePhotoDataUrl: 'unassigned' });
    for (const value of [{ id: 'a', userId: 'alice' }, { id: 'b', userId: 'bob' }, { id: 'legacy', alias: 'alice' }]) await db.put('deviceKeys', value);
    await keys.destroyLocalDeviceKeysForUser('alice'); await history.wipeAccountData('alice');
    for (const name of ['messages', 'conversations', 'contacts', 'calls', 'stories']) {
      expect(await db.get(name, 'alice')).toBeUndefined(); expect((await db.get(name, 'bob')).ciphertext).toBe('bob-private');
      expect(await db.get(name, 'unknown-legacy')).toBeDefined();
    }
    expect(await db.get('localVaultKeys', 'alice')).toBeUndefined(); expect(await db.get('localVaultKeys', 'bob')).toBeDefined();
    expect(await db.get('syncWatermarks', JSON.stringify(['message-sync-v2', 'alice', 'phone-a']))).toBeUndefined();
    expect(await db.get('profilesByAccount', ['alice', 'peer'])).toBeUndefined();
    expect((await db.get('profilesByAccount', ['bob', 'peer'])).profilePhotoDataUrl).toBe('b-only');
    expect(await db.get('profilesStore', 'legacy-peer')).toBeDefined();
    expect(await db.get('deviceKeys', 'a')).toBeUndefined(); expect(await db.get('deviceKeys', 'b')).toBeDefined();
    expect(await db.get('deviceKeys', 'legacy')).toBeDefined(); expect(clearSecret).not.toHaveBeenCalled();
  });

  it('uses parameterized exact SQLite owner deletion even when identifiers contain LIKE wildcards', async () => {
    const run = jasmine.createSpy('run').and.resolveTo();
    spyOn<any>(history, 'openNativeSqlite').and.resolveTo({ query: async () => ({ values: [
      { account_key: 'user%_a' }, { account_key: 'user-any-a' }, { account_key: 'bob' },
    ] }), run });
    await history.wipeAccountData('user%_a');
    expect(run).toHaveBeenCalledTimes(6);
    for (const call of run.calls.allArgs()) { expect(call[0]).toContain('WHERE account_key = ?'); expect(call[1]).toEqual(['user%_a']); }
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it('keeps a pending wipe out of the worker allowlist despite a stale registry sync', async () => {
    const alice = { userId: `wipe-test-${crypto.randomUUID()}`, deviceId: 'phone-a', hideNotificationContent: true };
    const bob = { userId: `saved-test-${crypto.randomUUID()}`, deviceId: 'phone-b', hideNotificationContent: false };
    const stateDb = await openDB('NivraPushScopes', 1, { upgrade(database) { database.createObjectStore('state'); } });
    try {
      await savePushAccountScopes([alice, bob], alice);
      await markWebPushAccountWipe(alice);
      expect((await pendingWebPushAccountWipes()).some(scope => scope.userId === alice.userId && scope.deviceId === alice.deviceId)).toBeTrue();
      await savePushAccountScopes([alice, bob], alice);
      const state = await stateDb.get('state', 'saved');
      expect(state.scopes).toEqual([bob]); expect(state.activeUserId).toBe(''); expect(state.activeDeviceId).toBe('');
    } finally { stateDb.close(); await acknowledgeWebPushAccountWipe(alice); }
  });
});

describe('pending account wipe acknowledgement', () => {
  let service: DeviceWipeService; let native: any; let auth: any; let history: any; let keys: any;
  const scope = { userId: 'alice', deviceId: 'phone-a' };
  beforeEach(() => {
    native = { clearPushRegistration: jasmine.createSpy().and.resolveTo(), acknowledgePushAccountWipe: jasmine.createSpy().and.resolveTo(), pendingPushAccountWipes: async () => [scope] };
    auth = { session: signal({ user: { id: 'bob' }, device: { id: 'phone-b' } }), storedSessionCredentials: jasmine.createSpy().and.resolveTo([]), removeStoredAccount: jasmine.createSpy().and.resolveTo() };
    history = { wipeAccountData: jasmine.createSpy().and.resolveTo() }; keys = { destroyLocalDeviceKeysForUser: jasmine.createSpy().and.resolveTo() };
    TestBed.configureTestingModule({ providers: [DeviceWipeService,
      { provide: NativeDeviceService, useValue: native }, { provide: AuthService, useValue: auth },
      { provide: LocalHistoryService, useValue: history }, { provide: CryptoService, useValue: keys },
    ] }); service = TestBed.inject(DeviceWipeService);
  });
  afterEach(() => TestBed.resetTestingModule());

  it('cleans a pending inactive scope after Auth has already removed its registry credential', async () => {
    await markWebPushAccountWipe(scope);
    await service.processPendingAccountWipes();
    expect(native.clearPushRegistration).toHaveBeenCalledOnceWith(scope);
    expect(auth.removeStoredAccount).toHaveBeenCalledOnceWith('alice', 'phone-a', 'FORCE_WIPE');
    expect(keys.destroyLocalDeviceKeysForUser).toHaveBeenCalledOnceWith('alice');
    expect(history.wipeAccountData).toHaveBeenCalledOnceWith('alice'); expect(native.acknowledgePushAccountWipe).toHaveBeenCalledOnceWith(scope);
    expect(auth.session().user.id).toBe('bob');
  });

  it('retains the native marker if local cleanup fails and retries safely', async () => {
    history.wipeAccountData.and.rejectWith(new Error('locked'));
    await expectAsync(service.wipeAccount(scope)).toBeRejectedWithError('locked');
    expect(native.acknowledgePushAccountWipe).not.toHaveBeenCalled();
    history.wipeAccountData.and.resolveTo(); await service.wipeAccount(scope);
    expect(native.acknowledgePushAccountWipe).toHaveBeenCalledOnceWith(scope);
  });

  it('removes only the wiped owner’s external list, preview and agenda caches', async () => {
    const prefixes = ['nivra.broadcasts.v1.', 'nivra.chatLaunchCache.v2.', 'nivra.contactPhones.', 'nivra.radar.seen.'];
    try {
      for (const prefix of prefixes) {
        localStorage.setItem(prefix + 'alice', 'a-private');
        localStorage.setItem(prefix + 'bob', 'b-private');
        localStorage.setItem(prefix + 'alice-other', 'other-private');
      }
      await service.wipeAccount(scope);
      for (const prefix of prefixes) {
        expect(localStorage.getItem(prefix + 'alice')).toBeNull();
        expect(localStorage.getItem(prefix + 'bob')).toBe('b-private');
        expect(localStorage.getItem(prefix + 'alice-other')).toBe('other-private');
      }
    } finally { for (const prefix of prefixes) for (const id of ['alice', 'bob', 'alice-other']) localStorage.removeItem(prefix + id); }
  });

  it('ignores old-device data deletion after the same user has enrolled a replacement session', async () => {
    auth.storedSessionCredentials.and.resolveTo([{ user: { id: 'alice' }, device: { id: 'new-phone-a' } }]);
    await service.wipeAccount(scope);
    expect(native.clearPushRegistration).toHaveBeenCalledOnceWith(scope);
    expect(auth.removeStoredAccount).not.toHaveBeenCalled();
    expect(keys.destroyLocalDeviceKeysForUser).not.toHaveBeenCalled(); expect(history.wipeAccountData).not.toHaveBeenCalled();
    expect(native.acknowledgePushAccountWipe).toHaveBeenCalledOnceWith(scope);
  });
});
