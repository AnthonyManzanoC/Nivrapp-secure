import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CryptoService } from './crypto.service';
import { HistoryDeviceSyncService, HistoryRecoveryEvidence } from './history-device-sync.service';

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
      nativeAndroid: false, otherDeviceRecovery: signal(false),
      requestEvidence: null, evidenceCheck: null, requestRevision: 0, recoveryStatus: signal('approval'),
      sourceDirectory: null, sourceDirectoryCheck: null, sourceDirectoryRevision: 0,
      preferredSource: signal(null), sourceCapability: signal('unknown'),
      sourceAvailability: signal('unknown'), localRecoveryCheckAt: 0, localRecoveryStamp: '', localReplayAwaitingAck: false, localRecoveryProved: false,
      identityTrust: {
        exportForLinkedDevice: jasmine.createSpy('exportIdentityTrust').and.resolveTo({ v: 1, purpose: 'identity-continuity', userId: 'alice', sourceDeviceId: id, entries: [] }),
        importFromLinkedDevice: jasmine.createSpy('importIdentityTrust').and.resolveTo(0),
      },
      checkingState: checking, checking: checking.asReadonly(),
      recovered$: { next: jasmine.createSpy('recovered'), complete: () => undefined },
    });
    running.push(service);
    return { service, auth, api };
  }
  afterEach(() => { running.splice(0).forEach(service => service.ngOnDestroy()); });
  const request = (key: JsonWebKey) => ({ id: 'request', userId: 'alice', targetDeviceId: 'target', targetIdentityKey: JSON.stringify(key), targetDeviceName: 'New browser', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const evidence = (publicKey: JsonWebKey, deviceId = 'target'): HistoryRecoveryEvidence => ({ userId: 'alice', deviceId, reason: 'undecryptable-ciphertext' as const,
    message: { id: 'old-message', conversationId: 'chat', recipients: [{ userId: 'alice', deviceId: 'old-device',
      header: JSON.stringify({ v: 1, alg: 'ECDH-P256-A256GCM', senderPublicKey: publicKey, iv: btoa(String.fromCharCode(...new Uint8Array(12))) }),
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(16))) }] } });
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
    targetSync.service.requestEvidence = evidence(sourceKey.publicJwk);
    targetSync.service.requestId = transfer.id; targetSync.service.requestExpiresAt = Date.parse(transfer.expiresAt);
    targetSync.api.get.and.callFake((url: string) => of(url.endsWith('/pending') ? [] : status));
    return { source, target, sourceSync, targetSync, status, response, transfer };
  }

  const registeredDevice = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
    id, userId: 'alice', name, isTrusted: true, revokedAt: null,
    createdAt: '2025-01-01T00:00:00Z', lastSeenAt: new Date().toISOString(), ...overrides,
  });

  it('keeps APK recovery local while still receiving requests from another device', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const missing = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const { service, api } = syncHarness(local.service, 'target'); service.nativeAndroid = true;
    const inbound = { ...request(missing.publicJwk), targetDeviceId: 'browser', id: 'inbound' };
    api.get.and.callFake((url: string) => of(url.endsWith('/pending') ? [inbound] : []));
    await service.requestHistory(evidence(missing.publicJwk)); await service.pumpPromise;
    expect(service.usesLocalRecovery()).toBeTrue();
    expect(service.pendingRequests().map((r: any) => r.id)).toEqual(['inbound']);
    expect(api.get.calls.allArgs().some(([url]) => url === '/devices')).toBeFalse();
    expect(api.post).not.toHaveBeenCalled();
    service.retry(); await service.pumpPromise;
    expect(service.usesLocalRecovery()).toBeTrue(); expect(api.post).not.toHaveBeenCalled();
    await service.approveRequest('inbound');
    expect(api.post).toHaveBeenCalledOnceWith('/devices/history-transfer/inbound/response', jasmine.any(Object));
  });

  it('recovers a saved APK key automatically without opting in to remote recovery', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const old = await local.service.createDeviceKeys(); const peer = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    await local.service.importHistoricalDeviceKeys('alice', 'alice', [old]);
    const proof = evidence(peer.publicJwk);
    Object.assign(proof.message.recipients[0], await local.service.encryptForPublicKey(peer, old.publicJwk, { text: 'Saved on phone' }));
    const { service, api } = syncHarness(local.service, 'target'); service.nativeAndroid = true;
    service.recovered$.next.and.callFake(() => service.markHistoryReadable());
    await service.requestHistory(proof);
    expect(service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(service.state()).toBe('idle'); expect(api.post).not.toHaveBeenCalled();
  });

  it('requires explicit APK recovery before creating a request and forgets that choice after recovery or account changes', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const missing = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const { service, api, auth } = syncHarness(local.service, 'target'); service.nativeAndroid = true;
    const transfer = request(own.publicJwk);
    api.post.and.returnValue(of(transfer));
    api.get.and.callFake((url: string) => of(url === '/devices' ? [registeredDevice('browser', 'Browser')] : url.endsWith('/pending') ? [] : { ...transfer, responses: [] }));
    await service.requestHistory(evidence(missing.publicJwk)); await service.pumpPromise;
    expect(api.post).not.toHaveBeenCalled();
    service.requestOtherDevice(); await service.pumpPromise;
    expect(service.usesLocalRecovery()).toBeFalse();
    expect(api.post).toHaveBeenCalledOnceWith('/devices/history-transfer/', {});
    service.markHistoryReadable(); expect(service.usesLocalRecovery()).toBeTrue();
    service.otherDeviceRecovery.set(true); service.reset('bob:phone'); auth.session.set(session('phone', 'bob'));
    expect(service.usesLocalRecovery()).toBeTrue();
    service.requestOtherDevice(); expect(service.usesLocalRecovery()).toBeTrue();
  });

  it('does not recreate an expired transfer when history became readable while the status request was in flight', async () => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestId = 'old'; service.requestExpiresAt = Date.now() + 60_000;
    const response = new Subject<any>(); api.get.and.returnValue(response);
    const status = service.requestStatus(service.scope());
    service.markHistoryReadable(); response.error({ status: 410 });
    await expectAsync(status).toBeRejected(); expect(api.post).not.toHaveBeenCalled();
  });

  it('does not use a remote device name as authority to suppress browser recovery', () => {
    const { service, auth } = syncHarness(cryptoHarness().service, 'target');
    auth.session.set({ ...session('target'), device: { ...session('target').device, name: 'Android Nivra Mobile' } });
    expect(service.usesLocalRecovery()).toBeFalse();
  });

  it('automatically replays a readable saved account key without requesting another device or replacing the identity', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const old = await local.service.createDeviceKeys(); const peer = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    await local.service.importHistoricalDeviceKeys('alice', 'alice', [old]);
    const before = JSON.stringify([...local.records.values()]);
    const sealed = await local.service.encryptForPublicKey(peer, old.publicJwk, { text: 'Retained history' });
    const proof = evidence(peer.publicJwk); Object.assign(proof.message.recipients[0], sealed);
    const { service, api } = syncHarness(local.service, 'target');
    service.recovered$.next.and.callFake(() => service.markHistoryReadable());
    await service.requestHistory(proof);
    expect(service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(service.state()).toBe('idle'); expect(api.post).not.toHaveBeenCalled();
    expect(JSON.stringify([...local.records.values()])).toBe(before);
    expect(local.service.samePublicKey((await local.service.currentKeyMaterial('alice', 'target')).publicJwk, own.publicJwk)).toBeTrue();
  });

  it('automatically retries newly available local keys after a pending single-device recovery', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const old = await local.service.createDeviceKeys(); const peer = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const sealed = await local.service.encryptForPublicKey(peer, old.publicJwk, { text: 'Recovered locally' });
    const proof = evidence(peer.publicJwk); Object.assign(proof.message.recipients[0], sealed);
    const { service, api } = syncHarness(local.service, 'target');
    service.requested = true; service.requestEvidence = proof; service.state.set('waiting');
    api.get.and.callFake((url: string) => of(url === '/devices' ? [registeredDevice('target', 'Android Nivra Mobile')] : []));
    await service.refreshSourcePreference(service.scope());
    expect(await service.tryRecoverLocally(service.scope(), proof)).toBeFalse();
    await local.service.importHistoricalDeviceKeys('alice', 'alice', [old]);
    service.localRecoveryCheckAt = 0;
    service.recovered$.next.and.callFake(() => service.markHistoryReadable());
    await service.pump();
    expect(service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(service.state()).toBe('idle'); expect(api.post).not.toHaveBeenCalled();
  });

  it('schedules bounded transient refresh recovery for a proven local key without requiring a remote import', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const peer = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const sealed = await local.service.encryptForPublicKey(peer, own.publicJwk, { text: 'Local readable evidence' });
    const proof = evidence(peer.publicJwk); Object.assign(proof.message.recipients[0], sealed);
    const { service, api } = syncHarness(local.service, 'target');
    service.recovered$.next.and.callFake(() => service.markHistoryRecoveryIncomplete({ retryable: true }));
    api.get.and.callFake((url: string) => of(url === '/devices' ? [registeredDevice('target', 'Android Nivra Mobile')] : []));
    await service.requestHistory(proof); await service.pumpPromise;
    expect(service.importedResponses.size).toBe(0);
    expect(service.recoveryStatus()).toBe('retryable');
    expect(service.recoveryRetryAttempts).toBe(1);
    expect(service.recoveryRetryAt).toBeGreaterThan(Date.now());
    for (let index = 0; index < 10; index++) service.markHistoryRecoveryIncomplete({ retryable: true });
    expect(service.recoveryRetryAttempts).toBe(3); expect(service.recoveryRetryAt).toBe(0);
  });

  it('avoids an impossible approval loop only when the authenticated directory confirms this sole device', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const missing = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const { service, api } = syncHarness(local.service, 'target');
    service.requested = true; service.requestEvidence = evidence(missing.publicJwk); service.state.set('waiting');
    api.get.and.callFake((url: string) => of(url === '/devices' ? [
      registeredDevice('target', 'Android Nivra Mobile'),
      registeredDevice('revoked', 'Windows', { revokedAt: new Date().toISOString() }),
      registeredDevice('untrusted', 'Windows', { isTrusted: false }),
      registeredDevice('foreign', 'Windows', { userId: 'someone-else' }),
    ] : []));
    await service.refreshSourcePreference(service.scope());
    await service.pump(); await service.pump();
    expect(service.sourceAvailability()).toBe('local-only');
    expect(service.state()).toBe('waiting'); expect(service.targetFingerprint()).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.get.calls.allArgs().some(args => String(args[0]).startsWith('/devices/history-transfer/') && !String(args[0]).endsWith('/pending'))).toBeFalse();
    service.invalidateSourcePreference();
    api.get.and.callFake((url: string) => of(url === '/devices' ? [registeredDevice('target', 'Android Nivra Mobile'), registeredDevice('old-device', 'Windows')] : []));
    await service.refreshSourcePreference(service.scope());
    expect(service.sourceAvailability()).toBe('available');
    expect(service.preferredSource()?.deviceId).toBe('old-device');
  });

  it('waits for a fast sole-device directory before creating the very first approval request', fakeAsync(() => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    const directory = new Subject<any[]>();
    service.requested = true; service.requestEvidence = evidence({}); service.state.set('waiting');
    spyOn(service, 'tryRecoverLocally').and.resolveTo(false);
    spyOn(service, 'persistedIdentity').and.resolveTo({ publicJwk: {} });
    spyOn(service, 'publicFingerprint').and.resolveTo('local-fingerprint');
    api.get.and.callFake((url: string) => url === '/devices' ? directory : of([]));
    void service.pump(); flushMicrotasks(); tick(100);
    expect(api.post).not.toHaveBeenCalled(); expect(service.targetFingerprint()).toBe('');
    directory.next([registeredDevice('target', 'Android Nivra Mobile')]); directory.complete(); flushMicrotasks();
    expect(service.sourceAvailability()).toBe('local-only'); expect(api.post).not.toHaveBeenCalled();
    expect(service.state()).toBe('waiting'); service.ngOnDestroy();
  }));

  it('bounds the directory grace period so a stalled directory cannot prevent a legitimate transfer', fakeAsync(() => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    const directory = new Subject<any[]>();
    service.requested = true; service.requestEvidence = evidence({}); service.state.set('waiting');
    spyOn(service, 'tryRecoverLocally').and.resolveTo(false);
    spyOn(service, 'persistedIdentity').and.resolveTo({ publicJwk: {} });
    spyOn(service, 'publicFingerprint').and.resolveTo('local-fingerprint');
    api.get.and.callFake((url: string) => url === '/devices' ? directory : of([]));
    api.post.and.returnValue(throwError(() => ({ status: 503 })));
    void service.pump(); flushMicrotasks(); tick(749); expect(api.post).not.toHaveBeenCalled();
    tick(1); flushMicrotasks(); expect(api.post).toHaveBeenCalledTimes(1);
    expect(service.sourceAvailability()).toBe('unknown');
    service.ngOnDestroy(); directory.complete(); flushMicrotasks();
  }));

  it('treats a failed or empty device directory as unknown rather than proof that keys cannot arrive', async () => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestEvidence = evidence({});
    for (const response of [of([]), throwError(() => ({ status: 503 }))]) {
      service.invalidateSourcePreference(); api.get.and.returnValue(response);
      await service.refreshSourcePreference(service.scope());
      expect(service.sourceAvailability()).toBe('unknown');
    }
    api.get.and.returnValue(of([registeredDevice('target', 'Android Nivra Mobile')]));
    service.invalidateSourcePreference(); await service.refreshSourcePreference(service.scope());
    expect(service.sourceAvailability()).toBe('local-only');
    service.invalidateSourcePreference(); expect(service.sourceAvailability()).toBe('unknown');
  });

  it('does not repeat failed cryptographic probes with an unchanged keyring or use an alias-only key', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    const legacy = await local.service.createDeviceKeys(); const peer = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    await local.service.saveDeviceKeys('alice', 'legacy', legacy);
    const sealed = await local.service.encryptForPublicKey(peer, legacy.publicJwk, { text: 'Legacy ownership unknown' });
    const proof = evidence(peer.publicJwk); Object.assign(proof.message.recipients[0], sealed);
    const { service } = syncHarness(local.service, 'target');
    const decrypt = spyOn(local.service, 'decryptEnvelope').and.callThrough();
    expect(await service.tryRecoverLocally(service.scope(), proof)).toBeFalse();
    for (let index = 0; index < 100; index++) expect(await service.tryRecoverLocally(service.scope(), proof)).toBeFalse();
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(service.recovered$.next).not.toHaveBeenCalled();
    expect((await local.service.getDeviceKeys('alice', 'legacy')).userId).toBeUndefined();
  });

  it('discards a local decryption that completes after the account changes', async () => {
    const local = cryptoHarness(); const own = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', own, { userId: 'alice' });
    const { service, auth, api } = syncHarness(local.service, 'target');
    spyOn(local.service, 'decryptEnvelope').and.callFake(async () => {
      auth.session.set(session('bob-device', 'bob')); service.reset('bob:bob-device'); return { text: 'Old account' };
    });
    await service.requestHistory(evidence(own.publicJwk));
    expect(service.recovered$.next).not.toHaveBeenCalled(); expect(service.state()).toBe('idle');
    expect(api.post).not.toHaveBeenCalled(); expect(service.requestEvidence).toBeNull();
  });

  it('recommends the habitual APK addressed by the unreadable message without declaring remote key possession', async () => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestEvidence = evidence({}, 'target');
    api.get.and.returnValue(of([
      registeredDevice('desktop', 'Windows Chrome'),
      registeredDevice('old-device', 'Android Nivra Mobile', { lastSeenAt: '2025-01-01T00:00:00Z' }),
    ]));
    await service.refreshSourcePreference(service.scope());
    expect(service.preferredSource()).toEqual({ deviceId: 'old-device', deviceName: 'Android Nivra Mobile', kind: 'android', basis: 'message-recipient' });
    expect(service.sourceCapability()).toBe('unknown');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps Web as the first source when a newly registered APK was never addressed by the old message', async () => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestEvidence = evidence({}, 'target');
    api.get.and.returnValue(of([
      registeredDevice('new-apk', 'Android Nivra Mobile'), registeredDevice('old-device', 'Windows Chrome'),
    ]));
    await service.refreshSourcePreference(service.scope());
    expect(service.preferredSource()?.deviceId).toBe('old-device');
    expect(service.preferredSource()?.kind).toBe('other');
  });

  it('allows an APK receiver to find its Web-only source and excludes self, revoked, untrusted and foreign devices', async () => {
    const { service, api } = syncHarness(cryptoHarness().service, 'new-apk');
    service.requested = true; service.requestEvidence = evidence({}, 'new-apk');
    api.get.and.returnValue(of([
      registeredDevice('new-apk', 'Android Nivra Mobile'), registeredDevice('old-device', 'Windows Chrome'),
      registeredDevice('other-account', 'Android Nivra Mobile', { userId: 'mallory' }),
      registeredDevice('revoked', 'Android Nivra Mobile', { revokedAt: new Date().toISOString() }),
      registeredDevice('untrusted', 'Android Nivra Mobile', { isTrusted: false }),
    ]));
    await service.refreshSourcePreference(service.scope());
    expect(service.preferredSource()?.deviceId).toBe('old-device');
    expect(service.state()).toBe('idle'); // Advice never initiates recovery.
    expect(api.post).not.toHaveBeenCalled();
  });

  it('coalesces recommendation reads per session and refreshes the cache when its device list changes', async () => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestEvidence = evidence({}, 'target');
    const devices = new Subject<any[]>(); api.get.and.returnValue(devices);
    const first = service.refreshSourcePreference(service.scope());
    for (let index = 0; index < 100; index++) expect(service.refreshSourcePreference(service.scope())).toBe(first);
    expect(api.get).toHaveBeenCalledOnceWith('/devices');
    devices.next([registeredDevice('old-device', 'Android Nivra Mobile')]); devices.complete(); await first;
    await service.refreshSourcePreference(service.scope());
    expect(api.get).toHaveBeenCalledTimes(1);
    service.invalidateSourcePreference();
    expect(service.preferredSource()).toBeNull();
    api.get.and.returnValue(of([registeredDevice('old-device', 'Windows Chrome')]));
    await service.refreshSourcePreference(service.scope());
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(service.preferredSource()?.kind).toBe('other');
  });

  it('imports an approved Web package immediately while the optional APK recommendation is stalled', async () => {
    const { targetSync, status } = await approvedTarget();
    const devices = new Subject<any[]>();
    targetSync.api.get.and.callFake((url: string) => url === '/devices' ? devices : of(url.endsWith('/pending') ? [] : status));
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(targetSync.service.state()).toBe('syncing');
    expect(targetSync.service.preferredSource()).toBeNull();
    devices.next([registeredDevice('source', 'Android Nivra Mobile')]); devices.complete();
    await targetSync.service.sourceDirectoryCheck?.promise;
  });

  it('does not advertise approval capability on a reinstalled or locked source without a readable saved identity', async () => {
    const local = cryptoHarness(); const destination = await local.service.createDeviceKeys();
    const { service, api } = syncHarness(local.service);
    const created = spyOn(local.service, 'createDeviceKeys').and.callThrough();
    api.get.and.returnValue(of([request(destination.publicJwk)]));
    await service.pump();
    expect(service.pendingRequests()).toEqual([]);
    expect(service.sourceCapability()).toBe('unavailable');
    expect(created).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
    expect(service.requested).toBeFalse(); expect(service.state()).toBe('idle');
  });

  it('discards an optional source directory that arrives after the account changes', async () => {
    const { service, api, auth } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestEvidence = evidence({}, 'target');
    const devices = new Subject<any[]>(); api.get.and.returnValue(devices);
    const read = service.refreshSourcePreference(service.scope());
    auth.session.set(session('bob-device', 'bob')); service.reset('bob:bob-device');
    devices.next([registeredDevice('old-device', 'Android Nivra Mobile')]); devices.complete(); await read;
    expect(service.preferredSource()).toBeNull(); expect(service.sourceDirectory).toBeNull();
  });

  it('never exports private keys merely because the server lists a trusted request', async () => {
    const { service: crypto } = cryptoHarness(); const target = await crypto.createDeviceKeys();
    await crypto.saveDeviceKeys('alice', 'source', await crypto.createDeviceKeys(), { userId: 'alice' });
    const { service, api } = syncHarness(crypto);
    const exported = spyOn(crypto, 'exportDeviceKeyMaterialsForUser').and.callThrough();
    api.get.and.returnValue(of([request(target.publicJwk)]));
    await service.pump();
    expect(service.pendingRequests().length).toBe(1);
    expect(service.pendingRequests()[0].fingerprint.replaceAll(' ', '').length).toBe(24);
    expect(exported).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps an empty first account idle on connection, retry and an unrelated local-storage failure', async () => {
    const { service, api, auth } = syncHarness(cryptoHarness().service, 'target');
    const identity = spyOn(auth, 'ensureDeviceIdentity').and.rejectWith(new Error('Local provider unavailable'));
    await service.requestHistory(undefined);
    service.retry(); service.markHistoryRecoveryIncomplete({ retryable: true });
    await service.pump();
    expect(api.post).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled();
    expect(service.requested).toBeFalse(); expect(service.state()).toBe('idle');
    expect(service.targetFingerprint()).toBe('');
  });

  it('rejects absent, foreign, expired, system and malformed ciphertext as recovery evidence', async () => {
    const local = cryptoHarness(); const keys = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', keys, { userId: 'alice' });
    const { service, api } = syncHarness(local.service, 'target');
    const valid = evidence(keys.publicJwk);
    const variants = [
      { ...valid, userId: 'other-account' }, { ...valid, deviceId: 'other-device' },
      { ...valid, message: { ...valid.message, recipients: [] } },
      { ...valid, message: { ...valid.message, expiresAt: new Date(0).toISOString() } },
      { ...valid, message: { ...valid.message, encryptedPolicy: 'system:call' } },
      { ...valid, message: { ...valid.message, recipients: [{ ...valid.message.recipients[0], userId: 'other-account' }] } },
      { ...valid, message: { ...valid.message, recipients: [{ ...valid.message.recipients[0], ciphertext: '' }] } },
      { ...valid, message: { ...valid.message, recipients: [{ ...valid.message.recipients[0], header: '{}' }] } },
    ];
    for (const invalid of variants) await service.requestHistory(invalid);
    expect(api.post).not.toHaveBeenCalled(); expect(service.state()).toBe('idle');
  });

  it('does not generate a key or request history when the account has no persisted device identity', async () => {
    const local = cryptoHarness(); const sender = await local.service.createDeviceKeys();
    const { service, api, auth } = syncHarness(local.service, 'target');
    const created = spyOn(local.service, 'createDeviceKeys').and.callThrough();
    const identity = spyOn(auth, 'ensureDeviceIdentity').and.callThrough();
    await service.requestHistory(evidence(sender.publicJwk));
    expect(created).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled(); expect(service.state()).toBe('idle');
  });

  it('does not request another device history because the habitual native key store cannot open', async () => {
    let secret: string | null = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const local = cryptoHarness(() => secret); const keys = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', keys, { userId: 'alice' });
    const before = JSON.stringify([...local.records.values()]); secret = null;
    const { service, api } = syncHarness(local.service);
    const created = spyOn(local.service, 'createDeviceKeys').and.callThrough();
    await service.requestHistory(evidence(keys.publicJwk, 'source'));
    service.retry();
    expect(api.post).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
    expect(service.state()).toBe('idle'); expect(JSON.stringify([...local.records.values()])).toBe(before);
  });

  it('keeps an unreadable persisted historical key separate from a genuinely absent historical key', async () => {
    let secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const local = cryptoHarness(() => secret); const historical = await local.service.createDeviceKeys();
    await local.service.importHistoricalDeviceKeys('alice', 'alice', [historical]);
    secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const current = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', current, { userId: 'alice' });
    expect((await local.service.deviceKeyMaterialsForUser('alice', 'alice')).length).toBe(1);
    await expectAsync(local.service.deviceKeyMaterialsForUser('alice', 'alice', { requireReadable: true })).toBeRejectedWithError(/llaves guardadas/);
    const { service, api } = syncHarness(local.service);
    await service.requestHistory(evidence(historical.publicJwk, 'source'));
    expect(api.post).not.toHaveBeenCalled(); expect(service.state()).toBe('idle');
  });

  it('does not let an unreadable key belonging to another account block this account or start a transfer', async () => {
    let secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const local = cryptoHarness(() => secret); const other = await local.service.createDeviceKeys();
    await local.service.importHistoricalDeviceKeys('other-account', 'old.alias', [other]);
    secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const current = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'source', current, { userId: 'alice' });
    const own = await local.service.deviceKeyMaterialsForUser('alice', 'alice', { requireReadable: true });
    expect(own.length).toBe(1); expect(own[0].userId).toBe('alice');
    const { service, api } = syncHarness(local.service); await service.pump();
    expect(api.post).not.toHaveBeenCalled(); expect(service.state()).toBe('idle');
  });

  it('automatically requests history for a real unreadable own-account message after a fresh device saved its identity', async () => {
    const local = cryptoHarness(); const source = cryptoHarness();
    const fresh = await local.service.createDeviceKeys(); const old = await source.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', fresh, { userId: 'alice' });
    await source.service.saveDeviceKeys('alice', 'source', old, { userId: 'alice' });
    const sealed = await source.service.encryptForPublicKey(await source.service.currentKeyMaterial('alice', 'source'), old.publicJwk, { text: 'Private existing history' });
    const { service, api } = syncHarness(local.service, 'target');
    const proof = evidence(old.publicJwk); proof.message.recipients[0] = { ...proof.message.recipients[0], ...sealed };
    const transfer = request(fresh.publicJwk);
    api.post.and.returnValue(of(transfer)); api.get.and.callFake((url: string) => of(url.endsWith('/pending') ? [] : { ...transfer, responses: [] }));
    await expectAsync(local.service.decryptEnvelope(await local.service.currentKeyMaterial('alice', 'target'), sealed.header, sealed.ciphertext)).toBeRejected();
    await service.requestHistory(proof); await service.pumpPromise;
    expect(api.post).toHaveBeenCalledOnceWith('/devices/history-transfer/', {});
    expect(service.state()).toBe('waiting'); expect(service.targetFingerprint()).toBeTruthy();
  });

  it('accepts supported group ciphertext evidence and keeps the primary Web account able to authorize an APK', async () => {
    const source = cryptoHarness(); const destination = cryptoHarness();
    const web = await source.service.createDeviceKeys(); const apk = await destination.service.createDeviceKeys();
    await source.service.saveDeviceKeys('alice', 'source', web, { userId: 'alice' });
    await destination.service.saveDeviceKeys('alice', 'target', apk, { userId: 'alice' });
    const sourceSync = syncHarness(source.service); const targetSync = syncHarness(destination.service, 'target');
    const grouped = (await source.service.encryptGroupPayloadForRecipients(await source.service.currentKeyMaterial('alice', 'source'),
      [{ userId: 'alice', deviceId: 'source', publicJwk: web.publicJwk }], { type: 'text', text: 'Created first on Web' }))[0];
    const proof = evidence(web.publicJwk); proof.message.recipients[0] = grouped;
    const transfer = request(apk.publicJwk); let response: any;
    targetSync.api.post.and.returnValue(of(transfer));
    targetSync.api.get.and.callFake((url: string) => of(url.endsWith('/pending') ? [] : { ...transfer, responses: response ? [response] : [] }));
    sourceSync.api.get.and.returnValue(of([transfer]));
    sourceSync.api.post.and.callFake((_url: string, sealed: any) => {
      response = { ...sealed, sourceDeviceId: 'source', sourceIdentityKey: JSON.stringify(web.publicJwk) }; return of(undefined);
    });
    await targetSync.service.requestHistory(proof); await targetSync.service.pumpPromise;
    await sourceSync.service.pump();
    expect(sourceSync.service.state()).toBe('idle'); expect(sourceSync.service.pendingRequests().length).toBe(1);
    expect(sourceSync.api.post).not.toHaveBeenCalled();
    await sourceSync.service.approveRequest(transfer.id); await targetSync.service.pump();
    expect(sourceSync.api.post).toHaveBeenCalledTimes(1); expect(sourceSync.service.state()).toBe('idle');
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    const imported = (await destination.service.exportDeviceKeyMaterialsForUser('alice', 'alice')).find((key: any) => destination.service.samePublicKey(key.publicJwk, web.publicJwk));
    expect((await destination.service.decryptEnvelope(imported, grouped.header, grouped.ciphertext)).text).toBe('Created first on Web');
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

  it('carries optional contact continuity only inside the approved encrypted package and applies it to this exact account device', async () => {
    const { targetSync, sourceSync, status, response } = await approvedTarget();
    expect(sourceSync.service.identityTrust.exportForLinkedDevice).toHaveBeenCalledOnceWith('alice', 'source');
    expect(JSON.stringify(response)).not.toContain('identity-continuity');
    await targetSync.service.pump();
    expect(targetSync.service.identityTrust.importFromLinkedDevice).toHaveBeenCalledOnceWith('alice:target', 'source', {
      v: 1, purpose: 'identity-continuity', userId: 'alice', sourceDeviceId: 'source', entries: [],
    }, jasmine.any(Function));
    await targetSync.service.pump();
    expect(targetSync.service.identityTrust.importFromLinkedDevice).toHaveBeenCalledTimes(1);
    expect(status.responses.length).toBe(1);
  });

  it('keeps valid historical keys when optional continuity metadata cannot be imported', async () => {
    const { targetSync, target } = await approvedTarget();
    targetSync.service.identityTrust.importFromLinkedDevice.and.rejectWith(new Error('Unsupported continuity'));
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    expect((await target.service.exportDeviceKeyMaterialsForUser('alice', 'alice')).length).toBe(2);
    expect(targetSync.service.state()).toBe('syncing');
  });

  it('still imports an already approved package after its source is no longer in the device directory', async () => {
    const { targetSync, status } = await approvedTarget();
    targetSync.service.sourceAvailability.set('local-only');
    targetSync.api.get.and.callFake((url: string) => of(url === '/devices'
      ? [registeredDevice('target', 'Android Nivra Mobile')] : url.endsWith('/pending') ? [] : status));
    await targetSync.service.pump();
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(targetSync.service.state()).toBe('syncing');
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

  it('replays persisted keys after reopening even when this session has no imported response or reachable transfer', async () => {
    const { target, targetSync, status } = await approvedTarget();
    await targetSync.service.pump();
    expect((await target.service.exportDeviceKeyMaterialsForUser('alice', 'alice')).length).toBe(2);
    const reopened = syncHarness(target.service, 'target');
    reopened.service.requested = true;
    reopened.service.requestEvidence = evidence(JSON.parse(status.targetIdentityKey));
    reopened.api.get.and.returnValue(throwError(() => ({ status: 503 })));
    reopened.service.recovered$.next.and.callFake(() => reopened.service.markHistoryReadable());
    expect(reopened.service.importedResponses.size).toBe(0);
    reopened.service.retry();
    await reopened.service.pumpPromise;
    expect(reopened.service.recovered$.next).toHaveBeenCalledTimes(1);
    expect(reopened.service.state()).toBe('idle');
    expect(reopened.service.requested).toBeFalse();
    expect(reopened.api.post).not.toHaveBeenCalled();
  });

  it('distinguishes a partial approved keyring from a transient message refresh failure', async () => {
    const { targetSync } = await approvedTarget();
    await targetSync.service.pump();
    targetSync.service.markHistoryRecoveryIncomplete();
    expect(targetSync.service.recoveryStatus()).toBe('partial');
    expect(targetSync.service.state()).toBe('waiting');
    targetSync.service.markHistoryRecoveryIncomplete({ retryable: true });
    expect(targetSync.service.recoveryStatus()).toBe('retryable');
    targetSync.service.markHistoryReadable();
    expect(targetSync.service.recoveryStatus()).toBe('approval');
    expect(targetSync.service.state()).toBe('idle');
  });

  it('does not reopen an already readable history after an older asynchronous evidence check returns', async () => {
    const local = cryptoHarness(); const key = await local.service.createDeviceKeys();
    await local.service.saveDeviceKeys('alice', 'target', key, { userId: 'alice' });
    const { service, api } = syncHarness(local.service, 'target');
    let release!: (value: unknown) => void;
    spyOn(local.service, 'recoverDeviceIdentity').and.returnValue(new Promise(resolve => release = resolve));
    const gate = service.requestHistory(evidence(key.publicJwk));
    service.markHistoryReadable();
    release(await local.service.currentKeyMaterial('alice', 'target'));
    await gate;
    expect(service.state()).toBe('idle'); expect(service.requested).toBeFalse();
    expect(api.post).not.toHaveBeenCalled();
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

  it('keeps a bounded transfer status alive for the slow-link policy rather than cutting it at fifteen seconds', fakeAsync(() => {
    const { service, api } = syncHarness(cryptoHarness().service, 'target');
    service.network = { readTimeoutMs: () => 90_000 };
    service.requestId = 'request'; service.requestExpiresAt = Date.now() + 120_000;
    const response = new Subject<any>(); api.get.and.returnValue(response);
    let failed = false;
    void service.requestStatus(service.scope()).catch(() => failed = true);
    tick(89_999); flushMicrotasks(); expect(failed).toBeFalse();
    tick(1); flushMicrotasks(); expect(failed).toBeTrue();
    expect(response.observers.length).toBe(0);
  }));

  it('automatically retries transient refresh failure with approved keys only three times', fakeAsync(() => {
    const { service } = syncHarness(cryptoHarness().service, 'target');
    service.requested = true; service.requestedAt = Date.now();
    service.requestEvidence = evidence({});
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
    service.requestEvidence = evidence({});
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
    const proof = evidence(key.publicJwk);
    await service.requestHistory(proof);
    const poll = service.pumpPromise;
    for (let index = 0; index < 100; index++) void service.requestHistory(proof);
    expect(api.get.calls.allArgs().filter(([url]) => url !== '/devices').length).toBe(1);
    pending.next([]); pending.complete(); await poll;
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.get.calls.allArgs().filter(([url]) => url !== '/devices').length).toBe(2); // Independent approval listing and our own status.
    expect(api.get.calls.allArgs().filter(([url]) => url === '/devices').length).toBe(1);
    // A duplicate-trigger follow-up would already be queued before this turn.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    expect(api.get.calls.allArgs().filter(([url]) => url !== '/devices').length).toBe(2);
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

  it('allows a newer approved import to supersede an earlier incomplete acknowledgement', async () => {
    const { targetSync, status } = await approvedTarget();
    const pending = new Subject<any[]>();
    targetSync.api.get.and.callFake((url: string) => url.endsWith('/pending') ? pending : of(status));
    targetSync.service.state.set('syncing');
    const poll = targetSync.service.pump();
    targetSync.service.markHistoryRecoveryIncomplete();
    expect(targetSync.service.state()).toBe('waiting');
    pending.next([]); pending.complete(); await poll;
    expect(targetSync.service.state()).toBe('syncing');
    expect(targetSync.service.recovered$.next).toHaveBeenCalledTimes(1);
    targetSync.service.markHistoryReadable();
    expect(targetSync.service.state()).toBe('idle');
  });

  it('ends local recovery loading on a partial acknowledgement even while the unrelated approval list is stalled', async () => {
    const { targetSync, status } = await approvedTarget();
    const pending = new Subject<any[]>();
    targetSync.api.get.and.callFake((url: string) => url.endsWith('/pending') ? pending : of(status));
    let received!: () => void;
    const acknowledged = new Promise<void>(resolve => received = resolve);
    targetSync.service.recovered$.next.and.callFake(() => {
      targetSync.service.markHistoryRecoveryIncomplete(); received();
    });
    const poll = targetSync.service.pump();
    await acknowledged;
    expect(targetSync.service.checking()).toBeTrue();
    expect(targetSync.service.state()).toBe('waiting');
    expect(targetSync.service.recoveryStatus()).toBe('partial');
    pending.next([]); pending.complete(); await poll;
    expect(targetSync.service.checking()).toBeFalse();
    expect(targetSync.service.state()).toBe('waiting');
  });
});
