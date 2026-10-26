import { Injectable, InjectionToken, OnDestroy, inject, signal } from '@angular/core';
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { AuthSession, NivraUser } from '../models/nivra.models';
import { NativeSecureVaultService } from './native-secure-vault.service';

export interface AccountSessionsSnapshot {
  revision: number;
  activeUserId: string | null;
  sessions: AuthSession[];
}

export interface AccountSessionSummary {
  id: string;
  alias: string;
  displayName: string | null;
  profilePhotoDataUrl: string | null;
  nivraNumber?: string | null;
  isPrivateAccount?: boolean;
  active: boolean;
}

export const ACCOUNT_SESSIONS_DB_NAME = new InjectionToken<string>('AccountSessionsDatabaseName', {
  providedIn: 'root', factory: () => 'NivraAccountSessions',
});
export const ACCOUNT_SESSIONS_STORE = 'registry';
export const ACCOUNT_SESSIONS_SNAPSHOT_KEY = 'snapshot';
export const ACCOUNT_SESSIONS_WEB_KEY = 'web-key';
const MAX_ACCOUNTS = 2;
const MAX_BYTES = 8 * 1024 * 1024;
const READ_ERROR = 'No pudimos abrir las cuentas guardadas. Sus datos se han conservado. Desbloquea el dispositivo y vuelve a intentar.';
const INVALID_ERROR = 'No se pudo comprobar la identidad de la cuenta.';
const LIMIT_ERROR = 'Puedes guardar un máximo de dos cuentas en este dispositivo.';
const CONFLICT_ERROR = 'Las cuentas cambiaron en otra ventana. Vuelve a intentar.';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface Envelope {
  schema: 1;
  revision: number;
  protector: 'web' | 'secure';
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}
interface RegistryDatabase extends DBSchema {
  registry: { key: string; value: Envelope | CryptoKey };
}

/** Tokens are kept only inside one authenticated envelope. UI receives summaries. */
@Injectable({ providedIn: 'root' })
export class AccountSessionsService implements OnDestroy {
  private readonly vault = inject(NativeSecureVaultService);
  private readonly databaseName = inject(ACCOUNT_SESSIONS_DB_NAME);
  private readonly summaries = signal<readonly AccountSessionSummary[]>([]);
  readonly accounts = this.summaries.asReadonly();
  private database?: Promise<IDBPDatabase<RegistryDatabase>>;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: AccountSessionsSnapshot | null = null;
  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cached = null;
    this.summaries.set([]);
    void this.database?.then(database => database.close()).catch(() => undefined);
  }

  load(): Promise<AccountSessionsSnapshot | null> {
    return this.enqueue(async () => {
      if (this.destroyed) return null;
      const envelope = await this.readEnvelope();
      const snapshot = envelope === undefined ? null : await this.decrypt(envelope);
      return this.destroyed ? null : this.publish(snapshot);
    });
  }

  async upsert(session: AuthSession, activate = true, isCurrent: () => boolean = () => true): Promise<AccountSessionsSnapshot | null> {
    let frozen: AuthSession;
    try { frozen = this.copy(session); } catch { throw new Error(INVALID_ERROR); }
    if (!this.validSession(frozen)) throw new Error(INVALID_ERROR);
    return this.mutate(snapshot => {
      const existing = snapshot.sessions.findIndex(item => item.user.id === frozen.user.id);
      if (existing < 0) {
        if (snapshot.sessions.length >= MAX_ACCOUNTS) throw new Error(LIMIT_ERROR);
        snapshot.sessions.push(frozen);
      } else snapshot.sessions[existing] = frozen;
      if (activate || snapshot.activeUserId === null) snapshot.activeUserId = frozen.user.id;
      return snapshot;
    }, isCurrent);
  }

  updateProfile(user: NivraUser, deviceId: string, isCurrent: () => boolean): Promise<AccountSessionsSnapshot | null> {
    const profile = this.copy(user);
    return this.mutate(snapshot => {
      const existing = snapshot.sessions.find(session => session.user.id === profile.id && session.device.id === deviceId);
      if (!existing) return null;
      existing.user = profile;
      return snapshot;
    }, isCurrent);
  }

  rotateTokens(userId: string, deviceId: string, previousRefreshToken: string, tokens: AuthSession['tokens'], isCurrent: () => boolean): Promise<AccountSessionsSnapshot | null> {
    const replacement = this.copy(tokens);
    return this.mutate(snapshot => {
      const existing = snapshot.sessions.find(session => session.user.id === userId && session.device.id === deviceId
        && session.tokens.refreshToken === previousRefreshToken);
      if (!existing) return null;
      existing.tokens = { ...existing.tokens, ...replacement };
      return snapshot;
    }, isCurrent);
  }

  activate(userId: string, isCurrent: () => boolean = () => true, expectedDeviceId?: string): Promise<AccountSessionsSnapshot | null> {
    return this.mutate(snapshot => {
      if (!snapshot.sessions.some(session => session.user.id === userId && (!expectedDeviceId || session.device.id === expectedDeviceId))) return null;
      snapshot.activeUserId = userId;
      return snapshot;
    }, isCurrent);
  }

  remove(userId: string, isCurrent: () => boolean = () => true, expectedDeviceId?: string): Promise<AccountSessionsSnapshot | null> {
    return this.mutate(snapshot => {
      if (!snapshot.sessions.some(session => session.user.id === userId && (!expectedDeviceId || session.device.id === expectedDeviceId))) return null;
      snapshot.sessions = snapshot.sessions.filter(session => session.user.id !== userId);
      if (snapshot.activeUserId === userId) snapshot.activeUserId = snapshot.sessions[0]?.user.id ?? null;
      return snapshot;
    }, isCurrent);
  }

  private mutate(change: (snapshot: AccountSessionsSnapshot) => AccountSessionsSnapshot | null, guard: () => boolean): Promise<AccountSessionsSnapshot | null> {
    return this.enqueue(async () => {
      const current = () => !this.destroyed && guard();
      for (let attempt = 0; attempt < 16; attempt++) {
        if (!current()) return null;
        const previous = await this.readEnvelope();
        const snapshot = previous === undefined ? { revision: 0, activeUserId: null, sessions: [] } : await this.decrypt(previous);
        if (!current()) return null;
        const next = change(this.copy(snapshot));
        if (!next) return null;
        next.revision = snapshot.revision + 1;
        if (!this.validSnapshot(next)) throw new Error(INVALID_ERROR);
        const key = await this.protector(previous !== undefined);
        if (!current()) return null;
        const envelope = await this.encrypt(next, key);
        if (!current()) return null;
        const result = await this.commit(previous, envelope, current);
        if (result === 'stale') return null;
        if (result === 'committed') return current() ? this.publish(next) : null;
        // Another tab won the CAS. Read/decrypt its latest snapshot before merging.
      }
      throw new Error(CONFLICT_ERROR);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async open(): Promise<IDBPDatabase<RegistryDatabase>> {
    try {
      return await (this.database ??= openDB<RegistryDatabase>(this.databaseName, 1, {
        upgrade(database) { database.createObjectStore(ACCOUNT_SESSIONS_STORE); },
        blocking(_version, _next, event) { (event.target as IDBDatabase).close(); },
      }));
    } catch { this.database = undefined; throw new Error(READ_ERROR); }
  }

  private async readEnvelope(): Promise<Envelope | undefined> {
    try {
      const stored = await (await this.open()).get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
      if (stored === undefined) return undefined;
      if (!this.validEnvelope(stored)) throw new Error(READ_ERROR);
      return stored;
    } catch { throw new Error(READ_ERROR); }
  }

  private async protector(existing: boolean): Promise<CryptoKey> {
    try {
      if (this.vault.requiresProtection()) {
        let secret = await this.vault.getOrCreateSecret('auth-session', { create: false });
        if (!secret && !existing) {
          // Never replace a missing protector for ciphertext that appeared meanwhile.
          if (await this.readEnvelope() !== undefined) throw new Error(READ_ERROR);
          secret = await this.vault.getOrCreateSecret('auth-session');
        }
        if (!secret) throw new Error(READ_ERROR);
        const raw = Uint8Array.from(atob(secret), character => character.charCodeAt(0));
        if (raw.length !== 32) throw new Error(READ_ERROR);
        const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
        return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
          salt: encoder.encode('Nivra account sessions protector v1'), info: encoder.encode(this.scope()) },
        material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      }
      const db = await this.open();
      const retained = await db.get(ACCOUNT_SESSIONS_STORE, ACCOUNT_SESSIONS_WEB_KEY);
      if (retained !== undefined) return this.validateWebKey(retained);
      if (existing) throw new Error(READ_ERROR);
      const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      // Key generation is outside the transaction. All tabs adopt the first committed key.
      const transaction = db.transaction(ACCOUNT_SESSIONS_STORE, 'readwrite');
      const store = transaction.objectStore(ACCOUNT_SESSIONS_STORE);
      const [winner, envelope] = await Promise.all([store.get(ACCOUNT_SESSIONS_WEB_KEY), store.get(ACCOUNT_SESSIONS_SNAPSHOT_KEY)]);
      if (winner !== undefined) {
        await transaction.done;
        return this.validateWebKey(winner);
      }
      if (envelope !== undefined) { await transaction.done; throw new Error(READ_ERROR); }
      await store.put(candidate, ACCOUNT_SESSIONS_WEB_KEY);
      await transaction.done;
      return candidate;
    } catch { throw new Error(READ_ERROR); }
  }

  private validateWebKey(value: unknown): CryptoKey {
    if (!(value instanceof CryptoKey) || value.extractable || value.type !== 'secret'
      || value.algorithm.name !== 'AES-GCM' || (value.algorithm as AesKeyAlgorithm).length !== 256
      || !value.usages.includes('encrypt') || !value.usages.includes('decrypt')) throw new Error(READ_ERROR);
    return value;
  }

  private async encrypt(snapshot: AccountSessionsSnapshot, key: CryptoKey): Promise<Envelope> {
    try {
      const plain = encoder.encode(JSON.stringify(snapshot));
      if (plain.byteLength > MAX_BYTES) throw new Error(READ_ERROR);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(snapshot.revision) }, key, plain);
      return { schema: 1, revision: snapshot.revision, protector: this.vault.requiresProtection() ? 'secure' : 'web', iv, ciphertext };
    } catch { throw new Error(READ_ERROR); }
  }

  private async decrypt(envelope: Envelope): Promise<AccountSessionsSnapshot> {
    try {
      if (envelope.protector !== (this.vault.requiresProtection() ? 'secure' : 'web')) throw new Error(READ_ERROR);
      const key = await this.protector(true);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.buffer(envelope.iv), additionalData: this.aad(envelope.revision) }, key, envelope.ciphertext);
      const snapshot: unknown = JSON.parse(decoder.decode(plain));
      if (!this.validSnapshot(snapshot) || snapshot.revision !== envelope.revision) throw new Error(READ_ERROR);
      return snapshot;
    } catch { throw new Error(READ_ERROR); }
  }

  private async commit(previous: Envelope | undefined, next: Envelope, current: () => boolean): Promise<'committed' | 'conflict' | 'stale'> {
    const transaction = (await this.open()).transaction(ACCOUNT_SESSIONS_STORE, 'readwrite');
    try {
      const store = transaction.objectStore(ACCOUNT_SESSIONS_STORE);
      const actual = await store.get(ACCOUNT_SESSIONS_SNAPSHOT_KEY);
      if (!current()) { transaction.abort(); await transaction.done.catch(() => undefined); return 'stale'; }
      if (actual !== undefined && !this.validEnvelope(actual)) throw new Error(READ_ERROR);
      if ((actual as Envelope | undefined)?.revision !== previous?.revision) { await transaction.done; return 'conflict'; }
      await store.put(next, ACCOUNT_SESSIONS_SNAPSHOT_KEY);
      if (!current()) { transaction.abort(); await transaction.done.catch(() => undefined); return 'stale'; }
      await transaction.done;
      return 'committed';
    } catch { await transaction.done.catch(() => undefined); throw new Error(READ_ERROR); }
  }

  private validEnvelope(value: unknown): value is Envelope {
    const envelope = value as Envelope | undefined;
    return Boolean(envelope && envelope.schema === 1 && Number.isSafeInteger(envelope.revision) && envelope.revision > 0
      && (envelope.protector === 'web' || envelope.protector === 'secure') && envelope.iv instanceof Uint8Array
      && envelope.iv.byteLength === 12 && envelope.ciphertext instanceof ArrayBuffer
      && envelope.ciphertext.byteLength >= 16 && envelope.ciphertext.byteLength <= MAX_BYTES + 16);
  }

  private validSnapshot(value: unknown): value is AccountSessionsSnapshot {
    const snapshot = value as AccountSessionsSnapshot | undefined;
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
      || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > MAX_ACCOUNTS
      || !snapshot.sessions.every(session => this.validSession(session))) return false;
    const ids = snapshot.sessions.map(session => session.user.id);
    return new Set(ids).size === ids.length && (ids.length === 0 ? snapshot.activeUserId === null : ids.includes(snapshot.activeUserId ?? ''));
  }

  private validSession(value: unknown): value is AuthSession {
    const session = value as AuthSession | undefined;
    const id = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 256 && item.trim() === item;
    if (!session || !id(session.user?.id) || !id(session.device?.id) || !id(session.user?.alias)
      || session.device.userId != null && session.device.userId !== session.user.id
      || !id(session.tokens?.refreshToken) || typeof session.tokens?.accessToken !== 'string'
      || !session.tokens.accessToken.trim() || session.tokens.accessToken.length > 32768) return false;
    // This is an ownership consistency check, not client-side signature validation.
    // The API currently emits two-part JSON tokens; also support conventional JWTs.
    try {
      const parts = session.tokens.accessToken.split('.');
      if (parts.length !== 2 && parts.length !== 3) return true;
      const encoded = parts[parts.length === 2 ? 0 : 1].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))) as Record<string, unknown>;
      if (!claims || typeof claims !== 'object') return true;
      const userClaims = [claims['UserId'], claims['userId'], claims['sub']].filter(value => value != null);
      const deviceClaims = [claims['DeviceId'], claims['deviceId']].filter(value => value != null);
      return userClaims.every(value => value === session.user.id) && deviceClaims.every(value => value === session.device.id);
    } catch { return true; }
  }

  private publish(snapshot: AccountSessionsSnapshot | null): AccountSessionsSnapshot | null {
    if (snapshot && this.cached && snapshot.revision < this.cached.revision) return this.copy(this.cached);
    this.cached = snapshot ? this.copy(snapshot) : null;
    const summaries = (this.cached?.sessions ?? []).map(({ user }) => ({
      id: user.id, alias: user.alias, displayName: user.displayName ?? null,
      profilePhotoDataUrl: user.profilePhotoDataUrl ?? null, nivraNumber: user.nivraNumber,
      isPrivateAccount: user.isPrivateAccount, active: this.cached?.activeUserId === user.id,
    }));
    // Privileged readers load credentials from effects that observe summaries.
    // Identical reads/token rotations must not recursively retrigger those effects.
    if (JSON.stringify(summaries) !== JSON.stringify(this.summaries())) this.summaries.set(summaries);
    return this.cached ? this.copy(this.cached) : null;
  }

  private scope(): string { return JSON.stringify([globalThis.location?.origin ?? '', this.databaseName, 'account-sessions', 1]); }
  private aad(revision: number): ArrayBuffer { return this.buffer(encoder.encode(JSON.stringify([this.scope(), revision]))); }
  private buffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }
  private copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
}
