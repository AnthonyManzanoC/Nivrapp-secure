// Experimental WebCrypto composition, isolated from all production clients.
// Memory-only: no durable acceptance, key vault or device directory is implied.
export const SUITE = 'NIVRA-LIBSIGNAL-A256GCM-PILOT-1';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_PAYLOAD = 1024 * 1024;
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
function contextBytes(context, sender, recipient) {
  for (const key of ['conversationId', 'messageId']) {
    if (typeof context?.[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(context[key])) throw Error('Invalid message context');
  }
  return encoder.encode(JSON.stringify({ suite: SUITE, context: {
    conversationId: context.conversationId, messageId: context.messageId,
    sender: `${sender.name}.${sender.device}`, recipient: `${recipient.name}.${recipient.device}`,
  } }));
}
const hash = async bytes => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

export class LabWebDevice {
  #core;
  #address;
  #public;
  #queue = Promise.resolve();
  #outbox = new Map();
  #closed = false;

  constructor(bridge, name, device = 1) {
    this.#address = peerAddress({ name, device });
    const identity = bridge.createIdentity();
    try {
      this.#public = bridge.identityPublic(identity);
      // Rejection sampling avoids a biased registration number.
      const value = new Uint16Array(1);
      do { crypto.getRandomValues(value); } while (value[0] >= 65516);
      this.#core = new bridge.RatchetDevice(name, device, identity, value[0] % 16379 + 1);
    } finally { identity.fill(0); }
  }
  get publicIdentity() { return this.#public.slice(); }
  get address() { return { ...this.#address }; }
  pinIdentity(peer, publicKey) {
    peer = peerAddress(peer); const key = new Uint8Array(publicKey);
    return this.#run(() => this.#core.pinIdentity(peer.name, peer.device, key));
  }
  bundle() { return this.#run(async () => JSON.parse(await this.#core.preKeyBundle(Date.now()))); }
  establish(peer, bundle) {
    peer = peerAddress(peer); const encoded = JSON.stringify(bundle);
    return this.#run(() => this.#core.establish(peer.name, peer.device, encoded, Date.now()));
  }
  encrypt(peer, context, payload) {
    peer = peerAddress(peer);
    const aad = contextBytes(context, this.#address, peer);
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== 'string') throw Error('Payload must be JSON');
    const plain = encoder.encode(serialized);
    if (plain.length > MAX_PAYLOAD) { plain.fill(0); return Promise.reject(Error('Message too large')); }
    return this.#run(async () => {
      let keyBytes, capsule; let token;
      try {
        const id = await hash(aad), requestHash = await hash(encoder.encode(JSON.stringify([b64(aad), b64(plain)])));
        const previous = this.#outbox.get(id);
        if (previous) {
          if (previous.requestHash !== requestHash) throw Error('Message ID reused with different content');
          return structuredClone(previous.envelope);
        }
        if (this.#outbox.size >= 256) throw Error('Laboratory outbox full');
        keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain));
        capsule = encoder.encode(JSON.stringify({ key: b64(keyBytes), contextHash: id, payloadHash: await hash(ciphertext) }));
        token = this.#core.checkpoint();
        const packet = JSON.parse(await this.#core.encrypt(peer.name, peer.device, capsule, Date.now()));
        const envelope = { v: 3, suite: SUITE, context: JSON.parse(decoder.decode(aad)).context,
          type: packet.type, keyMessage: packet.bytes, iv: b64(iv), ciphertext: b64(ciphertext) };
        const result = structuredClone(envelope);
        this.#core.commit(token); token = undefined;
        this.#outbox.set(id, { requestHash, envelope });
        return result;
      } catch (error) {
        if (token !== undefined) this.#core.rollback(token);
        throw error;
      } finally { plain.fill(0); keyBytes?.fill(0); capsule?.fill(0); }
    }).finally(() => plain.fill(0));
  }
  decrypt(peer, context, envelope) {
    peer = peerAddress(peer);
    const aad = contextBytes(context, peer, this.#address);
    // Snapshot caller input before the first asynchronous operation.
    envelope = structuredClone(envelope);
    return this.#run(async () => {
      if (envelope?.v !== 3 || envelope.suite !== SUITE || ![2, 3].includes(envelope.type)) throw Error('Unsupported protocol: no legacy fallback');
      if (JSON.stringify(envelope.context) !== JSON.stringify(JSON.parse(decoder.decode(aad)).context)) throw Error('Wrong message context');
      const iv = binary(envelope.iv, 12), payload = binary(envelope.ciphertext, MAX_PAYLOAD + 16);
      if (iv.length !== 12 || payload.length < 16) throw Error('Invalid encrypted payload');
      const ratchet = binary(envelope.keyMessage, 131072);
      const token = this.#core.checkpoint();
      let capsule, keyBytes, plain;
      try {
        capsule = await this.#core.decrypt(peer.name, peer.device, envelope.type, ratchet);
        const metadata = JSON.parse(decoder.decode(capsule));
        if (metadata.contextHash !== await hash(aad) || metadata.payloadHash !== await hash(payload)) throw Error('Message binding failed');
        keyBytes = binary(metadata.key, 32);
        if (keyBytes.length !== 32) throw Error('Invalid content key');
        const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, payload));
        const result = JSON.parse(decoder.decode(plain));
        this.#core.commit(token);
        return result;
      } catch (error) { this.#core.rollback(token); throw error; }
      finally { capsule?.fill(0); keyBytes?.fill(0); plain?.fill(0); }
    });
  }
  close() {
    return this.#run(() => { this.#core.free(); this.#outbox.clear(); this.#public.fill(0); this.#closed = true; });
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
