// Shared transactional WebCrypto capsule and retry coordinator.
// Production callers supply the encrypted platform storage and device directory.
// SUITE is retained only as the old laboratory bridge's default; new bridges
// must announce their own distinct protocolSuite and snapshots bind that suite.
export const SUITE = 'NIVRA-LIBSIGNAL-A256GCM-PILOT-1';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_PAYLOAD = 1024 * 1024;
const RESTORE = Symbol('restored laboratory core');
const b64 = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
function binary(value, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('Invalid binary encoding');
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes.length > maximum || b64(bytes) !== value) throw Error('Invalid binary size or encoding');
  return bytes;
}
function peerAddress(peer) {
  if (typeof peer?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(peer.name)
      || !Number.isInteger(peer.device) || peer.device < 1 || peer.device > 127) throw Error('Invalid device address');
  return { name: peer.name, device: peer.device };
}
function contextBytes(context, sender, recipient, suite = SUITE) {
  for (const key of ['conversationId', 'messageId']) {
    if (typeof context?.[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(context[key])) throw Error('Invalid message context');
  }
  return encoder.encode(JSON.stringify({ suite, context: {
    conversationId: context.conversationId, messageId: context.messageId,
    sender: `${sender.name}.${sender.device}`, recipient: `${recipient.name}.${recipient.device}`,
  } }));
}
const hash = async bytes => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

export class LabWebDevice {
  #core;
  #bridge;
  #suite;
  #address;
  #public;
  #queue = Promise.resolve();
  #outbox = new Map();
  #inbox = new Map();
  #bundles = new Map();
  #sessions = new Set();
  #application = {};
  #closed = false;
  #storage = null;
  #scope;
  #revision = 0;
  #poisoned = false;

  constructor(bridge, name, device = 1, restored = null) {
    this.#bridge = bridge;
    this.#suite = bridge.protocolSuite?.() ?? SUITE;
    this.#address = peerAddress({ name, device });
    this.#scope = JSON.stringify([name, device]);
    if (restored?.token === RESTORE) {
      this.#core = restored.core; this.#public = restored.public;
      return;
    }
    const identity = bridge.createIdentity();
    try {
      this.#public = bridge.identityPublic(identity);
      // Rejection sampling avoids a biased registration number.
      const value = new Uint16Array(1);
      do { crypto.getRandomValues(value); } while (value[0] >= 65516);
      this.#core = new bridge.RatchetDevice(name, device, identity, value[0] % 16379 + 1);
    } finally { identity.fill(0); }
  }

  static async open(bridge, name, device, storage, { createIfMissing = false } = {}) {
    peerAddress({ name, device });
    const scope = JSON.stringify([name, device]), saved = await storage.read(scope);
    const suite = bridge.protocolSuite?.() ?? SUITE;
    if (!saved) {
      if (!createIfMissing) throw Error('Stored session missing: explicit initialization required');
      const result = new LabWebDevice(bridge, name, device);
      try {
        result.#revision = await storage.commit(scope, 0, await result.#persistentState());
        result.#storage = storage;
        return result;
      } catch (error) { await result.close(); throw error; }
    }
    const state = saved.state;
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || state?.v !== 3 || state.scope !== scope || (state.suite ?? SUITE) !== suite
        || typeof state.core !== 'string' || state.core.length > 32 * 1024 * 1024
        || !Array.isArray(state.outbox) || state.outbox.length > 4096
        || !Array.isArray(state.bundles) || state.bundles.length > 256
        || !state.application || typeof state.application !== 'object' || Array.isArray(state.application)
        || !Array.isArray(state.inbox) || state.inbox.length > 64) throw Error('Invalid stored web device');
    const outbox = new Map();
    for (const entry of state.outbox) {
      if (!Array.isArray(entry) || entry.length !== 2 || outbox.has(entry[0]) || binary(entry[0], 32).length !== 32
          || binary(entry[1]?.requestHash, 32).length !== 32 || entry[1]?.envelope?.v !== 3 || entry[1]?.envelope?.suite !== suite
          || entry[1]?.envelope?.context?.sender !== `${name}.${device}`) throw Error('Invalid stored retry envelope');
      outbox.set(entry[0], structuredClone(entry[1]));
    }
    const inbox = new Map();
    for (const entry of state.inbox) {
      if (!Array.isArray(entry) || entry.length !== 2 || inbox.has(entry[0]) || binary(entry[0], 32).length !== 32
          || !entry[1] || entry[1].context?.recipient !== `${name}.${device}`) throw Error('Invalid stored incoming delivery');
      const peer = peerAddress(entry[1].peer);
      const aad = contextBytes(entry[1].context, peer, { name, device }, suite);
      if (await hash(aad) !== entry[0] || JSON.stringify(JSON.parse(decoder.decode(aad)).context) !== JSON.stringify(entry[1].context)) throw Error('Stored delivery context mismatch');
      inbox.set(entry[0], structuredClone(entry[1]));
    }
    const core = await bridge.RatchetDevice.restorePrivateState(name, device, state.core);
    let identity;
    try {
      identity = binary(JSON.parse(state.core).identity, 256 * 1024);
      const result = new LabWebDevice(bridge, name, device, { token: RESTORE, core, public: bridge.identityPublic(identity) });
      result.#storage = storage; result.#revision = saved.revision; result.#outbox = outbox; result.#inbox = inbox;
      const coreState = JSON.parse(state.core);
      result.#sessions = new Set(coreState.peers.filter(peer => peer.session).map(peer => JSON.stringify([peer.name, peer.device])));
      result.#application = structuredClone(state.application);
      for (const entry of state.bundles) {
        if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) || entry[0] < 1
            || result.#bundles.has(entry[0]) || entry[1]?.preKeyId !== entry[0]) throw Error('Invalid pending prekey publication');
        result.#bundles.set(entry[0], structuredClone(entry[1]));
      }
      return result;
    } catch (error) { core.free(); throw error; }
    finally { identity?.fill(0); }
  }
  get publicIdentity() { return this.#public.slice(); }
  get address() { return { ...this.#address }; }
  pinIdentity(peer, publicKey, applicationState) {
    peer = peerAddress(peer); const key = new Uint8Array(publicKey);
    const next = applicationState === undefined ? undefined : structuredClone(applicationState);
    return this.#mutate(async () => { await this.#core.pinIdentity(peer.name, peer.device, key); if (next !== undefined) this.#application = next; });
  }
  bundle() { return this.#mutate(async () => {
    const bundle = JSON.parse(await this.#core.preKeyBundle(Date.now()));
    this.#bundles.set(bundle.preKeyId, bundle); return structuredClone(bundle);
  }); }
  pendingBundles() { return this.#run(() => [...this.#bundles.values()].map(bundle => structuredClone(bundle))); }
  acknowledgeBundles(ids) {
    const acknowledged = [...ids];
    return this.#mutate(() => { for (const id of acknowledged) this.#bundles.delete(id); });
  }
  pendingConsumedPreKeys() { return this.#run(() => this.#core.consumedPreKeys ? [...this.#core.consumedPreKeys()] : []); }
  acknowledgeConsumedPreKeys(ids) { const copy = new Uint32Array(ids); return this.#mutate(() => this.#core.acknowledgeConsumedPreKeys?.(copy)); }
  hasSession(peer) { peer = peerAddress(peer); return this.#run(() => this.#sessions.has(JSON.stringify([peer.name, peer.device]))); }
  applicationState() { return this.#run(() => structuredClone(this.#application)); }
  signDeviceContinuity(message) {
    if (!(message instanceof Uint8Array) || message.length > 512 || !message.length || !this.#bridge.signIdentity) throw Error('Invalid device authorization');
    const copy = message.slice();
    return this.#run(async () => {
      const saved = JSON.parse(await this.#core.exportPrivateStateForEncryption());
      const identity = binary(saved.identity, 256 * 1024);
      try { return this.#bridge.signIdentity(identity, copy); }
      finally { identity.fill(0); }
    });
  }
  updateApplicationState(state) {
    const next = structuredClone(state);
    return this.#mutate(() => { this.#application = next; });
  }
  establish(peer, bundle) {
    peer = peerAddress(peer); const encoded = JSON.stringify(bundle);
    return this.#mutate(async () => { await this.#core.establish(peer.name, peer.device, encoded, Date.now()); this.#sessions.add(JSON.stringify([peer.name, peer.device])); });
  }
  encrypt(peer, context, payload) {
    peer = peerAddress(peer);
    const aad = contextBytes(context, this.#address, peer, this.#suite);
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== 'string') throw Error('Payload must be JSON');
    const plain = encoder.encode(serialized);
    if (plain.length > MAX_PAYLOAD) { plain.fill(0); return Promise.reject(Error('Message too large')); }
    return this.#mutate(() => this.#seal(peer, aad, plain)).finally(() => plain.fill(0));
  }
  encryptMany(requests) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 512) throw Error('Invalid recipient batch');
    const prepared = [];
    try {
      for (const request of requests) {
        const peer = peerAddress(request.peer), aad = contextBytes(request.context, this.#address, peer, this.#suite);
        const serialized = JSON.stringify(request.payload);
        if (typeof serialized !== 'string') throw Error('Payload must be JSON');
        const plain = encoder.encode(serialized);
        if (plain.length > MAX_PAYLOAD) { plain.fill(0); throw Error('Message too large'); }
        prepared.push({ peer, aad, plain });
      }
    } catch (error) { for (const row of prepared) row.plain.fill(0); throw error; }
    return this.#mutate(async () => {
      const result = [];
      for (const row of prepared) result.push(await this.#seal(row.peer, row.aad, row.plain));
      return result;
    }).finally(() => { for (const row of prepared) row.plain.fill(0); });
  }
  async #seal(peer, aad, plain) {
      let keyBytes, capsule;
      try {
        const id = await hash(aad), requestHash = await hash(encoder.encode(JSON.stringify([b64(aad), b64(plain)])));
        const previous = this.#outbox.get(id);
        if (previous) {
          if (previous.requestHash !== requestHash) throw Error('Message ID reused with different content');
          return structuredClone(previous.envelope);
        }
        if (this.#outbox.size >= 4096) throw Object.assign(Error('Encrypted outbox full'), { retryable: true, status: 503 });
        keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain));
        capsule = encoder.encode(JSON.stringify({ key: b64(keyBytes), contextHash: id, payloadHash: await hash(ciphertext) }));
        const packet = JSON.parse(await this.#core.encrypt(peer.name, peer.device, capsule, Date.now()));
        const envelope = { v: 3, suite: this.#suite, context: JSON.parse(decoder.decode(aad)).context,
          type: packet.type, keyMessage: packet.bytes, iv: b64(iv), ciphertext: b64(ciphertext) };
        const result = structuredClone(envelope);
        this.#outbox.set(id, { requestHash, envelope });
        return result;
      } finally { plain.fill(0); keyBytes?.fill(0); capsule?.fill(0); }
  }
  decrypt(peer, context, envelope, ephemeral = false) {
    peer = peerAddress(peer);
    const aad = contextBytes(context, peer, this.#address, this.#suite);
    // Snapshot caller input before the first asynchronous operation.
    envelope = structuredClone(envelope);
    return this.#mutate(async () => {
      if (envelope?.v !== 3 || envelope.suite !== this.#suite || ![2, 3].includes(envelope.type)) throw Error('Unsupported protocol: no legacy fallback');
      if (JSON.stringify(envelope.context) !== JSON.stringify(JSON.parse(decoder.decode(aad)).context)) throw Error('Wrong message context');
      const iv = binary(envelope.iv, 12), payload = binary(envelope.ciphertext, MAX_PAYLOAD + 16);
      if (iv.length !== 12 || payload.length < 16) throw Error('Invalid encrypted payload');
      const ratchet = binary(envelope.keyMessage, 131072);
      const id = await hash(aad);
      if (this.#inbox.has(id)) throw Error('Repeated message: recover the stored incoming delivery');
      if (!ephemeral && this.#inbox.size >= 64) throw Error('Incoming delivery queue full: save pending history first');
      let capsule, keyBytes, plain;
      try {
        capsule = await this.#core.decrypt(peer.name, peer.device, envelope.type, ratchet);
        this.#sessions.add(JSON.stringify([peer.name, peer.device]));
        const metadata = JSON.parse(decoder.decode(capsule));
        if (metadata.contextHash !== await hash(aad) || metadata.payloadHash !== await hash(payload)) throw Error('Message binding failed');
        keyBytes = binary(metadata.key, 32);
        if (keyBytes.length !== 32) throw Error('Invalid content key');
        const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, payload));
        const result = JSON.parse(decoder.decode(plain));
        if (this.#core.consumedPreKeys) for (const consumed of this.#core.consumedPreKeys()) this.#bundles.delete(consumed);
        // Keep a recoverable copy until the application confirms its own
        // history write. A process exit after commit must not lose plaintext.
        if (!ephemeral) this.#inbox.set(id, { peer, context: JSON.parse(decoder.decode(aad)).context, envelopeHash: await hash(encoder.encode(JSON.stringify(envelope))), payload: structuredClone(result) });
        return result;
      } finally { capsule?.fill(0); keyBytes?.fill(0); plain?.fill(0); }
    });
  }
  close() {
    return this.#run(() => { this.#core.free(); this.#outbox.clear(); this.#inbox.clear(); this.#bundles.clear(); this.#sessions.clear(); this.#application = {}; this.#public.fill(0); this.#closed = true; });
  }
  pendingReceived() {
    return this.#run(() => {
      if (this.#poisoned) throw Error('Storage outcome uncertain: close and reopen before reading deliveries');
      return [...this.#inbox].map(([id, record]) => ({ id, ...structuredClone(record) }));
    });
  }
  acknowledgeReceived(id) {
    if (binary(id, 32).length !== 32) throw Error('Invalid incoming delivery id');
    return this.#mutate(() => this.#inbox.delete(id));
  }
  releaseOutgoing(conversationId, messageId) {
    return this.#mutate(() => {
      for (const [id, record] of this.#outbox) {
        if (record.envelope.context.conversationId === conversationId && record.envelope.context.messageId === messageId) this.#outbox.delete(id);
      }
    });
  }
  async #persistentState() {
    return { v: 3, suite: this.#suite, scope: this.#scope, core: await this.#core.exportPrivateStateForEncryption(), outbox: [...this.#outbox], inbox: [...this.#inbox], bundles: [...this.#bundles], application: this.#application };
  }
  #mutate(action) {
    return this.#run(async () => {
      if (this.#poisoned) throw Error('Storage outcome uncertain: close and reopen before retrying');
      const token = this.#core.checkpoint(), previousOutbox = new Map(this.#outbox), previousInbox = new Map(this.#inbox), previousBundles = new Map(this.#bundles), previousApplication = this.#application, previousSessions = new Set(this.#sessions);
      try {
        const result = await action();
        if (this.#storage) {
          const state = await this.#persistentState();
          try { this.#revision = await this.#storage.commit(this.#scope, this.#revision, state); }
          catch (error) { this.#poisoned = true; throw error; }
        }
        this.#core.commit(token);
        return result;
      } catch (error) {
        this.#core.rollback(token); this.#outbox = previousOutbox; this.#inbox = previousInbox; this.#bundles = previousBundles; this.#application = previousApplication; this.#sessions = previousSessions;
        throw error;
      }
    });
  }
  #run(action) {
    const operation = this.#queue.then(() => {
      if (this.#closed) throw Error('Laboratory device is closed');
      return action();
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
