import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CryptoService } from './crypto.service';
import { HistoryDeviceSyncService } from './history-device-sync.service';

function cryptoHarness(protector?: () => string | null): { service: any; records: Map<string, any> } {
  const records = new Map<string, any>();
  const db = {
    get: async (_store: string, id: string) => records.get(id),
    put: async (_store: string, record: any) => { records.set(record.id, record); },
    getAll: async () => [...records.values()],
    getAllFromIndex: async (_store: string, _index: string, alias: string) => [...records.values()].filter(record => record.aliasLower === alias),
  };
  const service: any = Object.assign(Object.create(CryptoService.prototype), {
    secureVault: { requiresProtection: () => Boolean(protector), getOrCreateSecret: async () => protector?.() ?? null },
    open: async () => db,
    yieldToMainThread: async () => undefined,
  });
  return { service, records };
}

describe('approved encrypted history recovery', () => {
  const running: any[] = [];
  const session = (id = 'source', userId = 'alice') => ({ user: { id: userId, alias: 'alice' }, device: { id, isTrusted: true } });
  function syncHarness(crypto: any, id = 'source') {
    const auth = { session: signal<any>(session(id)), ensureDeviceIdentity: () => crypto.currentKeyMaterial('alice', auth.session().device.id) };
    const api = { get: jasmine.createSpy('get').and.returnValue(of([])), post: jasmine.createSpy('post').and.returnValue(of({})) };
    const checking = signal(false);
    const service: any = Object.assign(Object.create(HistoryDeviceSyncService.prototype), {
      auth, crypto, api, epoch: 1, scopeId: `alice:${id}`, timer: null, pumping: null, requested: false,
      requestId: null, requestExpiresAt: 0, requestedAt: 0, importedResponses: new Set(), dismissedRequests: new Set(),
      pendingRequests: signal([]), targetFingerprint: signal(''), approvingRequestId: signal(null),
      approvalError: signal(''), approvalEpoch: signal(1), state: signal('idle'),
      pumpPromise: null, pumpAgain: false, replayRequested: false, recoveryIncomplete: false,
      recoveryRetryAt: 0, recoveryRetryAttempts: 0,
      checkingState: checking, checking: checking.asReadonly(),
      recovered$: { next: jasmine.createSpy('recovered'), complete: () => undefined },
    });
    running.push(service);
    return { service, auth, api };
  }
  afterEach(() => { running.splice(0).forEach(service => service.ngOnDestroy()); });
  const request = (key: JsonWebKey) => ({ id: 'request', userId: 'alice', targetDeviceId: 'target', targetIdentityKey: JSON.stringify(key), targetDeviceName: 'New browser', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  async function approvedTarget() {
    const source = cryptoHarness(); const target = cryptoHarness();
    const sourceKey = await source.service.createDeviceKeys(); const targetKey = await target.service.createDeviceKeys();
    await source.service.saveDeviceKeys('alice', 'source', sourceKey, { userId: 'alice' });
    await target.service.saveDeviceKeys('alice', 'target', targetKey, { userId: 'alice' });
    const sourceSync = syncHarness(source.service); const targetSync = syncHarness(target.service, 'target');
    const transfer = request(targetKey.publicJwk);
    sourceSync.service.pendingRequests.set([{ ...transfer, fingerprint: await sourceSync.service.publicFingerprint(targetKey.publicJwk) }]);
    sourceSync.api.get.and.returnValue(of([transfer]));
    await sourceSync.service.approveRequest(transfer.id);
    const sealed = sourceSync.api.post.calls.first().args[1];
    const response = { ...sealed, sourceDeviceId: 'source', sourceIdentityKey: JSON.stringify(sourceKey.publicJwk) };
    const status = { ...transfer, responses: [response] };
    targetSync.service.requested = true; targetSync.service.requestedAt = Date.now();
    targetSync.service.requestId = transfer.id; targetSync.service.requestExpiresAt = Date.parse(transfer.expiresAt);
    targetSync.api.get.and.callFake((url: string) => of(url.endsWith('/pending') ? [] : status));
    return { source, target, sourceSync, targetSync, status, response, transfer };
  }

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
    const response = { sourceDeviceId: 'source', sourceIdentityKey: JSON.stringify(source.publicJwk), header: JSON.stringify({ v: 1, alg: 'ECDH-P256-A256GCM', senderPublicKey: source.publicJwk }), ciphertext: 'cipher' };
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

  it('recovers Web history by polling after an Android approval even when every realtime event is lost', async () => {
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const source = cryptoHarness(() => secret); const target = cryptoHarness();
    const old = await source.service.createDeviceKeys(); const current = await source.service.createDeviceKeys();
    const fresh = await target.service.createDeviceKeys();
    await source.service.saveDeviceKeys('alice', 'previous-device', old, { userId: 'alice' });
    await source.service.saveDeviceKeys('alice', 'source', current, { userId: 'alice' });
    await target.service.saveDeviceKeys('alice', 'target', fresh, { userId: 'alice' });
    expect(JSON.stringify([...source.records.values()])).not.toContain(old.privateJwk.d);
    const sourceSync = syncHarness(source.service); const targetSync = syncHarness(target.service, 'target');
    const transfer = request(fresh.publicJwk); const responses: any[] = []; let created = false;
    targetSync.api.post.and.callFake((url: string) => {
      expect(url).toBe('/devices/history-transfer/'); created = true;
      // The production create response intentionally omits targetIdentityKey.
      return of({ id: transfer.id, userId: transfer.userId, targetDeviceId: transfer.targetDeviceId, expiresAt: transfer.expiresAt });
    });
    targetSync.api.get.and.callFake((url: string) => of(url.endsWith('/pending') ? [] : { ...transfer, responses: [...responses] }));
    sourceSync.api.get.and.callFake((url: string) => {
      expect(url).toBe('/devices/history-transfer/pending');
      return of(created && !responses.length ? [transfer] : []);
    });
    sourceSync.api.post.and.callFake((url: string, sealed: any) => {
      expect(url).toBe(`/devices/history-transfer/${transfer.id}/response`);
      expect(source.service.samePublicKey(JSON.parse(sealed.header).senderPublicKey, current.publicJwk)).toBeTrue();
      responses.push({ ...sealed, sourceDeviceId: 'source', sourceIdentityKey: JSON.stringify(current.publicJwk) });
      return of(undefined);
    });
    targetSync.service.requested = true; targetSync.service.requestedAt = Date.now();
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).not.toHaveBeenCalled();
    await sourceSync.service.pump();
    expect(sourceSync.service.pendingRequests().length).toBe(1);
    expect(sourceSync.api.post).not.toHaveBeenCalled();
    await sourceSync.service.approveRequest(transfer.id);
    // No SignalR callback is emitted. The next regular poll must import the response.
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    const oldMessage = await source.service.encryptForPublicKey(
      await source.service.currentKeyMaterial('alice', 'source'), old.publicJwk, { text: 'Recovered privately on Web' });
    const materials = await target.service.exportDeviceKeyMaterialsForUser('alice', 'alice');
    const historical = materials.find((key: any) => target.service.samePublicKey(key.publicJwk, old.publicJwk));
    expect((await target.service.decryptEnvelope(historical, oldMessage.header, oldMessage.ciphertext)).text).toBe('Recovered privately on Web');
    expect(targetSync.service.state()).toBe('syncing');
    targetSync.service.markHistoryReadable();
    expect(targetSync.service.state()).toBe('idle');
    expect(target.service.samePublicKey((await target.service.currentKeyMaterial('alice', 'target')).publicJwk, fresh.publicJwk)).toBeTrue();
  });

  it('recreates an orphaned request after a missing status instead of polling the same ID until expiry', async () => {
    const target = cryptoHarness(); const fresh = await target.service.createDeviceKeys();
    await target.service.saveDeviceKeys('alice', 'target', fresh, { userId: 'alice' });
    const targetSync = syncHarness(target.service, 'target'); const replacement = { ...request(fresh.publicJwk), id: 'replacement' };
    targetSync.service.requested = true; targetSync.service.requestedAt = Date.now();
    targetSync.service.requestId = 'orphaned'; targetSync.service.requestExpiresAt = Date.now() + 60_000;
    targetSync.api.post.and.returnValue(of(replacement));
    targetSync.api.get.and.callFake((url: string) => url.endsWith('/pending') ? of([])
      : url.endsWith('/orphaned') ? throwError(() => ({ status: 404 })) : of({ ...replacement, responses: [] }));
    await targetSync.service.pump();
    expect(targetSync.api.post).toHaveBeenCalledTimes(1);
    expect(targetSync.service.requestId).toBe('replacement');
    expect(targetSync.service.state()).not.toBe('unavailable');
  });

  it('repairs an unreadable imported key after its native protector changed, using newly approved valid material', async () => {
    let secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const local = cryptoHarness(() => secret); const historical = await local.service.createDeviceKeys();
    expect(await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical])).toBe(1);
    secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    expect(await local.service.exportDeviceKeyMaterialsForUser('alice', 'alice')).toEqual([]);
    expect(await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical])).toBe(1);
    const restored = await local.service.exportDeviceKeyMaterialsForUser('alice', 'alice');
    expect(restored.length).toBe(1);
    const peer = await local.service.createDeviceKeys();
    const sealed = await local.service.encryptForPublicKey(peer, historical.publicJwk, { text: 'Readable again' });
    expect((await local.service.decryptEnvelope(restored[0], sealed.header, sealed.ciphertext)).text).toBe('Readable again');
  });

  it('repairs a corrupted private key instead of treating the public fingerprint alone as a usable import', async () => {
    const local = cryptoHarness(); const historical = await local.service.createDeviceKeys(); const different = await local.service.createDeviceKeys();
    await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical]);
    const stored = [...local.records.values()][0]; stored.privateJwk = { ...stored.privateJwk, d: different.privateJwk.d };
    expect(await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical])).toBe(1);
    const restored = (await local.service.exportDeviceKeyMaterialsForUser('alice', 'alice'))[0];
    expect(restored.privateJwk.d).toBe(historical.privateJwk.d);
    expect(await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical])).toBe(0);
  });

  it('repairs private coordinates and unusable key operations even when the private scalar is unchanged', async () => {
    const local = cryptoHarness(); const historical = await local.service.createDeviceKeys(); const other = await local.service.createDeviceKeys();
    await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical]);
    const id = [...local.records.keys()][0];
    local.records.get(id).privateJwk = { ...historical.privateJwk, y: other.privateJwk.y };
    expect(await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical])).toBe(1);
    local.records.get(id).privateJwk = { ...historical.privateJwk, key_ops: ['sign'] };
    expect(await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical])).toBe(1);
    const restored = (await local.service.exportDeviceKeyMaterialsForUser('alice', 'alice'))[0];
    const sealed = await local.service.encryptForPublicKey(other, historical.publicJwk, { text: 'Usable historical key' });
    expect((await local.service.decryptEnvelope(restored, sealed.header, sealed.ciphertext)).text).toBe('Usable historical key');
    expect(await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical])).toBe(0);
  });

  it('replays already approved keys once on explicit retry after a transient message-refresh failure', async () => {
    const { targetSync } = await approvedTarget();
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    targetSync.service.markHistoryRecoveryIncomplete();
    expect(targetSync.service.state()).toBe('waiting');
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    targetSync.service.retry();
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(2);
    expect(targetSync.service.state()).toBe('syncing');
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(2);
    targetSync.service.markHistoryReadable();
    expect(targetSync.service.state()).toBe('idle');
  });

  it('retrieves its own approved package when listing other devices requests temporarily fails', async () => {
    const { targetSync, status } = await approvedTarget();
    targetSync.api.get.and.callFake((url: string) => url.endsWith('/pending')
      ? throwError(() => ({ status: 503 })) : of(status));
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(targetSync.service.state()).toBe('syncing');
  });

  it('delivers an approved response while the independent approval listing is still stalled', async () => {
    const { targetSync, status } = await approvedTarget();
    const pending = new Subject<any[]>();
    let recovered!: () => void;
    const delivered = new Promise<void>(resolve => recovered = resolve);
    targetSync.service.recovered$.next.and.callFake(recovered);
    targetSync.api.get.and.callFake((url: string) => url.endsWith('/pending') ? pending : of(status));
    const poll = targetSync.service.pump();
    await delivered;
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(targetSync.service.checking()).toBeTrue();
    expect(targetSync.service.state()).toBe('syncing');
    pending.next([]); pending.complete(); await poll;
  });

  it('imports every source in an approval batch before notifying the message recovery consumer', async () => {
    const { targetSync, target, sourceSync, transfer, status } = await approvedTarget();
    const secondSource = cryptoHarness(); const secondKey = await secondSource.service.createDeviceKeys();
    await secondSource.service.saveDeviceKeys('alice', 'second-source', secondKey, { userId: 'alice' });
    const secondSync = syncHarness(secondSource.service, 'second-source');
    secondSync.api.get.and.returnValue(of([transfer]));
    secondSync.service.pendingRequests.set([{ ...transfer, fingerprint: await sourceSync.service.publicFingerprint(JSON.parse(transfer.targetIdentityKey)) }]);
    await secondSync.service.approveRequest(transfer.id);
    const sealed = secondSync.api.post.calls.first().args[1];
    status.responses.push({ ...sealed, sourceDeviceId: 'second-source', sourceIdentityKey: JSON.stringify(secondKey.publicJwk) });
    let completeAtNotification = false;
    targetSync.service.recovered$.next.and.callFake(() => completeAtNotification = targetSync.service.importedResponses.size === 2);
    await targetSync.service.pump();
    expect(completeAtNotification).toBeTrue();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    expect((await target.service.exportDeviceKeyMaterialsForUser('alice', 'alice')).length).toBe(3);
  });

  it('releases a stalled HTTP status and permits another poll after the bounded timeout', fakeAsync(() => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    const response = new Subject<any>();
    service.requestId = 'request'; service.requestExpiresAt = Date.now() + 60_000;
    let failed = false;
    api.get.and.returnValue(response);
    const status = service.requestStatus(service.scope()).catch(() => failed = true);
    tick(14_999); flushMicrotasks(); expect(failed).toBeFalse();
    tick(1); flushMicrotasks(); expect(failed).toBeTrue();
    expect(response.observers.length).toBe(0);
    api.get.and.returnValue(of({ id: 'request' }));
    let completed = false;
    service.requestStatus(service.scope()).then(() => completed = true);
    flushMicrotasks(); expect(completed).toBeTrue();
    void status;
  }));

  it('automatically retries transient refresh failure with approved keys only three times', fakeAsync(() => {
    const { service } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestedAt = Date.now();
    service.importedResponses.add('request:source');
    service.crypto.currentKeyMaterial = async () => { throw new Error('Transport unavailable'); };
    service.recovered$.next.and.callFake(() => service.markHistoryRecoveryIncomplete({ retryable: true }));
    service.markHistoryRecoveryIncomplete({ retryable: true });
    void service.pump(); flushMicrotasks();
    tick(30_000); flushMicrotasks();
    expect(service.recovered$.next).toHaveBeenCalledTimes(3);
    expect(service.recoveryRetryAttempts).toBe(3);
    expect(service.recoveryRetryAt).toBe(0);
    expect(service.state()).not.toBe('idle');
    service.ngOnDestroy();
  }));

  it('does not automatically repeat recovery when approved sources still lack a historical key', fakeAsync(() => {
    const { service } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestedAt = Date.now();
    service.importedResponses.add('request:source');
    service.crypto.currentKeyMaterial = async () => { throw new Error('Transport unavailable'); };
    service.markHistoryRecoveryIncomplete();
    void service.pump(); flushMicrotasks(); tick(30_000); flushMicrotasks();
    expect(service.recovered$.next).not.toHaveBeenCalled();
    expect(service.recoveryRetryAt).toBe(0);
    service.ngOnDestroy();
  }));

  it('retries already imported keys during an offline poll and creates no request after readable acknowledgement', async () => {
    const { targetSync } = await approvedTarget();
    await targetSync.service.pump();
    targetSync.service.markHistoryRecoveryIncomplete();
    const pending = new Subject<any[]>();
    targetSync.api.get.and.returnValue(pending);
    const poll = targetSync.service.pump();
    expect(targetSync.service.checking()).toBeTrue();
    targetSync.service.recovered$.next.and.callFake(() => targetSync.service.markHistoryReadable());
    targetSync.service.retry();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(2);
    expect(targetSync.service.state()).toBe('idle');
    pending.error({ status: 503 }); await poll;
    expect(targetSync.api.post).not.toHaveBeenCalled();
    expect(targetSync.service.requested).toBeFalse();
    expect(targetSync.service.state()).toBe('idle');
    expect(targetSync.service.checking()).toBeFalse();
  });

  for (const badFirst of [true, false]) {
    it(`keeps a valid response usable when an invalid response is ${badFirst ? 'first' : 'last'} in the same poll`, async () => {
      const { targetSync, status, response } = await approvedTarget();
      const bad = { ...response, sourceDeviceId: 'invalid-source', header: '{invalid-json' };
      status.responses = badFirst ? [bad, response] : [response, bad];
      await targetSync.service.pump();
      expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
      expect(targetSync.service.state()).toBe('syncing');
      expect(targetSync.service.importedResponses.size).toBe(1);
    });
  }

  it('coalesces triggers during a poll into one immediate follow-up and exposes actual checking state', fakeAsync(() => {
    const { service, api } = syncHarness(cryptoHarness().service);
    const pending = new Subject<any[]>();
    api.get.and.returnValues(pending, of([]));
    const first = service.pump();
    expect(service.checking()).toBeTrue();
    expect(service.pump()).toBe(first);
    expect(service.pump()).toBe(first);
    expect(api.get).toHaveBeenCalledTimes(1);
    pending.next([]); pending.complete(); flushMicrotasks();
    expect(service.checking()).toBeFalse();
    tick(0); flushMicrotasks();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(service.checking()).toBeFalse();
    service.ngOnDestroy();
  }));

  it('does not turn a batch of 100 protected messages into additional HTTP polls', async () => {
    const target = cryptoHarness(); const key = await target.service.createDeviceKeys();
    await target.service.saveDeviceKeys('alice', 'target', key, { userId: 'alice' });
    const { service, api } = syncHarness(target.service, 'target');
    const transfer = request(key.publicJwk); const pending = new Subject<any[]>();
    api.post.and.returnValue(of(transfer));
    api.get.and.callFake((url: string) => url.endsWith('/pending') ? pending : of({ ...transfer, responses: [] }));
    service.requestHistory();
    const poll = service.pumpPromise;
    for (let index = 0; index < 100; index++) service.requestHistory();
    expect(api.get).toHaveBeenCalledTimes(1);
    pending.next([]); pending.complete(); await poll;
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(2); // Independent approval listing and our own status.
    // A duplicate-trigger follow-up would already be queued before this turn.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(service.checking()).toBeFalse();
    expect(service.state()).toBe('waiting');
  });

  it('does not let a late poll from another account hide a new accounts checking state', async () => {
    const { service, api, auth } = syncHarness(cryptoHarness().service);
    const previous = new Subject<any[]>(); const current = new Subject<any[]>();
    api.get.and.returnValues(previous, current);
    const oldPoll = service.pump();
    auth.session.set(session('other', 'bob')); service.reset('bob:other');
    const newPoll = service.pump();
    previous.next([]); previous.complete(); await oldPoll;
    expect(service.checking()).toBeTrue();
    current.next([]); current.complete(); await newPoll;
    expect(service.checking()).toBeFalse();
    expect(service.pendingRequests()).toEqual([]);
  });

  it('does not let an incomplete acknowledgement override a newer approved import', async () => {
    const { targetSync, status } = await approvedTarget();
    const pending = new Subject<any[]>();
    targetSync.api.get.and.callFake((url: string) => url.endsWith('/pending') ? pending : of(status));
    targetSync.service.state.set('syncing');
    const poll = targetSync.service.pump();
    targetSync.service.markHistoryRecoveryIncomplete();
    expect(targetSync.service.state()).toBe('syncing');
    pending.next([]); pending.complete(); await poll;
    expect(targetSync.service.state()).toBe('syncing');
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    targetSync.service.markHistoryReadable();
    expect(targetSync.service.state()).toBe('idle');
  });
});
