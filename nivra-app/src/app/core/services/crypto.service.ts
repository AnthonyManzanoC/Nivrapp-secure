import { Injectable } from '@angular/core';
import { IDBPDatabase, openDB } from 'idb';
import {
  DeviceKeys,
  KeyBundle,
  RecipientCipherRequest,
  StoredDeviceKeys,
} from '../models/nivra.models';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const LOCAL_DB_NAME = 'NivraDB';
const LOCAL_DB_VERSION = 12;
const LOCAL_MESSAGE_STORE = 'messages';
const LOCAL_KEY_STORE = 'deviceKeys';
const LOCAL_PROFILE_STORE = 'profilesStore';
const LOCAL_VAULT_KEY_STORE = 'localVaultKeys';
const LOCAL_CONVERSATION_STORE = 'conversations';
const LOCAL_CONTACT_STORE = 'contacts';
const LOCAL_SYNC_STORE = 'syncWatermarks';
const LOCAL_CALL_STORE = 'calls';
const LOCAL_STORY_STORE = 'stories';

interface QrEphemeralKeys {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  publicSpki: string;
}

export interface PublicKeyRecipient {
  userId: string;
  deviceId: string;
  publicJwk: JsonWebKey;
}

@Injectable({ providedIn: 'root' })
export class CryptoService {
  private dbPromise?: Promise<IDBPDatabase>;

  async prepareDeviceKeys(alias?: string | null, registration = false): Promise<DeviceKeys> {
    if (!registration) {
      const existing = alias ? await this.latestDeviceKeysForAlias(alias) : await this.latestDeviceKeys();
      if (existing) {
        return this.materialToDeviceKeys(existing);
      }
    }

    return this.createDeviceKeys();
  }

  async createDeviceKeys(): Promise<DeviceKeys> {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return this.materialToDeviceKeys({ publicJwk, privateJwk });
  }

  materialToDeviceKeys(material: Pick<DeviceKeys, 'publicJwk' | 'privateJwk'>): DeviceKeys {
    const keyBundle: KeyBundle = {
      identityKey: JSON.stringify(material.publicJwk),
      signedPreKey: JSON.stringify(material.publicJwk),
      preKeySignature: 'webcrypto-p256',
      oneTimePreKeys: [],
    };

    return {
      publicJwk: material.publicJwk,
      privateJwk: material.privateJwk,
      keyBundle,
    };
  }

  async saveDeviceKeys(
    alias: string,
    deviceId: string,
    keys: DeviceKeys,
    metadata: { userId?: string } = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    const record: StoredDeviceKeys = {
      ...keys,
      ...metadata,
      id: this.deviceKeyStorageId(alias, deviceId),
      alias,
      aliasLower: this.normalizeAlias(alias),
      deviceId,
      createdAt: now,
      updatedAt: now,
    };
    const db = await this.open();
    await db.put(LOCAL_KEY_STORE, record);
    localStorage.removeItem(`nivra.keys.${alias}.${deviceId}`);
  }

  async getDeviceKeys(alias: string, deviceId: string): Promise<StoredDeviceKeys | null> {
    const db = await this.open();
    const indexed = await db.get(LOCAL_KEY_STORE, this.deviceKeyStorageId(alias, deviceId)) as StoredDeviceKeys | undefined;
    if (indexed) {
      return indexed;
    }

    const legacy = this.loadJson<Pick<DeviceKeys, 'publicJwk' | 'privateJwk'>>(`nivra.keys.${alias}.${deviceId}`);
    if (!legacy?.privateJwk || !legacy.publicJwk) {
      return null;
    }

    await this.saveDeviceKeys(alias, deviceId, this.materialToDeviceKeys(legacy));
    localStorage.removeItem(`nivra.keys.${alias}.${deviceId}`);
    return this.getDeviceKeys(alias, deviceId);
  }

  async closeLocalStore(): Promise<void> {
    const db = await this.dbPromise?.catch(() => null);
    db?.close();
    this.dbPromise = undefined;
  }

  async currentKeyMaterial(alias: string, deviceId: string): Promise<StoredDeviceKeys> {
    const keys = await this.getDeviceKeys(alias, deviceId);
    if (!keys) {
      throw new Error('No hay llave privada local para cifrar.');
    }
    return keys;
  }

  parsePublicJwk(value: unknown): JsonWebKey | null {
    if (!value) {
      return null;
    }
    if (typeof value === 'object' && value !== null && 'kty' in value) {
      return value as JsonWebKey;
    }
    try {
      const parsed = JSON.parse(String(value)) as JsonWebKey;
      return parsed?.kty ? parsed : null;
    } catch {
      return null;
    }
  }

  async encryptForPublicKey(
    own: StoredDeviceKeys,
    publicJwk: JsonWebKey,
    payload: unknown,
  ): Promise<Pick<RecipientCipherRequest, 'ciphertext' | 'header'>> {
    await this.yieldToMainThread();
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      own.privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey'],
    );
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: publicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      textEncoder.encode(JSON.stringify(payload)),
    );

    return {
      ciphertext: this.b64(new Uint8Array(ciphertext)),
      header: JSON.stringify({
        v: 1,
        alg: 'ECDH-P256-A256GCM',
        senderPublicKey: own.publicJwk,
        iv: this.b64(iv),
      }),
    };
  }

  async encryptGroupPayloadForRecipients(
    own: StoredDeviceKeys,
    recipients: PublicKeyRecipient[],
    payload: unknown,
    fileObjectId: string | null = null,
  ): Promise<RecipientCipherRequest[]> {
    await this.yieldToMainThread();
    const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawContentKey = new Uint8Array(await crypto.subtle.exportKey('raw', contentKey));
    const payloadIv = crypto.getRandomValues(new Uint8Array(12));
    const payloadCiphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: payloadIv },
      contentKey,
      textEncoder.encode(JSON.stringify(payload)),
    );
    const unique = new Map<string, PublicKeyRecipient>();
    recipients
      .filter((recipient) => recipient.userId && recipient.deviceId && recipient.publicJwk)
      .forEach((recipient) => unique.set(`${recipient.userId}:${recipient.deviceId}`, recipient));

    const sealedRecipients: RecipientCipherRequest[] = [];
    for (const recipient of unique.values()) {
      const sealedKey = await this.encryptForPublicKey(own, recipient.publicJwk, {
        type: 'group-sender-key',
        alg: 'A256GCM',
        key: this.b64(rawContentKey),
      });
      sealedRecipients.push({
        userId: recipient.userId,
        deviceId: recipient.deviceId,
        ciphertext: sealedKey.ciphertext,
        header: JSON.stringify({
          v: 2,
          alg: 'NIVRA-GROUP-A256GCM',
          keyHeader: sealedKey.header,
          payloadIv: this.b64(payloadIv),
          payloadCiphertext: this.b64(new Uint8Array(payloadCiphertext)),
        }),
        fileObjectId,
      });
    }
    rawContentKey.fill(0);
    return sealedRecipients;
  }

  async decryptEnvelope<T>(own: StoredDeviceKeys, header: string | null | undefined, ciphertext: string): Promise<T> {
    await this.yieldToMainThread();
    const meta = JSON.parse(header || '{}') as {
      v?: number;
      alg?: string;
      senderPublicKey?: JsonWebKey;
      iv?: string;
      keyHeader?: string;
      payloadIv?: string;
      payloadCiphertext?: string;
    };
    if (meta.v === 2 && meta.alg === 'NIVRA-GROUP-A256GCM') {
      return this.decryptGroupEnvelope<T>(own, meta, ciphertext);
    }
    return this.decryptEcdhEnvelope<T>(own, meta, ciphertext);
  }

  private async decryptEcdhEnvelope<T>(
    own: StoredDeviceKeys,
    meta: { senderPublicKey?: JsonWebKey; iv?: string },
    ciphertext: string,
  ): Promise<T> {
    if (!meta.senderPublicKey || !meta.iv) {
      throw new Error('Sobre cifrado invalido.');
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      own.privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey'],
    );
    const senderPublic = await crypto.subtle.importKey(
      'jwk',
      meta.senderPublicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: senderPublic },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.ub64Buffer(meta.iv) },
      key,
      this.ub64Buffer(ciphertext),
    );
    return JSON.parse(textDecoder.decode(plain)) as T;
  }

  private async decryptGroupEnvelope<T>(
    own: StoredDeviceKeys,
    meta: { keyHeader?: string; payloadIv?: string; payloadCiphertext?: string },
    sealedKeyCiphertext: string,
  ): Promise<T> {
    if (!meta.keyHeader || !meta.payloadIv || !meta.payloadCiphertext) {
      throw new Error('Sobre de grupo invalido.');
    }
    const keyPackage = await this.decryptEnvelope<{ type?: string; key?: string }>(own, meta.keyHeader, sealedKeyCiphertext);
    if (keyPackage.type !== 'group-sender-key' || !keyPackage.key) {
      throw new Error('Llave de grupo invalida.');
    }
    const key = await crypto.subtle.importKey('raw', this.ub64Buffer(keyPackage.key), { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.ub64Buffer(meta.payloadIv) },
      key,
      this.ub64Buffer(meta.payloadCiphertext),
    );
    return JSON.parse(textDecoder.decode(plain)) as T;
  }

  async createQrEphemeralKeys(): Promise<QrEphemeralKeys> {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['wrapKey', 'unwrapKey'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const publicSpki = this.b64url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
    return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, publicSpki };
  }

  async encryptQrPayload(publicMaterial: unknown, payload: unknown): Promise<string> {
    const publicKey = await this.importQrEncryptionPublicKey(publicMaterial);
    const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, textEncoder.encode(JSON.stringify(payload)));
    const wrappedKey = await crypto.subtle.wrapKey('raw', contentKey, publicKey, { name: 'RSA-OAEP' });
    return this.base64UrlJson({
      v: 1,
      alg: 'RSA-OAEP-256+A256GCM',
      key: this.b64(new Uint8Array(wrappedKey)),
      iv: this.b64(iv),
      ciphertext: this.b64(new Uint8Array(ciphertext)),
    });
  }

  async decryptQrPayload<T>(encryptedPayload: string, privateKey: CryptoKey): Promise<T> {
    const envelope = encryptedPayload.trim().startsWith('{')
      ? JSON.parse(encryptedPayload) as { key: string; iv: string; ciphertext: string }
      : this.jsonFromBase64Url<{ key: string; iv: string; ciphertext: string }>(encryptedPayload);
    const contentKey = await crypto.subtle.unwrapKey(
      'raw',
      this.ub64Buffer(envelope.key),
      privateKey,
      { name: 'RSA-OAEP' },
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.ub64Buffer(envelope.iv) },
      contentKey,
      this.ub64Buffer(envelope.ciphertext),
    );
    return JSON.parse(textDecoder.decode(plain)) as T;
  }

  async encryptAttachment(buffer: ArrayBuffer): Promise<{ bytes: ArrayBuffer; key: string; iv: string }> {
    await this.yieldToMainThread();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
    const rawKey = await crypto.subtle.exportKey('raw', key);
    return {
      bytes: encrypted,
      key: this.b64(new Uint8Array(rawKey)),
      iv: this.b64(iv),
    };
  }

  async decryptAttachment(buffer: ArrayBuffer, rawKey: string, iv: string): Promise<ArrayBuffer> {
    await this.yieldToMainThread();
    const key = await crypto.subtle.importKey('raw', this.ub64Buffer(rawKey), { name: 'AES-GCM' }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.ub64Buffer(iv) }, key, buffer);
  }

  async deriveVaultKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
    await this.yieldToMainThread();
    const baseKey = await crypto.subtle.importKey('raw', textEncoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: this.toArrayBuffer(salt), iterations: 210000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async encryptWithKey(key: CryptoKey, value: unknown): Promise<{ iv: string; ciphertext: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(JSON.stringify(value)));
    return { iv: this.b64(iv), ciphertext: this.b64(new Uint8Array(ciphertext)) };
  }

  async decryptWithKey<T>(key: CryptoKey, envelope: { iv: string; ciphertext: string }): Promise<T> {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.ub64Buffer(envelope.iv) },
      key,
      this.ub64Buffer(envelope.ciphertext),
    );
    return JSON.parse(textDecoder.decode(plain)) as T;
  }

  async phoneContactHash(normalizedPhone: string): Promise<string> {
    return this.sha256Hex(`nivra-phone:v1:${normalizedPhone.trim()}`);
  }

  async sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  randomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  base64UrlJson(value: unknown): string {
    return this.b64url(textEncoder.encode(JSON.stringify(value)));
  }

  jsonFromBase64Url<T>(value: string): T {
    return JSON.parse(textDecoder.decode(this.ub64url(value))) as T;
  }

  b64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  ub64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private async latestDeviceKeysForAlias(alias: string): Promise<StoredDeviceKeys | null> {
    const db = await this.open();
    const keys = await db.getAllFromIndex(LOCAL_KEY_STORE, 'byAlias', this.normalizeAlias(alias)) as StoredDeviceKeys[];
    return this.latestKeyRecord(keys);
  }

  private async latestDeviceKeys(): Promise<StoredDeviceKeys | null> {
    const db = await this.open();
    const keys = await db.getAll(LOCAL_KEY_STORE) as StoredDeviceKeys[];
    return this.latestKeyRecord(keys);
  }

  private latestKeyRecord(records: StoredDeviceKeys[]): StoredDeviceKeys | null {
    return records
      .filter((record) => record.privateJwk && record.publicJwk)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] ?? null;
  }

  private async open(): Promise<IDBPDatabase> {
    this.dbPromise ??= openDB(LOCAL_DB_NAME, LOCAL_DB_VERSION, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        const messageStore = db.objectStoreNames.contains(LOCAL_MESSAGE_STORE)
          ? transaction.objectStore(LOCAL_MESSAGE_STORE)
          : db.createObjectStore(LOCAL_MESSAGE_STORE, { keyPath: 'key' });
        if (!messageStore.indexNames.contains('byAccount')) {
          messageStore.createIndex('byAccount', 'accountKey');
        }
        if (!messageStore.indexNames.contains('byConversation')) {
          messageStore.createIndex('byConversation', ['accountKey', 'conversationId']);
        }
        if (!messageStore.indexNames.contains('byConversationAt')) {
          messageStore.createIndex('byConversationAt', ['accountKey', 'conversationId', 'at']);
        }
        if (!messageStore.indexNames.contains('byExpiry')) {
          messageStore.createIndex('byExpiry', 'expiresAtMs');
        }
        if (!messageStore.indexNames.contains('byAccountExpiry')) {
          messageStore.createIndex('byAccountExpiry', ['accountKey', 'expiresAtMs']);
        }
        if (!messageStore.indexNames.contains('byAccountOpenedAt')) {
          messageStore.createIndex('byAccountOpenedAt', ['accountKey', 'openedAtMs']);
        }

        const localVaultKeyStore = db.objectStoreNames.contains(LOCAL_VAULT_KEY_STORE)
          ? transaction.objectStore(LOCAL_VAULT_KEY_STORE)
          : db.createObjectStore(LOCAL_VAULT_KEY_STORE, { keyPath: 'accountKey' });
        if (!localVaultKeyStore.indexNames.contains('byCreated')) {
          localVaultKeyStore.createIndex('byCreated', 'createdAt');
        }

        const conversationStore = db.objectStoreNames.contains(LOCAL_CONVERSATION_STORE)
          ? transaction.objectStore(LOCAL_CONVERSATION_STORE)
          : db.createObjectStore(LOCAL_CONVERSATION_STORE, { keyPath: 'key' });
        if (!conversationStore.indexNames.contains('byAccount')) {
          conversationStore.createIndex('byAccount', 'accountKey');
        }
        if (!conversationStore.indexNames.contains('byAccountUpdated')) {
          conversationStore.createIndex('byAccountUpdated', ['accountKey', 'updatedAt']);
        }
        if (!conversationStore.indexNames.contains('byAccountType')) {
          conversationStore.createIndex('byAccountType', ['accountKey', 'type']);
        }

        const contactStore = db.objectStoreNames.contains(LOCAL_CONTACT_STORE)
          ? transaction.objectStore(LOCAL_CONTACT_STORE)
          : db.createObjectStore(LOCAL_CONTACT_STORE, { keyPath: 'key' });
        if (!contactStore.indexNames.contains('byAccount')) {
          contactStore.createIndex('byAccount', 'accountKey');
        }
        if (!contactStore.indexNames.contains('byAccountAlias')) {
          contactStore.createIndex('byAccountAlias', ['accountKey', 'alias']);
        }

        const syncStore = db.objectStoreNames.contains(LOCAL_SYNC_STORE)
          ? transaction.objectStore(LOCAL_SYNC_STORE)
          : db.createObjectStore(LOCAL_SYNC_STORE, { keyPath: 'accountKey' });
        if (!syncStore.indexNames.contains('byUpdated')) {
          syncStore.createIndex('byUpdated', 'updatedAt');
        }

        const callStore = db.objectStoreNames.contains(LOCAL_CALL_STORE)
          ? transaction.objectStore(LOCAL_CALL_STORE)
          : db.createObjectStore(LOCAL_CALL_STORE, { keyPath: 'key' });
        if (!callStore.indexNames.contains('byAccount')) {
          callStore.createIndex('byAccount', 'accountKey');
        }
        if (!callStore.indexNames.contains('byAccountStarted')) {
          callStore.createIndex('byAccountStarted', ['accountKey', 'startedAt']);
        }

        const storyStore = db.objectStoreNames.contains(LOCAL_STORY_STORE)
          ? transaction.objectStore(LOCAL_STORY_STORE)
          : db.createObjectStore(LOCAL_STORY_STORE, { keyPath: 'key' });
        if (!storyStore.indexNames.contains('byAccount')) {
          storyStore.createIndex('byAccount', 'accountKey');
        }
        if (!storyStore.indexNames.contains('byAccountTarget')) {
          storyStore.createIndex('byAccountTarget', ['accountKey', 'targetType', 'targetId']);
        }
        if (!storyStore.indexNames.contains('byAccountExpires')) {
          storyStore.createIndex('byAccountExpires', ['accountKey', 'expiresAt']);
        }

        if (!db.objectStoreNames.contains(LOCAL_KEY_STORE)) {
          const store = db.createObjectStore(LOCAL_KEY_STORE, { keyPath: 'id' });
          store.createIndex('byAlias', 'aliasLower');
          store.createIndex('byUser', 'userId');
          store.createIndex('byUpdated', 'updatedAt');
        } else {
          const store = transaction.objectStore(LOCAL_KEY_STORE);
          if (!store.indexNames.contains('byAlias')) {
            store.createIndex('byAlias', 'aliasLower');
          }
          if (!store.indexNames.contains('byUser')) {
            store.createIndex('byUser', 'userId');
          }
          if (!store.indexNames.contains('byUpdated')) {
            store.createIndex('byUpdated', 'updatedAt');
          }
        }

        const profileStore = db.objectStoreNames.contains(LOCAL_PROFILE_STORE)
          ? transaction.objectStore(LOCAL_PROFILE_STORE)
          : db.createObjectStore(LOCAL_PROFILE_STORE, { keyPath: 'userId' });
        if (!profileStore.indexNames.contains('byAlias')) {
          profileStore.createIndex('byAlias', 'aliasLower');
        }
        if (!profileStore.indexNames.contains('byUpdated')) {
          profileStore.createIndex('byUpdated', 'updatedAt');
        }
      },
    });
    return this.dbPromise;
  }

  private async importQrEncryptionPublicKey(publicMaterial: unknown): Promise<CryptoKey> {
    if (typeof publicMaterial === 'string') {
      return crypto.subtle.importKey('spki', this.ub64urlBuffer(publicMaterial), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
    }

    if (this.hasSpki(publicMaterial)) {
      return crypto.subtle.importKey('spki', this.ub64urlBuffer(publicMaterial.spki), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
    }

    return crypto.subtle.importKey('jwk', publicMaterial as JsonWebKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  }

  private hasSpki(value: unknown): value is { spki: string } {
    return typeof value === 'object' && value !== null && 'spki' in value && typeof (value as { spki?: unknown }).spki === 'string';
  }

  private b64url(bytes: Uint8Array): string {
    return this.b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private ub64url(value: string): Uint8Array {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    return this.ub64(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  }

  private ub64Buffer(value: string): ArrayBuffer {
    return this.toArrayBuffer(this.ub64(value));
  }

  private ub64urlBuffer(value: string): ArrayBuffer {
    return this.toArrayBuffer(this.ub64url(value));
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  private normalizeAlias(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  private deviceKeyStorageId(alias: string, deviceId: string): string {
    return `${this.normalizeAlias(alias)}:${deviceId}`;
  }

  private loadJson<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null') as T | null;
    } catch {
      return null;
    }
  }

  private yieldToMainThread(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
