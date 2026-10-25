import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { IDBPDatabase, deleteDB, openDB } from 'idb';
import { ChatMessageVm } from '../models/nivra.models';
import { LocalHistoryService } from './local-history.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

describe('encrypted browser history transaction boundaries', () => {
  let service: LocalHistoryService;
  let db: IDBPDatabase;
  let databaseName: string;
  let secret: string;
  let getSecret: jasmine.Spy;
  const message = (id: string, text: string): ChatMessageVm => ({
    id, conversationId: 'conversation', senderUserId: 'sender', mine: false,
    at: `2026-10-21T12:00:0${id}Z`, payload: { type: 'text', text },
  });

  beforeEach(async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    // A native key protector is asynchronous and may resume on another task.
    getSecret = jasmine.createSpy().and.callFake(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return secret;
    });
    TestBed.configureTestingModule({ providers: [LocalHistoryService, {
      provide: NativeSecureVaultService,
      useValue: { getOrCreateSecret: getSecret, requiresProtection: () => true },
    }] });
    service = TestBed.inject(LocalHistoryService);
    databaseName = `nivra-history-regression-${crypto.randomUUID()}`;
    db = await openDB(databaseName, 1, { upgrade(database) {
      const store = database.createObjectStore('messages', { keyPath: 'key' });
      store.createIndex('byConversationAt', ['accountKey', 'conversationId', 'at']);
      database.createObjectStore('localVaultKeys', { keyPath: 'accountKey' });
    } });
    spyOn<any>(service, 'open').and.resolveTo(db);
  // IndexedDB setup depends on OS storage scheduling on loaded build hosts.
  // Keep the tested operations' normal timeout; allow setup/cleanup more time.
  }, 15_000);

  afterEach(async () => {
    try {
      db?.close();
      if (databaseName) await deleteDB(databaseName);
    } finally { TestBed.resetTestingModule(); }
  }, 15_000);

  it('persists a first encrypted batch after real asynchronous key protection without an inactive transaction', async () => {
    const messages = [message('1', 'first protected text'), message('2', 'second protected text')];
    await service.putMessages('account', messages);
    const stored = await db.getAll('messages');
    expect(stored.length).toBe(2);
    expect(JSON.stringify(stored)).not.toContain('protected text');
    expect(stored.every(record => record.payloadEnvelope?.alg === 'A256GCM' && !record.payload)).toBeTrue();
    const keyRecord = await db.get('localVaultKeys', 'account');
    expect(keyRecord.key).toBeUndefined();
    expect(keyRecord.keyEnvelope.alg).toBe('NIVRA-SECURE-VAULT-A256GCM');
    const restored = await service.conversationMessagesPage('account', 'conversation');
    expect(restored.map(item => item.payload.text)).toEqual(messages.map(item => item.payload.text));
    expect(restored.some(item => item.decryptError)).toBeFalse();
  });

  it('keeps concurrent first batches readable under one retained account key', async () => {
    await Promise.all([
      service.putMessages('account', [message('1', 'batch one')]),
      service.putMessages('account', [message('2', 'batch two')]),
    ]);
    expect((await db.getAll('localVaultKeys')).length).toBe(1);
    const restored = await service.conversationMessagesPage('account', 'conversation');
    expect(restored.map(item => item.payload.text)).toEqual(['batch one', 'batch two']);
    expect(restored.some(item => item.decryptError)).toBeFalse();
  });

  it('never falls back to plaintext persistence when a required protector is unavailable', async () => {
    getSecret.and.resolveTo(null);
    await expectAsync(service.putMessages('account', [message('1', 'must stay private')])).toBeRejectedWithError(/protector seguro/);
    expect(await db.getAll('messages')).toEqual([]);
    expect(await db.getAll('localVaultKeys')).toEqual([]);
  });
});
