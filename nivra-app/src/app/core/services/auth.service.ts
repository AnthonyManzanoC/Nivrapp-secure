import { Injectable, NgZone, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import {
  Auth,
  ConfirmationResult,
  RecaptchaVerifier,
  getAuth,
  signInWithPhoneNumber,
  useDeviceLanguage,
} from 'firebase/auth';
import { FirebaseApp, deleteApp, getApps, initializeApp } from 'firebase/app';
import { ReCaptchaV3Provider, initializeAppCheck, type AppCheck } from 'firebase/app-check';
import {
  AuthSession,
  DeviceKeys,
  NivraUser,
  PhoneAliasChallenge,
  QrLoginAuthorizedResponse,
  QrLoginStatusResponse,
  QrLoginStartResponse,
  StoredDeviceKeys,
} from '../models/nivra.models';
import { CryptoService, HistoricalDeviceKeyMaterial } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { environment } from '../../../environments/environment';
import { NativeSecureVaultService } from './native-secure-vault.service';
import { ChatLaunchCacheService } from './chat-launch-cache.service';
import { authErrorMessage } from '../utils/auth-error';
import { normalizeNivraNumber } from '../utils/nivra-number';
import { AccountSessionsService } from './account-sessions.service';
import { NivraNative } from './native-plugin';
import { markWebPushAccountWipe, pendingWebPushAccountWipes } from './push-account-scopes';
import { IdentityTrustService, IdentityTrustTransfer } from './identity-trust.service';

export class StoredAccountWipeRequiredError extends Error {
  constructor(readonly scope: { userId: string; deviceId: string }) { super('STORED_ACCOUNT_FORCE_WIPE'); }
}

interface FirebasePhoneVerifyResponse {
  requiresAlias?: boolean;
  auth?: AuthSession | null;
  phoneSetupToken?: string | null;
  phoneSetupExpiresAt?: string | null;
  phone?: string | null;
}

export interface QrLoginChallenge {
  qrId: string;
  code: string;
  qrData: string;
  shortCode: string;
  expiresAt: string;
}

interface ParsedQrLoginChallenge {
  qrId?: string | null;
  code?: string | null;
  syncToken?: string | null;
  publicJwk?: JsonWebKey | null;
  publicSpki?: string | null;
  connectionId?: string | null;
  expiresAt?: string | null;
}

interface ProtectedAuthSessionEnvelope {
  v: 1;
  alg: 'NIVRA-AUTH-SESSION-A256GCM';
  iv: string;
  ciphertext: string;
  updatedAt: string;
}

interface QrHistoryPayload {
  userId?: string;
  sourceDeviceId?: string;
  identityTrust?: IdentityTrustTransfer;
  keyring?: HistoricalDeviceKeyMaterial[];
  keyMaterial?: Pick<StoredDeviceKeys, 'privateJwk' | 'publicJwk'>;
}

const FIREBASE_APP_NAME = 'nivra-web-phone-auth';
const SESSION_KEY = 'nivra.auth';
const PROTECTED_SESSION_KEY = 'nivra.auth.protected';
const PENDING_VAULT_INVITE_KEY = 'nivra.pendingVaultInvite';
const PENDING_CONTACT_ALIAS_KEY = 'nivra.pendingContactAlias';
const HARDWARE_ID_KEY = 'nivra_hardware_id';
const SKIP_ROUTE_RESTORE_ONCE_KEY = 'nivra.skipRouteRestoreOnce';
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;
const authTextEncoder = new TextEncoder();
const authTextDecoder = new TextDecoder();

@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly crypto = inject(CryptoService);
  private readonly identityTrust = inject(IdentityTrustService);
  private readonly secureVault = inject(NativeSecureVaultService);
  private readonly launchCache = inject(ChatLaunchCacheService);
  private readonly accountSessions = inject(AccountSessionsService);
  private readonly router = inject(Router);
  private readonly ngZone = inject(NgZone);
  private firebaseApp: FirebaseApp | null = null;
  private firebaseAppCheck: AppCheck | null = null;
  private firebaseAuth: Auth | null = null;
  private recaptchaVerifier: RecaptchaVerifier | null = null;
  private confirmationResult: ConfirmationResult | null = null;
  private nativePhoneVerificationId = '';
  private nativePhoneListenerHandles: PluginListenerHandle[] = [];
  private qrConnection: HubConnection | null = null;
  private qrPollTimer: number | null = null;
  private qrGeneration = 0;
  private sessionWriteEpoch = 0;
  private authRefreshPromise: Promise<boolean> | null = null;
  private refreshOperations = new Map<string, Promise<boolean>>();
  private protectedSessionRestorePromise: Promise<void> | null = null;
  private refreshBackoffUntil = 0;
  private refreshHardFailure = false;
  private deviceIdentityOperation: { scope: string; promise: Promise<StoredDeviceKeys> } | null = null;
  private deviceIdentityReady: { scope: string; keys: StoredDeviceKeys } | null = null;
  private deviceIdentityValidationEpoch = 0;
  private authIntentEpoch = 0;
  private accountOperationEpoch = 0;
  private sessionRestoreComplete = false;
  private addingReturnUserId: string | null = null;
  private phoneRequestCancel: (() => void) | null = null;
  private destroyed = false;

  // Never paint a legacy account before the encrypted registry has restored
  // its authoritative active pointer, including after an interrupted switch.
  readonly session = signal<AuthSession | null>(null);
  readonly savedAccounts = this.accountSessions.accounts;
  readonly addingAccount = signal(false);
  readonly accountsBusy = signal(false);
  readonly accountError = signal('');
  readonly sessionGeneration = signal(0);
  readonly pendingPhoneAlias = signal<PhoneAliasChallenge | null>(null);
  readonly busy = signal(false);
  readonly qrState = signal<'idle' | 'starting' | 'waiting' | 'authorizing' | 'expired' | 'error'>('idle');
  readonly qrError = signal<unknown>(null);
  readonly forceWipeRequested = signal(0);
  readonly forceWipeScope = signal<{ userId: string; deviceId: string; generation: number } | null>(null);
  readonly deviceIdentityError = signal('');
  readonly deviceIdentityNeedsRelink = signal(false);
  readonly accessToken = computed(() => this.session()?.tokens.accessToken ?? '');
  readonly isAuthenticated = computed(() => Boolean(this.accessToken()));
  readonly hasFreshAccessToken = computed(() => this.hasUsableAccessToken(this.session()));

  constructor() {
    void this.restoreProtectedSession();
    void this.hardwareId();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.invalidateAuthenticationIntent();
    void this.stopQrLogin();
    void this.resetRecaptcha({ clear: true });
    void this.clearNativePhoneListeners();
  }

  /** Privileged snapshot for native push registration; UI consumes savedAccounts only. */
  async storedSessionCredentials(): Promise<readonly AuthSession[]> {
    const snapshot = await this.accountSessions.load();
    return snapshot ? structuredClone(snapshot.sessions) : [];
  }

  /** Refresh one saved notification slot without adopting its profile or UI session. */
  async getFreshStoredSessionCredentials(userId: string, deviceId: string): Promise<AuthSession | null> {
    const alive = () => !this.destroyed;
    const read = async () => (await this.accountSessions.load())?.sessions.find(session =>
      session.user.id === userId && session.device.id === deviceId) ?? null;
    const saved = await read();
    if (!saved || !alive() || !await this.allowAccountActivation(saved, alive)) return null;
    if (this.hasUsableAccessToken(saved)) return saved;
    const previousRefreshToken = saved.tokens.refreshToken;
    const operationKey = JSON.stringify([userId, deviceId, previousRefreshToken]);
    const operations = this.refreshOperations ??= new Map();
    let operation = operations.get(operationKey);
    if (!operation) {
      operation = this.api.fetch('/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nivra-Device-Id': deviceId },
        body: JSON.stringify({ refreshToken: previousRefreshToken }),
      }, false, () => alive() && this.savedAccounts().some(account => account.id === userId)).then(async response => {
        if (!alive()) return false;
        if (!response.ok) {
          if (await this.isForceWipeResponse(response)) {
            const current = await read();
            if (!alive() || current?.tokens.refreshToken !== previousRefreshToken) return false;
            await markWebPushAccountWipe({ userId, deviceId });
            throw new StoredAccountWipeRequiredError({ userId, deviceId });
          }
          return false;
        }
        const tokens = await response.json() as AuthSession['tokens'];
        if (!tokens?.accessToken || !alive()) return false;
        const snapshot = await this.accountSessions.rotateTokens(userId, deviceId, previousRefreshToken, tokens, alive);
        return Boolean(snapshot?.sessions.some(session => session.user.id === userId && session.device.id === deviceId));
      }).catch(error => {
        if (error instanceof StoredAccountWipeRequiredError) throw error;
        return false;
      }).finally(() => {
        if (operations.get(operationKey) === operation) operations.delete(operationKey);
      });
      operations.set(operationKey, operation);
    }
    await operation;
    const latest = await read();
    return latest && alive() && this.hasUsableAccessToken(latest) && await this.allowAccountActivation(latest, alive) ? latest : null;
  }

  async switchToStoredAccount(userId: string, deviceId: string): Promise<boolean> {
    const snapshot = await this.accountSessions.load();
    if (!snapshot?.sessions.some(auth => auth.user.id === userId && auth.device.id === deviceId)) return false;
    return this.switchAccount(userId, deviceId);
  }

  async switchAccount(userId: string, expectedDeviceId?: string): Promise<boolean> {
    if (!userId) return false;
    const current = this.session();
    if (current?.user.id === userId && (!expectedDeviceId || current.device.id === expectedDeviceId) && !this.addingAccount()) return true;
    const operation = this.beginAccountOperation();
    const isCurrent = () => this.accountOperationEpoch === operation && !this.destroyed;
    try {
      await this.stopAuthenticationTransports();
      if (!isCurrent()) return false;
      const existing = await this.accountSessions.load();
      if (!isCurrent()) return false;
      const target = existing?.sessions.find(auth => auth.user.id === userId);
      if (!target || expectedDeviceId && target.device.id !== expectedDeviceId || !await this.allowAccountActivation(target, isCurrent)) return false;
      const snapshot = await this.accountSessions.activate(userId, isCurrent, target.device.id);
      if (!snapshot || !isCurrent()) return false;
      const active = snapshot.sessions.find(auth => auth.user.id === snapshot.activeUserId);
      if (!active || active.user.id !== userId) return false;
      this.finishAccountActivation(active);
      this.markFreshAuthNavigation();
      await this.router.navigateByUrl('/app/chats', { replaceUrl: true });
      return isCurrent();
    } catch {
      if (isCurrent()) this.accountError.set('No se pudo abrir esta cuenta. Sus sesiones e historial se han conservado.');
      return false;
    } finally { if (isCurrent()) this.accountsBusy.set(false); }
  }

  async beginAddAccount(): Promise<void> {
    const current = this.session();
    if (!current) throw new Error('Abre tu primera cuenta antes de añadir otra.');
    const operation = this.beginAccountOperation();
    const isCurrent = () => this.accountOperationEpoch === operation && !this.destroyed;
    try {
      const snapshot = await this.accountSessions.load();
      if (!snapshot || !isCurrent()) return;
      if (!snapshot.sessions.some(auth => auth.user.id === current.user.id && auth.device.id === current.device.id)) throw new Error('No se pudo comprobar la cuenta activa.');
      if (snapshot.sessions.length >= 2) throw new Error('Puedes mantener hasta dos cuentas en este dispositivo.');
      await this.stopAuthenticationTransports();
      if (!isCurrent()) return;
      this.addingReturnUserId = current.user.id;
      this.addingAccount.set(true);
      this.sessionRestoreComplete = true;
      this.adoptSession(null);
      this.clearLegacySessionRecords();
      await this.router.navigateByUrl('/auth', { replaceUrl: true });
    } finally { if (isCurrent()) this.accountsBusy.set(false); }
  }

  async cancelAddAccount(): Promise<void> {
    if (!this.addingAccount()) return;
    const userId = this.addingReturnUserId;
    // Invalidate before the first await so pending login, QR and OTP results
    // cannot acquire authority again after A -> B -> A navigation.
    const operation = this.beginAccountOperation();
    const isCurrent = () => this.accountOperationEpoch === operation && !this.destroyed;
    try {
      await this.stopAuthenticationTransports();
      if (!isCurrent()) return;
      const snapshot = userId ? await this.accountSessions.activate(userId, isCurrent) : await this.accountSessions.load();
      if (!snapshot || !isCurrent()) return;
      const active = snapshot.sessions.find(auth => auth.user.id === snapshot.activeUserId);
      if (active && await this.allowAccountActivation(active, isCurrent) && isCurrent()) {
        this.finishAccountActivation(active);
        this.markFreshAuthNavigation();
        await this.router.navigateByUrl('/app/chats', { replaceUrl: true });
      }
    } finally { if (isCurrent()) this.accountsBusy.set(false); }
  }

  async removeStoredAccount(userId: string, deviceId: string, _reason = 'removed'): Promise<void> {
    const snapshot = await this.accountSessions.load();
    if (!snapshot?.sessions.some(auth => auth.user.id === userId && auth.device.id === deviceId)) return;
    await this.removeAccount(userId, false, deviceId);
  }

  async removeAccount(userId: string, revokeServer = true, expectedDeviceId?: string): Promise<void> {
    const operation = this.beginAccountOperation();
    const isCurrent = () => this.accountOperationEpoch === operation && !this.destroyed;
    try {
      const existing = await this.accountSessions.load();
      if (!isCurrent()) return;
      const removed = existing?.sessions.find(auth => auth.user.id === userId);
      if (!removed || expectedDeviceId && removed.device.id !== expectedDeviceId) return;
      const snapshot = await this.accountSessions.remove(userId, isCurrent, removed.device.id);
      if (!snapshot || !isCurrent()) return;
      this.launchCache.clear(userId);
      const wasActive = this.session()?.user.id === userId || this.addingReturnUserId === userId;
      if (wasActive) {
        await this.stopAuthenticationTransports();
        if (!isCurrent()) return;
        const active = snapshot.sessions.find(auth => auth.user.id === snapshot.activeUserId);
        if (active && await this.allowAccountActivation(active, isCurrent) && isCurrent()) this.finishAccountActivation(active);
        else if (isCurrent()) this.finishAccountActivation(null);
        if (isCurrent()) await this.router.navigateByUrl(this.session() ? '/app/chats' : '/auth', { replaceUrl: true });
      }
      if (snapshot.sessions.length === 0 && isCurrent()) await this.nativeFirebaseSignOut();
      // Use the removed session's credentials directly. An inactive logout
      // must never borrow the current account's interceptor or cookies.
      if (revokeServer) {
        await this.api.fetch('/auth/logout', {
          method: 'POST', credentials: 'omit', headers: {
            'Content-Type': 'application/json', Authorization: `Bearer ${removed.tokens.accessToken}`,
            'X-Nivra-Device-Id': removed.device.id,
          }, body: '{}',
        }, false).catch(() => undefined);
      }
      // The shared protector may still decrypt another slot or launch cache.
      // Removing an account never deletes global authentication/device keys.
    } finally { if (isCurrent()) this.accountsBusy.set(false); }
  }

  private beginAccountOperation(): number {
    this.invalidateAuthenticationIntent();
    this.accountOperationEpoch = (this.accountOperationEpoch ?? 0) + 1;
    this.invalidateDeviceIdentity();
    this.authRefreshPromise = null;
    this.refreshBackoffUntil = 0;
    this.refreshHardFailure = false;
    this.accountsBusy.set(true);
    this.accountError.set('');
    this.busy.set(false);
    return this.accountOperationEpoch;
  }

  private invalidateAuthenticationIntent(): void {
    this.authIntentEpoch = (this.authIntentEpoch ?? 0) + 1;
    this.sessionWriteEpoch = (this.sessionWriteEpoch ?? 0) + 1;
    this.phoneRequestCancel?.();
    this.phoneRequestCancel = null;
  }

  private beginAuthenticationIntent(): () => boolean {
    this.invalidateAuthenticationIntent();
    this.accountOperationEpoch = (this.accountOperationEpoch ?? 0) + 1;
    this.accountsBusy?.set(false);
    const intent = this.authIntentEpoch;
    return () => !this.destroyed && this.authIntentEpoch === intent;
  }

  private async stopAuthenticationTransports(): Promise<void> {
    this.pendingPhoneAlias.set(null);
    this.confirmationResult = null;
    this.nativePhoneVerificationId = '';
    await Promise.all([this.stopQrLogin(), this.resetRecaptcha({ clear: true }), this.clearNativePhoneListeners()]);
  }

  private finishAccountActivation(auth: AuthSession | null): void {
    this.addingAccount.set(false);
    this.addingReturnUserId = null;
    this.sessionRestoreComplete = true;
    this.pendingPhoneAlias.set(null);
    this.clearLegacySessionRecords();
    this.adoptSession(auth);
  }

  private adoptSession(auth: AuthSession | null): void {
    const previous = this.session();
    if (previous?.user.id !== auth?.user.id || previous?.device.id !== auth?.device.id) {
      this.sessionGeneration?.update(value => value + 1);
      this.invalidateDeviceIdentity();
      this.deviceIdentityError?.set('');
      this.deviceIdentityNeedsRelink?.set(false);
    }
    this.session.set(auth);
  }

  private clearLegacySessionRecords(): void {
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(PROTECTED_SESSION_KEY); } catch { /* Registry remains authoritative. */ }
  }

  private async allowAccountActivation(auth: AuthSession, isCurrent: () => boolean): Promise<boolean> {
    if (!isCurrent()) return false;
    const scopes = await pendingWebPushAccountWipes();
    if (!isCurrent()) return false;
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      const pending = await NivraNative.getPendingPushAccountWipes();
      if (!pending || !Array.isArray(pending.scopes)) throw new Error('No se pudo comprobar la sesión guardada.');
      scopes.push(...pending.scopes);
    }
    if (!isCurrent()) return false;
    if (scopes.some(scope => scope.userId === auth.user.id && scope.deviceId === auth.device.id)) {
      await this.accountSessions.remove(auth.user.id, isCurrent, auth.device.id);
      if (isCurrent()) this.accountError.set('Esta sesión ya no está autorizada. La otra cuenta se ha conservado.');
      return false;
    }
    return true;
  }

  updateUser(user: NivraUser): void {
    const current = this.session();
    if (!current || user.id !== current.user.id) {
      return;
    }
    const generation = this.sessionGeneration();
    const intent = this.authIntentEpoch;
    const isCurrent = () => this.authIntentEpoch === intent && this.sessionGeneration() === generation
      && this.session()?.user.id === current.user.id && this.session()?.device.id === current.device.id;
    void this.accountSessions.updateProfile(user, current.device.id, isCurrent).then(snapshot => {
      if (!isCurrent()) return;
      const updated = snapshot?.sessions.find(auth => auth.user.id === current.user.id && auth.device.id === current.device.id);
      if (updated) this.adoptSession(updated);
    }).catch(() => undefined);
  }

  async loginWithAlias(alias: string, password: string, mode: 'login' | 'register', displayName = ''): Promise<void> {
    let normalizedAlias = alias.trim();
    if (!normalizedAlias || !password) {
      throw new Error('Alias y password son obligatorios.');
    }

    const isCurrent = this.beginAuthenticationIntent();
    this.busy.set(true);
    try {
      const device = await this.deviceProfile();
      if (!isCurrent()) return;
      let identity: { alias: string; userId: string; deviceId?: string | null; identityKey?: string | null } | undefined;
      if (mode === 'login') {
        identity = await firstValueFrom(this.api.post<{ alias: string; userId: string; deviceId?: string | null; identityKey?: string | null }>('/auth/login', {
          alias: normalizeNivraNumber(normalizedAlias) || `@${normalizedAlias.replace(/^@/, '')}`, password, deviceName: device.name,
          hardwareId: device.hardwareId, keyBundle: null, resolveOnly: true,
        }, { skipAuth: true }));
        if (!isCurrent()) return;
        if (!identity || typeof identity.alias !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(identity.alias)
          || ('userId' in identity && (typeof identity.userId !== 'string' || !identity.userId.trim()))) throw new Error('No se pudo comprobar la identidad de tu cuenta. Actualiza Nivra.');
        normalizedAlias = identity.alias;
      }
      // Older servers resolve only aliases. Keep login usable, but never infer
      // ownership of an existing private key from a mutable alias alone.
      const keys = identity && !('userId' in identity)
        ? await this.crypto.createDeviceKeys()
        : await this.crypto.prepareDeviceKeys(normalizedAlias, mode === 'register', identity);
      if (!isCurrent()) return;
      const payload = {
        alias: mode === 'login' ? `@${normalizedAlias}` : normalizedAlias,
        password,
        deviceName: device.name,
        hardwareId: device.hardwareId,
        displayName: mode === 'register' ? displayName.trim() || normalizedAlias : undefined,
        email: null,
        phone: null,
        keyBundle: keys.keyBundle,
      };
      const auth = await firstValueFrom(
        this.api.post<AuthSession>(mode === 'register' ? '/auth/register' : '/auth/login', payload, { skipAuth: true }),
      );
      if (!isCurrent()) return;
      if (identity?.userId && auth.user?.id !== identity.userId) throw new Error('La identidad de la cuenta cambió durante el inicio de sesión. Vuelve a intentar.');
      await this.completeAuth(auth, keys, isCurrent);
    } finally {
      if (isCurrent()) this.busy.set(false);
    }
  }

  async createPrivateAccount(password: string): Promise<void> {
    if (password.length < 10) {
      throw new Error('Usa una contraseña de al menos 10 caracteres.');
    }
    const isCurrent = this.beginAuthenticationIntent();
    this.busy.set(true);
    try {
      const keys = await this.crypto.createDeviceKeys();
      const device = await this.deviceProfile();
      if (!isCurrent()) return;
      const auth = await firstValueFrom(this.api.post<AuthSession>('/auth/register-private', {
        password, deviceName: device.name, hardwareId: device.hardwareId, keyBundle: keys.keyBundle,
      }, { skipAuth: true }));
      if (!isCurrent()) return;
      await this.completeAuth(auth, keys, isCurrent);
    } finally {
      if (isCurrent()) this.busy.set(false);
    }
  }

  async sendFirebaseOtp(phone: string): Promise<void> {
    const normalizedPhone = phone.trim();
    if (!normalizedPhone) {
      throw new Error('Ingresa tu telefono con codigo de pais.');
    }

    const isCurrent = this.beginAuthenticationIntent();
    this.busy.set(true);
    try {
      if (this.usesNativeFirebasePhoneAuth()) {
        await this.sendNativeFirebaseOtp(normalizedPhone, isCurrent);
        return;
      }

      const auth = await this.ensureFirebaseAuth();
      if (!isCurrent()) return;
      const verifier = await this.ensureRecaptcha(auth);
      if (!isCurrent()) return;
      const confirmation = await signInWithPhoneNumber(auth, normalizedPhone, verifier);
      if (isCurrent()) this.confirmationResult = confirmation;
    } catch (error) {
      if (!isCurrent()) return;
      await this.resetRecaptcha({ clear: true });
      throw new Error(this.firebasePhoneAuthErrorMessage(error, 'No se pudo enviar el codigo SMS.'));
    } finally {
      if (isCurrent()) this.busy.set(false);
    }
  }

  async verifyFirebaseOtp(phone: string, code: string): Promise<void> {
    if (!phone.trim() || !code.trim()) {
      throw new Error('Telefono y codigo son obligatorios.');
    }

    const intent = this.authIntentEpoch;
    const isCurrent = () => !this.destroyed && this.authIntentEpoch === intent;
    if (this.usesNativeFirebasePhoneAuth()) {
      await this.verifyNativeFirebaseOtp(phone, code, isCurrent);
      return;
    }

    if (!this.confirmationResult) {
      throw new Error('Primero pide el codigo SMS de Firebase.');
    }

    this.busy.set(true);
    try {
      const credential = await this.confirmationResult.confirm(code.trim());
      if (!isCurrent()) return;
      const firebaseToken = await credential.user.getIdToken();
      if (!isCurrent()) return;
      await this.completeFirebasePhoneSignIn(phone, firebaseToken, isCurrent);
      if (isCurrent()) this.confirmationResult = null;
    } catch (error) {
      if (!isCurrent()) return;
      throw new Error(this.firebasePhoneAuthErrorMessage(error, 'No se pudo entrar por telefono.'));
    } finally {
      if (isCurrent()) this.busy.set(false);
    }
  }

  async completePhoneAlias(alias: string, displayName = ''): Promise<void> {
    const pending = this.pendingPhoneAlias();
    const normalizedAlias = alias.trim();
    if (!pending?.token || !pending.keys || !normalizedAlias) {
      throw new Error('Escoge tu alias para terminar la cuenta.');
    }

    const isCurrent = this.beginAuthenticationIntent();
    this.busy.set(true);
    try {
      const device = await this.deviceProfile();
      if (!isCurrent()) return;
      const auth = await firstValueFrom(
        this.api.post<AuthSession>('/auth/phone/complete-alias', {
          phoneSetupToken: pending.token,
          alias: normalizedAlias,
          displayName: displayName.trim() || normalizedAlias,
          deviceName: device.name,
          hardwareId: device.hardwareId,
          keyBundle: pending.keys.keyBundle,
        }, { skipAuth: true }),
      );
      if (!isCurrent()) return;
      this.pendingPhoneAlias.set(null);
      await this.completeAuth(auth, pending.keys, isCurrent);
    } finally {
      if (isCurrent()) this.busy.set(false);
    }
  }

  async startQrLogin(): Promise<QrLoginChallenge> {
    const isCurrent = this.beginAuthenticationIntent();
    const generation = this.qrGeneration + 1;
    await this.stopQrLogin();
    if (!isCurrent() || generation !== this.qrGeneration) {
      throw new Error('QR_CANCELLED');
    }
    this.qrState.set('starting');
    this.qrError.set(null);
    try {
      return await this.createQrLogin(generation);
    } catch (error) {
      if (generation === this.qrGeneration) {
        const stopped = this.stopQrLogin();
        this.qrState.set('error');
        this.qrError.set(error);
        await stopped;
      }
      throw error;
    }
  }

  private async createQrLogin(generation: number): Promise<QrLoginChallenge> {
    const intent = this.authIntentEpoch;
    const isCurrent = () => !this.destroyed && generation === this.qrGeneration && intent === this.authIntentEpoch;
    const ephemeral = await this.crypto.createQrEphemeralKeys();
    const localKeys = await this.crypto.createDeviceKeys();
    const device = await this.deviceProfile();
    if (!isCurrent()) throw new Error('QR_CANCELLED');
    const serverChallenge = await firstValueFrom(
      this.api.post<QrLoginStartResponse>('/auth/qr/start', {
        deviceName: device.name,
        hardwareId: device.hardwareId,
        keyBundle: localKeys.keyBundle,
        publicKey: this.crypto.base64UrlJson(ephemeral.publicJwk),
      }, { skipAuth: true }),
    );

    if (!isCurrent()) {
      throw new Error('QR_CANCELLED');
    }
    if (!serverChallenge.qrId || !serverChallenge.code || !Number.isFinite(Date.parse(serverChallenge.expiresAt))) {
      throw new Error('No pudimos generar un QR válido. Inténtalo de nuevo.');
    }

    const connection = new HubConnectionBuilder()
      .withUrl(this.api.url(`/hubs/realtime?${new URLSearchParams({
        qr_login_id: serverChallenge.qrId,
        qr_code: serverChallenge.code,
      }).toString()}`), { withCredentials: false })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .configureLogging(LogLevel.None)
      .build();

    let finished = false;
    let finishing = false;
    const fail = async (error: unknown) => {
      if (!isCurrent()) {
        return;
      }
      const stopped = this.stopQrLogin();
      this.ngZone.run(() => {
        this.qrError.set(error);
        this.qrState.set('error');
      });
      await stopped;
    };
    const finish = async (authorization: QrLoginAuthorizedResponse | { encryptedPayload?: string | null; auth?: AuthSession | null }) => {
      if (!isCurrent() || finished || finishing) {
        return;
      }
      finishing = true;
      this.qrState.set('authorizing');
      const auth = authorization.auth;
      const encryptedPayload = authorization.encryptedPayload;
      if (!auth?.tokens?.accessToken || !encryptedPayload) {
        throw new Error('La autorizacion QR no contiene una sesion valida.');
      }
      const payload = await this.crypto.decryptQrPayload<QrHistoryPayload>(
        encryptedPayload,
        ephemeral.privateKey,
      );
      if (!isCurrent()) {
        return;
      }
      await this.completeLocalQrAuth(auth, payload, localKeys, isCurrent);
      finished = true;
      if (isCurrent()) {
        await this.stopQrLogin();
      }
    };

    connection.on('QrAuthorized', (authorization: QrLoginAuthorizedResponse) => {
      void this.ngZone.run(() => finish(authorization)).catch(fail);
    });
    connection.on('auth.qrAuthorized', (authorization: QrLoginAuthorizedResponse) => {
      void this.ngZone.run(() => finish(authorization)).catch(fail);
    });
    connection.on('qr-login-success', (encryptedPayload: string) => {
      void this.ngZone.run(async () => {
        if (!isCurrent() || finished || finishing) {
          return;
        }
        finishing = true;
        this.qrState.set('authorizing');
        // This obsolete transport copies the source session/device credentials.
        // Publishing a destination identity with those tokens would rotate the
        // source's key. A fresh v3 challenge issues a distinct target session.
        throw new Error('Renueva el QR de vinculación y escanéalo de nuevo. Este QR antiguo no permite vincular un dispositivo de forma segura.');
      }).catch(fail);
    });

    this.qrConnection = connection;
    // Polling can finish the same challenge when a network blocks WebSockets.
    void connection.start().catch(() => undefined);
    const expiresAt = serverChallenge.expiresAt;
    let polling = false;
    this.qrPollTimer = window.setInterval(() => {
      if (!isCurrent() || finished || finishing) {
        return;
      }
      if (Date.parse(expiresAt) <= Date.now()) {
        void this.stopQrLogin();
        this.ngZone.run(() => this.qrState.set('expired'));
        return;
      }
      if (polling) {
        return;
      }
      polling = true;
      void firstValueFrom(this.api.get<QrLoginStatusResponse>(
        `/auth/qr/status/${encodeURIComponent(serverChallenge.qrId)}?code=${encodeURIComponent(serverChallenge.code)}`,
        { skipAuth: true },
      ))
        .then((status) => {
          if (status.status === 'authorized') {
            return this.ngZone.run(() => finish(status));
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (finishing) {
            return fail(error);
          }
          // An intermittent poll failure is retried until the challenge expires.
          return undefined;
        })
        .finally(() => { polling = false; });
    }, 2500);
    this.qrState.set('waiting');
    const query = new URLSearchParams({
      v: '3',
      type: 'nivra-qr-login',
      qrId: serverChallenge.qrId,
      code: serverChallenge.code,
      pk: ephemeral.publicSpki || this.crypto.base64UrlJson(ephemeral.publicJwk),
      k: ephemeral.publicSpki ? 'spki' : 'jwk',
      exp: expiresAt,
    });

    return {
      qrId: serverChallenge.qrId,
      code: serverChallenge.code,
      qrData: `nivra://login/qr?${query.toString()}`,
      shortCode: serverChallenge.code || serverChallenge.syncToken.slice(-6).toUpperCase(),
      expiresAt,
    };
  }

  async stopQrLogin(): Promise<void> {
    this.qrGeneration++;
    this.qrState.set('idle');
    this.qrError.set(null);
    if (this.qrPollTimer !== null) {
      window.clearInterval(this.qrPollTimer);
      this.qrPollTimer = null;
    }
    const connection = this.qrConnection;
    this.qrConnection = null;
    if (connection) {
      connection.off('QrAuthorized');
      connection.off('auth.qrAuthorized');
      connection.off('qr-login-success');
      await connection.stop().catch(() => undefined);
    }
  }

  async authorizeQrLoginText(rawText: string): Promise<void> {
    const challenge = this.parseQrLoginChallenge(rawText);
    const current = this.session();
    if (!current?.tokens?.accessToken) {
      throw new Error('Necesitas una sesion activa para vincular otro dispositivo.');
    }
    const keyMaterial = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const keyring = await this.crypto.exportDeviceKeyMaterialsForUser(current.user.id, current.user.alias);
    const identityTrust = await this.identityTrust.exportForLinkedDevice(current.user.id, current.device.id).catch(() => undefined);
    if (this.session()?.user.id !== current.user.id || this.session()?.device.id !== current.device.id) throw new Error('La sesión cambió durante la vinculación.');
    const device = await this.deviceProfile();
    const payload = {
      userId: current.user.id,
      sourceDeviceId: current.device.id,
      ...(identityTrust ? { identityTrust } : {}),
      keyring: keyring.map(key => ({ privateJwk: key.privateJwk, publicJwk: key.publicJwk, createdAt: key.createdAt })),
      keyMaterial: {
        privateJwk: keyMaterial.privateJwk,
        publicJwk: keyMaterial.publicJwk,
      },
      sourceDeviceName: device.name,
      sourceHardwareId: device.hardwareId,
      linkedAt: new Date().toISOString(),
    };
    const publicMaterial = challenge.publicJwk || challenge.publicSpki;
    if (!publicMaterial) {
      throw new Error('Ese QR no trae llave publica de vinculacion.');
    }
    const sealed = await this.crypto.encryptQrPayload(publicMaterial, challenge.qrId && challenge.code ? payload : { ...payload, auth: current });
    if (this.session()?.user.id !== current.user.id || this.session()?.device.id !== current.device.id) throw new Error('La sesión cambió durante la vinculación.');
    if (challenge.qrId && challenge.code) {
      await firstValueFrom(this.api.post('/api/auth/qr-login', {
        qrId: challenge.qrId,
        code: challenge.code,
        encryptedPayload: sealed,
      })).catch((error: unknown) => { throw new Error(authErrorMessage(error, 'qr').fallback); });
      return;
    }
    if (challenge.connectionId) {
      await firstValueFrom(this.api.post('/api/auth/authorize-qr', {
        targetConnectionId: challenge.connectionId,
        encryptedPayload: sealed,
      }));
      return;
    }
    throw new Error('QR de vinculacion incompleto.');
  }

  async refreshToken(): Promise<boolean> {
    const requestedSession = this.session();
    const requestedGeneration = this.sessionGeneration?.();
    await this.restoreProtectedSession();
    if (requestedSession && (this.sessionGeneration?.() !== requestedGeneration
      || this.session()?.user.id !== requestedSession.user.id || this.session()?.device.id !== requestedSession.device.id)) return false;
    await this.synchronizeStoredSessionTokens();
    if (requestedSession && (this.sessionGeneration?.() !== requestedGeneration
      || this.session()?.user.id !== requestedSession.user.id || this.session()?.device.id !== requestedSession.device.id)) return false;
    const refreshToken = this.session()?.tokens.refreshToken;
    if (!refreshToken) {
      // An intentionally signed-out add-account form has no expired session.
      this.refreshHardFailure = Boolean(this.session()?.tokens.accessToken);
      return false;
    }
    if (Date.now() < this.refreshBackoffUntil) {
      this.refreshHardFailure = false;
      return false;
    }

    const currentSession = this.session();
    const refreshIntent = this.authIntentEpoch;
    const refreshGeneration = this.sessionGeneration?.();
    const sameRefreshContext = () => {
      const current = this.session();
      return this.sessionGeneration?.() === refreshGeneration
        && current?.user.id === currentSession?.user.id && current?.device.id === currentSession?.device.id
        && current?.tokens.refreshToken === refreshToken;
    };
    const mayApplyRefresh = () => !this.destroyed && this.authIntentEpoch === refreshIntent && sameRefreshContext();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (currentSession?.device?.id) {
      headers['X-Nivra-Device-Id'] = currentSession.device.id;
    }

    const operationKey = JSON.stringify([currentSession?.user.id, currentSession?.device.id, refreshToken]);
    const operations = this.refreshOperations ??= new Map();
    const pending = operations.get(operationKey);
    if (pending) return pending.then(async result => {
      await this.synchronizeStoredSessionTokens();
      return !this.destroyed && this.authIntentEpoch === refreshIntent && this.sessionGeneration?.() === refreshGeneration
        && this.session()?.user.id === currentSession?.user.id && this.session()?.device.id === currentSession?.device.id
        && (result || this.session()?.tokens.refreshToken !== refreshToken);
    });
    const operation = this.api.fetch('/auth/refresh', {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken }),
    }, false, mayApplyRefresh)
      .then(async (response) => {
        if (!response.ok) {
          if (!mayApplyRefresh()) return false;
          if (await this.isForceWipeResponse(response)) {
            if (!mayApplyRefresh()) return false;
            if (currentSession) this.forceWipeScope.set({ userId: currentSession.user.id, deviceId: currentSession.device.id, generation: this.sessionGeneration() });
            this.forceWipeRequested.update((value) => value + 1);
            this.refreshHardFailure = true;
            return false;
          }
          if (!mayApplyRefresh()) return false;
          this.refreshHardFailure = response.status === 401 || response.status === 403;
          if (response.status === 429 || response.status >= 500) {
            this.refreshBackoffUntil = Date.now() + this.refreshRetryDelayMs(response);
          }
          return false;
        }
        const tokens = await response.json() as AuthSession['tokens'];
        if (!currentSession?.tokens || !tokens.accessToken || this.destroyed) {
          if (mayApplyRefresh()) this.refreshHardFailure = true;
          return false;
        }
        // The server rotated this exact slot even when the user switched accounts
        // while it was in flight. Keep the replacement token without resurrecting
        // a removed slot or replacing a later login's credentials.
        const snapshot = await this.accountSessions.rotateTokens(currentSession.user.id, currentSession.device.id, refreshToken, tokens, () => !this.destroyed);
        if (!snapshot || this.destroyed) return false;
        const refreshed = snapshot.sessions.find(auth => auth.user.id === currentSession.user.id && auth.device.id === currentSession.device.id);
        if (!refreshed) return false;
        const originalAuthority = mayApplyRefresh();
        if (originalAuthority) { this.refreshHardFailure = false; this.refreshBackoffUntil = 0; }
        // Token-only reconciliation is safe across A -> B -> A when A still has
        // the exact old refresh credential. Never copy the old profile or route.
        this.reconcileSessionTokens(currentSession, refreshed.tokens);
        return originalAuthority;
      })
      .catch(() => {
        if (!mayApplyRefresh()) return false;
        this.refreshHardFailure = false;
        this.refreshBackoffUntil = Date.now() + 30000;
        return false;
      })
      .finally(() => {
        if (operations.get(operationKey) === operation) operations.delete(operationKey);
        if (this.authRefreshPromise === operation) this.authRefreshPromise = null;
      });
    operations.set(operationKey, operation);
    this.authRefreshPromise = operation;
    return operation;
  }

  lastRefreshFailedPermanently(): boolean {
    return this.refreshHardFailure;
  }

  async ensureFreshSession(options: { force?: boolean; skewMs?: number } = {}): Promise<boolean> {
    const requestedSession = this.session();
    const requestedGeneration = this.sessionGeneration?.();
    await this.restoreProtectedSession();
    if (requestedSession && (this.sessionGeneration?.() !== requestedGeneration
      || this.session()?.user.id !== requestedSession.user.id || this.session()?.device.id !== requestedSession.device.id)) return false;
    await this.synchronizeStoredSessionTokens();
    if (requestedSession && (this.sessionGeneration?.() !== requestedGeneration
      || this.session()?.user.id !== requestedSession.user.id || this.session()?.device.id !== requestedSession.device.id)) return false;
    const current = this.session();
    if (!current?.tokens?.accessToken || !current.tokens.refreshToken) {
      return false;
    }
    if (!options.force && this.hasUsableAccessToken(current, options.skewMs ?? TOKEN_REFRESH_SKEW_MS)) {
      return true;
    }
    return this.refreshToken();
  }

  private async synchronizeStoredSessionTokens(): Promise<void> {
    const requested = this.session();
    if (!requested) return;
    const generation = this.sessionGeneration?.();
    try {
      const snapshot = await this.accountSessions.load();
      if (this.destroyed || this.sessionGeneration?.() !== generation) return;
      const stored = snapshot?.sessions.find(auth => auth.user.id === requested.user.id && auth.device.id === requested.device.id);
      if (stored && stored.tokens.refreshToken !== requested.tokens.refreshToken) this.reconcileSessionTokens(requested, stored.tokens);
    } catch { /* A transient vault failure must not replace or discard the live credential. */ }
  }

  private reconcileSessionTokens(previous: AuthSession, tokens: AuthSession['tokens']): void {
    const current = this.session();
    if (current?.user.id === previous.user.id && current.device.id === previous.device.id
      && current.tokens.refreshToken === previous.tokens.refreshToken) {
      this.session.set({ ...current, tokens: { ...current.tokens, ...tokens } });
    }
  }

  async ensureDeviceIdentity(): Promise<StoredDeviceKeys> {
    if (!await this.ensureFreshSession()) throw new Error('No se pudo comprobar la sesión para abrir las llaves de este dispositivo. Vuelve a intentar cuando haya conexión.');
    const auth = this.session();
    if (!auth?.device.isTrusted || auth.device.revokedAt) throw new Error('Este dispositivo necesita una vinculación autorizada.');
    const scope = `${auth.user.id}:${auth.device.id}`;
    const generation = this.sessionGeneration?.();
    if (this.deviceIdentityReady && this.deviceIdentityReady.scope !== scope) this.deviceIdentityReady = null;
    if (this.deviceIdentityReady?.scope === scope) {
      const known = this.deviceIdentityReady.keys;
      const local = await this.crypto.currentKeyMaterial(auth.user.alias, auth.device.id).catch(() => null);
      if (this.sessionGeneration?.() !== generation || this.session()?.user.id !== auth.user.id || this.session()?.device.id !== auth.device.id) throw new Error('La sesión cambió durante la apertura de las llaves.');
      if (local?.userId === auth.user.id && this.crypto.samePublicKey(local.publicJwk, known.publicJwk)
        && this.crypto.samePublicKey(local.privateJwk, known.privateJwk) && local.privateJwk.d === known.privateJwk.d) {
        this.deviceIdentityError?.set(''); this.deviceIdentityNeedsRelink?.set(false); return local;
      }
      this.deviceIdentityReady = null;
    }
    if (this.deviceIdentityOperation?.scope === scope) return this.deviceIdentityOperation.promise;
    const validationEpoch = this.deviceIdentityValidationEpoch;
    const promise = this.reconcileDeviceIdentity(auth).then(keys => {
      const current = this.session();
      if (current && this.deviceIdentityValidationEpoch === validationEpoch && current.user.id === keys.userId && current.device.id === keys.deviceId) {
        this.deviceIdentityReady = { scope: `${current.user.id}:${current.device.id}`, keys };
      }
      if (this.deviceIdentityValidationEpoch === validationEpoch) {
        this.deviceIdentityError?.set(''); this.deviceIdentityNeedsRelink?.set(false);
      }
      return keys;
    }).catch(error => {
      if (this.deviceIdentityValidationEpoch === validationEpoch && this.session()?.user.id === auth.user.id && this.session()?.device.id === auth.device.id) {
        this.deviceIdentityError?.set(error instanceof Error ? error.message : 'No se pudo abrir la identidad local de este dispositivo.');
      }
      throw error;
    }).finally(() => {
      if (this.deviceIdentityOperation?.promise === promise) this.deviceIdentityOperation = null;
    });
    this.deviceIdentityOperation = { scope, promise };
    return promise;
  }

  invalidateDeviceIdentity(): void {
    this.deviceIdentityReady = null;
    this.deviceIdentityOperation = null;
    this.deviceIdentityValidationEpoch = (this.deviceIdentityValidationEpoch ?? 0) + 1;
  }

  relinkDevice(): Promise<void> {
    // A legacy QR can share the source refresh token. Remove only this local
    // copy; server logout could otherwise sign the user's phone out as well.
    return this.logout(true);
  }

  private async reconcileDeviceIdentity(auth: AuthSession): Promise<StoredDeviceKeys> {
    const epoch = this.sessionWriteEpoch;
    const generation = this.sessionGeneration?.();
    const isCurrent = () => this.sessionWriteEpoch === epoch && this.session()?.user.id === auth.user.id && this.session()?.device.id === auth.device.id;
    const check = () => { if (!isCurrent()) throw new Error('La sesión cambió durante la recuperación de las llaves.'); };
    const [directory, devices, hardwareId] = await Promise.all([
      this.readOwnKeyDirectory(auth, isCurrent),
      this.deviceIdentityJson<AuthSession['device'][]>('/devices', auth, undefined, isCurrent),
      this.hardwareId(),
    ]);
    check();
    const registered = devices.find(device => device.id === auth.device.id && device.userId === auth.user.id && device.isTrusted && !device.revokedAt);
    if (!registered) {
      this.deviceIdentityNeedsRelink?.set(true);
      throw new Error('Este dispositivo ya no está autorizado. Vuelve a vincularlo desde tu teléfono.');
    }
    if (registered.hardwareId !== hardwareId) {
      // Old QR transports copied the source credentials. Give this installation
      // its own session instead of publishing a new key onto the source device.
      const pendingId = `identity-repair:${auth.user.id}:${hardwareId}`;
      let pending = await this.crypto.recoverDeviceIdentity(auth.user.id, auth.user.alias, pendingId, null, isCurrent);
      check();
      if (!pending) {
        const generated = await this.crypto.createDeviceKeys(); check();
        await this.crypto.saveDeviceKeys(auth.user.alias, pendingId, generated, { userId: auth.user.id }, isCurrent);
        pending = await this.crypto.recoverDeviceIdentity(auth.user.id, auth.user.alias, pendingId, generated.publicJwk, isCurrent);
      }
      check();
      if (!pending) throw new Error('No se pudo guardar la identidad local de este dispositivo.');
      // The server can resume only a target created by this repair, bound to
      // a secret derived from the pending private key. Public directory data
      // alone must never let another device claim an existing phone session.
      const proof = await crypto.subtle.digest('SHA-256', authTextEncoder.encode(JSON.stringify([
        'nivra-device-repair-v1', auth.user.id, auth.device.id, hardwareId, pending.privateJwk.d,
      ])));
      const recoveryToken = Array.from(new Uint8Array(proof), byte => byte.toString(16).padStart(2, '0')).join('');
      check();
      const linked = await this.deviceIdentityJson<AuthSession>('/auth/repair-device', auth, {
        deviceName: this.deviceName(), hardwareId, keyBundle: pending.keyBundle, recoveryToken,
      }, isCurrent);
      check();
      if (!this.isValidAuthSession(linked) || linked.user.id !== auth.user.id || linked.device.id === auth.device.id
        || !linked.device.isTrusted || linked.device.revokedAt || linked.device.hardwareId !== hardwareId) throw new Error('No se pudo crear una sesión independiente. Renueva el QR desde tu teléfono.');
      const published = await this.readOwnKeyDirectory(linked, isCurrent); check();
      if (!this.crypto.samePublicKey(pending.publicJwk, published)) throw new Error('No se pudo comprobar la identidad del nuevo dispositivo. Renueva el QR.');
      await this.crypto.saveDeviceKeys(linked.user.alias, linked.device.id, pending, { userId: linked.user.id }, isCurrent);
      const restored = await this.crypto.recoverDeviceIdentity(linked.user.id, linked.user.alias, linked.device.id, published, isCurrent);
      check();
      // persistSession advances sessionWriteEpoch itself and owns the write
      // compare-and-set. Keep the source scope guard without freezing that epoch.
      const sourceScope = () => this.sessionGeneration?.() === generation && this.session()?.user.id === auth.user.id && this.session()?.device.id === auth.device.id;
      if (!restored || !await this.persistSession(linked, sourceScope)) throw new Error('No se pudo guardar la sesión del nuevo dispositivo.');
      return restored;
    }
    let own = await this.crypto.recoverDeviceIdentity(auth.user.id, auth.user.alias, auth.device.id, directory, isCurrent);
    check();
    if (!own) {
      const generated = await this.crypto.createDeviceKeys(); check();
      // Persist and read back before publishing. A storage failure must never
      // leave the server pointing at an identity that this installation lost.
      await this.crypto.saveDeviceKeys(auth.user.alias, auth.device.id, generated, { userId: auth.user.id }, isCurrent);
      own = await this.crypto.recoverDeviceIdentity(auth.user.id, auth.user.alias, auth.device.id, generated.publicJwk, isCurrent);
    }
    check();
    if (!own) throw new Error('No se pudo guardar la llave privada local. Tu historial se ha conservado.');
    if (!this.crypto.samePublicKey(own.publicJwk, directory)) {
      await this.deviceIdentityJson('/keys/prekeys', auth, own.keyBundle, isCurrent); check();
      const published = await this.readOwnKeyDirectory(auth, isCurrent); check();
      if (!this.crypto.samePublicKey(own.publicJwk, published)) throw new Error('No se pudo comprobar la llave publicada. Vuelve a intentar la sincronización.');
    }
    return own;
  }

  private async readOwnKeyDirectory(auth: AuthSession, isCurrent: () => boolean): Promise<JsonWebKey | null> {
    const directories = await this.deviceIdentityJson<Array<{ userId: string; devices: Array<{ deviceId: string; keyBundle?: { identityKey?: string | null } }> }>>('/keys/batch', auth, { userIds: [auth.user.id], aliases: [] }, isCurrent);
    const device = directories.find(directory => directory.userId === auth.user.id)?.devices.find(item => item.deviceId === auth.device.id);
    return this.crypto.parsePublicJwk(device?.keyBundle?.identityKey);
  }

  private async deviceIdentityJson<T>(path: string, auth: AuthSession, body: unknown, isCurrent: () => boolean): Promise<T> {
    const response = await this.api.fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.tokens.accessToken}`, 'X-Nivra-Device-Id': auth.device.id },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, path !== '/auth/repair-device', isCurrent);
    if (!isCurrent()) throw new Error('La sesión cambió durante la recuperación de las llaves.');
    if (!response.ok) {
      if (path === '/auth/repair-device' && [404, 409, 410].includes(response.status)) {
        this.deviceIdentityNeedsRelink?.set(true);
        throw new Error('Esta sesión antigua necesita volver a vincularse. Escanea un QR nuevo desde tu teléfono; el historial local se conserva.');
      }
      throw new Error('No se pudieron comprobar las llaves de este dispositivo. Revisa la conexión y vuelve a intentar.');
    }
    return await response.json() as T;
  }

  async logout(skipServer = false): Promise<void> {
    const current = this.session();
    if (current) {
      await this.removeAccount(current.user.id, !skipServer, current.device.id);
      return;
    }
    if (this.addingAccount()) {
      // Automatic expiry handling has no authority over the saved return slot.
      // Only the user's explicit cancel/logout action may leave this form.
      if (skipServer) return;
      await this.cancelAddAccount();
      return;
    }
    const operation = this.beginAccountOperation();
    const isCurrent = () => this.accountOperationEpoch === operation && !this.destroyed;
    try {
      await this.stopAuthenticationTransports();
      if (!isCurrent()) return;
      await this.nativeFirebaseSignOut();
      if (!isCurrent()) return;
      this.finishAccountActivation(null);
      await this.router.navigateByUrl('/auth', { replaceUrl: true });
    } finally { if (isCurrent()) this.accountsBusy.set(false); }
  }

  async completeAuth(auth: AuthSession, keys: DeviceKeys, isCurrent: () => boolean = () => true): Promise<void> {
    if (!auth?.tokens?.accessToken || !auth.user?.alias || !auth.device?.id) {
      throw new Error('La respuesta de autenticacion no contiene una sesion valida.');
    }
    if (!isCurrent()) return;
    await this.stopQrLogin();
    if (!isCurrent()) return;
    await this.crypto.saveDeviceKeys(auth.user.alias, auth.device.id, keys, { userId: auth.user.id }, isCurrent);
    if (!isCurrent() || !await this.allowAccountActivation(auth, isCurrent)) return;
    if (!await this.persistSession(auth, isCurrent) || !isCurrent()) return;
    this.addingAccount.set(false);
    this.addingReturnUserId = null;
    this.markFreshAuthNavigation();
    await this.router.navigateByUrl(this.consumePostAuthUrl(), { replaceUrl: true });
  }

  deviceName(): string {
    return this.describeDeviceName();
  }

  firebaseClientDiagnostics(): string[] {
    const config = environment.firebase;
    const appCheckSiteKey = String(environment.firebaseAppCheckSiteKey || '').trim();
    const nativeAuth = this.usesNativeFirebasePhoneAuth();
    return [
      `Firebase projectId: ${config.projectId}`,
      `Firebase authDomain: ${config.authDomain}`,
      `Firebase appId: ${config.appId}`,
      `Capacitor Android origin: https://${config.authDomain}`,
      `Auth client: ${nativeAuth ? 'Firebase Android nativo con Play Integrity/SHA' : 'Firebase Web Auth + reCAPTCHA invisible'}`,
      `App Check web: ${appCheckSiteKey ? 'configurado con reCAPTCHA v3' : 'sin site key en environment; no se inicializa App Check web'}`,
      nativeAuth
        ? 'Play Integrity: el flujo SMS del APK usa el SDK nativo Android y lee google-services.json + SHA registrados.'
        : 'Play Integrity: aplica al SDK nativo Android; web/PC usa reCAPTCHA.',
    ];
  }

  private usesNativeFirebasePhoneAuth(): boolean {
    return Capacitor.isNativePlatform?.() === true;
  }

  private async sendNativeFirebaseOtp(normalizedPhone: string, isCurrent: () => boolean): Promise<void> {
    this.nativePhoneVerificationId = '';
    await this.clearNativePhoneListeners();
    if (!isCurrent()) return;

    let requestResolved = false;
    let resolveRequest: () => void = () => undefined;
    let rejectRequest: (error: unknown) => void = () => undefined;
    const resolveOnce = () => {
      if (!requestResolved) {
        requestResolved = true;
        resolveRequest();
      }
    };
    const rejectOnce = (error: unknown) => {
      if (!requestResolved) {
        requestResolved = true;
        rejectRequest(error);
      }
    };
    const waitForCode = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    void waitForCode.catch(() => undefined);
    const cancel = () => rejectOnce(new Error('AUTH_CANCELLED'));
    this.phoneRequestCancel = cancel;
    const register = async (handle: PluginListenerHandle) => {
      if (isCurrent()) this.nativePhoneListenerHandles.push(handle);
      else await handle.remove().catch(() => undefined);
    };

    try {
      const codeSentHandle = await FirebaseAuthentication.addListener('phoneCodeSent', (event) => {
        if (!isCurrent()) return;
        this.nativePhoneVerificationId = event.verificationId;
        resolveOnce();
      });
      await register(codeSentHandle);
      if (!isCurrent()) return;
      const completedHandle = await FirebaseAuthentication.addListener('phoneVerificationCompleted', () => {
        if (!isCurrent()) return;
        void this.completeNativeAutoVerifiedPhone(normalizedPhone, isCurrent)
          .then(resolveOnce)
          .catch(rejectOnce);
      });
      await register(completedHandle);
      if (!isCurrent()) return;
      const failedHandle = await FirebaseAuthentication.addListener('phoneVerificationFailed', (event) => {
        if (!isCurrent()) return;
        rejectOnce(new Error(event.message || 'Firebase no pudo verificar este telefono en Android.'));
      });
      await register(failedHandle);
      if (!isCurrent()) return;

      await FirebaseAuthentication.signInWithPhoneNumber({
        phoneNumber: normalizedPhone,
        timeout: 60,
      });
      await waitForCode;
    } catch (error) {
      if (isCurrent()) {
        this.nativePhoneVerificationId = '';
        await this.clearNativePhoneListeners();
      }
      throw error;
    } finally {
      if (this.phoneRequestCancel === cancel) this.phoneRequestCancel = null;
    }
  }

  private async verifyNativeFirebaseOtp(phone: string, code: string, isCurrent: () => boolean): Promise<void> {
    if (!this.nativePhoneVerificationId) {
      throw new Error('Primero pide el codigo SMS de Firebase.');
    }

    this.busy.set(true);
    try {
      await FirebaseAuthentication.confirmVerificationCode({
        verificationId: this.nativePhoneVerificationId,
        verificationCode: code.trim(),
      });
      if (!isCurrent()) return;
      const result = await FirebaseAuthentication.getIdToken({ forceRefresh: true });
      if (!isCurrent()) return;
      await this.completeFirebasePhoneSignIn(phone, result.token, isCurrent);
      if (!isCurrent()) return;
      this.nativePhoneVerificationId = '';
      await this.clearNativePhoneListeners();
    } catch (error) {
      if (!isCurrent()) return;
      throw new Error(this.firebasePhoneAuthErrorMessage(error, 'No se pudo entrar por telefono.'));
    } finally {
      if (isCurrent()) this.busy.set(false);
    }
  }

  private async completeNativeAutoVerifiedPhone(phone: string, isCurrent: () => boolean): Promise<void> {
    const result = await FirebaseAuthentication.getIdToken({ forceRefresh: true });
    if (!isCurrent()) return;
    await this.completeFirebasePhoneSignIn(phone, result.token, isCurrent);
    if (!isCurrent()) return;
    this.nativePhoneVerificationId = '';
    await this.clearNativePhoneListeners();
  }

  private async completeFirebasePhoneSignIn(phone: string, firebaseToken: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (!firebaseToken) {
      throw new Error('Firebase no entrego un token valido para este telefono.');
    }

    // The phone account is not resolved yet. Reusing the browser's latest
    // key could give a different account ownership of another user's secrets.
    const keys = await this.crypto.createDeviceKeys();
    const device = await this.deviceProfile();
    if (!isCurrent()) return;
    const response = await firstValueFrom(
      this.api.post<FirebasePhoneVerifyResponse>('/api/auth/phone/verify-firebase', {
        firebaseToken,
        deviceName: device.name,
        hardwareId: device.hardwareId,
        keyBundle: keys.keyBundle,
      }, { skipAuth: true }),
    );
    if (!isCurrent()) return;

    if (response.requiresAlias) {
      this.pendingPhoneAlias.set({
        token: response.phoneSetupToken ?? '',
        expiresAt: response.phoneSetupExpiresAt,
        phone: response.phone ?? phone.trim(),
        keys,
      });
      return;
    }

    const auth = response.auth ?? (response as unknown as AuthSession);
    await this.completeAuth(auth, keys, isCurrent);
  }

  private async clearNativePhoneListeners(): Promise<void> {
    const handles = this.nativePhoneListenerHandles.splice(0);
    await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)));
  }

  private async nativeFirebaseSignOut(): Promise<void> {
    if (!this.usesNativeFirebasePhoneAuth()) {
      return;
    }
    await FirebaseAuthentication.signOut().catch(() => undefined);
  }

  private async deviceProfile(): Promise<{ hardwareId: string; name: string }> {
    return {
      hardwareId: await this.hardwareId(),
      name: this.describeDeviceName(),
    };
  }

  private async hardwareId(): Promise<string> {
    const nativeId = await this.nativeHardwareId();
    if (nativeId) {
      localStorage.setItem(HARDWARE_ID_KEY, nativeId);
      return nativeId;
    }

    const existing = localStorage.getItem(HARDWARE_ID_KEY)?.trim();
    if (existing) {
      return existing;
    }

    const id = crypto.randomUUID?.() ?? this.fallbackUuid();
    localStorage.setItem(HARDWARE_ID_KEY, id);
    return id;
  }

  private async nativeHardwareId(): Promise<string | null> {
    if (!Capacitor.isNativePlatform?.()) {
      return null;
    }

    const capacitorWindow = window as unknown as {
      Capacitor?: {
        Plugins?: {
          Device?: {
            getId?: () => Promise<{ identifier?: string | null; uuid?: string | null }>;
          };
        };
      };
    };
    const getId = capacitorWindow.Capacitor?.Plugins?.Device?.getId;
    if (!getId) {
      return null;
    }

    try {
      const result = await getId();
      return result.identifier?.trim() || result.uuid?.trim() || null;
    } catch {
      return null;
    }
  }

  private fallbackUuid(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private describeDeviceName(): string {
    const platform = Capacitor.getPlatform?.() || 'web';
    const os = this.detectOs();
    const browser = this.detectBrowser();
    if (platform !== 'web') {
      return `${os} Nivra Mobile`;
    }
    return `${os} ${browser}`;
  }

  private detectOs(): string {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    if (/android/i.test(ua)) return 'Android';
    if (/iphone|ipad|ipod/i.test(ua) || /iPad|iPhone|iPod/.test(platform)) return 'iOS';
    if (/win/i.test(platform)) return 'Windows';
    if (/mac/i.test(platform)) return 'macOS';
    if (/linux/i.test(platform)) return 'Linux';
    return 'Web';
  }

  private detectBrowser(): string {
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari';
    if (/Firefox\//.test(ua)) return 'Firefox';
    return 'Browser';
  }

  private async completeLocalQrAuth(auth: AuthSession, payload: QrHistoryPayload, localKeys: DeviceKeys, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) return;
    if (!this.isValidAuthSession(auth) || (payload.userId && payload.userId !== auth.user.id)) throw new Error('El historial QR pertenece a otra cuenta.');
    if (!payload.keyMaterial?.privateJwk || !payload.keyMaterial.publicJwk || (payload.keyring !== undefined && !Array.isArray(payload.keyring))) throw new Error('El paquete QR no contiene un historial válido.');
    // The destination identity must have been generated on this device. The
    // sealed source payload supplies historical decryption keys only.
    const response = await this.api.fetch('/keys/batch', {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.tokens.accessToken}`, 'X-Nivra-Device-Id': auth.device.id },
      body: JSON.stringify({ userIds: [auth.user.id], aliases: [] }),
    }, true, isCurrent);
    if (!isCurrent()) return;
    if (!response.ok) throw new Error('Actualiza Nivra y renueva el QR de vinculación.');
    const directories = await response.json() as Array<{ userId: string; devices: Array<{ deviceId: string; keyBundle?: { identityKey?: string | null } }> }>;
    if (!isCurrent()) return;
    const published = directories?.find(directory => directory.userId === auth.user.id)?.devices?.find(device => device.deviceId === auth.device.id);
    if (!this.crypto.samePublicKey(localKeys.publicJwk, this.crypto.parsePublicJwk(published?.keyBundle?.identityKey))) throw new Error('Actualiza Nivra y renueva el QR. No se pudo comprobar la identidad local de este dispositivo.');
    const historical = [...(payload.keyring ?? [])];
    if (!historical.some(key => this.crypto.samePublicKey(key.publicJwk, payload.keyMaterial!.publicJwk))) historical.push(payload.keyMaterial);
    await this.completeImportedAuth(auth, localKeys, historical, isCurrent, payload);
  }

  private async completeImportedAuth(
    auth: AuthSession,
    keyMaterial: Pick<StoredDeviceKeys, 'privateJwk' | 'publicJwk'>,
    keyring?: HistoricalDeviceKeyMaterial[],
    isCurrent: () => boolean = () => true,
    handoff?: Pick<QrHistoryPayload, 'identityTrust' | 'sourceDeviceId'>,
  ): Promise<void> {
    if (!isCurrent() || !await this.allowAccountActivation(auth, isCurrent)) return;
    if (keyring?.length) await this.crypto.importHistoricalDeviceKeys(auth.user.id, auth.user.alias, keyring, isCurrent);
    if (!isCurrent()) return;
    const keys = this.crypto.materialToDeviceKeys(keyMaterial);
    await this.crypto.saveDeviceKeys(auth.user.alias, auth.device.id, keys, { userId: auth.user.id }, isCurrent);
    if (!isCurrent()) return;
    if (handoff?.identityTrust && handoff.sourceDeviceId) {
      // Optional public pins cannot prevent importing a valid private-key history.
      // The payload was opened only after the user approved this destination QR.
      await this.identityTrust.importFromLinkedDevice(JSON.stringify([auth.user.id, auth.device.id]), handoff.sourceDeviceId, handoff.identityTrust, isCurrent).catch(() => undefined);
      if (!isCurrent()) return;
    }
    if (!await this.persistSession(auth, isCurrent) || !isCurrent()) return;
    this.addingAccount.set(false);
    this.addingReturnUserId = null;
    this.markFreshAuthNavigation();
    await this.router.navigateByUrl(this.consumePostAuthUrl(), { replaceUrl: true });
  }

  private markFreshAuthNavigation(): void {
    try {
      sessionStorage.setItem(SKIP_ROUTE_RESTORE_ONCE_KEY, '1');
    } catch {
      // Route restore is a convenience only.
    }
  }

  consumeFreshAuthNavigation(): boolean {
    try {
      const skip = sessionStorage.getItem(SKIP_ROUTE_RESTORE_ONCE_KEY) === '1';
      sessionStorage.removeItem(SKIP_ROUTE_RESTORE_ONCE_KEY);
      return skip;
    } catch {
      return false;
    }
  }

  async ensureSessionRestored(): Promise<boolean> {
    for (const delayMs of [0, 180, 600]) {
      if (this.addingAccount?.()) return false;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await this.restoreProtectedSession();
      if (this.addingAccount?.()) return false;
      if (this.isAuthenticated()) return true;
    }
    return this.isAuthenticated();
  }

  private async persistSession(auth: AuthSession, isCurrent: () => boolean = () => true): Promise<boolean> {
    const epoch = this.sessionWriteEpoch = (this.sessionWriteEpoch ?? 0) + 1;
    const mayWrite = () => !this.destroyed && this.sessionWriteEpoch === epoch && isCurrent();
    if (!mayWrite()) return false;
    if (!await this.accountSessions.upsert(auth, true, mayWrite) || !mayWrite()) return false;
    this.sessionRestoreComplete = true;
    this.clearLegacySessionRecords();
    const previous = this.session();
    if (previous?.user.id === auth.user.id && previous?.device.id === auth.device.id) {
      this.sessionGeneration?.update(value => value + 1);
      this.invalidateDeviceIdentity();
    }
    this.adoptSession(auth);
    return true;
  }

  private async restoreProtectedSession(): Promise<void> {
    if (this.sessionRestoreComplete || this.destroyed || this.addingAccount?.()) return;
    if (this.protectedSessionRestorePromise) return this.protectedSessionRestorePromise;
    const operation = (async () => {
      const restoreEpoch = this.sessionWriteEpoch;
      const initialSession = this.session();
      const mayRestore = () => !this.destroyed && !this.addingAccount?.()
        && this.sessionWriteEpoch === restoreEpoch && this.session() === initialSession;
      try {
        let snapshot = await this.accountSessions.load();
        if (!mayRestore()) return;
        if (snapshot) {
          // The registry, including an empty tombstone, supersedes all v5 records.
          for (let remaining = 2; remaining >= 0; remaining--) {
            const active = snapshot.sessions.find(auth => auth.user.id === snapshot!.activeUserId);
            if (!active || await this.allowAccountActivation(active, mayRestore)) {
              if (!mayRestore()) return;
              this.sessionRestoreComplete = true;
              this.clearLegacySessionRecords();
              this.adoptSession(active ?? null);
              return;
            }
            snapshot = await this.accountSessions.load();
            if (!snapshot || !mayRestore()) return;
          }
          return;
        }
        const encrypted = this.readProtectedSessionEnvelope();
        if (localStorage.getItem(PROTECTED_SESSION_KEY) && !encrypted) throw new Error('Sesión protegida no válida.');
        const legacy = encrypted ? await this.decryptProtectedSession(encrypted) : this.readPlainSession();
        if (!mayRestore()) return;
        if (legacy) {
          if (!this.isValidAuthSession(legacy)) throw new Error('Sesión no válida.');
          if (!await this.allowAccountActivation(legacy, mayRestore) || !mayRestore()) return;
          if (!await this.accountSessions.upsert(legacy, true, mayRestore) || !mayRestore()) return;
          this.adoptSession(legacy);
        }
        if (!mayRestore() && this.session() !== legacy) return;
        this.sessionRestoreComplete = true;
        this.clearLegacySessionRecords();
      } catch {
        if (mayRestore()) this.accountError.set('No pudimos abrir las cuentas guardadas. Sus datos se han conservado. Desbloquea el dispositivo y vuelve a intentar.');
      }
    })().finally(() => {
      if (this.protectedSessionRestorePromise === operation) this.protectedSessionRestorePromise = null;
    });
    this.protectedSessionRestorePromise = operation;
    return operation;
  }

  private async decryptProtectedSession(envelope: ProtectedAuthSessionEnvelope): Promise<unknown> {
    if (envelope.v !== 1 || envelope.alg !== 'NIVRA-AUTH-SESSION-A256GCM') {
      throw new Error('Envelope de sesion protegida no soportado.');
    }
    const key = await this.authSessionProtectorKey(false);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.toArrayBuffer(this.crypto.ub64(envelope.iv)) },
      key,
      this.toArrayBuffer(this.crypto.ub64(envelope.ciphertext)),
    );
    return JSON.parse(authTextDecoder.decode(plain));
  }

  private async authSessionProtectorKey(create = true): Promise<CryptoKey> {
    const secret = await this.secureVault.getOrCreateSecret('auth-session', { create }).catch(() => null);
    if (!secret) {
      throw new Error('No se pudo abrir el protector seguro de la sesion.');
    }
    return globalThis.crypto.subtle.importKey('raw', this.toArrayBuffer(this.crypto.ub64(secret)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  private readProtectedSessionEnvelope(): ProtectedAuthSessionEnvelope | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROTECTED_SESSION_KEY) || 'null') as ProtectedAuthSessionEnvelope | null;
      return parsed?.v === 1 && parsed.alg === 'NIVRA-AUTH-SESSION-A256GCM' ? parsed : null;
    } catch {
      return null;
    }
  }

  private consumePostAuthUrl(): string {
    const groupCode = sessionStorage.getItem('nivra_pending_group_invite');
    sessionStorage.removeItem('nivra_pending_group_invite');
    if (groupCode && /^[A-Za-z0-9_-]{43}$/.test(groupCode)) return `/group/invite#${groupCode}`;
    const inviteCode = localStorage.getItem(PENDING_VAULT_INVITE_KEY);
    if (inviteCode) {
      localStorage.removeItem(PENDING_VAULT_INVITE_KEY);
      return `/app/vault?invite=${encodeURIComponent(inviteCode)}`;
    }
    const contactAlias = localStorage.getItem(PENDING_CONTACT_ALIAS_KEY);
    if (contactAlias) {
      localStorage.removeItem(PENDING_CONTACT_ALIAS_KEY);
      return `/contact?alias=${encodeURIComponent(contactAlias)}`;
    }
    return '/app/chats';
  }

  private refreshRetryDelayMs(response: Response): number {
    const retryAfter = response.headers.get('Retry-After');
    const retrySeconds = Number(retryAfter);
    if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
      return Math.min(5 * 60 * 1000, retrySeconds * 1000);
    }
    const retryDate = retryAfter ? Date.parse(retryAfter) : NaN;
    if (Number.isFinite(retryDate)) {
      return Math.min(5 * 60 * 1000, Math.max(15000, retryDate - Date.now()));
    }
    return response.status === 429 ? 60000 : 30000;
  }

  private async isForceWipeResponse(response: Response): Promise<boolean> {
    if (response.headers.get('X-Nivra-Action') === 'FORCE_WIPE') {
      return true;
    }
    try {
      const body = await response.clone().json() as { code?: unknown };
      return body?.code === 'FORCE_WIPE';
    } catch {
      return false;
    }
  }

  private loadSession(): AuthSession | null {
    return this.readPlainSession();
  }

  private readPlainSession(): AuthSession | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as unknown;
      return this.isValidAuthSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private isValidAuthSession(value: unknown): value is AuthSession {
    const candidate = value as AuthSession | null | undefined;
    return Boolean(candidate?.tokens?.accessToken && candidate.tokens.refreshToken && candidate.user?.id && candidate.device?.id);
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  private hasUsableAccessToken(session: AuthSession | null, skewMs = TOKEN_REFRESH_SKEW_MS): boolean {
    const token = session?.tokens?.accessToken;
    if (!token) {
      return false;
    }
    const expiresAt = this.accessTokenExpiresAt(session?.tokens);
    return expiresAt === null || expiresAt - Date.now() > skewMs;
  }

  private accessTokenExpiresAt(tokens: AuthSession['tokens'] | null | undefined): number | null {
    const explicit = Date.parse(tokens?.accessTokenExpiresAt || tokens?.expiresAt || '');
    if (Number.isFinite(explicit)) {
      return explicit;
    }
    const token = tokens?.accessToken || '';
    try {
      const [, payload] = token.split('.');
      if (!payload) {
        return null;
      }
      const decoded = JSON.parse(this.base64UrlDecode(payload)) as {
        exp?: unknown;
        ExpiresUnixSeconds?: unknown;
        expiresUnixSeconds?: unknown;
      };
      const seconds = Number(decoded.exp ?? decoded.ExpiresUnixSeconds ?? decoded.expiresUnixSeconds);
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    } catch {
      return null;
    }
  }

  private base64UrlDecode(value: string): string {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + (4 - value.length % 4) % 4, '=');
    return decodeURIComponent(Array.from(atob(padded), (char) =>
      `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
    ).join(''));
  }

  private async ensureFirebaseAuth(): Promise<Auth> {
    if (this.firebaseAuth) {
      return this.firebaseAuth;
    }

    const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    if (existing) {
      await deleteApp(existing).catch(() => undefined);
      this.firebaseAppCheck = null;
    }
    this.firebaseApp = initializeApp(environment.firebase, FIREBASE_APP_NAME);
    this.ensureFirebaseAppCheck(this.firebaseApp);
    this.firebaseAuth = getAuth(this.firebaseApp);
    useDeviceLanguage(this.firebaseAuth);
    return this.firebaseAuth;
  }

  private ensureFirebaseAppCheck(app: FirebaseApp): void {
    const siteKey = String(environment.firebaseAppCheckSiteKey || '').trim();
    if (!siteKey || this.firebaseAppCheck) {
      return;
    }
    try {
      this.firebaseAppCheck = initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch {
      this.firebaseAppCheck = null;
    }
  }

  private async ensureRecaptcha(auth: Auth): Promise<RecaptchaVerifier> {
    const element = this.ensureRecaptchaContainer();
    if (this.recaptchaVerifier) {
      return this.recaptchaVerifier;
    }

    this.recaptchaVerifier = new RecaptchaVerifier(auth, element, {
      size: 'invisible',
      callback: () => undefined,
      'expired-callback': () => void this.resetRecaptcha(),
    });
    await this.recaptchaVerifier.render();
    return this.recaptchaVerifier;
  }

  private ensureRecaptchaContainer(): HTMLElement {
    let element = document.querySelector<HTMLElement>('#phoneRecaptcha');
    if (element) {
      return element;
    }
    element = document.createElement('div');
    element.id = 'phoneRecaptcha';
    element.className = 'recaptcha-slot';
    document.body.appendChild(element);
    return element;
  }

  private async resetRecaptcha(options: { clear?: boolean } = {}): Promise<void> {
    if (!this.recaptchaVerifier) {
      return;
    }
    if (options.clear) {
      this.recaptchaVerifier.clear();
      this.recaptchaVerifier = null;
      this.ensureRecaptchaContainer().innerHTML = '';
      return;
    }
    try {
      const widgetId = await this.recaptchaVerifier.render();
      window.grecaptcha?.reset?.(widgetId);
    } catch {
      this.recaptchaVerifier.clear();
      this.recaptchaVerifier = null;
    }
  }

  private firebasePhoneAuthErrorMessage(error: unknown, fallback: string): string {
    const candidate = error as { code?: string; message?: string };
    const code = `${candidate?.code || ''} ${candidate?.message || ''}`.toLowerCase();
    if (code.includes('invalid-phone-number')) return 'Revisa el numero con codigo de pais, por ejemplo +593...';
    if (code.includes('captcha-check-failed') || code.includes('missing-app-credential') || code.includes('invalid-app-credential')) return 'No se pudo validar reCAPTCHA. Reintenta el envio del codigo.';
    if (code.includes('app-not-authorized') || code.includes('unauthorized-domain') || code.includes('requests-from-referer')) return 'Firebase bloqueo el origen de esta app. Actualiza la APK y vuelve a pedir el SMS.';
    if (code.includes('too-many-requests') || code.includes('quota-exceeded')) return 'Firebase bloqueo temporalmente los SMS por demasiados intentos.';
    if (code.includes('invalid-verification-code')) return 'Ese codigo no coincide. Revisalo e intenta otra vez.';
    if (code.includes('code-expired')) return 'Ese codigo vencio. Pide uno nuevo.';
    if (code.includes('network-request-failed')) return 'No hay conexion estable con Firebase. Revisa internet e intenta otra vez.';
    return candidate?.message || fallback;
  }

  private parseQrLoginChallenge(rawText: string): ParsedQrLoginChallenge {
    const text = this.extractQrLoginText(rawText);
    if (!text) {
      throw new Error('Pega o escanea un QR de Nivra.');
    }
    let payload: Record<string, unknown> | null = null;
    try {
      const url = new URL(text);
      const params = url.searchParams;
      const protocol = url.protocol.toLowerCase();
      const route = `${url.hostname}${url.pathname}`.replace(/^\/+|\/+$/g, '').toLowerCase();
      const explicitType = params.get('type') || params.get('t');
      const isNivraScheme = protocol === 'nivra:';
      const isQrRoute = route === 'login/qr' || route.endsWith('/login/qr');
      if (!isNivraScheme && explicitType !== 'nivra-qr-login' && !isQrRoute) {
        throw new Error('Ese QR no pertenece a Nivra.');
      }
      if (isNivraScheme && !isQrRoute && explicitType !== 'nivra-qr-login') {
        throw new Error('Ese QR no pertenece a Nivra.');
      }
      payload = {
        type: explicitType || 'nivra-qr-login',
        qrId: this.qrParam(params, 'qrId', 'qrid', 'qr_id'),
        code: this.qrParam(params, 'code', 'c'),
        syncToken: this.qrParam(params, 'syncToken', 'sync_token', 'token'),
        publicKey: this.qrParam(params, 'publicKey', 'public_key'),
        publicSpki: this.qrParam(params, 'publicSpki', 'public_spki', 'spki'),
        pk: this.qrParam(params, 'pk', 'key'),
        k: params.get('k'),
        connectionId: this.qrParam(params, 'connectionId', 'connection_id', 'cid'),
        expiresAt: this.qrParam(params, 'exp', 'expiresAt', 'expires_at'),
      };
    } catch {
      try {
        payload = text.startsWith('{') ? JSON.parse(text) as Record<string, unknown> : this.crypto.jsonFromBase64Url<Record<string, unknown>>(text);
      } catch {
        throw new Error('Ese QR no pertenece a Nivra.');
      }
    }
    if (payload?.['type'] !== 'nivra-qr-login') {
      throw new Error('QR de vinculacion invalido.');
    }
    if (typeof payload['syncToken'] === 'string' && (!payload['qrId'] || !payload['code'])) {
      const [qrId, code] = payload['syncToken'].split('.');
      payload['qrId'] ||= qrId;
      payload['code'] ||= code;
    }
    const expiresAt = typeof payload['expiresAt'] === 'string' ? payload['expiresAt'] : null;
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      throw new Error('Ese QR ya vencio. Genera uno nuevo.');
    }
    const keyMode = String(payload['k'] || '').toLowerCase();
    const pk = typeof payload['pk'] === 'string' ? payload['pk'] : null;
    const publicKey = typeof payload['publicKey'] === 'string' ? payload['publicKey'] : null;
    const publicSpki = typeof payload['publicSpki'] === 'string'
      ? payload['publicSpki']
      : pk && keyMode === 'spki' ? pk : null;
    const publicJwk = publicKey
      ? this.crypto.jsonFromBase64Url<JsonWebKey>(publicKey)
      : pk && keyMode !== 'spki' ? this.crypto.jsonFromBase64Url<JsonWebKey>(pk) : null;

    return {
      qrId: typeof payload['qrId'] === 'string' ? payload['qrId'] : null,
      code: typeof payload['code'] === 'string' ? payload['code'] : null,
      syncToken: typeof payload['syncToken'] === 'string' ? payload['syncToken'] : null,
      connectionId: typeof payload['connectionId'] === 'string' ? payload['connectionId'] : null,
      publicJwk,
      publicSpki,
      expiresAt,
    };
  }

  private extractQrLoginText(rawText: string): string {
    const text = String(rawText || '').trim();
    if (!text) {
      return '';
    }
    const embedded = text.match(/nivra:\/\/[^\s"'<>]+/i);
    if (embedded?.[0]) {
      return embedded[0];
    }
    const compact = text.replace(/\s+/g, '');
    if (compact.toLowerCase().startsWith('nivra://')) {
      return compact;
    }
    return text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  }

  private qrParam(params: URLSearchParams, ...names: string[]): string | null {
    for (const name of names) {
      const value = params.get(name);
      if (value !== null && value !== '') {
        return value;
      }
    }
    return null;
  }
}
