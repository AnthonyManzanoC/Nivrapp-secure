import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  AndroidBiometryStrength,
  BiometricAuth,
  BiometryError,
  BiometryErrorType,
  BiometryType,
  CheckBiometryResult,
} from '@aparajita/capacitor-biometric-auth';
import { AuthService } from './auth.service';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const APP_LOCK_STORAGE_PREFIX = 'nivra.appLock.v1';
const PIN_ITERATIONS = 240000;
const PIN_LENGTH = 4;
const PIN_ATTEMPTS_PREFIX = 'nivra.appLock.attempts.v1';
const MAX_PIN_RETRY_MS = 5 * 60 * 1000;

interface PinAttempts {
  failures: number;
  retryAt: number;
}

type AppLockMode = 'biometric' | 'pin';

interface PinEnvelope {
  v: 1;
  alg: 'PBKDF2-SHA256+A256GCM';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

interface AppLockSettings {
  enabled: boolean;
  mode: AppLockMode;
  createdAt: string;
  updatedAt: string;
  pin?: PinEnvelope;
}

interface PinVerifierPayload {
  type: 'nivra-app-lock-pin';
  accountKey: string;
  nonce: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class AppLockService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly settings = signal<AppLockSettings | null>(null);
  private bootLockAccountKey = '';
  private pinFailureCount = 0;
  private loadedAccountKey = '';
  private stateVersion = 0;
  private operationSequence = 0;
  private activeOperation = 0;
  private pinRetryAt = 0;
  private pinRetryTimer?: ReturnType<typeof setTimeout>;
  private readonly accountAttempts = new Map<string, PinAttempts>();

  readonly isNativePlatform = signal(Boolean(Capacitor.isNativePlatform?.()));
  readonly isLocked = signal(false);
  readonly busy = signal(false);
  readonly unlockError = signal('');
  readonly statusMessage = signal('');
  readonly biometryLabel = signal('biometria');
  readonly lockCycle = signal(0);
  readonly pinRetrySeconds = signal(0);
  readonly unlockMode = computed<AppLockMode>(() => this.settings()?.mode ?? (this.isNativePlatform() ? 'biometric' : 'pin'));
  readonly isEnabled = computed(() => Boolean(this.auth.isAuthenticated() && this.settings()?.enabled));

  constructor() {
    effect(() => {
      const accountKey = this.currentAccountKey();
      untracked(() => this.loadForAccount(accountKey));
    });
  }

  lock(): void {
    if (!this.isEnabled() || this.isLocked()) {
      return;
    }
    this.invalidateVerification();
    this.unlockError.set('');
    this.statusMessage.set(this.unlockMode() === 'biometric'
      ? 'Nivra esta bloqueado. Toca para desbloquear.'
      : 'Nivra esta bloqueado. Ingresa tu PIN.');
    this.isLocked.set(true);
    this.refreshPinRetry();
  }

  unlock(): void {
    this.invalidateVerification();
    this.pinFailureCount = 0;
    this.pinRetryAt = 0;
    this.persistPinAttempts(this.currentAccountKey());
    this.refreshPinRetry();
    this.unlockError.set('');
    this.statusMessage.set('');
    this.isLocked.set(false);
  }

  ngOnDestroy(): void {
    this.invalidateVerification();
    if (this.pinRetryTimer) clearTimeout(this.pinRetryTimer);
  }

  async enableMobileBiometrics(): Promise<void> {
    const accountKey = this.requireAccountKey();
    const version = this.stateVersion;
    if (!this.isNativePlatform()) {
      throw new Error('La biometria solo se activa dentro de la APK movil.');
    }

    const info = await this.checkBiometry();
    if (!info.isAvailable) {
      throw new Error(info.reason || 'Este telefono no tiene huella o reconocimiento facial configurado.');
    }

    this.requireUnchangedAccount(accountKey, version);
    await this.authenticateBiometrics('Confirma tu identidad para activar Modo Seguro.');
    this.requireUnchangedAccount(accountKey, version);
    this.saveSettings(accountKey, {
      enabled: true,
      mode: 'biometric',
      createdAt: this.settings()?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.bootLockAccountKey = accountKey;
    this.unlock();
  }

  async enableWebPin(pin: string): Promise<void> {
    const accountKey = this.requireAccountKey();
    const version = this.stateVersion;
    const normalized = this.normalizePin(pin);
    if (!this.isValidPin(normalized)) {
      throw new Error('El PIN debe tener exactamente 4 digitos.');
    }

    const envelope = await this.createPinEnvelope(normalized, accountKey);
    this.requireUnchangedAccount(accountKey, version);
    this.saveSettings(accountKey, {
      enabled: true,
      mode: 'pin',
      pin: envelope,
      createdAt: this.settings()?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.bootLockAccountKey = accountKey;
    this.unlock();
  }

  disable(): void {
    const accountKey = this.currentAccountKey();
    if (accountKey) {
      this.removeSettings(accountKey);
    }
    this.settings.set(null);
    this.bootLockAccountKey = accountKey;
    this.unlock();
  }

  async unlockWithBiometrics(): Promise<boolean> {
    if (!this.isLocked()) {
      return true;
    }
    if (this.busy()) return false;
    if (!this.isNativePlatform() || this.unlockMode() !== 'biometric') {
      this.unlockError.set('Esta sesion usa PIN, no biometria.');
      return false;
    }

    const accountKey = this.currentAccountKey();
    const version = this.stateVersion;
    const operation = this.beginVerification();
    this.unlockError.set('');
    this.statusMessage.set('Verificando identidad...');
    try {
      await this.authenticateBiometrics('Desbloquear Nivra');
      if (!this.isCurrentVerification(accountKey, version, operation)) return false;
      this.unlock();
      return true;
    } catch (error) {
      if (!this.isCurrentVerification(accountKey, version, operation)) return false;
      this.statusMessage.set('Nivra esta bloqueado. Toca para desbloquear.');
      this.unlockError.set(this.biometricErrorMessage(error, 'No se pudo desbloquear con biometria.'));
      return false;
    } finally {
      this.finishVerification(operation);
    }
  }

  async unlockWithPin(pin: string): Promise<boolean> {
    const normalized = this.normalizePin(pin);
    const accountKey = this.currentAccountKey();
    const pinEnvelope = this.settings()?.pin;
    if (!this.isLocked()) {
      return true;
    }
    if (this.busy()) return false;
    this.refreshPinRetry();
    if (this.pinRetrySeconds() > 0) return false;
    if (!accountKey || !pinEnvelope) {
      this.unlockError.set('Configura de nuevo el PIN de Modo Seguro.');
      return false;
    }

    if (!this.isValidPin(normalized)) return false;
    const version = this.stateVersion;
    const operation = this.beginVerification();
    this.unlockError.set('');
    this.statusMessage.set('Verificando PIN...');
    try {
      const valid = await this.verifyPinEnvelope(normalized, pinEnvelope, accountKey);
      if (!this.isCurrentVerification(accountKey, version, operation)) return false;
      if (!valid) {
        this.pinFailureCount = Math.min(1000, this.pinFailureCount + 1);
        if (this.pinFailureCount >= 5) {
          this.pinRetryAt = Date.now() + Math.min(MAX_PIN_RETRY_MS,
            30000 * 2 ** Math.floor((this.pinFailureCount - 5) / 5));
        }
        this.persistPinAttempts(accountKey);
        this.refreshPinRetry();
        this.statusMessage.set('Nivra esta bloqueado. Ingresa tu PIN.');
        this.unlockError.set(this.pinFailureCount >= 3 ? 'PIN incorrecto. Revisa y vuelve a intentar.' : 'PIN incorrecto.');
        return false;
      }
      this.unlock();
      return true;
    } finally {
      this.finishVerification(operation);
    }
  }

  async refreshBiometryAvailability(): Promise<void> {
    if (!this.isNativePlatform() || this.unlockMode() !== 'biometric') {
      return;
    }
    await this.checkBiometry().catch(() => undefined);
  }

  normalizePin(value: string | number | null | undefined): string {
    return String(value ?? '').replace(/\D/g, '').slice(0, PIN_LENGTH);
  }

  isValidPin(pin: string): boolean {
    return /^\d{4}$/.test(pin);
  }

  private async checkBiometry(): Promise<CheckBiometryResult> {
    try {
      const info = await BiometricAuth.checkBiometry();
      this.biometryLabel.set(this.describeBiometry(info));
      return info;
    } catch (error) {
      throw new Error(this.biometricErrorMessage(error, 'La biometria nativa no esta disponible en esta APK.'));
    }
  }

  private authenticateBiometrics(reason: string): Promise<void> {
    return BiometricAuth.authenticate({
      reason,
      cancelTitle: 'Cancelar',
      iosFallbackTitle: 'Usar codigo',
      allowDeviceCredential: true,
      androidTitle: 'Nivra bloqueado',
      androidSubtitle: reason,
      androidConfirmationRequired: false,
      androidBiometryStrength: AndroidBiometryStrength.weak,
    });
  }

  private loadForAccount(accountKey: string): void {
    if (accountKey !== this.loadedAccountKey) {
      this.invalidateVerification();
      this.loadedAccountKey = accountKey;
      const attempts = this.readPinAttempts(accountKey);
      this.pinFailureCount = attempts.failures;
      this.pinRetryAt = attempts.retryAt;
      this.refreshPinRetry();
      // A previous account's locked state must not skip this account's boot lock.
      this.isLocked.set(false);
    }
    if (!accountKey) {
      this.settings.set(null);
      this.bootLockAccountKey = '';
      this.unlock();
      return;
    }

    const settings = this.readSettings(accountKey);
    this.settings.set(settings);
    if (!settings?.enabled) {
      this.unlock();
      return;
    }

    if (this.bootLockAccountKey !== accountKey) {
      this.bootLockAccountKey = accountKey;
      this.lock();
    }
  }

  private saveSettings(accountKey: string, settings: AppLockSettings): void {
    localStorage.setItem(this.storageKey(accountKey), JSON.stringify(settings));
    this.settings.set(settings);
  }

  private removeSettings(accountKey: string): void {
    localStorage.removeItem(this.storageKey(accountKey));
  }

  private readSettings(accountKey: string): AppLockSettings | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.storageKey(accountKey)) || 'null') as AppLockSettings | null;
      if (!parsed?.enabled || (parsed.mode !== 'biometric' && parsed.mode !== 'pin')) {
        return null;
      }
      if (parsed.mode === 'pin' && !parsed.pin) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private storageKey(accountKey: string): string {
    return `${APP_LOCK_STORAGE_PREFIX}.${accountKey}`;
  }

  private requireAccountKey(): string {
    const accountKey = this.currentAccountKey();
    if (!accountKey) {
      throw new Error('Inicia sesion antes de activar Modo Seguro.');
    }
    return accountKey;
  }

  private requireUnchangedAccount(accountKey: string, version: number): void {
    if (this.currentAccountKey() !== accountKey || this.stateVersion !== version) {
      throw new Error('La cuenta cambio. Vuelve a configurar Modo Seguro.');
    }
  }

  private invalidateVerification(): void {
    this.stateVersion += 1;
    this.activeOperation = 0;
    this.busy.set(false);
    this.lockCycle.update(value => value + 1);
  }

  private beginVerification(): number {
    this.activeOperation = ++this.operationSequence;
    this.busy.set(true);
    return this.activeOperation;
  }

  private isCurrentVerification(accountKey: string, version: number, operation: number): boolean {
    return this.isLocked() && this.currentAccountKey() === accountKey
      && this.stateVersion === version && this.activeOperation === operation;
  }

  private finishVerification(operation: number): void {
    if (this.activeOperation !== operation) return;
    this.activeOperation = 0;
    this.busy.set(false);
  }

  private readPinAttempts(accountKey: string): PinAttempts {
    const fallback = this.accountAttempts.get(accountKey) ?? { failures: 0, retryAt: 0 };
    if (!accountKey) return fallback;
    try {
      const parsed = JSON.parse(localStorage.getItem(`${PIN_ATTEMPTS_PREFIX}.${accountKey}`) || 'null');
      if (!parsed || !Number.isSafeInteger(parsed.failures) || parsed.failures < 0
        || parsed.failures > 1000 || !Number.isFinite(parsed.retryAt) || parsed.retryAt < 0) return fallback;
      return { failures: parsed.failures, retryAt: Math.min(parsed.retryAt, Date.now() + MAX_PIN_RETRY_MS) };
    } catch {
      return fallback;
    }
  }

  private persistPinAttempts(accountKey: string): void {
    if (!accountKey) return;
    const attempts = { failures: this.pinFailureCount, retryAt: this.pinRetryAt };
    this.accountAttempts.set(accountKey, attempts);
    try {
      const key = `${PIN_ATTEMPTS_PREFIX}.${accountKey}`;
      if (attempts.failures === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(attempts));
    } catch {
      // Still rate-limit in memory when browser storage is unavailable.
    }
  }

  private refreshPinRetry(): void {
    if (this.pinRetryTimer) clearTimeout(this.pinRetryTimer);
    this.pinRetryTimer = undefined;
    const seconds = Math.max(0, Math.ceil((this.pinRetryAt - Date.now()) / 1000));
    this.pinRetrySeconds.set(seconds);
    if (seconds > 0) this.pinRetryTimer = setTimeout(() => this.refreshPinRetry(), 1000);
  }

  private currentAccountKey(): string {
    const user = this.auth.session()?.user;
    return user?.id || user?.alias || '';
  }

  private async createPinEnvelope(pin: string, accountKey: string): Promise<PinEnvelope> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.derivePinKey(pin, salt, PIN_ITERATIONS);
    const payload: PinVerifierPayload = {
      type: 'nivra-app-lock-pin',
      accountKey,
      nonce: this.b64(crypto.getRandomValues(new Uint8Array(24))),
      createdAt: new Date().toISOString(),
    };
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: this.toArrayBuffer(iv) },
      key,
      textEncoder.encode(JSON.stringify(payload)),
    );
    return {
      v: 1,
      alg: 'PBKDF2-SHA256+A256GCM',
      iterations: PIN_ITERATIONS,
      salt: this.b64(salt),
      iv: this.b64(iv),
      ciphertext: this.b64(new Uint8Array(ciphertext)),
    };
  }

  private async verifyPinEnvelope(pin: string, envelope: PinEnvelope, accountKey: string): Promise<boolean> {
    if (!this.isValidPin(pin) || envelope.v !== 1 || envelope.alg !== 'PBKDF2-SHA256+A256GCM') {
      return false;
    }

    try {
      const key = await this.derivePinKey(pin, this.ub64(envelope.salt), envelope.iterations || PIN_ITERATIONS);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.ub64Buffer(envelope.iv) },
        key,
        this.ub64Buffer(envelope.ciphertext),
      );
      const payload = JSON.parse(textDecoder.decode(plain)) as PinVerifierPayload;
      return payload.type === 'nivra-app-lock-pin' && payload.accountKey === accountKey;
    } catch {
      return false;
    }
  }

  private async derivePinKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(`nivra-app-lock:v1:${pin}`),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: this.toArrayBuffer(salt), iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private describeBiometry(info: CheckBiometryResult): string {
    const types = [info.biometryType, ...info.biometryTypes];
    const hasFace = types.some((type) => type === BiometryType.faceId || type === BiometryType.faceAuthentication);
    const hasFinger = types.some((type) => type === BiometryType.touchId || type === BiometryType.fingerprintAuthentication);
    const hasIris = types.some((type) => type === BiometryType.irisAuthentication);
    if (hasFace && hasFinger) return 'huella o rostro';
    if (hasFace) return 'reconocimiento facial';
    if (hasFinger) return 'huella digital';
    if (hasIris) return 'iris';
    return 'biometria';
  }

  private biometricErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof BiometryError) {
      if (error.code === BiometryErrorType.biometryNotEnrolled) {
        return 'Primero configura huella o reconocimiento facial en el telefono.';
      }
      if (error.code === BiometryErrorType.biometryNotAvailable) {
        return 'La biometria no esta disponible para esta app en este telefono.';
      }
      if (error.code === BiometryErrorType.biometryLockout) {
        return 'Biometria bloqueada temporalmente por muchos intentos.';
      }
      if (error.code === BiometryErrorType.passcodeNotSet || error.code === BiometryErrorType.noDeviceCredential) {
        return 'Configura un bloqueo de pantalla en el telefono antes de activar Modo Seguro.';
      }
      if (error.code === BiometryErrorType.userCancel || error.code === BiometryErrorType.systemCancel) {
        return 'Desbloqueo cancelado.';
      }
      return error.message || fallback;
    }
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const message = raw.toLowerCase();
    if (message.includes('not implemented') || message.includes('plugin') || message.includes('unimplemented')) {
      return 'La verificacion biometrica no esta disponible. Actualiza Nivra y vuelve a intentarlo.';
    }
    if (message.includes('not enrolled') || message.includes('not_enrolled') || message.includes('enrolled')) {
      return 'Primero configura huella o reconocimiento facial en el telefono.';
    }
    if (message.includes('lockout')) {
      return 'Biometria bloqueada temporalmente por muchos intentos.';
    }
    if (message.includes('cancel')) {
      return 'Desbloqueo cancelado.';
    }
    return raw || fallback;
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

  private ub64Buffer(value: string): ArrayBuffer {
    return this.toArrayBuffer(this.ub64(value));
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
