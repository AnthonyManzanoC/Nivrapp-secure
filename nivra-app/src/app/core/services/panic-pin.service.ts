import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from './auth.service';

const textEncoder = new TextEncoder();
const PANIC_PIN_STORAGE_PREFIX = 'nivra.panicPin.v1';
const PANIC_PIN_ITERATIONS = 240000;

interface PanicPinRecord {
  v: 1;
  alg: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class PanicPinService {
  private readonly auth = inject(AuthService);
  private readonly record = signal<PanicPinRecord | null>(null);

  readonly isConfigured = computed(() => Boolean(this.record()));

  constructor() {
    effect(() => {
      const accountKey = this.currentAccountKey();
      untracked(() => this.record.set(accountKey ? this.readRecord(accountKey) : null));
    });
  }

  async configure(pin: string): Promise<void> {
    const accountKey = this.requireAccountKey();
    const normalized = this.normalizePin(pin);
    if (!this.isValidPin(normalized)) {
      throw new Error('El PIN de panico debe tener de 4 a 6 digitos.');
    }

    const now = new Date().toISOString();
    const previous = this.record();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const record: PanicPinRecord = {
      v: 1,
      alg: 'PBKDF2-SHA256',
      iterations: PANIC_PIN_ITERATIONS,
      salt: this.b64(salt),
      hash: await this.hashPin(normalized, accountKey, salt, PANIC_PIN_ITERATIONS),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    localStorage.setItem(this.storageKey(accountKey), JSON.stringify(record));
    this.record.set(record);
  }

  clear(): void {
    const accountKey = this.currentAccountKey();
    if (accountKey) {
      localStorage.removeItem(this.storageKey(accountKey));
    }
    this.record.set(null);
  }

  async matches(pin: string): Promise<boolean> {
    const accountKey = this.currentAccountKey();
    const record = this.record();
    const normalized = this.normalizePin(pin);
    if (!accountKey || !record || !this.isValidPin(normalized)) {
      return false;
    }

    try {
      const candidate = await this.hashPin(normalized, accountKey, this.ub64(record.salt), record.iterations || PANIC_PIN_ITERATIONS);
      return this.constantTimeEqual(this.ub64(candidate), this.ub64(record.hash));
    } catch {
      return false;
    }
  }

  normalizePin(value: string | number | null | undefined): string {
    return String(value ?? '').trim();
  }

  isValidPin(pin: string): boolean {
    return /^\d{4,6}$/.test(pin);
  }

  private async hashPin(pin: string, accountKey: string, salt: Uint8Array, iterations: number): Promise<string> {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(`nivra-panic-pin:v1:${accountKey}:${pin}`),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: this.toArrayBuffer(salt), iterations, hash: 'SHA-256' },
      baseKey,
      256,
    );
    return this.b64(new Uint8Array(bits));
  }

  private readRecord(accountKey: string): PanicPinRecord | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.storageKey(accountKey)) || 'null') as PanicPinRecord | null;
      if (parsed?.v !== 1 || parsed.alg !== 'PBKDF2-SHA256' || !parsed.salt || !parsed.hash) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private requireAccountKey(): string {
    const accountKey = this.currentAccountKey();
    if (!accountKey) {
      throw new Error('Inicia sesion antes de configurar el PIN de panico.');
    }
    return accountKey;
  }

  private currentAccountKey(): string {
    const user = this.auth.session()?.user;
    return user?.id || user?.alias || '';
  }

  private storageKey(accountKey: string): string {
    return `${PANIC_PIN_STORAGE_PREFIX}.${accountKey}`;
  }

  private constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) {
      return false;
    }
    let diff = 0;
    for (let index = 0; index < left.length; index += 1) {
      diff |= left[index] ^ right[index];
    }
    return diff === 0;
  }

  private b64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  private ub64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
