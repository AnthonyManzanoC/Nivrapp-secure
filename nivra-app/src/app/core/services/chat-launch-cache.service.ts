import { Injectable, inject } from '@angular/core';
import { Contact, Conversation } from '../models/nivra.models';
import { NativeSecureVaultService } from './native-secure-vault.service';

/** A small, encrypted display cache. The local history database remains authoritative. */
export interface ChatLaunchSnapshot {
  conversations: Conversation[];
  contacts: Contact[];
  previews: Record<string, string>;
}

interface ChatLaunchEnvelope {
  v: 1;
  alg: 'NIVRA-CHAT-LAUNCH-HKDF-A256GCM';
  iv: string;
  ciphertext: string;
}

const STORAGE_PREFIX = 'nivra.chatLaunchCache.v1.';
const ENVELOPE_ALGORITHM = 'NIVRA-CHAT-LAUNCH-HKDF-A256GCM';
const KEY_SALT = new TextEncoder().encode('Nivra chat launch cache HKDF-SHA256 v1');
const MAX_CONVERSATIONS = 250;
const MAX_CONTACTS = 400;
const MAX_PREVIEWS = 250;
const MAX_PREVIEW_LENGTH = 280;
const MAX_ITEM_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_ENVELOPE_LENGTH = 3 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class ChatLaunchCacheService {
  private readonly secureVault = inject(NativeSecureVaultService);
  private readonly generations = new Map<string, number>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  async load(userId: string): Promise<ChatLaunchSnapshot | null> {
    if (!this.available(userId)) return null;
    const generation = this.generation(userId);
    let stored: string | null;
    try {
      stored = localStorage.getItem(this.storageKey(userId));
    } catch {
      return null;
    }
    if (!stored || stored.length > MAX_ENVELOPE_LENGTH) return null;

    try {
      const envelope = JSON.parse(stored) as ChatLaunchEnvelope;
      if (envelope?.v !== 1 || envelope.alg !== ENVELOPE_ALGORITHM
        || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') return null;
      const iv = this.fromBase64(envelope.iv);
      const ciphertext = this.fromBase64(envelope.ciphertext);
      if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_SNAPSHOT_BYTES + 16) return null;
      const key = await this.deriveKey(userId);
      if (!key || this.generation(userId) !== generation) return null;
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.toArrayBuffer(iv), additionalData: this.associatedData(userId) },
        key,
        this.toArrayBuffer(ciphertext),
      );
      if (this.generation(userId) !== generation || plaintext.byteLength > MAX_SNAPSHOT_BYTES) return null;
      const parsed = JSON.parse(this.decoder.decode(plaintext)) as unknown;
      return this.validSnapshot(parsed) ? parsed : null;
    } catch {
      // Keep the envelope: a temporary Keystore or bridge failure can recover later.
      return null;
    }
  }

  async save(userId: string, snapshot: ChatLaunchSnapshot): Promise<void> {
    if (!this.available(userId)) return;
    // A newer save or logout invalidates this write even if encryption finishes later.
    const generation = this.bumpGeneration(userId);
    try {
      const bounded = this.boundedSnapshot(snapshot);
      const plaintext = this.encoder.encode(JSON.stringify(bounded));
      if (plaintext.byteLength > MAX_SNAPSHOT_BYTES) return;
      const key = await this.deriveKey(userId);
      if (!key || this.generation(userId) !== generation) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: this.toArrayBuffer(iv), additionalData: this.associatedData(userId) },
        key,
        plaintext,
      );
      if (this.generation(userId) !== generation) return;
      const envelope: ChatLaunchEnvelope = {
        v: 1,
        alg: ENVELOPE_ALGORITHM,
        iv: this.toBase64(iv),
        ciphertext: this.toBase64(new Uint8Array(ciphertext)),
      };
      localStorage.setItem(this.storageKey(userId), JSON.stringify(envelope));
    } catch {
      // Storage quota and secure-vault failures must never block chat or sign-out.
    }
  }

  clear(userId: string): void {
    if (!userId) return;
    this.bumpGeneration(userId);
    try {
      localStorage.removeItem(this.storageKey(userId));
    } catch {
      // Best effort if storage is temporarily unavailable.
    }
  }

  private available(userId: string): boolean {
    return Boolean(userId && this.secureVault.requiresProtection()
      && typeof localStorage !== 'undefined' && globalThis.crypto?.subtle);
  }

  private async deriveKey(userId: string): Promise<CryptoKey | null> {
    const secret = await this.secureVault.getOrCreateSecret('auth-session').catch(() => null);
    if (!secret) return null;
    const raw = this.fromBase64(secret);
    if (raw.length !== 32) return null;
    const material = await crypto.subtle.importKey('raw', this.toArrayBuffer(raw), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: KEY_SALT,
        info: this.encoder.encode(`chat-list-snapshot/v1/${userId}`),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private associatedData(userId: string): ArrayBuffer {
    return this.toArrayBuffer(this.encoder.encode(`${ENVELOPE_ALGORITHM}|${userId}`));
  }

  private boundedSnapshot(snapshot: ChatLaunchSnapshot): ChatLaunchSnapshot {
    const bounded: ChatLaunchSnapshot = { conversations: [], contacts: [], previews: {} };
    let remaining = MAX_SNAPSHOT_BYTES - 512;
    for (const item of (Array.isArray(snapshot.conversations) ? snapshot.conversations : []).slice(0, MAX_CONVERSATIONS)) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      const size = this.jsonBytes(item);
      if (size === 0 || size > MAX_ITEM_BYTES || size > remaining) continue;
      bounded.conversations.push(item);
      remaining -= size;
    }
    for (const item of (Array.isArray(snapshot.contacts) ? snapshot.contacts : []).slice(0, MAX_CONTACTS)) {
      if (!item || typeof item.userId !== 'string' || !item.userId) continue;
      const size = this.jsonBytes(item);
      if (size === 0 || size > MAX_ITEM_BYTES || size > remaining) continue;
      bounded.contacts.push(item);
      remaining -= size;
    }
    const includedIds = new Set(bounded.conversations.map((item) => item.id));
    let previewCount = 0;
    for (const [id, value] of Object.entries(snapshot.previews || {})) {
      if (previewCount >= MAX_PREVIEWS || !includedIds.has(id) || typeof value !== 'string') continue;
      const preview = value.slice(0, MAX_PREVIEW_LENGTH);
      const size = this.jsonBytes([id, preview]);
      if (size === 0 || size > remaining) continue;
      bounded.previews[id] = preview;
      remaining -= size;
      previewCount += 1;
    }
    return bounded;
  }

  private validSnapshot(value: unknown): value is ChatLaunchSnapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Partial<ChatLaunchSnapshot>;
    return Array.isArray(snapshot.conversations)
      && snapshot.conversations.length <= MAX_CONVERSATIONS
      && snapshot.conversations.every((item) => item && typeof item.id === 'string')
      && Array.isArray(snapshot.contacts)
      && snapshot.contacts.length <= MAX_CONTACTS
      && snapshot.contacts.every((item) => item && typeof item.userId === 'string')
      && snapshot.previews !== null && typeof snapshot.previews === 'object'
      && !Array.isArray(snapshot.previews)
      && Object.entries(snapshot.previews).length <= MAX_PREVIEWS
      && Object.values(snapshot.previews).every((preview) => typeof preview === 'string' && preview.length <= MAX_PREVIEW_LENGTH);
  }

  private jsonBytes(value: unknown): number {
    try {
      const serialized = JSON.stringify(value);
      return serialized ? this.encoder.encode(serialized).byteLength : 0;
    } catch {
      return 0;
    }
  }

  private storageKey(userId: string): string {
    return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`;
  }

  private generation(userId: string): number {
    return this.generations.get(userId) ?? 0;
  }

  private bumpGeneration(userId: string): number {
    const next = this.generation(userId) + 1;
    this.generations.set(userId, next);
    return next;
  }

  private toBase64(value: Uint8Array): string {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  private fromBase64(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }

  private toArrayBuffer(value: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(value);
    return buffer;
  }
}
