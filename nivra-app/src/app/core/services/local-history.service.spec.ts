import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { IDBPDatabase } from 'idb';
import { LocalHistoryService } from './local-history.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

interface HistoryInternals {
  open(): Promise<IDBPDatabase | null>;
  nativeLocalVaultKey(accountKey: string): Promise<CryptoKey | null>;
  unprotectLocalVaultKey(record: unknown): Promise<CryptoKey | null>;
  localVaultKey(accountKey: string): Promise<CryptoKey>;
}

describe('local history vault recovery', () => {
  let service: LocalHistoryService;
  let internals: HistoryInternals;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [LocalHistoryService, {
        provide: NativeSecureVaultService,
        useValue: { getOrCreateSecret: async () => 'existing-vault-secret' },
      }],
    });
    service = TestBed.inject(LocalHistoryService);
    internals = service as unknown as HistoryInternals;
  });

  it('preserves the native database on open failure and retries after the device unlocks', async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    const db = jasmine.createSpyObj<SQLiteDBConnection>('db', ['open', 'execute', 'query']);
    db.open.and.rejectWith(new Error('temporarily locked'));
    db.execute.and.resolveTo({ changes: { changes: 0 } });
    db.query.and.resolveTo({ values: [] });
    spyOn(SQLiteConnection.prototype, 'isConnection').and.resolveTo({ result: true });
    spyOn(SQLiteConnection.prototype, 'retrieveConnection').and.resolveTo(db);
    spyOn(SQLiteConnection.prototype, 'setEncryptionSecret').and.resolveTo();
    spyOn(SQLiteConnection.prototype, 'clearEncryptionSecret').and.resolveTo();
    spyOn(SQLiteConnection.prototype, 'closeConnection').and.resolveTo();
    const create = spyOn(SQLiteConnection.prototype, 'createConnection');
    const fallback = spyOn(internals, 'open').and.resolveTo(null);

    await expectAsync(service.conversationMessagesPage('account', 'conversation')).toBeRejectedWithError(/historial cifrado/);
    expect(create).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(service.storageError()).toContain('historial cifrado');

    const zoneRun = spyOn(TestBed.inject(NgZone), 'run').and.callThrough();
    db.open.and.resolveTo();
    await expectAsync(service.conversationMessagesPage('account', 'conversation')).toBeResolvedTo([]);
    expect(db.open).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(zoneRun).toHaveBeenCalled();
    expect(service.storageError()).toBe('');
  });

  it('does not replace an existing wrapped history key when its protector cannot unlock it', async () => {
    const existing = { accountKey: 'account', keyEnvelope: { v: 1, ciphertext: 'existing-ciphertext' } };
    const store = { get: jasmine.createSpy().and.resolveTo(existing), put: jasmine.createSpy() };
    const db = { transaction: () => ({ objectStore: () => store }) } as unknown as IDBPDatabase;
    spyOn(internals, 'nativeLocalVaultKey').and.resolveTo(null);
    spyOn(internals, 'unprotectLocalVaultKey').and.resolveTo(null);
    spyOn(internals, 'open').and.resolveTo(db);

    await expectAsync(internals.localVaultKey('account')).toBeRejectedWithError(/clave del historial local/);
    expect(store.put).not.toHaveBeenCalled();
    expect(existing.keyEnvelope.ciphertext).toBe('existing-ciphertext');
    expect(service.storageError()).toContain('clave guardada se ha conservado');
  });
});
