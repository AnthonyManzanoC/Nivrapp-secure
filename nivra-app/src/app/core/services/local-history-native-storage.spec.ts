import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLitePlugin, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
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
  sqliteConnection?: SQLiteConnection;
}

describe('native encrypted history startup recovery', () => {
  let service: LocalHistoryService;
  let internals: NativeHistoryInternals;
  let db: jasmine.SpyObj<SQLiteDBConnection>;
  let vault: { getOrCreateSecret: jasmine.Spy; requiresProtection: () => boolean; clearSecret: jasmine.Spy; retryLocalHistoryInitialization: jasmine.Spy; inspectLocalHistoryStorage: jasmine.Spy; migrateLegacyHistoryStorage: jasmine.Spy };
  let reconcile: jasmine.Spy;
  let checkSecret: jasmine.Spy;
  let create: jasmine.Spy;
  let clearSecret: jasmine.Spy;
  let databaseExists: jasmine.Spy;
  let secretStored: jasmine.Spy;

  beforeEach(() => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    vault = { getOrCreateSecret: jasmine.createSpy().and.resolveTo('retained-native-secret'),
      requiresProtection: () => true, clearSecret: jasmine.createSpy().and.resolveTo(),
      retryLocalHistoryInitialization: jasmine.createSpy().and.resolveTo(true),
      inspectLocalHistoryStorage: jasmine.createSpy().and.resolveTo(null),
      migrateLegacyHistoryStorage: jasmine.createSpy().and.resolveTo() };
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
    databaseExists = spyOn(SQLiteConnection.prototype, 'isDatabase').and.resolveTo({ result: true });
    secretStored = spyOn(SQLiteConnection.prototype, 'isSecretStored').and.resolveTo({ result: true });
    checkSecret = spyOn(SQLiteConnection.prototype, 'checkEncryptionSecret').and.resolveTo({ result: true });
    spyOn(SQLiteConnection.prototype, 'setEncryptionSecret').and.resolveTo();
    clearSecret = spyOn(SQLiteConnection.prototype, 'clearEncryptionSecret').and.resolveTo();
    spyOn(SQLiteConnection.prototype, 'closeConnection').and.resolveTo();
    spyOn(SQLiteConnection.prototype, 'closeAllConnections').and.resolveTo();
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

  it('reinitializes a native plugin that cached a temporary Keystore startup failure', async () => {
    checkSecret.and.callFake(() => checkSecret.calls.count() === 1
      ? Promise.reject(new Error('CapacitorSQLitePlugin: Keystore unavailable during startup'))
      : Promise.resolve({ result: true }));
    expect(await service.retryNativeStorage()).toBeTrue();
    expect(vault.retryLocalHistoryInitialization).toHaveBeenCalledTimes(1);
    expect(checkSecret).toHaveBeenCalledTimes(2);
    expect(db.open).toHaveBeenCalledTimes(1);
    expect(service.storageState()).toBe('ready');
    expect(service.storageError()).toBe('');
    expect(clearSecret).not.toHaveBeenCalled();
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('ends a persistent native initialization failure after bounded recovery and retains storage', async () => {
    checkSecret.and.rejectWith(new Error('CapacitorSQLitePlugin: Keystore remains unavailable'));
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(checkSecret).toHaveBeenCalledTimes(3);
    expect(vault.retryLocalHistoryInitialization).toHaveBeenCalledTimes(2);
    expect(service.storageBusy()).toBeFalse();
    expect(service.storageState()).toBe('error');
    expect(service.storageError()).toContain('historial cifrado');
    expect(clearSecret).not.toHaveBeenCalled();
    expect(vault.clearSecret).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps real failures visible and coalesces concurrent explicit retries into one successful open', async () => {
    db.open.and.rejectWith(new Error('device remains locked'));
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(service.storageState()).toBe('error');
    expect(vault.retryLocalHistoryInitialization).not.toHaveBeenCalled();
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

  it('rejects a retained mismatched secret if the existing DB cannot validate the history schema', async () => {
    checkSecret.and.resolveTo({ result: false });
    const fallback = spyOn(internals, 'open').and.resolveTo(null);
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(checkSecret).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledOnceWith('nivra_local_vault', true, 'secret', 1, true);
    expect(db.open).toHaveBeenCalledTimes(1);
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
    expect(clearSecret).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(service.storageState()).toBe('error');
    expect(vault.retryLocalHistoryInitialization).not.toHaveBeenCalled();
    expect(service.storageDiagnostic()).toEqual({ backend: 'sqlite', stage: 'retained-key', code: 'RETAINED_KEY_SCHEMA_INVALID', attempt: 1, retryable: false });
  });

  it('opens an existing history using its validated retained SQLCipher secret without replacing either vault secret', async () => {
    checkSecret.and.resolveTo({ result: false });
    db.query.and.resolveTo({ values: ['local_messages', 'local_conversations', 'local_vault_keys'].map(name => ({ name })) });
    expect(await service.retryNativeStorage()).toBeTrue();
    expect(create).toHaveBeenCalledOnceWith('nivra_local_vault', true, 'secret', 1, true);
    expect(db.open).toHaveBeenCalledTimes(2); // Read-only validation, then normal connection.
    expect(db.query.calls.first().args[0]).toContain('sqlite_master');
    expect(vault.getOrCreateSecret).toHaveBeenCalledWith('local-db', { create: false });
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
    expect(clearSecret).not.toHaveBeenCalled();
    expect(vault.clearSecret).not.toHaveBeenCalled();
    expect(service.storageState()).toBe('ready');
    expect(service.storageDiagnostic()).toBeNull();
  });

  it('retains a readable native history when the separate Nivra protector is temporarily unavailable', async () => {
    vault.getOrCreateSecret.and.rejectWith({ code: 'NIVRA_KEYSTORE_LOCKED', message: 'private Android provider details' });
    db.query.and.resolveTo({ values: ['local_messages', 'local_conversations', 'local_vault_keys'].map(name => ({ name })) });
    expect(await service.retryNativeStorage()).toBeTrue();
    expect(checkSecret).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnceWith('nivra_local_vault', true, 'secret', 1, true);
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it('does not create a replacement database when retained secrets disagree and the old DB is missing', async () => {
    databaseExists.and.resolveTo({ result: false });
    checkSecret.and.resolveTo({ result: false });
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(create).not.toHaveBeenCalled();
    expect(db.open).not.toHaveBeenCalled();
    expect(service.storageDiagnostic()?.code).toBe('DATABASE_MISSING_WITH_RETAINED_KEY');
    expect(vault.getOrCreateSecret).toHaveBeenCalledWith('local-db', { create: false });
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('rejects an unreadable retained key using only a safe stage and cause code', async () => {
    checkSecret.and.resolveTo({ result: false });
    db.open.and.rejectWith(new Error('file is not a database; private-secret-and-path-must-never-appear'));
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(db.open).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledOnceWith('nivra_local_vault', true, 'secret', 1, true);
    expect(service.storageDiagnostic()).toEqual({ backend: 'sqlite', stage: 'retained-key', code: 'DATABASE_KEY_UNREADABLE', attempt: 1, retryable: false });
    expect(service.storageError()).toContain('retained-key/DATABASE_KEY_UNREADABLE');
    expect(JSON.stringify(service.storageDiagnostic()) + service.storageError()).not.toContain('private-secret');
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it('does not create another Nivra protector for an existing DB with no retained SQLCipher secret', async () => {
    secretStored.and.resolveTo({ result: false });
    vault.getOrCreateSecret.and.resolveTo(null);
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(vault.getOrCreateSecret).toHaveBeenCalledOnceWith('local-db', { create: false });
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(service.storageDiagnostic()?.code).toBe('NIVRA_SECURE_SECRET_MISSING');
  });

  it('automatically migrates legacy plaintext with the retained key and reopens it without replacing any secrets', async () => {
    checkSecret.and.resolveTo({ result: false });
    let migrated = false;
    db.open.and.callFake(async () => { if (!migrated) throw new Error('file is not a database'); });
    db.query.and.callFake(async (sql: string) => ({ values: sql.startsWith('SELECT name')
      ? ['local_messages', 'local_conversations', 'local_vault_keys'].map(name => ({ name })) : [] }));
    vault.inspectLocalHistoryStorage.and.callFake(async () => ({ databaseExists: true,
      databaseFormat: migrated ? 'encrypted-or-unknown' : 'sqlite' }));
    vault.migrateLegacyHistoryStorage.and.callFake(async () => { migrated = true; });
    expect(await service.retryNativeStorage()).toBeTrue();
    expect(vault.migrateLegacyHistoryStorage).toHaveBeenCalledTimes(1);
    expect(SQLiteConnection.prototype.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2); // Both are RO validation, including the retained key after migration.
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(service.storageState()).toBe('ready');
    expect(service.storageDiagnostic()).toBeNull();
    expect(vault.getOrCreateSecret.calls.allArgs().every(args => args[1]?.create === false)).toBeTrue();
    expect(clearSecret).not.toHaveBeenCalled();
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('fails closed when safe migration cannot verify contents, without leaking native details or looping', async () => {
    db.open.and.rejectWith(new Error('file is not a database'));
    vault.inspectLocalHistoryStorage.and.resolveTo({ databaseExists: true, databaseFormat: 'sqlite' });
    vault.migrateLegacyHistoryStorage.and.rejectWith({ code: 'NIVRA_HISTORY_MIGRATION_CONTENT_MISMATCH', message: 'PRIVATE_ROWS_AND_KEY' });
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(service.storageDiagnostic()).toEqual({ backend: 'sqlite', stage: 'legacy-migration',
      code: 'NIVRA_HISTORY_MIGRATION_CONTENT_MISMATCH', attempt: 1, retryable: false });
    expect(vault.migrateLegacyHistoryStorage).toHaveBeenCalledTimes(1);
    expect(service.storageError()).not.toContain('PRIVATE_ROWS_AND_KEY');
    expect(clearSecret).not.toHaveBeenCalled();
    expect(vault.clearSecret).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('finishes a previously published migration before opening the database for normal writes', async () => {
    const order: string[] = [];
    vault.inspectLocalHistoryStorage.and.resolveTo({ databaseExists: true,
      databaseFormat: 'encrypted-or-unknown', migrationPending: true });
    vault.migrateLegacyHistoryStorage.and.callFake(async () => { order.push('verified-cleanup'); });
    db.open.and.callFake(async () => { order.push('open'); });
    db.execute.and.callFake(async () => { order.push('schema'); return { changes: { changes: 0 } }; });
    expect(await service.retryNativeStorage()).toBeTrue();
    expect(order).toEqual(['verified-cleanup', 'open', 'schema']);
    expect(vault.migrateLegacyHistoryStorage).toHaveBeenCalledTimes(1);
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('does not attempt conversion when a retained key cannot read an encrypted database', async () => {
    db.open.and.rejectWith(new Error('file is not a database'));
    vault.inspectLocalHistoryStorage.and.resolveTo({ databaseExists: true, databaseFormat: 'encrypted-or-unknown' });
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(vault.migrateLegacyHistoryStorage).not.toHaveBeenCalled();
    expect(service.storageDiagnostic()?.code).toBe('DATABASE_KEY_UNREADABLE');
  });

  it('preserves the pending migration copies when the existing retained secret is unavailable', async () => {
    vault.inspectLocalHistoryStorage.and.resolveTo({ databaseExists: true,
      databaseFormat: 'encrypted-or-unknown', migrationPending: true });
    vault.migrateLegacyHistoryStorage.and.rejectWith({ code: 'NIVRA_HISTORY_MIGRATION_SECRET_UNAVAILABLE' });
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(service.storageDiagnostic()?.code).toBe('NIVRA_HISTORY_MIGRATION_SECRET_UNAVAILABLE');
    expect(db.open).not.toHaveBeenCalled();
    expect(vault.clearSecret).not.toHaveBeenCalled();
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('distinguishes a partial native protector from a locked device and preserves its fragments', async () => {
    secretStored.and.resolveTo({ result: false });
    vault.getOrCreateSecret.and.rejectWith({ code: 'NIVRA_SECURE_ENVELOPE_INCOMPLETE', message: 'do-not-show-envelope-values' });
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(service.storageDiagnostic()).toEqual({ backend: 'sqlite', stage: 'secure-secret', code: 'NIVRA_SECURE_ENVELOPE_INCOMPLETE', attempt: 1, retryable: false });
    expect(service.storageError()).not.toContain('envelope-values');
    expect(vault.clearSecret).not.toHaveBeenCalled();
    expect(SQLiteConnection.prototype.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('reports schema preparation separately and never publishes the native SQL or values', async () => {
    db.execute.and.rejectWith(new Error('syntax error in SQL with PRIVATE_VALUE'));
    expect(await service.retryNativeStorage()).toBeFalse();
    expect(service.storageDiagnostic()).toEqual({ backend: 'sqlite', stage: 'schema', code: 'SCHEMA_MISMATCH', attempt: 1, retryable: false });
    expect(service.storageError()).toContain('estructura');
    expect(service.storageError()).not.toContain('PRIVATE_VALUE');
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

describe('native history with the actual SQLite connection wrapper', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reconciles retained JS handles after Android secret checking closes native connections', async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    const handles = new Map<string, boolean>();
    const native = {
      isDatabase: jasmine.createSpy().and.resolveTo({ result: true }),
      isSecretStored: jasmine.createSpy().and.resolveTo({ result: true }),
      checkEncryptionSecret: jasmine.createSpy().and.callFake(async () => {
        // This is the Android 8.1 plugin contract, not a side-effect-free check.
        handles.clear();
        return { result: true };
      }),
      checkConnectionsConsistency: jasmine.createSpy().and.callFake(async (options: { dbNames: string[] }) => ({
        result: options.dbNames.length > 0 && options.dbNames.every(name => handles.has(name)),
      })),
      createConnection: jasmine.createSpy().and.callFake(async (options: { database: string }) => { handles.set(options.database, false); }),
      closeConnection: jasmine.createSpy().and.callFake(async (options: { database: string }) => {
        if (!handles.has(options.database)) throw new Error('No available connection');
        handles.delete(options.database);
      }),
      isDBOpen: jasmine.createSpy().and.callFake(async (options: { database: string }) => {
        if (!handles.has(options.database)) throw new Error('No available connection');
        return { result: handles.get(options.database) };
      }),
      open: jasmine.createSpy().and.callFake(async (options: { database: string }) => {
        if (!handles.has(options.database)) throw new Error('No available connection');
        handles.set(options.database, true);
      }),
      execute: jasmine.createSpy().and.resolveTo({ changes: { changes: 0 } }),
      query: jasmine.createSpy().and.resolveTo({ values: [] }),
    };
    TestBed.configureTestingModule({ providers: [LocalHistoryService, {
      provide: NativeSecureVaultService, useValue: { getOrCreateSecret: async () => 'retained-native-secret' },
    }] });
    const service = TestBed.inject(LocalHistoryService);
    const connection = new SQLiteConnection(native as unknown as CapacitorSQLitePlugin);
    await connection.createConnection('nivra_local_vault', true, 'secret', 1, false);
    handles.set('nivra_local_vault', true);
    (service as unknown as NativeHistoryInternals).sqliteConnection = connection;

    expect(await service.retryNativeStorage()).toBeTrue();
    expect(native.checkEncryptionSecret).toHaveBeenCalledTimes(1);
    expect(native.checkConnectionsConsistency).toHaveBeenCalledTimes(1);
    expect(native.createConnection).toHaveBeenCalledTimes(2); // Seed plus fresh handle.
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.closeConnection).not.toHaveBeenCalled();
    expect(service.storageState()).toBe('ready');
    expect(service.storageError()).toBe('');
    expect(await service.conversations('account')).toEqual([]);
  });
});
