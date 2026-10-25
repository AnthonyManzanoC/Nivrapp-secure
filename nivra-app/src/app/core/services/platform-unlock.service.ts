import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AndroidBiometryStrength, BiometricAuth } from '@aparajita/capacitor-biometric-auth';

export type PlatformUnlockKind = 'native-biometric' | 'platform-credential' | 'none';
export interface PlatformUnlockAvailability {
  available: boolean;
  enrolled: boolean;
  kind: PlatformUnlockKind;
  label: string;
  reason?: 'unsupported' | 'origin-unavailable' | 'not-enrolled' | 'unavailable';
}
interface WebContext { origin: string; rpId: string; }
interface PlatformCredentialRecord {
  v: 1;
  origin: string;
  rpId: string;
  accountBinding: string;
  id: string;
  publicKey: string;
  algorithm: -7 | -257;
  counter: number;
}
interface VerificationOperation { epoch: number; account: string; controller: AbortController; }

const PREFIX = 'nivra.platformUnlock.v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const LABEL = 'Verificación del dispositivo';
const FAILURE = 'No se pudo verificar tu identidad con el dispositivo. Puedes usar el PIN de tu cuenta.';

/**
 * Local OS verification only; account policy and its shared PIN live in AppLock.
 * No biometrics or private keys are collected, stored or sent by this service.
 * WebAuthn UV can mean the OS PIN or biometrics; it cannot identify the gesture.
 */
@Injectable({ providedIn: 'root' })
export class PlatformUnlockService {
  readonly lastError = signal('');
  private epoch = 0;
  private operation?: VerificationOperation;
  private nativePrompt?: Promise<void>;
  private readonly biometry = BiometricAuth;

  async availability(accountKey: string): Promise<PlatformUnlockAvailability> {
    if (!accountKey) return this.unavailable('unsupported');
    if (this.nativePlatform()) {
      try {
        const info = await this.biometry.checkBiometry();
        // Android biometryTypes describes hardware, including sensors which
        // apps cannot use or which have not been enrolled. Never claim a type.
        return { available: info.isAvailable === true, enrolled: info.isAvailable === true,
          kind: 'native-biometric', label: 'Biometría del dispositivo',
          ...(info.isAvailable ? {} : { reason: info.code === 'biometryNotEnrolled' ? 'not-enrolled' as const : 'unavailable' as const }) };
      } catch { return this.unavailable('unavailable'); }
    }
    const context = this.webContext();
    if (!context) return this.unavailable('origin-unavailable');
    if (!this.webApiAvailable()) return this.unavailable('unsupported');
    try {
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      const binding = await this.accountBinding(accountKey, context);
      return { available, enrolled: available && Boolean(this.readRecord(accountKey, context, binding)),
        kind: available ? 'platform-credential' : 'none', label: LABEL,
        ...(available ? {} : { reason: 'unavailable' as const }) };
    } catch { return this.unavailable('unavailable'); }
  }

  /** Explicit user action; caller authorizes enrollment with the account PIN. */
  async enroll(accountKey: string, displayName = 'Cuenta Nivra'): Promise<boolean> {
    const operation = this.begin(accountKey);
    try {
      const available = await this.availability(accountKey);
      this.assertCurrent(operation);
      if (!available.available) throw new Error(FAILURE);
      if (this.nativePlatform()) {
        await this.authenticateNative('Confirma tu identidad para activar el desbloqueo del dispositivo.');
        this.assertCurrent(operation);
        return true;
      }
      const context = this.webContext();
      if (!context) throw new Error(FAILURE);
      const binding = await this.accountBinding(accountKey, context);
      const previous = this.readRecord(accountKey, context, binding);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      this.assertCurrent(operation);
      const result = await this.credentials().create({ signal: operation.controller.signal, publicKey: {
        challenge: this.buffer(challenge), rp: { id: context.rpId, name: 'Nivra' },
        user: { id: this.buffer(this.decode(binding)), name: `cuenta-${binding.slice(0, 16)}`,
          displayName: displayName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Cuenta Nivra' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none', timeout: 60_000,
        ...(previous ? { excludeCredentials: [{ id: this.buffer(this.decode(previous.id)), type: 'public-key' as const, transports: ['internal' as const] }] } : {}),
      } });
      this.assertCurrent(operation);
      const credential = this.publicCredential(result);
      const response = credential.response as AuthenticatorAttestationResponse;
      if (typeof response.getPublicKey !== 'function' || typeof response.getAuthenticatorData !== 'function'
        || typeof response.getPublicKeyAlgorithm !== 'function') throw new Error(FAILURE);
      this.verifyClientData(response.clientDataJSON, 'webauthn.create', challenge, context);
      const data = new Uint8Array(response.getAuthenticatorData());
      const counter = await this.verifyAuthenticatorData(data, context);
      // Registration must include the attested credential ID matching rawId.
      if (!(data[32] & 0x40) || data.length < 55) throw new Error(FAILURE);
      const idLength = (data[53] << 8) | data[54];
      if (!idLength || idLength > 1024 || data.length < 55 + idLength
        || !this.equal(data.slice(55, 55 + idLength), new Uint8Array(credential.rawId))) throw new Error(FAILURE);
      const algorithm = response.getPublicKeyAlgorithm();
      const publicKey = response.getPublicKey();
      if ((algorithm !== -7 && algorithm !== -257) || !publicKey || publicKey.byteLength > 4096) throw new Error(FAILURE);
      // Import validates the SPKI and supported curve/key size before persisting.
      await this.importKey(publicKey, algorithm);
      this.assertCurrent(operation);
      localStorage.setItem(this.storageKey(accountKey), JSON.stringify({ v: 1, origin: context.origin,
        rpId: context.rpId, accountBinding: binding, id: this.encode(new Uint8Array(credential.rawId)),
        publicKey: this.encode(new Uint8Array(publicKey)), algorithm, counter } satisfies PlatformCredentialRecord));
      return true;
    } catch {
      if (this.isCurrent(operation)) this.lastError.set(FAILURE);
      return false;
    } finally { this.finish(operation); }
  }

  async verify(accountKey: string, reason = 'Desbloquear Nivra'): Promise<boolean> {
    const operation = this.begin(accountKey);
    try {
      if (this.nativePlatform()) {
        const info = await this.biometry.checkBiometry();
        this.assertCurrent(operation);
        if (!info.isAvailable) throw new Error(FAILURE);
        await this.authenticateNative(reason);
        this.assertCurrent(operation);
        return true;
      }
      const context = this.webContext();
      if (!context || !this.webApiAvailable()) throw new Error(FAILURE);
      const binding = await this.accountBinding(accountKey, context);
      const record = this.readRecord(accountKey, context, binding);
      if (!record) throw new Error(FAILURE);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      this.assertCurrent(operation);
      const result = await this.credentials().get({ signal: operation.controller.signal, mediation: 'required', publicKey: {
        challenge: this.buffer(challenge), rpId: context.rpId, timeout: 60_000, userVerification: 'required',
        allowCredentials: [{ id: this.buffer(this.decode(record.id)), type: 'public-key', transports: ['internal'] }],
      } });
      this.assertCurrent(operation);
      const credential = this.publicCredential(result);
      if (this.encode(new Uint8Array(credential.rawId)) !== record.id) throw new Error(FAILURE);
      const response = credential.response as AuthenticatorAssertionResponse;
      this.verifyClientData(response.clientDataJSON, 'webauthn.get', challenge, context);
      const data = new Uint8Array(response.authenticatorData);
      const counter = await this.verifyAuthenticatorData(data, context);
      if (response.userHandle && !this.equal(new Uint8Array(response.userHandle), this.decode(binding))) throw new Error(FAILURE);
      const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', response.clientDataJSON));
      const signed = new Uint8Array(data.length + clientHash.length);
      signed.set(data); signed.set(clientHash, data.length);
      const key = await this.importKey(this.buffer(this.decode(record.publicKey)), record.algorithm);
      const signature = record.algorithm === -7 ? this.ecdsaSignature(new Uint8Array(response.signature)) : new Uint8Array(response.signature);
      const valid = await crypto.subtle.verify(record.algorithm === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5',
        key, this.buffer(signature), this.buffer(signed));
      this.assertCurrent(operation);
      // Logout, forgetting/re-enrolling, or a newer assertion in another tab
      // must not accept or roll back the credential record read before a prompt.
      const current = this.readRecord(accountKey, context, binding);
      if (!valid || !current || current.id !== record.id || current.publicKey !== record.publicKey
        || current.algorithm !== record.algorithm || ((counter > 0 || current.counter > 0) && counter <= current.counter)) throw new Error(FAILURE);
      if (counter > current.counter) localStorage.setItem(this.storageKey(accountKey), JSON.stringify({ ...current, counter }));
      return true;
    } catch {
      if (this.isCurrent(operation)) this.lastError.set(FAILURE);
      return false;
    } finally { this.finish(operation); }
  }

  /**
   * Migration escape hatch ONLY for an old native biometric lock without an
   * account PIN. AppLock must never call this for a shared account policy.
   * Still requires a successful, interactive OS prompt on a secured device.
   */
  async verifyLegacyDeviceCredential(accountKey: string, reason = 'Desbloquear Nivra para actualizar Modo Seguro'): Promise<boolean> {
    const operation = this.begin(accountKey);
    try {
      if (!this.nativePlatform()) throw new Error(FAILURE);
      const info = await this.biometry.checkBiometry();
      this.assertCurrent(operation);
      if (info.deviceIsSecure !== true) throw new Error(FAILURE);
      await this.authenticateNative(reason, true);
      this.assertCurrent(operation);
      return true;
    } catch {
      if (this.isCurrent(operation)) this.lastError.set(FAILURE);
      return false;
    } finally { this.finish(operation); }
  }

  /** Forgets this browser binding; WebAuthn cannot delete an OS passkey. */
  forget(accountKey: string): void {
    if (this.operation?.account === accountKey) this.cancel();
    try { localStorage.removeItem(this.storageKey(accountKey)); } catch { this.lastError.set(FAILURE); }
  }

  cancel(): void {
    this.epoch++;
    this.operation?.controller.abort();
    this.operation = undefined;
    this.lastError.set('');
  }

  private nativePlatform(): boolean { return Capacitor.isNativePlatform() && ['android', 'ios'].includes(Capacitor.getPlatform()); }
  private credentials(): CredentialsContainer { return navigator.credentials; }

  private webContext(): WebContext | null {
    // The current Windows shell loads file://, which has no WebAuthn RP origin.
    // Do not advertise Windows Hello on that shell without a real native bridge.
    if (!window.isSecureContext || !crypto?.subtle) return null;
    const url = new URL(window.location.href);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))
      || !url.hostname || /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.includes(':')) return null;
    return { origin: url.origin, rpId: url.hostname };
  }

  private webApiAvailable(): boolean {
    return typeof PublicKeyCredential !== 'undefined'
      && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
      && typeof navigator.credentials?.create === 'function' && typeof navigator.credentials?.get === 'function'
      && typeof AuthenticatorAttestationResponse !== 'undefined'
      && typeof AuthenticatorAttestationResponse.prototype.getPublicKey === 'function';
  }

  private unavailable(reason: PlatformUnlockAvailability['reason']): PlatformUnlockAvailability {
    return { available: false, enrolled: false, kind: 'none', label: LABEL, reason };
  }

  private begin(account: string): VerificationOperation {
    this.cancel();
    const operation = { epoch: this.epoch, account, controller: new AbortController() };
    this.operation = operation;
    return operation;
  }
  private isCurrent(operation: VerificationOperation): boolean { return Boolean(operation.account) && operation === this.operation && operation.epoch === this.epoch; }
  private assertCurrent(operation: VerificationOperation): void { if (!this.isCurrent(operation)) throw new Error(FAILURE); }
  private finish(operation: VerificationOperation): void { if (this.operation === operation) this.operation = undefined; }

  private async authenticateNative(reason: string, legacyDeviceCredential = false): Promise<void> {
    // The plugin cannot cancel an already open native prompt. Keep it exclusive,
    // and let the operation generation reject its result after logout/account change.
    if (this.nativePrompt) throw new Error(FAILURE);
    const prompt = this.biometry.authenticate({ reason, androidTitle: 'Nivra bloqueado', androidSubtitle: reason,
      cancelTitle: legacyDeviceCredential ? 'Cancelar' : 'Usar PIN de la cuenta',
      iosFallbackTitle: legacyDeviceCredential ? 'Usar código del dispositivo' : '', allowDeviceCredential: legacyDeviceCredential,
      androidBiometryStrength: AndroidBiometryStrength.weak, androidConfirmationRequired: true });
    this.nativePrompt = prompt;
    try { await prompt; } finally { if (this.nativePrompt === prompt) this.nativePrompt = undefined; }
  }

  private async accountBinding(account: string, context: WebContext): Promise<string> {
    return this.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`nivra-platform-unlock:v1:${context.origin}:${account}`))));
  }
  private storageKey(account: string): string { return `${PREFIX}${encodeURIComponent(window.location.origin)}:${encodeURIComponent(account)}`; }

  private readRecord(account: string, context: WebContext, binding: string): PlatformCredentialRecord | null {
    try {
      const raw = localStorage.getItem(this.storageKey(account));
      if (!raw || raw.length > 12_000) return null;
      const value = JSON.parse(raw) as PlatformCredentialRecord;
      if (value.v !== 1 || value.origin !== context.origin || value.rpId !== context.rpId || value.accountBinding !== binding
        || ![-7, -257].includes(value.algorithm) || !Number.isSafeInteger(value.counter) || value.counter < 0 || value.counter > 0xffffffff
        || typeof value.id !== 'string' || !value.id || value.id.length > 1400
        || typeof value.publicKey !== 'string' || !value.publicKey || value.publicKey.length > 5500) return null;
      this.decode(value.id); this.decode(value.publicKey);
      return value;
    } catch { return null; }
  }

  private publicCredential(result: Credential | null): PublicKeyCredential {
    const value = result as PublicKeyCredential | null;
    if (!value || value.type !== 'public-key' || !(value.rawId instanceof ArrayBuffer) || !value.rawId.byteLength
      || value.rawId.byteLength > 1024 || value.id !== this.encode(new Uint8Array(value.rawId))
      || (value.authenticatorAttachment && value.authenticatorAttachment !== 'platform')) throw new Error(FAILURE);
    return value;
  }

  private verifyClientData(buffer: ArrayBuffer, type: string, challenge: Uint8Array, context: WebContext): void {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > 16_384) throw new Error(FAILURE);
    const data = JSON.parse(decoder.decode(buffer));
    if (data.type !== type || data.challenge !== this.encode(challenge) || data.origin !== context.origin || data.crossOrigin === true) throw new Error(FAILURE);
  }

  private async verifyAuthenticatorData(data: Uint8Array, context: WebContext): Promise<number> {
    if (data.length < 37 || data.length > 65_536 || (data[32] & 0x05) !== 0x05
      || ((data[32] & 0x10) !== 0 && (data[32] & 0x08) === 0)) throw new Error(FAILURE);
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(context.rpId)));
    if (!this.equal(data.slice(0, 32), rpHash)) throw new Error(FAILURE);
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(33, false);
  }

  private async importKey(spki: ArrayBuffer, algorithm: -7 | -257): Promise<CryptoKey> {
    const key = await crypto.subtle.importKey('spki', spki, algorithm === -7 ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (algorithm === -257 && (key.algorithm as RsaHashedKeyAlgorithm).modulusLength < 2048) throw new Error(FAILURE);
    return key;
  }

  /** WebAuthn ECDSA uses DER; WebCrypto verify requires fixed-size r || s. */
  private ecdsaSignature(der: Uint8Array): Uint8Array {
    if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error(FAILURE);
    const raw = new Uint8Array(64);
    let offset = 2;
    for (let part = 0; part < 2; part++) {
      if (der[offset++] !== 0x02) throw new Error(FAILURE);
      const length = der[offset++];
      if (length < 1 || length > 33 || offset + length > der.length || (der[offset] & 0x80)) throw new Error(FAILURE);
      const value = der.slice(offset, offset + length); offset += length;
      if (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) throw new Error(FAILURE);
      const unsigned = value[0] === 0 ? value.slice(1) : value;
      if (unsigned.length > 32) throw new Error(FAILURE);
      raw.set(unsigned, part * 32 + 32 - unsigned.length);
    }
    if (offset !== der.length) throw new Error(FAILURE);
    return raw;
  }

  private equal(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    return difference === 0;
  }
  private buffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; }
  private encode(value: Uint8Array): string {
    let binary = ''; for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  private decode(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error(FAILURE);
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    if (this.encode(bytes) !== value) throw new Error(FAILURE);
    return bytes;
  }
}
