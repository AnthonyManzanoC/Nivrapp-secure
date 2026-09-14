import { Injectable, InjectionToken, inject } from '@angular/core';
import { BaseKeyProvider, createKeyMaterialFromBuffer, isE2EESupported, type Room, type RoomOptions } from 'livekit-client';
import { CallSession } from '../models/nivra.models';

export const GROUP_MEDIA_ENCRYPTION = 'livekit-e2ee-v1';
export type MediaKeySignalType = 'media-key-request' | 'media-key' | 'media-key-ready';
export type SendEncryptedMediaSignal = (targetUserId: string, type: MediaKeySignalType, payload: unknown) => Promise<unknown>;

export interface GroupEncryptionContext {
  encryption: NonNullable<RoomOptions['encryption']>;
  enable(room: Pick<Room, 'setE2EEEnabled' | 'isE2EEEnabled'>): Promise<void>;
  dispose(): void;
}

export interface GroupCryptoPlatform {
  supported(): boolean;
  createWorker(): Worker;
  handshakeTimeoutMs: number;
}

export const GROUP_CRYPTO_PLATFORM = new InjectionToken<GroupCryptoPlatform>('GROUP_CRYPTO_PLATFORM', {
  providedIn: 'root',
  factory: () => ({
    supported: () => typeof Worker !== 'undefined' && typeof crypto?.subtle !== 'undefined' && isE2EESupported(),
    // Copied unchanged from the installed SDK by angular.json; no CDN or remote code is loaded.
    createWorker: () => new Worker(new URL('assets/crypto/nivra-e2ee.worker.js', document.baseURI)),
    handshakeTimeoutMs: 15_000,
  }),
});

class PublisherKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, keySize: 256, keyringSize: 1, ratchetWindowSize: 0, failureTolerance: -1 });
  }
  async install(userId: string, rawKey: Uint8Array): Promise<void> {
    const key = await createKeyMaterialFromBuffer(rawKey.slice().buffer);
    this.onSetEncryptionKey(key, userId, 0);
  }
}

interface PublisherKey {
  raw: Uint8Array;
  revision: number;
  keyId: string;
  session: string;
}
interface ContextRecord { provider: PublisherKeyProvider; worker: Worker; disposed: boolean; }
interface CryptoState {
  call: CallSession;
  localUserId: string;
  localSession: string;
  fingerprint: string;
  local: PublisherKey;
  remote: Map<string, PublisherKey>;
  ready: Set<string>;
  contexts: Set<ContextRecord>;
  send: SendEncryptedMediaSignal;
  disposed: boolean;
  queue: Promise<void>;
  wake: Set<() => void>;
}
interface KeyMessage {
  v: 1;
  callId: string;
  senderSession: string;
  recipientSession: string;
  revision?: number;
  keyId?: string;
  key?: string;
}
interface PendingSignal { fromUserId: string; type: MediaKeySignalType; payload: unknown; }

/** Uses the SDK's media cryptography. Key distribution is encrypted by the existing device channel. */
@Injectable({ providedIn: 'root' })
export class GroupCallCryptoService {
  private readonly platform = inject(GROUP_CRYPTO_PLATFORM);
  private readonly states = new Map<string, CryptoState>();
  private readonly pending = new Map<string, PendingSignal[]>();

  supported(): boolean { return this.platform.supported(); }
  isMediaKeySignal(type: string): type is MediaKeySignalType {
    return type === 'media-key' || type === 'media-key-ready' || type === 'media-key-request';
  }

  async prepare(call: CallSession, localUserId: string, send: SendEncryptedMediaSignal): Promise<GroupEncryptionContext> {
    if (call.mediaEncryption !== GROUP_MEDIA_ENCRYPTION) throw new Error('Esta sala requiere una llamada nueva con cifrado grupal actualizado.');
    if (!this.supported()) throw new Error('Este navegador no admite cifrado de llamadas grupales. Actualiza el navegador o usa un dispositivo compatible.');
    const localSession = this.sessionFor(call, localUserId);
    if (!localSession) throw new Error('Confirma primero esta sesión de llamada.');
    let state = this.states.get(call.id);
    if (state && state.localSession !== localSession) { this.clear(call.id); state = undefined; }
    if (!state) {
      state = {
        call, localUserId, localSession, fingerprint: this.rosterFingerprint(call),
        local: this.newKey(localSession, 1), remote: new Map(), ready: new Set(), contexts: new Set(),
        send, disposed: false, queue: Promise.resolve(), wake: new Set(),
      };
      this.states.set(call.id, state);
    }
    state.send = send;
    await this.updateRoster(call);
    const active = state;
    const worker = this.platform.createWorker();
    const record: ContextRecord = { provider: new PublisherKeyProvider(), worker, disposed: false };
    state.contexts.add(record);
    const dispose = () => {
      if (record.disposed) return;
      record.disposed = true;
      record.worker.terminate();
      record.provider.removeAllListeners();
      active.contexts.delete(record);
    };
    try {
      await record.provider.install(localUserId, state.local.raw);
      for (const [userId, key] of state.remote) await record.provider.install(userId, key.raw);
      const buffered = this.pending.get(call.id) ?? [];
      this.pending.delete(call.id);
      for (const item of buffered) await this.handleSignal(call, item.fromUserId, item.type, item.payload);
      await this.exchange(active);
      await this.awaitReady(active);
      if (active.disposed || record.disposed) throw new Error('La llamada se cerró durante el intercambio de claves.');
      return {
        encryption: { keyProvider: record.provider, worker },
        enable: async room => {
          if (active.disposed || record.disposed) throw new Error('La sesión de cifrado ya se cerró.');
          await room.setE2EEEnabled(true);
          const deadline = Date.now() + 5_000;
          while (!room.isE2EEEnabled && Date.now() < deadline && !active.disposed && !record.disposed) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (!room.isE2EEEnabled || active.disposed || record.disposed) throw new Error('No se pudo activar el cifrado. No se publicará audio ni video.');
        },
        dispose,
      };
    } catch (error) { dispose(); throw error; }
  }

  async updateRoster(call: CallSession): Promise<void> {
    const state = this.states.get(call.id);
    if (!state || state.disposed) return;
    if (this.sessionFor(call, state.localUserId) !== state.localSession || call.status === 'Ended' || call.endedAt) {
      this.clear(call.id);
      return;
    }
    const fingerprint = this.rosterFingerprint(call);
    if (fingerprint === state.fingerprint) { state.call = call; return; }
    await this.enqueue(state, async () => {
      if (state.disposed || fingerprint === state.fingerprint) return;
      state.call = call;
      state.fingerprint = fingerprint;
      for (const [userId, key] of state.remote) {
        if (this.sessionFor(call, userId) !== key.session) { key.raw.fill(0); state.remote.delete(userId); }
      }
      const previous = state.local;
      state.local = this.newKey(state.localSession, previous.revision + 1);
      previous.raw.fill(0);
      state.ready.clear();
      await this.install(state, state.localUserId, state.local.raw);
      this.notify(state);
    });
    await this.exchange(state);
  }

  /** The caller must first use decodeAuthenticatedMediaKeySignal; plaintext payloads are forbidden. */
  async handleSignal(call: CallSession, fromUserId: string, type: string, payload: unknown): Promise<boolean> {
    if (!this.isMediaKeySignal(type)) return false;
    if (call.mediaEncryption !== GROUP_MEDIA_ENCRYPTION || call.endedAt || call.status === 'Ended') return true;
    const state = this.states.get(call.id);
    if (!state) {
      const messages = this.pending.get(call.id) ?? [];
      if (this.pending.size < 20 && messages.length < 100) {
        messages.push({ fromUserId, type, payload }); this.pending.set(call.id, messages);
      }
      return true;
    }
    if (state.disposed || fromUserId === state.localUserId) return true;
    const message = payload as Partial<KeyMessage> | null;
    const senderSession = this.sessionFor(state.call, fromUserId);
    if (!message || message.v !== 1 || message.callId !== call.id || !senderSession ||
        message.senderSession !== senderSession || message.recipientSession !== state.localSession) return true;
    if (type === 'media-key-request') { await this.sendKey(state, fromUserId); return true; }
    if (type === 'media-key-ready') {
      if (message.revision === state.local.revision && message.keyId === state.local.keyId) {
        state.ready.add(fromUserId); this.notify(state);
      }
      return true;
    }
    if (!Number.isSafeInteger(message.revision) || Number(message.revision) < 1 ||
        typeof message.keyId !== 'string' || message.keyId.length > 128 || typeof message.key !== 'string') return true;
    const raw = this.decodeKey(message.key);
    if (!raw) return true;
    await this.enqueue(state, async () => {
      if (state.disposed) { raw.fill(0); return; }
      const previous = state.remote.get(fromUserId);
      if (previous?.session === senderSession && (previous.revision > message.revision! ||
          (previous.revision === message.revision && previous.keyId !== message.keyId))) { raw.fill(0); return; }
      if (!previous || previous.revision !== message.revision || previous.session !== senderSession) {
        await this.install(state, fromUserId, raw);
        previous?.raw.fill(0);
        state.remote.set(fromUserId, { raw, revision: message.revision!, keyId: message.keyId!, session: senderSession });
      } else { raw.fill(0); }
      this.notify(state);
    });
    const installed = state.remote.get(fromUserId);
    if (installed?.keyId === message.keyId && installed.revision === message.revision) {
      await state.send(fromUserId, 'media-key-ready', { ...this.baseMessage(state, fromUserId), keyId: installed.keyId, revision: installed.revision });
    }
    return true;
  }

  clear(callId: string): void {
    this.pending.delete(callId);
    const state = this.states.get(callId);
    if (!state) return;
    state.disposed = true;
    state.local.raw.fill(0);
    state.remote.forEach(key => key.raw.fill(0));
    state.remote.clear(); state.ready.clear();
    state.contexts.forEach(context => { context.disposed = true; context.worker.terminate(); context.provider.removeAllListeners(); });
    state.contexts.clear();
    this.states.delete(callId);
    this.notify(state);
  }

  private newKey(session: string, revision: number): PublisherKey {
    return { raw: crypto.getRandomValues(new Uint8Array(32)), revision, session, keyId: crypto.randomUUID() };
  }
  private sessionFor(call: CallSession, userId: string): string | null {
    const owner = call.participantSessions?.[userId];
    return owner?.deviceId && owner.clientSessionId ? `${owner.deviceId}:${owner.clientSessionId}` : null;
  }
  private rosterFingerprint(call: CallSession): string {
    return Object.keys(call.participantSessions ?? {}).sort().map(userId => `${userId}=${this.sessionFor(call, userId)}`).join('|');
  }
  private peers(state: CryptoState): string[] {
    return Object.keys(state.call.participantSessions ?? {}).filter(userId => userId !== state.localUserId && this.sessionFor(state.call, userId));
  }
  private baseMessage(state: CryptoState, target: string): KeyMessage {
    return { v: 1, callId: state.call.id, senderSession: state.localSession, recipientSession: this.sessionFor(state.call, target)! };
  }
  private async sendKey(state: CryptoState, target: string): Promise<void> {
    if (state.disposed || !this.sessionFor(state.call, target)) return;
    await state.send(target, 'media-key', {
      ...this.baseMessage(state, target), revision: state.local.revision, keyId: state.local.keyId,
      key: btoa(String.fromCharCode(...state.local.raw)),
    });
  }
  private async exchange(state: CryptoState): Promise<void> {
    if (state.disposed) return;
    await Promise.allSettled(this.peers(state).map(async userId => {
      await this.sendKey(state, userId);
      await state.send(userId, 'media-key-request', this.baseMessage(state, userId));
    }));
  }
  private async install(state: CryptoState, userId: string, raw: Uint8Array): Promise<void> {
    await Promise.all([...state.contexts].filter(item => !item.disposed).map(item => item.provider.install(userId, raw)));
  }
  private enqueue(state: CryptoState, action: () => Promise<void>): Promise<void> {
    const next = state.queue.then(action);
    state.queue = next.catch(() => undefined);
    return next;
  }
  private notify(state: CryptoState): void { state.wake.forEach(wake => wake()); }
  private awaitReady(state: CryptoState): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout); clearInterval(retry); state.wake.delete(check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (state.disposed) { finish(new Error('La llamada se cerró durante el intercambio de claves.')); return; }
        if (this.peers(state).every(userId => state.remote.get(userId)?.session === this.sessionFor(state.call, userId) && state.ready.has(userId))) finish();
      };
      const timeout = setTimeout(() => finish(new Error('No se confirmó el cifrado con todos los participantes. Actualiza sus dispositivos y vuelve a entrar; no se enviará audio sin cifrar.')), this.platform.handshakeTimeoutMs);
      const retry = setInterval(() => { void this.exchange(state); }, 2_000);
      state.wake.add(check); check();
    });
  }
  private decodeKey(value: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
    try { const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0)); return bytes.length === 32 ? bytes : null; } catch { return null; }
  }
}
