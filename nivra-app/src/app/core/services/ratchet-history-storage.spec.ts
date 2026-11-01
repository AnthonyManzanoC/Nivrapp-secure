import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { deleteDB, IDBPDatabase, openDB } from 'idb';
import { LocalHistoryService } from './local-history.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

describe('application ratchet state in protected history storage', () => {
  let service: LocalHistoryService, keys: IDBPDatabase, states: IDBPDatabase;
  let keyName: string, stateName: string;
  beforeEach(async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    TestBed.configureTestingModule({ providers: [LocalHistoryService, { provide: NativeSecureVaultService,
      useValue: { requiresProtection: () => false, getOrCreateSecret: async () => null } }] });
    service = TestBed.inject(LocalHistoryService);
    keyName = 'ratchet-app-keys-' + crypto.randomUUID(); stateName = 'ratchet-app-state-' + crypto.randomUUID();
    keys = await openDB(keyName, 1, { upgrade(db) { db.createObjectStore('localVaultKeys', { keyPath: 'accountKey' }); db.createObjectStore('messages', { keyPath: 'key' }); } });
    states = await openDB(stateName, 1, { upgrade(db) { db.createObjectStore('snapshots', { keyPath: 'scope' }); } });
    spyOn<any>(service, 'open').and.resolveTo(keys);
    spyOn<any>(service, 'openRatchetDb').and.resolveTo(states);
  }, 15000);
  afterEach(async () => { keys?.close(); states?.close(); await Promise.all([deleteDB(keyName), deleteDB(stateName)]); TestBed.resetTestingModule(); }, 15000);
  const snapshot = { core: 'synthetic-private-identity', outbox: ['exact-retry-bytes'], inbox: [{ text: 'recoverable message' }] };

  it('confirms encrypted session and both queues together and reopens without changing the storage key', async () => {
    expect(await service.commitRatchetState('alice', 'phone', 0, snapshot)).toBe(1);
    const encoded = JSON.stringify(await states.getAll('snapshots'));
    expect(encoded).not.toContain('synthetic-private-identity'); expect(encoded).not.toContain('recoverable message');
    expect((await keys.get('localVaultKeys', 'alice')).key.extractable).toBeFalse();
    expect(await service.readRatchetState('alice', 'phone')).toEqual({ revision: 1, state: snapshot });
    expect(await service.readRatchetState('alice', 'computer')).toBeNull();
  });
  it('allows exactly one concurrent revision and refuses a stale writer', async () => {
    await service.commitRatchetState('alice', 'phone', 0, snapshot);
    const writers = await Promise.allSettled([service.commitRatchetState('alice', 'phone', 1, { step: 2 }), service.commitRatchetState('alice', 'phone', 1, { step: 3 })]);
    expect(writers.filter(result => result.status === 'fulfilled').length).toBe(1);
    expect((await service.readRatchetState('alice', 'phone'))?.revision).toBe(2);
  });
  it('authenticates the device scope and revision before opening private state', async () => {
    await service.commitRatchetState('alice', 'phone', 0, snapshot);
    const original = await states.get('snapshots', JSON.stringify(['alice', 'phone']));
    await states.put('snapshots', { ...original, revision: 2 });
    await expectAsync(service.readRatchetState('alice', 'phone')).toBeRejected();
    await states.put('snapshots', { ...original, scope: JSON.stringify(['alice', 'computer']), deviceId: 'computer' });
    await expectAsync(service.readRatchetState('alice', 'computer')).toBeRejected();
  });
  it('preserves unreadable state instead of generating a replacement history key', async () => {
    await service.commitRatchetState('alice', 'phone', 0, snapshot);
    const before = await states.get('snapshots', JSON.stringify(['alice', 'phone']));
    await keys.delete('localVaultKeys', 'alice');
    await expectAsync(service.readRatchetState('alice', 'phone')).toBeRejectedWithError(/clave guardada/);
    expect(await keys.get('localVaultKeys', 'alice')).toBeUndefined();
    expect(await states.get('snapshots', JSON.stringify(['alice', 'phone']))).toEqual(before);
  });
  it('wipes only the requested account and does not touch another account or the old history schema', async () => {
    await service.commitRatchetState('alice', 'phone', 0, snapshot);
    await service.commitRatchetState('bob', 'phone', 0, { core: 'bob' });
    await keys.put('messages', { key: 'alice:old', accountKey: 'alice' });
    await keys.put('messages', { key: 'bob:old', accountKey: 'bob' });
    await service.wipeAccountData('alice');
    expect(await service.readRatchetState('alice', 'phone')).toBeNull();
    expect((await service.readRatchetState('bob', 'phone'))?.state).toEqual({ core: 'bob' });
    expect(await keys.get('messages', 'bob:old')).toBeDefined();
  });
});
