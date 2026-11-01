import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import {
  IdentityKeyStore, IdentityChange, IdentityKeyPair, PrivateKey, PublicKey, ProtocolAddress,
  PreKeyRecord, SignedPreKeyRecord, KyberPreKeyRecord, KEMKeyPair, PreKeyBundle, SessionRecord,
  processPreKeyBundle, signalEncrypt, signalDecrypt, signalDecryptPreKey,
  SignalMessage, PreKeySignalMessage, CiphertextMessageType,
} from '@signalapp/libsignal-client';

export const SUITE = 'NIVRA-LIBSIGNAL-A256GCM-PILOT-1';
const hash = bytes => createHash('sha256').update(bytes).digest('base64');
const copyMap = map => new Map([...map].map(([key, value]) => [key, Buffer.from(value)]));

/** Local laboratory only. Optional encrypted persistence does not provide
 * a browser/native bridge or a reviewed device-credential/directory protocol. */
export class PilotDevice extends IdentityKeyStore {
  #identity = IdentityKeyPair.generate();
  #registration = randomInt(1, 16380);
  #sessions = new Map();
  #trusted = new Map();
  #prekeys = new Map();
  #signed = new Map();
  #kyber = new Map();
  #usedKyber = new Map();
  #outbox = new Map();
  #prekeyId = 0;
  #queue = Promise.resolve();
  #storage = null;
  #revision = 0;
  #scope;

  constructor(userId, deviceId = 1) {
    super();
    this.address = ProtocolAddress.new(userId, deviceId);
    this.#scope = JSON.stringify([userId, deviceId]);
  }

  static async open(userId, deviceId, storage) {
    const device = new PilotDevice(userId, deviceId);
    device.#storage = storage;
    const saved = await storage.read(device.#scope);
    if (saved) {
      device.#restoreState(saved.state);
      device.#revision = saved.revision;
    } else {
      device.#revision = await storage.commit(device.#scope, 0, device.#persistentState());
    }
    return device;
  }

  get publicIdentity() { return this.#identity.publicKey; }
  async pinIdentity(address, publicKey) {
    return this.#transaction(async () => {
      const previous = this.#trusted.get(address.toString());
      if (previous && !PublicKey.deserialize(previous).equals(publicKey)) throw new Error('Identity changed: explicit re-verification required');
      this.#replace(this.#trusted, address.toString(), publicKey.serialize());
    });
  }
  async getIdentityKey() { return this.#identity.privateKey; }
  async getLocalRegistrationId() { return this.#registration; }
  async getIdentity(address) {
    const key = this.#trusted.get(address.toString());
    return key ? PublicKey.deserialize(key) : null;
  }
  async isTrustedIdentity(address, key) { return (await this.getIdentity(address))?.equals(key) ?? false; }
  async saveIdentity(address, key) {
    if (!await this.isTrustedIdentity(address, key)) throw new Error('Unverified identity');
    return IdentityChange.NewOrUnchanged;
  }
  async saveSession(address, record) { this.#replace(this.#sessions, address.toString(), record.serialize()); }
  async getSession(address) {
    const bytes = this.#sessions.get(address.toString());
    return bytes ? SessionRecord.deserialize(bytes) : null;
  }
  async getExistingSessions(addresses) {
    return Promise.all(addresses.map(async address => {
      const record = await this.getSession(address);
      if (!record) throw new Error('Missing ratchet session');
      return record;
    }));
  }
  async savePreKey(id, record) { this.#replace(this.#prekeys, id, record.serialize()); }
  async getPreKey(id) { return PreKeyRecord.deserialize(this.#required(this.#prekeys, id)); }
  async removePreKey(id) { this.#prekeys.get(id)?.fill(0); this.#prekeys.delete(id); }
  async saveSignedPreKey(id, record) { this.#replace(this.#signed, id, record.serialize()); }
  async getSignedPreKey(id) { return SignedPreKeyRecord.deserialize(this.#required(this.#signed, id)); }
  async saveKyberPreKey(id, record) { this.#replace(this.#kyber, id, record.serialize()); }
  async getKyberPreKey(id) { return KyberPreKeyRecord.deserialize(this.#required(this.#kyber, id)); }
  async markKyberPreKeyUsed(id, signedId, baseKey) {
    const use = `${id}:${signedId}:${Buffer.from(baseKey.serialize()).toString('base64')}`;
    if (this.#usedKyber.has(use)) throw new Error('Reused prekey');
    this.#usedKyber.set(use, Buffer.of(1));
  }
  #required(map, id) {
    const value = map.get(id);
    if (!value) throw new Error('Missing prekey');
    return value;
  }
  #replace(map, id, bytes) {
    const next = Buffer.from(bytes);
    map.get(id)?.fill(0);
    map.set(id, next);
  }

  async bundle() {
    return this.#transaction(async () => {
    if (this.#prekeyId >= 2147483647) throw new Error('Prekey identifiers exhausted');
    const id = ++this.#prekeyId;
    const oneTime = PrivateKey.generate();
    const signed = PrivateKey.generate();
    const kem = KEMKeyPair.generate();
    const signature = this.#identity.privateKey.sign(signed.getPublicKey().serialize());
    const kemSignature = this.#identity.privateKey.sign(kem.getPublicKey().serialize());
    await this.savePreKey(id, PreKeyRecord.new(id, oneTime.getPublicKey(), oneTime));
    await this.saveSignedPreKey(id, SignedPreKeyRecord.new(id, Date.now(), signed.getPublicKey(), signed, signature));
    await this.saveKyberPreKey(id, KyberPreKeyRecord.new(id, Date.now(), kem, kemSignature));
    return PreKeyBundle.new(this.#registration, this.address.deviceId(), id, oneTime.getPublicKey(),
      id, signed.getPublicKey(), signature, this.publicIdentity, id, kem.getPublicKey(), kemSignature);
    });
  }

  async establish(peer, bundle) {
    return this.#transaction(() => processPreKeyBundle(bundle, peer, this.address, this, this));
  }

  async encrypt(peer, context, payload) {
    const aad = contextBytes(context, this.address, peer);
    const plaintext = Buffer.from(JSON.stringify(payload));
    if (plaintext.length > 1024 * 1024) { plaintext.fill(0); throw new Error('Message too large'); }
    const requestHash = hash(Buffer.concat([aad, plaintext]));
    const id = hash(aad);
    try {
      return await this.#transaction(async () => {
        const queued = this.#outbox.get(id);
        if (queued) {
          if (queued.requestHash !== requestHash) throw new Error('Message ID reused with different content');
          return structuredClone(queued.envelope);
        }
        if (this.#outbox.size >= 256) throw new Error('Pilot outbox full');
        const key = randomBytes(32);
        const iv = randomBytes(12);
        let capsule;
        try {
          const aes = createCipheriv('aes-256-gcm', key, iv);
          aes.setAAD(aad);
          const encrypted = Buffer.concat([aes.update(plaintext), aes.final(), aes.getAuthTag()]);
          capsule = Buffer.from(JSON.stringify({ key: key.toString('base64'), contextHash: hash(aad), payloadHash: hash(encrypted) }));
          const ratchet = await signalEncrypt(capsule, peer, this.address, this, this);
          const envelope = {
            v: 3, suite: SUITE, context: JSON.parse(aad.toString()).context,
            type: ratchet.type(), keyMessage: Buffer.from(ratchet.serialize()).toString('base64'),
            iv: iv.toString('base64'), ciphertext: encrypted.toString('base64'),
          };
          // The state advance and exact retry bytes commit together.
          this.#outbox.set(id, { requestHash, envelope });
          return structuredClone(envelope);
        } finally { key.fill(0); capsule?.fill(0); }
      });
    } finally { plaintext.fill(0); }
  }

  async decrypt(peer, expectedContext, envelope) {
    if (envelope?.v !== 3 || envelope.suite !== SUITE) throw new Error('Unsupported protocol: no legacy fallback');
    const aad = contextBytes(expectedContext, peer, this.address);
    if (JSON.stringify(envelope.context) !== JSON.stringify(JSON.parse(aad.toString()).context)) throw new Error('Wrong message context');
    const iv = decode(envelope.iv, 12);
    if (iv.length !== 12) throw new Error('Invalid nonce');
    const payload = decode(envelope.ciphertext, 1024 * 1024 + 16);
    if (payload.length < 16) throw new Error('Truncated ciphertext');
    const ratchetBytes = decode(envelope.keyMessage, 128 * 1024);
    return this.#transaction(async () => {
      let capsule;
      let key;
      let plain;
      try {
        if (envelope.type === CiphertextMessageType.PreKey) {
          capsule = Buffer.from(await signalDecryptPreKey(PreKeySignalMessage.deserialize(ratchetBytes), peer, this.address, this, this, this, this, this));
        } else if (envelope.type === CiphertextMessageType.Whisper) {
          capsule = Buffer.from(await signalDecrypt(SignalMessage.deserialize(ratchetBytes), peer, this.address, this, this));
        } else throw new Error('Invalid ratchet message type');
        const metadata = JSON.parse(capsule.toString());
        if (metadata.contextHash !== hash(aad) || metadata.payloadHash !== hash(payload)) throw new Error('Message binding failed');
        key = decode(metadata.key, 32);
        if (key.length !== 32) throw new Error('Invalid content key');
        const aes = createDecipheriv('aes-256-gcm', key, iv);
        aes.setAAD(aad);
        aes.setAuthTag(payload.subarray(-16));
        plain = Buffer.concat([aes.update(payload.subarray(0, -16)), aes.final()]);
        return JSON.parse(plain.toString());
      } finally { key?.fill(0); capsule?.fill(0); plain?.fill(0); }
    });
  }

  #transaction(action) {
    const operation = this.#queue.then(async () => {
      const snapshot = [this.#sessions, this.#prekeys, this.#signed, this.#kyber, this.#usedKyber, this.#trusted].map(copyMap);
      const prekeyId = this.#prekeyId;
      const outbox = new Map(this.#outbox);
      try {
        const result = await action();
        if (this.#storage) this.#revision = await this.#storage.commit(this.#scope, this.#revision, this.#persistentState());
        for (const map of snapshot) for (const value of map.values()) value.fill(0);
        return result;
      } catch (error) {
        for (const map of [this.#sessions, this.#prekeys, this.#signed, this.#kyber, this.#usedKyber, this.#trusted]) for (const value of map.values()) value.fill(0);
        [this.#sessions, this.#prekeys, this.#signed, this.#kyber, this.#usedKyber, this.#trusted] = snapshot;
        this.#prekeyId = prekeyId;
        this.#outbox = outbox;
        throw error;
      }
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  #persistentState() {
    return { v: 1, scope: this.#scope, identity: Buffer.from(this.#identity.serialize()).toString('base64'),
      registration: this.#registration, prekeyId: this.#prekeyId,
      maps: [this.#sessions, this.#prekeys, this.#signed, this.#kyber, this.#usedKyber, this.#trusted]
        .map(map => [...map].map(([key, bytes]) => [key, bytes.toString('base64')])),
      outbox: [...this.#outbox] };
  }
  #restoreState(state) {
    if (state?.v !== 1 || state.scope !== this.#scope || !Array.isArray(state.maps) || state.maps.length !== 6
      || !Number.isInteger(state.registration) || state.registration < 1 || state.registration >= 16380
      || !Number.isInteger(state.prekeyId) || state.prekeyId < 0 || state.prekeyId > 2147483647
      || !Array.isArray(state.outbox) || state.outbox.length > 256) throw new Error('Invalid stored pilot state');
    this.#identity = IdentityKeyPair.deserialize(decode(state.identity, 1024));
    this.#registration = state.registration;
    this.#prekeyId = state.prekeyId;
    [this.#sessions, this.#prekeys, this.#signed, this.#kyber, this.#usedKyber, this.#trusted] = state.maps.map(entries => {
      if (!Array.isArray(entries) || entries.length > 10000) throw new Error('Pilot state bounds exceeded');
      return new Map(entries.map(([key, value]) => [key, decode(value, 2 * 1024 * 1024)]));
    });
    this.#outbox = new Map(state.outbox);
  }
}

function contextBytes(context, sender, recipient) {
  for (const key of ['conversationId', 'messageId']) {
    if (typeof context?.[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(context[key])) throw new Error('Invalid message context');
  }
  return Buffer.from(JSON.stringify({ suite: SUITE, context: {
    conversationId: context.conversationId, messageId: context.messageId,
    sender: sender.toString(), recipient: recipient.toString(),
  } }));
}
function decode(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid binary encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new Error('Binary value too large');
  return bytes;
}
