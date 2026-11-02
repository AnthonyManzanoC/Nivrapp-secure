import { of, throwError, Subject } from 'rxjs';
import { HistoryArchiveService } from './history-archive.service';
import { CryptoService } from './crypto.service';
import { RatchetMessagingService, RatchetTarget } from './ratchet-messaging.service';
import { RatchetBundle, openRatchetRuntime, ratchetTransport } from './ratchet-runtime';
import { MessageResponse } from '../models/nivra.models';

describe('actual application Double Ratchet delivery', () => {
  let clients: any[], directory: Map<string, any>, bundles: Map<string, RatchetBundle[]>, proofs: Map<string, any>, requests: Map<string, Set<string>>;
  beforeEach(() => { clients = []; directory = new Map(); bundles = new Map(); proofs = new Map(); requests = new Map(); });
  afterEach(async () => { for (const client of clients) await client.runtime?.close().catch(() => undefined); });
  async function client(name: string, accountName = name) {
    const service: any = Object.create(RatchetMessagingService.prototype);
    const keypair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const keys = { publicJwk: await crypto.subtle.exportKey('jwk', keypair.publicKey), privateJwk: await crypto.subtle.exportKey('jwk', keypair.privateKey) };
    const owner = { user: { id: `usr-${accountName}`, alias: accountName }, device: { id: `dev-${name}` } };
    service.auth = { session: () => owner, ensureDeviceIdentity: async () => keys };
    service.crypto = Object.create(CryptoService.prototype); service.crypto.currentKeyMaterial = async () => keys;
    service.trust = { check: jasmine.createSpy('identityCheck').and.resolveTo() };
    service.appLock = { isContentLocked: () => false };
    service.factory = openRatchetRuntime; service.runtime = null; service.runtimeScope = ''; service.opening = null; service.generation = 0; service.serial = Promise.resolve(); service.enabledCache = null;
    const saved = new Map<string, any>(), messages = new Map<string, any>();
    service.history = { messageWriteGuard: () => () => true, readRatchetState: async (_user: string, device: string) => structuredClone(saved.get(device) ?? null),
      commitRatchetState: async (_user: string, device: string, revision: number, state: unknown) => {
        if ((saved.get(device)?.revision ?? 0) !== revision) throw Error('CAS conflict');
        saved.set(device, { revision: revision + 1, state: structuredClone(state) }); return revision + 1;
      },
      putMessages: async (_user: string, values: any[]) => { for (const value of values) messages.set(`${value.conversationId}:${value.id}`, structuredClone(value)); },
      messageById: async (_user: string, chat: string, id: string) => structuredClone(messages.get(`${chat}:${id}`) ?? null) };
    const target: RatchetTarget = { userId: owner.user.id, deviceId: owner.device.id, publicJwk: keys.publicJwk };
    const record = { target, service, owner, saved, messages, keys }; directory.set(target.deviceId, record);
    service.api = { get: (path: string) => {
      if (path === '/ratchet/olm/config') return of({ enabled: true, protocol: 5 });
      if (path === '/ratchet/olm/prekeys/status') return of({ available: bundles.get(target.deviceId)?.length ?? 0 });
      if (path === '/ratchet/olm/bindings/pending') return of([...(requests.get(target.deviceId) ?? [])].map(id => ({ userId: directory.get(id).target.userId, deviceId: id, identityKey: JSON.stringify(directory.get(id).keys.publicJwk) })));
      return throwError(() => Error('Unexpected GET ' + path));
    }, post: (path: string, body: any) => {
      if (path === '/ratchet/olm/prekeys') { bundles.set(target.deviceId, [...(bundles.get(target.deviceId) ?? []), ...body.bundles]); record['registration' as keyof typeof record] = body.bundles[0] as never; return of({ added: body.bundles.length }); }
      if (path === '/ratchet/olm/prekeys/consumed') return of(null);
      if (path === '/ratchet/olm/directory') return of(body.deviceIds.flatMap((id: string) => {
        const remote = directory.get(id), first = remote?.registration; if (!first) return [];
        const binding = proofs.get(`${id}:${target.deviceId}`);
        return [{ userId: remote.target.userId, deviceId: id, signalDeviceNumber: 1, registrationId: first.registrationId, identityKey: first.identityKey, bindingHeader: binding?.header, bindingCiphertext: binding?.ciphertext }];
      }));
      if (path === '/ratchet/olm/bindings/request') { for (const id of body.deviceIds) { const pending = requests.get(id) ?? new Set<string>(); pending.add(target.deviceId); requests.set(id, pending); } return of(null); }
      if (path === '/ratchet/olm/bindings') { for (const binding of body.bindings) { proofs.set(`${target.deviceId}:${binding.targetDeviceId}`, binding); requests.get(target.deviceId)?.delete(binding.targetDeviceId); } return of(null); }
      if (path.startsWith('/ratchet/olm/devices/')) { const id = path.split('/')[4], bundle = bundles.get(id)?.shift(); return bundle ? of({ deviceId: id, requestId: body.requestId, bundle }) : throwError(() => Error('No prekeys')); }
      if (path === '/keys/batch') return of(body.userIds.map((id: string) => ({ userId: id, devices: [...directory.values()].filter(remote => remote.target.userId === id).map(remote => ({ deviceId: remote.target.deviceId, keyBundle: { identityKey: JSON.stringify(remote.keys.publicJwk) } })) })));
      return throwError(() => Error('Unexpected POST ' + path));
    } };
    clients.push(service); return record;
  }
  const response = (sender: any, recipients: any[], clientMessageId = 'msg-one'): MessageResponse => ({ id: 'server-' + clientMessageId, conversationId: 'chat-test', clientMessageId,
    senderUserId: sender.target.userId, senderDeviceId: sender.target.deviceId, kind: 'Text', recipients, serverReceivedAt: new Date().toISOString(), deleteAfterRead: false, receipts: [] });

  it('keeps notes to self encrypted, retryable and readable after restarting the client', async () => {
    const alice=await client('alice');await alice.service.pump();
    const payload={type:'text',text:'Private note to myself'},id='self-note';
    const recipients=await alice.service.encrypt('chat-test',id,payload,[alice.target],null);
    expect(recipients.length).toBe(1);expect(recipients[0].ciphertext).toBe('local-history-v1');
    expect(JSON.stringify(recipients)).not.toContain(payload.text);
    await alice.service.runtime.close();alice.service.runtime=null;
    expect(await alice.service.encrypt('chat-test',id,payload,[alice.target],null)).toEqual(recipients);
    const message=response(alice,recipients,id);await alice.service.confirmSent(message,payload);
    await alice.service.runtime.close();alice.service.runtime=null;
    expect(await alice.service.decrypt(message,recipients[0])).toEqual(payload);
  },30000);

  it('delivers notes to another authorized device of the same account through a real ratchet session', async () => {
    const alice=await client('alice'),linked=await client('alice-linked','alice');
    await alice.service.pump();await linked.service.pump();
    const targets=[alice.target,linked.target],payload={type:'text',text:'Synced private note'},id='self-linked';
    await alice.service.encrypt('chat-test',id,payload,targets,null).catch(()=>undefined);await linked.service.pump();
    const recipients=await alice.service.encrypt('chat-test',id,payload,targets,null);
    expect(recipients[1].ciphertext).not.toBe('local-history-v1');
    const message=response(alice,recipients,id);expect(await linked.service.decrypt(message,recipients[1])).toEqual(payload);
    await linked.service.runtime.close();linked.service.runtime=null;
    expect(await linked.service.decrypt(message,recipients[1])).toEqual(payload);
  },30000);

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
    const altered = JSON.parse(recipients[1].header); altered.payloadIv = btoa('tampered-iv!');
    await expectAsync(bob.service.decrypt(message, { ...recipients[1], header: JSON.stringify(altered) })).toBeRejected();
    const save = bob.service.history.putMessages; bob.service.history.putMessages = async () => { throw Error('disk full'); };
    await expectAsync(bob.service.decrypt(message, recipients[1])).toBeRejectedWithError('disk full');
    bob.service.history.putMessages = save;
    await expectAsync(bob.service.decrypt({ ...message, conversationId: 'wrong-chat' }, recipients[1])).toBeRejected();
    expect(await bob.service.decrypt(message, recipients[1])).toEqual(payload);
    const next = await alice.service.encrypt('chat-test', 'msg-next', { type: 'text', text: 'next' }, targets, null);
    expect(await bob.service.decrypt(response(alice, next, 'msg-next'), next[1])).toEqual({ type: 'text', text: 'next' });
  }, 30000);

  it('encrypts one shared body for a group, queues an unupdated recipient and still reads old ciphertext', async () => {
    const alice = await client('alice'), peers = await Promise.all(Array.from({ length: 8 }, (_, index) => client('peer' + index))), legacy = await client('legacy');
    await alice.service.pump(); for (const peer of peers) await peer.service.pump();
    const targets = [alice.target, ...peers.map(peer => peer.target)], payload = { type: 'text', text: 'group message '.repeat(4500) };
    await expectAsync(alice.service.encrypt('chat-test', 'group-message', payload, [...targets, legacy.target], null)).toBeRejectedWithError(/actualizar/);
    await expectAsync(alice.service.encrypt('chat-test', 'group-message', payload, targets, null)).toBeRejected();
    for (const peer of peers) await peer.service.pump();
    const packets = await alice.service.encrypt('chat-test', 'group-message', payload, targets, null);
    const transport = ratchetTransport(packets);
    expect(JSON.stringify(transport).length).toBeLessThan(payload.text.length * 4);
    const sharedMessage = { ...response(alice, transport.recipients, 'group-message'), ...transport };
    for (let index = 0; index < peers.length; index++) {
      expect(packets[index + 1].ciphertext.length).toBeLessThan(8192);
      if (index === 0) await expectAsync(peers[index].service.decrypt({ ...sharedMessage, sharedPayloadCiphertext: sharedMessage.sharedPayloadCiphertext!.slice(4) }, transport.recipients[index + 1])).toBeRejected();
      expect(await peers[index].service.decrypt(sharedMessage, transport.recipients[index + 1])).toEqual(payload);
    }
    const older = await alice.service.crypto.encryptForPublicKey(alice.keys, legacy.keys.publicJwk, payload);
    expect(await legacy.service.crypto.decryptEnvelope(legacy.keys, older.header, older.ciphertext)).toEqual(payload);
    expect(JSON.stringify(alice.saved.get(alice.target.deviceId)).length).toBeLessThan(1000000);
  }, 60000);

  it('transfers approved history to a linked device using actual ratchet pages and resumes after an interrupted import', async () => {
    const source = await client('source'), linked = await client('linked');
    linked.owner.user.id = source.owner.user.id; linked.target.userId = source.target.userId;
    await source.service.pump(); await linked.service.pump();
    const at = new Date().toISOString(), text = 'history survives linking '.repeat(4200);
    const historical = { id: 'msg_history_one', clientMessageId: 'original-message', conversationId: 'chat-test', mine: true,
      senderUserId: source.target.userId, senderDeviceId: source.target.deviceId, at: at.replace('Z', '4567Z'), payload: { type: 'text', text } };
    source.messages.set('chat-test:msg_history_one', historical);
    // A crash may leave the durable ratchet receipt before the visible history row.
    const recovered = { ...historical, id: 'msg_hidden_only', clientMessageId: 'hidden-original', payload: { type: 'text', text: 'saved before crash' } };
    const edited = { ...historical, id: 'msg_history_edit', clientMessageId: 'edit-original', payload: { type: 'edit', messageId: historical.id, text: 'updated text' } };
    for (const message of [recovered, edited]) source.messages.set(`ratchet-receipt:chat-test:${message.id}`, { ...message, conversationId: 'ratchet-receipt:chat-test', payload: { type: 'ratchet-delivery', content: message.payload } });
    const pages = new Map<number, any>(); let nextSequence = 0, acknowledgedSequence = -1, finished = false;
    for (const record of [source, linked]) {
      const originalGet = record.service.api.get, originalPost = record.service.api.post;
      record.service.history.conversations = async () => [{ id: 'chat-test' }];
      record.service.history.accountKeysForUser = async () => [source.target.userId];
      record.service.history.conversationMessagesPage = async (_user: string, chat: string, options: any) => [...record.messages.values()]
        .filter(message => message.conversationId === chat && (!options.before || message.at < options.before || message.at === options.before && message.id < options.beforeId))
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-options.limit).map(value => structuredClone(value));
      record.service.api.get = (path: string) => path.includes('/archive/') ? of({ nextSequence, acknowledgedSequence, finished, pages: [...pages.values()] }) : originalGet(path);
      record.service.api.post = (path: string, body: any) => {
        if (path.endsWith('/ack')) { acknowledgedSequence = Math.max(acknowledgedSequence, body.sequence); for (const sequence of pages.keys()) if (sequence <= acknowledgedSequence) pages.delete(sequence); return of(null); }
        if (path.includes('/archive/')) { if (!pages.has(body.sequence)) { pages.set(body.sequence, structuredClone(body)); nextSequence++; finished = body.final; } return of(null); }
        if (path === '/messages/history-recovery') return of({ messages: [historical, recovered, edited].map(message => ({ ...response(source, [], message.clientMessageId), id: message.id, serverReceivedAt: at })), deletedMessages: [] });
        return originalPost(path, body);
      };
    }
    const transfer = { id: 'transfer_real_archive', userId: source.target.userId, targetDeviceId: linked.target.deviceId, targetIdentityKey: JSON.stringify(linked.keys.publicJwk), expiresAt: new Date(Date.now() + 600000).toISOString() };
    const createArchive = (record: any): any => {
      const archive: any = Object.create(HistoryArchiveService.prototype);
      Object.assign(archive, { auth: record.service.auth, lock: record.service.appLock, crypto: record.service.crypto, history: record.service.history, api: record.service.api, ratchet: record.service, imported$: new Subject(), running: false, receiving: new Map() });
      return archive;
    };
    const sending = createArchive(source), receiving = createArchive(linked);
    expect(await sending.beginSend(transfer)).toBeTrue();
    await receiving.beginReceive(transfer, source.target.deviceId, JSON.stringify(source.keys.publicJwk));
    await sending.pump(); await linked.service.pump(); await sending.pump();
    expect(pages.size).toBeGreaterThan(2);
    const save = linked.service.history.putMessages; let fail = true;
    linked.service.history.putMessages = async (user: string, messages: any[]) => {
      if (fail && messages.some(message => message.conversationId === 'chat-test')) { fail = false; throw Error('interrupted history import'); }
      return save(user, messages);
    };
    await receiving.pump(); await receiving.pump(); await sending.pump();
    expect(linked.messages.get('chat-test:msg_history_one')?.payload.text).toBe(text);
    expect(linked.messages.get('chat-test:msg_hidden_only')?.payload.text).toBe('saved before crash');
    expect(linked.messages.has('chat-test:msg_history_edit')).toBeFalse();
    const editResponse = { ...response(source, [], edited.clientMessageId), id: edited.id, serverReceivedAt: at };
    expect(await linked.service.transferredPayload(editResponse)).toEqual(edited.payload);
    expect(await linked.service.transferredPayload({ ...editResponse, senderDeviceId: 'another-device' })).toBeNull();
    expect(await linked.service.transferredPayload({ ...editResponse, conversationId: 'another-chat' })).toBeNull();
    expect(await linked.service.transferredPayload({ ...editResponse, deleteAfterRead: true })).toBeNull();
    expect(finished).toBeTrue(); expect(pages.size).toBe(0); expect(acknowledgedSequence).toBe(nextSequence - 1);
    expect(linked.service.runtime.publicIdentity).not.toEqual(source.service.runtime.publicIdentity);
  }, 30000);

  it('ratchets ephemeral vault messages without retaining plaintext in snapshots or permanent history', async () => {
    const alice = await client('vault-alice'), bob = await client('vault-bob'); await alice.service.pump(); await bob.service.pump();
    const targets = [alice.target, bob.target], payload = { type: 'text', text: 'EPHEMERAL VAULT SECRET' };
    await alice.service.encrypt('vault-room', 'vault-one', payload, targets, null, true).catch(() => undefined); await bob.service.pump();
    const packets = await alice.service.encrypt('vault-room', 'vault-one', payload, targets, null, true);
    expect(JSON.stringify(alice.saved.get(alice.target.deviceId))).not.toContain(payload.text);
    const transport = ratchetTransport(packets), message = { ...response(alice, transport.recipients, 'vault-one'), ...transport, conversationId: 'vault-room' };
    expect(await bob.service.decrypt(message, transport.recipients[1], () => true, true)).toEqual(payload);
    expect(JSON.stringify([...bob.messages.values()])).not.toContain(payload.text);
    expect(await bob.service.runtime.pendingReceived()).toEqual([]);
    await alice.service.discardEphemeral('vault-room', 'vault-one');
    expect(alice.saved.get(alice.target.deviceId).state.outbox).toEqual([]);
  }, 30000);

  it('archives every record once when more than one page shares a millisecond with different database precision', async () => {
    const records = Array.from({ length: 12 }, (_, index) => ({ id: `msg_${String(12 - index).padStart(2, '0')}`, conversationId: 'chat-test',
      at: `2026-11-01T12:00:00.123${String(index).padStart(3, '0')}Z`, payload: { type: 'text', text: 'precision boundary' } }));
    const archive: any = Object.create(HistoryArchiveService.prototype);
    archive.owner = () => ({ userId: 'archive-owner', assert: () => undefined }); archive.save = async () => undefined;
    archive.history = { conversationMessagesPage: async (_account: string, chat: string, page: any) => chat !== 'chat-test' ? [] : records
      .filter(record => !page.before || record.at < page.before || record.at === page.before && record.id < page.beforeId)
      .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1).slice(-page.limit) };
    const progress: any = { conversations: ['chat-test'], cursor: { chat: 0 } }, received: string[] = [];
    for (let page = 0; page < 4; page++) {
      await archive.nextBatch(progress); received.push(...JSON.parse(progress.batch.text).map((record: any) => record.id));
      if (progress.batch.final) break;
      progress.cursor = progress.batch.after; progress.batch = undefined;
    }
    expect(received.length).toBe(12); expect(new Set(received)).toEqual(new Set(records.map(record => record.id)));
  });
});
