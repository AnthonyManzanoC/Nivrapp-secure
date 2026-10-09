import { signal } from '@angular/core';
import { of } from 'rxjs';
import { CryptoService } from './crypto.service';
import { HistoryDeviceSyncService } from './history-device-sync.service';

function cryptoHarness(): { service: any; records: Map<string, any> } {
  const records = new Map<string, any>();
  const db = {
    get: async (_store: string, id: string) => records.get(id),
    put: async (_store: string, record: any) => { records.set(record.id, record); },
    getAll: async () => [...records.values()],
    getAllFromIndex: async (_store: string, _index: string, alias: string) => [...records.values()].filter(record => record.aliasLower === alias),
  };
  const service: any = Object.assign(Object.create(CryptoService.prototype), {
    secureVault: { requiresProtection: () => false, getOrCreateSecret: async () => null },
    open: async () => db,
    yieldToMainThread: async () => undefined,
  });
  return { service, records };
}

describe('approved encrypted history recovery', () => {
  const running: any[] = [];
  const session = (id = 'source', userId = 'alice') => ({ user: { id: userId, alias: 'alice' }, device: { id, isTrusted: true } });
  function syncHarness(crypto: any, id = 'source') {
    const auth = { session: signal<any>(session(id)) };
    const api = { get: jasmine.createSpy('get').and.returnValue(of([])), post: jasmine.createSpy('post').and.returnValue(of({})) };
    const service: any = Object.assign(Object.create(HistoryDeviceSyncService.prototype), {
      auth, crypto, api, epoch: 1, scopeId: `alice:${id}`, timer: null, pumping: null, requested: false,
      requestId: null, requestExpiresAt: 0, requestedAt: 0, importedResponses: new Set(), dismissedRequests: new Set(),
      pendingRequests: signal([]), targetFingerprint: signal(''), approvingRequestId: signal(null),
      approvalError: signal(''), approvalEpoch: signal(1), state: signal('idle'),
      recovered$: { next: jasmine.createSpy('recovered'), complete: () => undefined },
    });
    running.push(service);
    return { service, auth, api };
  }
  afterEach(() => { running.splice(0).forEach(service => service.ngOnDestroy()); });
  const request = (key: JsonWebKey) => ({ id: 'request', userId: 'alice', targetDeviceId: 'target', targetIdentityKey: JSON.stringify(key), targetDeviceName: 'New browser', expiresAt: new Date(Date.now() + 60_000).toISOString() });

  it('never exports private keys merely because the server lists a trusted request', async () => {
    const { service: crypto } = cryptoHarness(); const target = await crypto.createDeviceKeys();
    const { service, api } = syncHarness(crypto);
    const exported = spyOn(crypto, 'exportDeviceKeyMaterialsForUser').and.callThrough();
    api.get.and.returnValue(of([request(target.publicJwk)]));
    await service.pump();
    expect(service.pendingRequests().length).toBe(1);
    expect(service.pendingRequests()[0].fingerprint.replaceAll(' ', '').length).toBe(24);
    expect(exported).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });

  it('rejects a target public key substituted after local approval was displayed', async () => {
    const { service: crypto } = cryptoHarness(); const target = await crypto.createDeviceKeys(); const changed = await crypto.createDeviceKeys();
    const { service, api } = syncHarness(crypto); const displayed = request(target.publicJwk);
    service.pendingRequests.set([{ ...displayed, fingerprint: await service.publicFingerprint(target.publicJwk) }]);
    api.get.and.returnValue(of([{ ...displayed, targetIdentityKey: JSON.stringify(changed.publicJwk) }]));
    await service.approveRequest(displayed.id);
    expect(api.post).not.toHaveBeenCalled(); expect(service.approvalError()).toBeTruthy();
    expect(service.pendingRequests().length).toBe(1);
  });

  it('transfers the complete account keyring as opaque ciphertext and unlocks old messages without replacing the new identity', async () => {
    const source = cryptoHarness(); const target = cryptoHarness();
    const old = await source.service.createDeviceKeys(); const current = await source.service.createDeviceKeys(); const fresh = await target.service.createDeviceKeys();
    await source.service.saveDeviceKeys('alice', 'old', old, { userId: 'alice' });
    await source.service.saveDeviceKeys('alice', 'source', current, { userId: 'alice' });
    await target.service.saveDeviceKeys('alice', 'target', fresh, { userId: 'alice' });
    const sourceSync = syncHarness(source.service); const targetSync = syncHarness(target.service, 'target');
    const transfer = request(fresh.publicJwk);
    sourceSync.service.pendingRequests.set([{ ...transfer, fingerprint: await sourceSync.service.publicFingerprint(fresh.publicJwk) }]);
    sourceSync.api.get.and.returnValue(of([transfer]));
    await sourceSync.service.approveRequest(transfer.id);
    expect(sourceSync.api.post).toHaveBeenCalledTimes(1);
    const sealed = sourceSync.api.post.calls.first().args[1];
    expect(JSON.stringify(sealed)).not.toContain(old.privateJwk.d);
    expect(JSON.stringify(sealed)).not.toContain(current.privateJwk.d);
    targetSync.service.requestId = transfer.id;
    const response = { ...sealed, sourceDeviceId: 'source', sourceIdentityKey: JSON.stringify(current.publicJwk) };
    await targetSync.service.importResponse({ ...transfer, responses: [response] }, response, targetSync.service.scope());
    const materials = await target.service.exportDeviceKeyMaterialsForUser('alice', 'alice');
    expect(materials.length).toBe(3);
    const historical = materials.find((key: any) => target.service.samePublicKey(key.publicJwk, old.publicJwk));
    const oldMessage = await source.service.encryptForPublicKey(await source.service.currentKeyMaterial('alice', 'source'), old.publicJwk, { text: 'old private message' });
    expect((await target.service.decryptEnvelope(historical, oldMessage.header, oldMessage.ciphertext)).text).toBe('old private message');
    expect(target.service.samePublicKey((await target.service.currentKeyMaterial('alice', 'target')).publicJwk, fresh.publicJwk)).toBeTrue();
    await targetSync.service.importResponse({ ...transfer, responses: [response] }, response, targetSync.service.scope());
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
  });

  it('calculates the target code from its own local identity, independently of server metadata', async () => {
    const { service: crypto } = cryptoHarness(); const own = await crypto.createDeviceKeys(); const fake = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const { service, api } = syncHarness(crypto, 'target'); const transfer = request(fake.publicJwk);
    api.get.and.callFake((url: string) => of(url.endsWith('/pending') ? [] : { ...transfer, responses: [] }));
    api.post.and.returnValue(of(transfer)); service.requested = true; service.requestedAt = Date.now();
    await service.pump();
    expect(service.targetFingerprint()).toBe(await service.publicFingerprint(own.publicJwk));
    expect(service.targetFingerprint()).not.toBe(await service.publicFingerprint(fake.publicJwk));
  });

  it('refuses expired, cross-account and mismatched request contexts before decrypting', async () => {
    const { service: crypto } = cryptoHarness(); const own = await crypto.createDeviceKeys();
    const { service } = syncHarness(crypto, 'target'); const transfer = request(own.publicJwk); service.requestId = transfer.id;
    const decrypt = spyOn(crypto, 'decryptEnvelope'); const response = { sourceDeviceId: 'source', sourceIdentityKey: '', header: '', ciphertext: '' };
    for (const status of [{ ...transfer, userId: 'mallory' }, { ...transfer, targetDeviceId: 'other' }, { ...transfer, id: 'replay' }, { ...transfer, expiresAt: new Date(0).toISOString() }]) {
      await expectAsync(service.importResponse(status, response, service.scope())).toBeRejected();
    }
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('does not import a response after account changes while decrypting', async () => {
    const { service: crypto } = cryptoHarness(); const own = await crypto.createDeviceKeys(); const source = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const { service, auth } = syncHarness(crypto, 'target'); const transfer = request(own.publicJwk); service.requestId = transfer.id;
    const imported = spyOn(crypto, 'importHistoricalDeviceKeys').and.callThrough();
    spyOn(crypto, 'decryptEnvelope').and.callFake(async () => { auth.session.set(session('other', 'mallory')); return {}; });
    const response = { sourceDeviceId: 'source', sourceIdentityKey: JSON.stringify(source.publicJwk), header: JSON.stringify({ alg: 'ECDH-P256-A256GCM', senderPublicKey: source.publicJwk }), ciphertext: 'cipher' };
    await expectAsync(service.importResponse(transfer, response, service.scope())).toBeRejected();
    expect(imported).not.toHaveBeenCalled(); expect(service.recovered$.next).not.toHaveBeenCalled();
  });

  it('keeps the approval visible if this source has no user-bound historical keys', async () => {
    const { service: crypto } = cryptoHarness(); const own = await crypto.createDeviceKeys(); const target = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('alice', 'source', own); // Unassigned legacy record is never exportable by alias.
    const { service, api } = syncHarness(crypto); const transfer = request(target.publicJwk);
    service.pendingRequests.set([{ ...transfer, fingerprint: await service.publicFingerprint(target.publicJwk) }]); api.get.and.returnValue(of([transfer]));
    await service.approveRequest(transfer.id);
    expect(api.post).not.toHaveBeenCalled(); expect(service.approvalError()).toBeTruthy(); expect(service.pendingRequests().length).toBe(1);
  });

  it('exports only records bound to the authenticated user, never a reassigned alias or unknown legacy record', async () => {
    const { service: crypto } = cryptoHarness(); const key = await crypto.createDeviceKeys(); const other = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('reassigned', 'old', key, { userId: 'old-account' });
    await crypto.saveDeviceKeys('reassigned', 'legacy', other);
    expect(await crypto.exportDeviceKeyMaterialsForUser('new-account', 'reassigned')).toEqual([]);
    expect((await crypto.exportDeviceKeyMaterialsForUser('old-account', 'renamed')).length).toBe(1);
    await expectAsync(crypto.prepareDeviceKeys('reassigned', false, { userId: undefined })).toBeRejected();
  });

  it('prefers the authenticated hardware key over a newer record from another device', async () => {
    const { service: crypto } = cryptoHarness(); const habitual = await crypto.createDeviceKeys(); const newer = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('alice', 'habitual', habitual, { userId: 'alice' });
    await crypto.saveDeviceKeys('alice', 'newer', newer, { userId: 'alice' });
    const prepared = await crypto.prepareDeviceKeys('alice', false, { userId: 'alice', deviceId: 'habitual', identityKey: JSON.stringify(habitual.publicJwk) });
    expect(crypto.samePublicKey(prepared.publicJwk, habitual.publicJwk)).toBeTrue();
  });

  it('archives a rotated key without making the archive the current login identity', async () => {
    const { service: crypto } = cryptoHarness(); const old = await crypto.createDeviceKeys(); const fresh = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('alice', 'habitual', old, { userId: 'alice' });
    await crypto.saveDeviceKeys('alice', 'habitual', fresh, { userId: 'alice' });
    expect((await crypto.exportDeviceKeyMaterialsForUser('alice', 'alice')).length).toBe(2);
    const prepared = await crypto.prepareDeviceKeys('alice', false, { userId: 'alice', deviceId: 'habitual', identityKey: JSON.stringify(fresh.publicJwk) });
    expect(crypto.samePublicKey(prepared.publicJwk, fresh.publicJwk)).toBeTrue();
  });

  it('preserves an unassigned legacy key locally during fresh login without making it exportable', async () => {
    const { service: crypto } = cryptoHarness(); const old = await crypto.createDeviceKeys(); const fresh = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('alice', 'habitual', old);
    await crypto.saveDeviceKeys('alice', 'habitual', fresh, { userId: 'alice' });
    const local = await crypto.deviceKeyMaterialsForUser('alice', 'alice');
    const legacy = local.find((key: any) => crypto.samePublicKey(key.publicJwk, old.publicJwk));
    expect(legacy).toBeDefined(); expect(legacy.userId).toBeUndefined(); expect(legacy.id).toContain('history:legacy:');
    const exported = await crypto.exportDeviceKeyMaterialsForUser('alice', 'alice');
    expect(exported.length).toBe(1); expect(crypto.samePublicKey(exported[0].publicJwk, fresh.publicJwk)).toBeTrue();
  });

  it('proves that imported private keys match their public identity and aborts canceled writes', async () => {
    const { service: crypto, records } = cryptoHarness(); const a = await crypto.createDeviceKeys(); const b = await crypto.createDeviceKeys();
    await expectAsync(crypto.importHistoricalDeviceKeys('alice', 'alice', [{ publicJwk: a.publicJwk, privateJwk: { ...a.privateJwk, d: b.privateJwk.d } }])).toBeRejected();
    expect(records.size).toBe(0);
    await expectAsync(crypto.importHistoricalDeviceKeys('alice', 'alice', [a], () => false)).toBeRejected();
    expect(records.size).toBe(0);
  });
});
