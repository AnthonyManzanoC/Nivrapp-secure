import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';

describe('authenticated device identity recovery', () => {
  function cryptography(secret?: () => string | null) {
    const records = new Map<string, any>();
    const db = { get: async (_store: string, id: string) => records.get(id),
      getAll: async () => [...records.values()], put: async (_store: string, record: any) => records.set(record.id, record) };
    const service: any = Object.assign(Object.create(CryptoService.prototype), {
      open: async () => db, yieldToMainThread: async () => undefined,
      secureVault: { requiresProtection: () => Boolean(secret), getOrCreateSecret: async () => secret?.() ?? null },
    });
    return { service, records };
  }
  function harness(crypto: any, publishedKey: JsonWebKey, sourceHardware = 'local-hardware') {
    const jwt = (deviceId: string) => `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ sub: 'alice', deviceId, exp: 4070908800 })).replace(/=/g, '')}.synthetic-test-token`;
    const initial = { user: { id: 'alice', alias: 'alice' }, device: { id: 'source', userId: 'alice', hardwareId: sourceHardware, isTrusted: true },
      tokens: { accessToken: jwt('source'), refreshToken: 'source-refresh' } };
    const linked = { ...initial, device: { ...initial.device, id: 'target', hardwareId: 'local-hardware' },
      tokens: { accessToken: jwt('target'), refreshToken: 'target-refresh' } };
    const published = new Map<string, JsonWebKey>([['source', publishedKey]]);
    const paths: string[] = [];
    let savedBeforePublish = false;
    const service: any = Object.assign(Object.create(AuthService.prototype), {
      session: signal<any>(initial), sessionWriteEpoch: 0, deviceIdentityOperation: null,
      deviceIdentityReady: null, deviceIdentityValidationEpoch: 0,
      ensureFreshSession: async () => true, hardwareId: async () => 'local-hardware', deviceName: () => 'Local browser', crypto,
      persistSession: jasmine.createSpy('persist').and.callFake(async (auth: any, current: () => boolean) => {
        if (!current()) return false; service.session.set(auth); return true;
      }),
    });
    const fetch = jasmine.createSpy('fetch').and.callFake(async (path: string, init: RequestInit) => {
      paths.push(path); const headers = init.headers as Record<string, string>; const device = headers['X-Nivra-Device-Id'];
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (path === '/devices') return new Response(JSON.stringify([initial.device]));
      if (path === '/keys/batch') return new Response(JSON.stringify([{ userId: 'alice', devices: [...published].map(([deviceId, key]) => ({ deviceId, keyBundle: { identityKey: JSON.stringify(key) } })) }]));
      if (path === '/keys/prekeys') {
        const stored = await crypto.currentKeyMaterial('alice', device);
        savedBeforePublish = crypto.samePublicKey(stored.publicJwk, JSON.parse(body.identityKey));
        published.set(device, JSON.parse(body.identityKey)); return new Response(JSON.stringify(initial.device));
      }
      if (path === '/auth/repair-device') {
        const pending = await crypto.currentKeyMaterial('alice', 'identity-repair:alice:local-hardware');
        expect(body.recoveryToken).toMatch(/^[a-f0-9]{64}$/);
        expect(String(init.body)).not.toContain(pending.privateJwk.d);
        savedBeforePublish = crypto.samePublicKey(pending.publicJwk, JSON.parse(body.keyBundle.identityKey));
        published.set('target', JSON.parse(body.keyBundle.identityKey)); return new Response(JSON.stringify(linked));
      }
      throw new Error(`Unexpected local test route: ${path}`);
    });
    service.api = { fetch };
    return { service, initial, linked, published, paths, fetch, savedBeforePublish: () => savedBeforePublish };
  }

  it('saves a missing local identity before publishing it and verifies the registered key before returning', async () => {
    const local = cryptography(); const lost = await local.service.createDeviceKeys();
    const test = harness(local.service, lost.publicJwk);
    const restored = await test.service.ensureDeviceIdentity();
    expect(test.savedBeforePublish()).toBeTrue();
    expect(restored.userId).toBe('alice'); expect(restored.deviceId).toBe('source');
    expect(local.service.samePublicKey(restored.publicJwk, test.published.get('source'))).toBeTrue();
    expect(local.service.samePublicKey(restored.publicJwk, lost.publicJwk)).toBeFalse();
    expect(test.service.session()).toBe(test.initial);
  });

  it('coalesces concurrent repair and caches successful verification until device changes invalidate it', async () => {
    const local = cryptography(); const keys = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', keys, { userId: 'alice' });
    const test = harness(local.service, keys.publicJwk);
    const [first, second] = await Promise.all([test.service.ensureDeviceIdentity(), test.service.ensureDeviceIdentity()]);
    expect(first.publicJwk).toEqual(second.publicJwk);
    const calls = test.fetch.calls.count();
    await test.service.ensureDeviceIdentity(); await test.service.ensureDeviceIdentity();
    expect(test.fetch.calls.count()).toBe(calls);
    test.service.invalidateDeviceIdentity(); await test.service.ensureDeviceIdentity();
    expect(test.fetch.calls.count()).toBeGreaterThan(calls);
    expect(test.paths.filter(path => path === '/keys/prekeys').length).toBe(0);
  });

  it('migrates copied QR credentials to a separately generated device without rotating the source key', async () => {
    const local = cryptography(); const source = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', source, { userId: 'alice' });
    const test = harness(local.service, source.publicJwk, 'physical-phone');
    const repaired = await test.service.ensureDeviceIdentity();
    expect(test.savedBeforePublish()).toBeTrue();
    expect(repaired.deviceId).toBe('target'); expect(test.service.session().device.id).toBe('target');
    expect(local.service.samePublicKey(repaired.publicJwk, source.publicJwk)).toBeFalse();
    expect(test.published.get('source')).toEqual(source.publicJwk);
    expect(test.paths).not.toContain('/keys/prekeys');
    expect(local.service.samePublicKey((await local.service.currentKeyMaterial('alice', 'source')).publicJwk, source.publicJwk)).toBeTrue();
  });

  it('adopts the repaired device with the real session compare-and-set that advances its write epoch', async () => {
    const local = cryptography(); const source = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', source, { userId: 'alice' });
    const test = harness(local.service, source.publicJwk, 'physical-phone');
    test.service.persistSession = (AuthService.prototype as any).persistSession.bind(test.service);
    test.service.secureVault = { requiresProtection: () => false };
    const write = spyOn(localStorage, 'setItem'); spyOn(localStorage, 'removeItem');
    const keys = await test.service.ensureDeviceIdentity();
    expect(keys.deviceId).toBe('target'); expect(test.service.session().device.id).toBe('target');
    expect(test.service.sessionWriteEpoch).toBe(1);
    expect(write).toHaveBeenCalledWith('nivra.auth', JSON.stringify(test.linked));
    expect(JSON.parse(atob(test.service.session().tokens.accessToken.split('.')[1])).deviceId).toBe('target');
    const freshLookup = await local.service.currentKeyMaterial('alice', 'target');
    expect(freshLookup.privateJwk.d).toBe(keys.privateJwk.d);
    expect(test.published.get('source')).toEqual(source.publicJwk);
    expect((await local.service.currentKeyMaterial('alice', 'source')).privateJwk.d).toBe(source.privateJwk.d);
  });

  it('keeps the old session and local keys when a server cannot safely migrate copied credentials', async () => {
    const local = cryptography(); const source = await local.service.createDeviceKeys();
    const test = harness(local.service, source.publicJwk, 'physical-phone');
    // Keep normal directory reads; reject only the optional migration endpoint.
    test.fetch.and.callFake(async (path: string) => {
      if (path === '/devices') return new Response(JSON.stringify([test.initial.device]));
      if (path === '/keys/batch') return new Response(JSON.stringify([{ userId: 'alice', devices: [{ deviceId: 'source', keyBundle: { identityKey: JSON.stringify(source.publicJwk) } }] }]));
      return new Response('{}', { status: 404 });
    });
    await expectAsync(test.service.ensureDeviceIdentity()).toBeRejectedWithError(/QR nuevo/);
    expect(test.service.session()).toBe(test.initial); expect(test.service.persistSession).not.toHaveBeenCalled();
    expect((await local.service.currentKeyMaterial('alice', 'identity-repair:alice:local-hardware')).privateJwk.d).toBeTruthy();
  });

  it('does not generate or publish another identity while an existing native private key is unreadable', async () => {
    let secret: string | null = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const local = cryptography(() => secret); const keys = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', keys, { userId: 'alice' });
    const before = JSON.stringify([...local.records.values()]); secret = null;
    const created = spyOn(local.service, 'createDeviceKeys').and.callThrough();
    const secretRead = spyOn(local.service.secureVault, 'getOrCreateSecret').and.callThrough();
    const test = harness(local.service, keys.publicJwk);
    await expectAsync(test.service.ensureDeviceIdentity()).toBeRejectedWithError(/Desbloquéalo/);
    expect(created).not.toHaveBeenCalled(); expect(test.paths).not.toContain('/keys/prekeys');
    expect(secretRead).toHaveBeenCalledWith('device-keys', { create: false });
    expect(JSON.stringify([...local.records.values()])).toBe(before);
  });

  it('recovers the exact published private key after an alias rename or from an approved history record', async () => {
    const local = cryptography(); const keys = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('old.alias', 'source', keys, { userId: 'alice' });
    const restored = await local.service.recoverDeviceIdentity('alice', 'alice', 'source', keys.publicJwk);
    expect(restored.privateJwk.d).toBe(keys.privateJwk.d);
    expect((await local.service.currentKeyMaterial('alice', 'source')).privateJwk.d).toBe(keys.privateJwk.d);
    const historical = await local.service.createDeviceKeys();
    await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical]);
    const imported = await local.service.recoverDeviceIdentity('alice', 'alice', 'new-device', historical.publicJwk);
    expect(imported.privateJwk.d).toBe(historical.privateJwk.d);
  });

  it('does not publish keys when local persistence fails', async () => {
    const local = cryptography(); const keys = await local.service.createDeviceKeys();
    const test = harness(local.service, keys.publicJwk);
    spyOn(local.service, 'saveDeviceKeys').and.rejectWith(new Error('Storage unavailable'));
    await expectAsync(test.service.ensureDeviceIdentity()).toBeRejectedWithError('Storage unavailable');
    expect(test.paths).not.toContain('/keys/prekeys');
    expect(test.service.persistSession).not.toHaveBeenCalled();
  });

  it('never adopts a matching private key owned by another account', async () => {
    const local = cryptography(); const keys = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('previous.owner', 'source', keys, { userId: 'bob' });
    expect(await local.service.recoverDeviceIdentity('alice', 'alice', 'source', keys.publicJwk)).toBeNull();
    expect((await local.service.currentKeyMaterial('previous.owner', 'source')).userId).toBe('bob');
  });

  it('does not promote an unassigned legacy key when its public identity is not registered for this account', async () => {
    const local = cryptography(); const legacy = await local.service.createDeviceKeys(); const published = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', legacy);
    expect(await local.service.recoverDeviceIdentity('alice', 'alice', 'source', published.publicJwk)).toBeNull();
    expect((await local.service.currentKeyMaterial('alice', 'source')).userId).toBeUndefined();
    const proved = await local.service.recoverDeviceIdentity('alice', 'alice', 'source', legacy.publicJwk);
    expect(proved.userId).toBe('alice'); expect(proved.privateJwk.d).toBe(legacy.privateJwk.d);
  });

  it('never generates or publishes keys for an account that changed during reconciliation', async () => {
    const local = cryptography(); const keys = await local.service.createDeviceKeys();
    const test = harness(local.service, keys.publicJwk);
    const created = spyOn(local.service, 'createDeviceKeys').and.callThrough();
    spyOn(local.service, 'recoverDeviceIdentity').and.callFake(async () => {
      test.service.session.set({ ...test.initial, user: { id: 'bob', alias: 'bob' } }); return null;
    });
    await expectAsync(test.service.ensureDeviceIdentity()).toBeRejectedWithError(/sesión cambió/);
    expect(created).not.toHaveBeenCalled(); expect(test.paths).not.toContain('/keys/prekeys');
    expect(test.service.persistSession).not.toHaveBeenCalled();
  });
});
