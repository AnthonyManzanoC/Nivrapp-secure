import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { ChatPayload } from '../models/nivra.models';
import { LocalHistoryService } from './local-history.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

interface NativeHistoryInternals {
  open(): Promise<unknown>;
  nativeLocalVaultKey(account: string): Promise<CryptoKey | null>;
  localVaultKey(account: string): Promise<CryptoKey>;
  encryptPayload(account: string, payload: ChatPayload): Promise<any>;
  decryptPayload(account: string, payload: any): Promise<ChatPayload>;
  deleteIndexedDatabases(): Promise<void>;
  deleteNativeSqliteDatabase(): Promise<void>;
}

describe('native encrypted history startup recovery', () => {
  let service: LocalHistoryService;
  let internals: NativeHistoryInternals;
  let db: jasmine.SpyObj<SQLiteDBConnection>;
  let vault: { getOrCreateSecret: jasmine.Spy; requiresProtection: () => boolean; clearSecret: jasmine.Spy };
  let reconcile: jasmine.Spy;
  let checkSecret: jasmine.Spy;
  let create: jasmine.Spy;
  let clearSecret: jasmine.Spy;

  beforeEach(() => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    vault = { getOrCreateSecret: jasmine.createSpy().and.resolveTo('retained-native-secret'),
      requiresProtection: () => true, clearSecret: jasmine.createSpy().and.resolveTo() };
    TestBed.configureTestingModule({ providers: [
      LocalHistoryService, { provide: NativeSecureVaultService, useValue: vault },
    ] });
    service = TestBed.inject(LocalHistoryService);
    internals = service as unknown as NativeHistoryInternals;
    db = jasmine.createSpyObj<SQLiteDBConnection>('db', ['open', 'close', 'isDBOpen', 'execute', 'query', 'run']);
    db.open.and.resolveTo();
    db.close.and.resolveTo();
    db.isDBOpen.and.resolveTo({ result: false });
    db.execute.and.resolveTo({ changes: { changes: 0 } });
    db.query.and.resolveTo({ values: [] });
    db.run.and.resolveTo({ changes: { changes: 1 } });
    reconcile = spyOn(SQLiteConnection.prototype, 'checkConnectionsConsistency').and.resolveTo({ result: true });
    spyOn(SQLiteConnection.prototype, 'isConnection').and.resolveTo({ result: true });
    spyOn(SQLiteConnection.prototype, 'retrieveConnection').and.resolveTo(db);
    spyOn(SQLiteConnection.prototype, 'isSecretStored').and.resolveTo({ result: true });
    checkSecret = spyOn(SQLiteConnection.prototype, 'checkEncryptionSecret').and.resolveTo({ result: true });
    spyOn(SQLiteConnection.prototype, 'setEncryptionSecret').and.resolveTo();
    clearSecret = spyOn(SQLiteConnection.prototype, 'clearEncryptionSecret').and.resolveTo();
    spyOn(SQLiteConnection.prototype, 'closeConnection').and.resolveTo();
    create = spyOn(SQLiteConnection.prototype, 'createConnection').and.resolveTo(db);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('recovers a transient first open without ever publishing a final error or changing storage', async () => {
    db.open.and.callFake(() => db.open.calls.count() === 1
      ? Promise.reject(new Error('Keystore still resuming')) : Promise.resolve());
    const fallback = spyOn(internals, 'open').and.resolveTo(null);
    const errorChanges = spyOn(service.storageError, 'set').and.callThrough();
    const loading = service.conversations('account');
    expect(service.storageState()).toBe('opening');
    expect(service.storageBusy()).toBeTrue();
    expect(await loading).toEqual([]);
    expect(db.open).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(vault.getOrCreateSecret).toHaveBeenCalledTimes(2);
    expect(errorChanges.calls.allArgs().every(args => args[0] === '')).toBeTrue();
    expect(service.storageState()).toBe('ready');
    expect(service.storageBusy()).toBeFalse();
    expect(fallback).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it('reconciles the SQLite wrapper again after a temporary first bridge failure', async () => {
    reconcile.and.callFake(() => reconcile.calls.count() === 1
      ? Promise.reject(new Error('bridge not ready')) : Promise.resolve({ result: true }));
    expect(await service.retryNativeStorage()).toBeTrue();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(db.open).toHaveBeenCalledTimes(1);
    expect(service.storageState()).toBe('ready');
    expect(service.storageError()).toBe('');
  });

  it('uses an already-open native handle instead of failing by opening it twice', async () => {
    db.isDBOpen.and.resolveTo({ result: true });
    db.open.and.rejectWith(new Error('database already open'));
    expect(await service.retryNativeStorage()).toBeTrue();
    expect(db.open).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(service.storageState()).toBe('ready');
  });

  it('keeps real failures visible and coalesces concurrent explicit retries into one successful open', async () => {
    db.open.and.rejectWith(new Error('device remains locked'));
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(service.storageState()).toBe('error');
    expect(service.storageError()).toContain('historial cifrado');
    service.clearStorageError();
    expect(service.storageError()).toContain('historial cifrado');
    let finish!: () => void;
    db.open.and.callFake(() => new Promise<void>(resolve => finish = resolve));
    const first = service.retryNativeStorage();
    const second = service.retryNativeStorage();
    expect(first).toBe(second);
    expect(service.storageState()).toBe('retrying');
    expect(service.storageError()).toContain('historial cifrado');
    // Wait for the asynchronously imported bridge to reach the controlled open.
    for (let tick = 0; !finish && tick < 50; tick++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(finish).toBeDefined();
    finish();
    expect(await first).toBeTrue();
    expect(await second).toBeTrue();
    expect(db.open).toHaveBeenCalledTimes(4);
    expect(service.storageState()).toBe('ready');
    expect(service.storageError()).toBe('');
  });

  it('fails closed on a mismatched retained secret without replacing the database, key, or backend', async () => {
    checkSecret.and.resolveTo({ result: false });
    const fallback = spyOn(internals, 'open').and.resolveTo(null);
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(checkSecret).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(db.open).not.toHaveBeenCalled();
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
    expect(clearSecret).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(service.storageState()).toBe('error');
  });

  it('creates one retained account key for concurrent first payloads and decrypts both with real AES-GCM', async () => {
    const keys = new Map<string, string>();
    db.query.and.callFake(async (_sql, values) => ({ values: keys.has(String(values?.[0]))
      ? [{ raw_key: keys.get(String(values?.[0])), created_at: '' }] : [] }));
    db.run.and.callFake(async (sql, values) => {
      expect(sql).toContain('INSERT OR IGNORE INTO local_vault_keys');
      if (!keys.has(String(values?.[0]))) keys.set(String(values?.[0]), String(values?.[1]));
      return { changes: { changes: 1 } };
    });
    const payloads: ChatPayload[] = [{ type: 'text', text: 'first private payload' }, { type: 'text', text: 'second private payload' }];
    const envelopes = await Promise.all(payloads.map(payload => internals.encryptPayload('account', payload)));
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(keys.size).toBe(1);
    expect(envelopes.every(envelope => !JSON.stringify(envelope).includes('private payload'))).toBeTrue();
    expect(await internals.decryptPayload('account', envelopes[0])).toEqual(payloads[0]);
    expect(await internals.decryptPayload('account', envelopes[1])).toEqual(payloads[1]);
    expect(db.open).toHaveBeenCalledTimes(1);
  });

  it('honours the same committed key even when independent history instances race to initialize it', async () => {
    let storedRaw = '';
    let initialReads = 0;
    let release!: () => void;
    const bothReaders = new Promise<void>(resolve => release = resolve);
    db.query.and.callFake(async () => {
      if (!storedRaw) {
        initialReads++;
        if (initialReads === 2) release();
        await bothReaders;
        return { values: [] };
      }
      return { values: [{ raw_key: storedRaw, created_at: '' }] };
    });
    db.run.and.callFake(async (sql, values) => {
      expect(sql).toContain('INSERT OR IGNORE');
      storedRaw ||= String(values?.[1]);
      return { changes: { changes: 1 } };
    });
    const other = TestBed.runInInjectionContext(() => new LocalHistoryService()) as unknown as NativeHistoryInternals;
    const [left, right] = await Promise.all([internals.nativeLocalVaultKey('account'), other.nativeLocalVaultKey('account')]);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, left!, new TextEncoder().encode('history stays readable'));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, right!, ciphertext);
    expect(new TextDecoder().decode(plain)).toBe('history stays readable');
  });

  it('does not share or replace history keys across account scopes', async () => {
    const keys = new Map<string, string>();
    db.query.and.callFake(async (_sql, values) => ({ values: keys.has(String(values?.[0]))
      ? [{ raw_key: keys.get(String(values?.[0])), created_at: '' }] : [] }));
    db.run.and.callFake(async (_sql, values) => {
      if (!keys.has(String(values?.[0]))) keys.set(String(values?.[0]), String(values?.[1]));
      return { changes: { changes: 1 } };
    });
    const payload: ChatPayload = { type: 'text', text: 'account A only' };
    const [envelope] = await Promise.all([
      internals.encryptPayload('account-a', payload), internals.encryptPayload('account-b', { type: 'text', text: 'account B only' }),
    ]);
    expect(keys.size).toBe(2);
    expect(await internals.decryptPayload('account-a', envelope)).toEqual(payload);
    await expectAsync(internals.decryptPayload('account-b', envelope)).toBeRejected();
  });

  it('invalidates a pending account key load during an explicit device wipe', async () => {
    let finish!: (key: CryptoKey) => void;
    spyOn(internals, 'nativeLocalVaultKey').and.returnValue(new Promise(resolve => finish = resolve));
    spyOn(internals, 'deleteIndexedDatabases').and.resolveTo();
    spyOn(internals, 'deleteNativeSqliteDatabase').and.resolveTo();
    const pending = internals.localVaultKey('previous-account');
    await service.wipeAllLocalData();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    finish(key);
    await expectAsync(pending).toBeRejectedWithError(/almacenamiento local cambio/);
    expect(service.storageState()).toBe('idle');
    expect(service.storageError()).toBe('');
    expect(db.run).not.toHaveBeenCalled();
  });
});
