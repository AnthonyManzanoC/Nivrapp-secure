import { of, throwError } from 'rxjs';
import { CryptoService } from './crypto.service';
import { RatchetMessagingService, RatchetTarget } from './ratchet-messaging.service';
import { RatchetBundle, openRatchetRuntime } from './ratchet-runtime';
import { MessageResponse } from '../models/nivra.models';

describe('actual application Double Ratchet delivery', () => {
  let clients: any[], directory: Map<string, any>, bundles: Map<string, RatchetBundle[]>, proofs: Map<string, any>, requests: Map<string, Set<string>>;
  beforeEach(() => { clients = []; directory = new Map(); bundles = new Map(); proofs = new Map(); requests = new Map(); });
  afterEach(async () => { for (const client of clients) await client.runtime?.close().catch(() => undefined); });
  async function client(name: string) {
    const service: any = Object.create(RatchetMessagingService.prototype);
    const keypair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const keys = { publicJwk: await crypto.subtle.exportKey('jwk', keypair.publicKey), privateJwk: await crypto.subtle.exportKey('jwk', keypair.privateKey) };
    const owner = { user: { id: `usr-${name}`, alias: name }, device: { id: `dev-${name}` } };
    service.auth = { session: () => owner, ensureDeviceIdentity: async () => keys };
    service.crypto = Object.create(CryptoService.prototype); service.crypto.currentKeyMaterial = async () => keys;
    service.trust = { check: jasmine.createSpy('identityCheck').and.resolveTo() };
    service.appLock = { isContentLocked: () => false };
    service.factory = openRatchetRuntime; service.runtime = null; service.runtimeScope = ''; service.opening = null; service.generation = 0; service.serial = Promise.resolve(); service.enabledCache = null;
    const saved = new Map<string, any>(), messages = new Map<string, any>();
    service.history = { readRatchetState: async (_user: string, device: string) => structuredClone(saved.get(device) ?? null),
      commitRatchetState: async (_user: string, device: string, revision: number, state: unknown) => {
        if ((saved.get(device)?.revision ?? 0) !== revision) throw Error('CAS conflict');
        saved.set(device, { revision: revision + 1, state: structuredClone(state) }); return revision + 1;
      },
      putMessages: async (_user: string, values: any[]) => { for (const value of values) messages.set(`${value.conversationId}:${value.id}`, structuredClone(value)); },
      messageById: async (_user: string, chat: string, id: string) => structuredClone(messages.get(`${chat}:${id}`) ?? null) };
    const target: RatchetTarget = { userId: owner.user.id, deviceId: owner.device.id, publicJwk: keys.publicJwk };
    const record = { target, service, owner, saved, messages, keys }; directory.set(target.deviceId, record);
    service.api = { get: (path: string) => {
      if (path === '/ratchet/config') return of({ enabled: true, protocol: 3 });
      if (path === '/ratchet/prekeys/status') return of({ available: bundles.get(target.deviceId)?.length ?? 0 });
      if (path === '/ratchet/bindings/pending') return of([...(requests.get(target.deviceId) ?? [])].map(id => ({ userId: directory.get(id).target.userId, deviceId: id, identityKey: JSON.stringify(directory.get(id).keys.publicJwk) })));
      return throwError(() => Error('Unexpected GET ' + path));
    }, post: (path: string, body: any) => {
      if (path === '/ratchet/prekeys') { bundles.set(target.deviceId, [...(bundles.get(target.deviceId) ?? []), ...body.bundles]); record['registration' as keyof typeof record] = body.bundles[0] as never; return of({ added: body.bundles.length }); }
      if (path === '/ratchet/directory') return of(body.deviceIds.flatMap((id: string) => {
        const remote = directory.get(id), first = remote?.registration; if (!first) return [];
        const binding = proofs.get(`${id}:${target.deviceId}`);
        return [{ userId: remote.target.userId, deviceId: id, signalDeviceNumber: 1, registrationId: first.registrationId, identityKey: first.identityKey, bindingHeader: binding?.header, bindingCiphertext: binding?.ciphertext }];
      }));
      if (path === '/ratchet/bindings/request') { for (const id of body.deviceIds) { const pending = requests.get(id) ?? new Set<string>(); pending.add(target.deviceId); requests.set(id, pending); } return of(null); }
      if (path === '/ratchet/bindings') { for (const binding of body.bindings) { proofs.set(`${target.deviceId}:${binding.targetDeviceId}`, binding); requests.get(target.deviceId)?.delete(binding.targetDeviceId); } return of(null); }
      if (path.startsWith('/ratchet/devices/')) { const id = path.split('/')[3], bundle = bundles.get(id)?.shift(); return bundle ? of({ deviceId: id, requestId: body.requestId, bundle }) : throwError(() => Error('No prekeys')); }
      if (path === '/keys/batch') return of(body.userIds.map((id: string) => ({ userId: id, devices: [...directory.values()].filter(remote => remote.target.userId === id).map(remote => ({ deviceId: remote.target.deviceId, keyBundle: { identityKey: JSON.stringify(remote.keys.publicJwk) } })) })));
      return throwError(() => Error('Unexpected POST ' + path));
    } };
    clients.push(service); return record;
  }
  const response = (sender: any, recipients: any[], clientMessageId = 'msg-one'): MessageResponse => ({ id: 'server-' + clientMessageId, conversationId: 'chat-test', clientMessageId,
    senderUserId: sender.target.userId, senderDeviceId: sender.target.deviceId, kind: 'Text', recipients, serverReceivedAt: new Date().toISOString(), deleteAfterRead: false, receipts: [] });

  it('authenticates migration, sends, retries identical bytes, restarts and reads both sides without a static-key self copy', async () => {
    const alice = await client('alice'), bob = await client('bob');
    await alice.service.pump(); await bob.service.pump();
    const targets = [alice.target, bob.target], payload = { type: 'text', text: 'real application message', _padding: 'first' };
    await expectAsync(alice.service.encrypt('chat-test', 'msg-one', payload, targets, null)).toBeRejectedWithError(/preparando/);
    await bob.service.pump();
    const encrypted = await alice.service.encrypt('chat-test', 'msg-one', payload, targets, null);
    expect(encrypted[0].ciphertext).toBe('local-history-v1'); expect(JSON.stringify(encrypted)).not.toContain('real application message');
    await alice.service.runtime.close(); alice.service.runtime = null;
    expect(await alice.service.encrypt('chat-test', 'msg-one', { ...payload, _padding: 'new random padding' }, targets, null)).toEqual(encrypted);
    const message = response(alice, encrypted);
    expect(await bob.service.decrypt(message, encrypted[1])).toEqual(payload);
    await bob.service.runtime.close(); bob.service.runtime = null;
    expect(await bob.service.decrypt(message, encrypted[1])).toEqual(payload);
    await alice.service.confirmSent(message, payload);
    await alice.service.runtime.close(); alice.service.runtime = null;
    expect(await alice.service.decrypt(message, encrypted[0])).toEqual(payload);
  }, 30000);

  it('recovers after a failed history write, rejects changed routing and keeps the next valid message readable', async () => {
    const alice = await client('alice'), bob = await client('bob'); await alice.service.pump(); await bob.service.pump();
    const targets = [alice.target, bob.target], payload = { type: 'file', name: 'photo.jpg', key: 'protected-file-key' };
    await alice.service.encrypt('chat-test', 'file-one', payload, targets, null).catch(() => undefined); await bob.service.pump();
    const recipients = await alice.service.encrypt('chat-test', 'file-one', payload, targets, null), message = response(alice, recipients, 'file-one');
    const save = bob.service.history.putMessages; bob.service.history.putMessages = async () => { throw Error('disk full'); };
    await expectAsync(bob.service.decrypt(message, recipients[1])).toBeRejectedWithError('disk full');
    bob.service.history.putMessages = save;
    await expectAsync(bob.service.decrypt({ ...message, conversationId: 'wrong-chat' }, recipients[1])).toBeRejected();
    expect(await bob.service.decrypt(message, recipients[1])).toEqual(payload);
    const next = await alice.service.encrypt('chat-test', 'msg-next', { type: 'text', text: 'next' }, targets, null);
    expect(await bob.service.decrypt(response(alice, next, 'msg-next'), next[1])).toEqual({ type: 'text', text: 'next' });
  }, 30000);
});
