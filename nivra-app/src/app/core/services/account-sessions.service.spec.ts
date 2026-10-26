import { TestBed } from '@angular/core/testing';
import { IDBPDatabase, deleteDB, openDB } from 'idb';
import { AuthSession } from '../models/nivra.models';
import {
  ACCOUNT_SESSIONS_DB_NAME, ACCOUNT_SESSIONS_SNAPSHOT_KEY, ACCOUNT_SESSIONS_STORE,
  ACCOUNT_SESSIONS_WEB_KEY, AccountSessionsService,
} from './account-sessions.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

describe('encrypted account session registry', () => {
  let name: string;
  let db: IDBPDatabase;
  let services: AccountSessionsService[];
  let service: AccountSessionsService;
  let native: boolean;
  let secret: string | null;
  let getSecret: jasmine.Spy;
  let clearSecret: jasmine.Spy;
  const session = (id: string, token = `opaque-access-${id}`): AuthSession => ({
    user: { id, alias: `alias-${id}`, displayName: `Name ${id}`, profilePhotoDataUrl: null,
      nivraNumber: '123456789', isPrivateAccount: true, isDiscoverable: false,
      allowStoryReposts: true, planCode: 'free', privacySettings: {}, createdAt: '2026-10-25T00:00:00Z' },
    device: { id: `device-${id}`, userId: id, name: 'Fixture', isTrusted: true, createdAt: '2026-10-25T00:00:00Z' },
    tokens: { accessToken: token, refreshToken: `opaque-refresh-${id}` },
  });
  const fresh = () => {
    const next = TestBed.runInInjectionContext(() => new AccountSessionsService());
    services.push(next);
    return next;
  };

  beforeEach(async () => {
    name = `nivra-account-sessions-spec-${crypto.randomUUID()}`;
    services = [];
    native = false;
    secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    getSecret = jasmine.createSpy('getOrCreateSecret').and.callFake(async () => secret);
    clearSecret = jasmine.createSpy('clearSecret').and.resolveTo();
    TestBed.configureTestingModule({ providers: [
      { provide: ACCOUNT_SESSIONS_DB_NAME, useValue: name },
      { provide: NativeSecureVaultService, useValue: { requiresProtection: () => native, getOrCreateSecret: getSecret, clearSecret } },
    ] });
    db = await openDB(name, 1, { upgrade(database) { database.createObjectStore(ACCOUNT_SESSIONS_STORE); } });
    service = fresh();
  }, 15_000);

  afterEach(async () => {
    services.forEach(item => item.ngOnDestroy());
    await Promise.all(services.map(item => (item as any).database?.then((database: IDBPDatabase) => database.close())));
    db.close();
    await deleteDB(name);
    TestBed.resetTestingModule();
  }, 15_000);

  it('returns null for an empty registry without creating a key or touching session storage', async () => {
    const setItem = spyOn(localStorage, 'setItem');
    expect(await service.load()).toBeNull();
    expect(await db.count(ACCOUNT_SESSIONS_STORE)).toBe(0);
    expect(service.accounts()).toEqual([]);
    expect(getSecret).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('stores two accounts and exposes only account summaries through its signal', async () => {
    await service.upsert(session('a'));
    const stored = await service.upsert(session('b'));
    expect(stored?.revision).toBe(2);
    expect(stored?.activeUserId).toBe('b');
    expect(stored?.sessions.map(item => item.user.id)).toEqual(['a', 'b']);
    expect(service.accounts().map(item => [item.id, item.active])).toEqual([['a', false], ['b', true]]);
    expect(JSON.stringify(service.accounts())).not.toContain('accessToken');
    expect(JSON.stringify(service.accounts())).not.toContain('refreshToken');
    expect(JSON.stringify(service.accounts())).not.toContain('device-a');
    expect((await fresh().load())?.sessions).toEqual(stored?.sessions);
  });

  it('encrypts tokens and profiles at rest using a persistent nonextractable browser key', async () => {
    const setItem = spyOn(localStorage, 'setItem');
    await service.upsert(session('a'));
    const envelope = await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
    expect(envelope.schema).toBe(1);
    expect(envelope.protector).toBe('web');
    expect(envelope.ciphertext instanceof ArrayBuffer).toBeTrue();
    expect(new TextDecoder().decode(envelope.ciphertext)).not.toContain('opaque-access-a');
    expect(JSON.stringify(envelope)).not.toContain('Name a');
    expect(envelope.sessions).toBeUndefined();
    const key = await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_WEB_KEY) as CryptoKey;
    expect(key.extractable).toBeFalse();
    await expectAsync(crypto.subtle.exportKey('raw', key)).toBeRejected();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps summary identity stable across privileged reads and token-only rotation', async () => {
    await service.upsert(session('a'));
    const summaries = service.accounts();
    await service.load(); await service.load();
    expect(service.accounts()).toBe(summaries);
    await service.rotateTokens('a', 'device-a', 'opaque-refresh-a', { accessToken: 'new-access', refreshToken: 'new-refresh' }, () => true);
    expect(service.accounts()).toBe(summaries);
  });

  it('rejects a third account while preserving both stored sessions', async () => {
    await service.upsert(session('a'));
    await service.upsert(session('b'));
    await expectAsync(service.upsert(session('c'))).toBeRejectedWithError('Puedes guardar un máximo de dos cuentas en este dispositivo.');
    expect((await service.load())?.sessions.map(item => item.user.id)).toEqual(['a', 'b']);
  });

  it('updates one saved session without activating it or changing the other credentials', async () => {
    await service.upsert(session('a'));
    await service.upsert(session('b'));
    const result = await service.upsert(session('a', 'rotated-access-a'), false);
    expect(result?.activeUserId).toBe('b');
    expect(result?.sessions[0].tokens.accessToken).toBe('rotated-access-a');
    expect(result?.sessions[1].tokens).toEqual(session('b').tokens);
  });

  it('merges profile edits and token rotation without restoring old refresh credentials', async () => {
    await service.upsert(session('a')); await service.upsert(session('b'));
    const edited = { ...session('a').user, displayName: 'Edited name' };
    const rotated = { accessToken: 'rotated-access-a', refreshToken: 'rotated-refresh-a' };
    await Promise.all([
      service.updateProfile(edited, 'device-a', () => true),
      fresh().rotateTokens('a', 'device-a', 'opaque-refresh-a', rotated, () => true),
    ]);
    const stored = await service.load();
    expect(stored?.sessions[0].user.displayName).toBe('Edited name');
    expect(stored?.sessions[0].tokens).toEqual(rotated);
    expect(stored?.sessions[1].tokens).toEqual(session('b').tokens);
    expect(stored?.activeUserId).toBe('b');
    expect(await service.rotateTokens('a', 'device-a', 'opaque-refresh-a', session('a').tokens, () => true)).toBeNull();
    expect(await service.rotateTokens('a', 'old-device', 'rotated-refresh-a', session('a').tokens, () => true)).toBeNull();
    await service.remove('a');
    expect(await service.rotateTokens('a', 'device-a', 'rotated-refresh-a', session('a').tokens, () => true)).toBeNull();
    expect(await service.updateProfile(edited, 'device-a', () => true)).toBeNull();
    expect((await service.load())?.sessions.map(auth => auth.user.id)).toEqual(['b']);
  });

  it('activates and removes accounts atomically while retaining the other account and protector', async () => {
    await service.upsert(session('a'));
    await service.upsert(session('b'));
    expect((await service.activate('a'))?.activeUserId).toBe('a');
    const remaining = await service.remove('a');
    expect(remaining?.activeUserId).toBe('b');
    expect(remaining?.sessions).toEqual([session('b')]);
    const empty = await service.remove('b');
    expect(empty?.activeUserId).toBeNull();
    expect(empty?.sessions).toEqual([]);
    expect(await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_WEB_KEY)).toBeDefined();
    expect(clearSecret).not.toHaveBeenCalled();
    expect(await service.activate('missing')).toBeNull();
  });

  it('does not create or mutate anything for a stale operation', async () => {
    expect(await service.upsert(session('a'), true, () => false)).toBeNull();
    expect(await db.count(ACCOUNT_SESSIONS_STORE)).toBe(0);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('matches the saved device when activating or removing a notification target', async () => {
    await service.upsert(session('a')); await service.upsert(session('b'));
    const replacement = session('a'); replacement.device.id = 'replacement-device';
    await service.upsert(replacement, false);
    expect(await service.activate('a', () => true, 'device-a')).toBeNull();
    expect(await service.remove('a', () => true, 'device-a')).toBeNull();
    const saved = await service.load();
    expect(saved?.sessions.length).toBe(2);
    expect(saved?.activeUserId).toBe('b');
    expect(saved?.sessions[0].device.id).toBe('replacement-device');
  });

  it('discards a write invalidated while encryption is pending', async () => {
    await service.upsert(session('a'));
    let current = true;
    const original = (service as any).encrypt.bind(service);
    spyOn<any>(service, 'encrypt').and.callFake(async (...args: any[]) => {
      const encrypted = await original(...args);
      current = false;
      return encrypted;
    });
    expect(await service.upsert(session('b'), true, () => current)).toBeNull();
    expect((await fresh().load())?.sessions.map(item => item.user.id)).toEqual(['a']);
  });

  it('keeps corrupted ciphertext unchanged and never publishes fabricated sessions', async () => {
    await service.upsert(session('a'));
    const envelope = await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
    new Uint8Array(envelope.ciphertext)[0] ^= 1;
    await db.put(ACCOUNT_SESSIONS_STORE, envelope, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
    const reader = fresh();
    await expectAsync(reader.load()).toBeRejectedWithError(/Sus datos se han conservado/);
    await expectAsync(reader.upsert(session('b'))).toBeRejectedWithError(/Sus datos se han conservado/);
    expect((await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY)).ciphertext).toEqual(envelope.ciphertext);
    expect(reader.accounts()).toEqual([]);
  });

  it('does not recreate a missing browser key when ciphertext already exists', async () => {
    await service.upsert(session('a'));
    await db.delete(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_WEB_KEY);
    await expectAsync(fresh().load()).toBeRejectedWithError(/Sus datos se han conservado/);
    await expectAsync(service.upsert(session('b'))).toBeRejectedWithError(/Sus datos se han conservado/);
    expect(await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_WEB_KEY)).toBeUndefined();
    expect(await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY)).toBeDefined();
  });

  it('creates a native protector only for a new registry and stores no browser key', async () => {
    native = true;
    const retained = secret;
    getSecret.and.callFake(async (_name: string, options?: { create?: boolean }) => options?.create === false ? null : retained);
    await service.upsert(session('a'));
    expect(getSecret.calls.allArgs()).toEqual([['auth-session', { create: false }], ['auth-session']]);
    expect((await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY)).protector).toBe('secure');
    expect(await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_WEB_KEY)).toBeUndefined();
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it('uses native read-only key access for existing ciphertext and preserves it when locked or missing', async () => {
    native = true;
    await service.upsert(session('a'));
    getSecret.calls.reset();
    secret = null;
    await expectAsync(fresh().load()).toBeRejectedWithError(/Sus datos se han conservado/);
    await expectAsync(service.upsert(session('b'))).toBeRejectedWithError(/Sus datos se han conservado/);
    expect(getSecret.calls.allArgs().every(args => args[1]?.create === false)).toBeTrue();
    expect(clearSecret).not.toHaveBeenCalled();
    getSecret.and.rejectWith(new Error('sensitive-native-provider-path'));
    await expectAsync(fresh().load()).toBeRejectedWithError('No pudimos abrir las cuentas guardadas. Sus datos se han conservado. Desbloquea el dispositivo y vuelve a intentar.');
  });

  it('authenticates the envelope revision as associated data', async () => {
    await service.upsert(session('a'));
    const envelope = await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
    envelope.revision++;
    await db.put(ACCOUNT_SESSIONS_STORE, envelope, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
    await expectAsync(fresh().load()).toBeRejectedWithError(/Sus datos se han conservado/);
  });

  it('rejects malformed records without replacing them or creating a new native secret', async () => {
    native = true;
    await db.put(ACCOUNT_SESSIONS_STORE, { schema: 99, ciphertext: 'retained-invalid-record' }, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
    await expectAsync(service.upsert(session('a'))).toBeRejectedWithError(/Sus datos se han conservado/);
    expect(await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY)).toEqual({ schema: 99, ciphertext: 'retained-invalid-record' });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('merges concurrent first writes from separate instances under one committed browser key', async () => {
    const other = fresh();
    await Promise.all([service.upsert(session('a')), other.upsert(session('b'))]);
    const result = await fresh().load();
    expect(result?.revision).toBe(2);
    expect(result?.sessions.map(item => item.user.id).sort()).toEqual(['a', 'b']);
    expect(await db.count(ACCOUNT_SESSIONS_STORE)).toBe(2);
  });

  it('enforces the two-account limit against concurrent additions in different instances', async () => {
    await service.upsert(session('a'));
    const results = await Promise.allSettled([service.upsert(session('b')), fresh().upsert(session('c'))]);
    expect(results.filter(result => result.status === 'fulfilled').length).toBe(1);
    expect(results.filter(result => result.status === 'rejected').length).toBe(1);
    const snapshot = await fresh().load();
    expect(snapshot?.sessions.length).toBe(2);
    expect(snapshot?.sessions[0].user.id).toBe('a');
  });

  it('rejects mixed user/device/token ownership while allowing opaque future bearer tokens', async () => {
    const mixedDevice = session('a'); mixedDevice.device.userId = 'b';
    await expectAsync(service.upsert(mixedDevice)).toBeRejectedWithError('No se pudo comprobar la identidad de la cuenta.');
    const apiClaims = btoa(JSON.stringify({ UserId: 'b', DeviceId: 'device-a' })).replace(/=/g, '');
    await expectAsync(service.upsert(session('a', `${apiClaims}.signature`))).toBeRejectedWithError('No se pudo comprobar la identidad de la cuenta.');
    const jwtClaims = btoa(JSON.stringify({ sub: 'a', deviceId: 'device-b' })).replace(/=/g, '');
    await expectAsync(service.upsert(session('a', `e30.${jwtClaims}.signature`))).toBeRejectedWithError('No se pudo comprobar la identidad de la cuenta.');
    const future = session('a'); delete (future.device as Partial<AuthSession['device']>).userId;
    expect((await service.upsert(future))?.sessions[0].tokens.accessToken).toBe('opaque-access-a');
  });

  it('returns detached snapshots so caller edits cannot change the stored credentials or summaries', async () => {
    const result = await service.upsert(session('a'));
    result!.sessions[0].tokens.accessToken = 'caller-overwrite';
    result!.sessions[0].user.alias = 'caller-overwrite';
    expect((await service.load())?.sessions[0].tokens.accessToken).toBe('opaque-access-a');
    expect(service.accounts()[0].alias).toBe('alias-a');
  });
});
