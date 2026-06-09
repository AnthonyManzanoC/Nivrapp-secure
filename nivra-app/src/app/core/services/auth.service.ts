import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
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
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { environment } from '../../../environments/environment';
import { NativeSecureVaultService } from './native-secure-vault.service';

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
  private readonly secureVault = inject(NativeSecureVaultService);
  private readonly router = inject(Router);
  private firebaseApp: FirebaseApp | null = null;
  private firebaseAppCheck: AppCheck | null = null;
  private firebaseAuth: Auth | null = null;
  private recaptchaVerifier: RecaptchaVerifier | null = null;
  private confirmationResult: ConfirmationResult | null = null;
  private nativePhoneVerificationId = '';
  private nativePhoneListenerHandles: PluginListenerHandle[] = [];
  private qrConnection: HubConnection | null = null;
  private qrPollTimer: number | null = null;
  private authRefreshPromise: Promise<boolean> | null = null;
  private protectedSessionRestorePromise: Promise<void> | null = null;
  private refreshBackoffUntil = 0;
  private refreshHardFailure = false;

  readonly session = signal<AuthSession | null>(this.loadSession());
  readonly pendingPhoneAlias = signal<PhoneAliasChallenge | null>(null);
  readonly busy = signal(false);
  readonly forceWipeRequested = signal(0);
  readonly accessToken = computed(() => this.session()?.tokens.accessToken ?? '');
  readonly isAuthenticated = computed(() => Boolean(this.accessToken()));
  readonly hasFreshAccessToken = computed(() => this.hasUsableAccessToken(this.session()));

  constructor() {
    void this.restoreProtectedSession();
    void this.hardwareId();
  }

  ngOnDestroy(): void {
    void this.stopQrLogin();
    void this.resetRecaptcha({ clear: true });
    void this.clearNativePhoneListeners();
  }

  updateUser(user: NivraUser): void {
    const current = this.session();
    if (!current) {
      return;
    }
    void this.persistSession({ ...current, user }).catch(() => undefined);
  }

  async loginWithAlias(alias: string, password: string, mode: 'login' | 'register', displayName = ''): Promise<void> {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias || !password) {
      throw new Error('Alias y password son obligatorios.');
    }

    this.busy.set(true);
    try {
      const keys = await this.crypto.prepareDeviceKeys(normalizedAlias, mode === 'register');
      const device = await this.deviceProfile();
      const payload = {
        alias: normalizedAlias,
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
      await this.completeAuth(auth, keys);
    } finally {
      this.busy.set(false);
    }
  }

  async sendFirebaseOtp(phone: string): Promise<void> {
    const normalizedPhone = phone.trim();
    if (!normalizedPhone) {
      throw new Error('Ingresa tu telefono con codigo de pais.');
    }

    this.busy.set(true);
    try {
      if (this.usesNativeFirebasePhoneAuth()) {
        await this.sendNativeFirebaseOtp(normalizedPhone);
        return;
      }

      const auth = await this.ensureFirebaseAuth();
      const verifier = await this.ensureRecaptcha(auth);
      this.confirmationResult = await signInWithPhoneNumber(auth, normalizedPhone, verifier);
    } catch (error) {
      await this.resetRecaptcha({ clear: true });
      throw new Error(this.firebasePhoneAuthErrorMessage(error, 'No se pudo enviar el codigo SMS.'));
    } finally {
      this.busy.set(false);
    }
  }

  async verifyFirebaseOtp(phone: string, code: string): Promise<void> {
    if (!phone.trim() || !code.trim()) {
      throw new Error('Telefono y codigo son obligatorios.');
    }

    if (this.usesNativeFirebasePhoneAuth()) {
      await this.verifyNativeFirebaseOtp(phone, code);
      return;
    }

    if (!this.confirmationResult) {
      throw new Error('Primero pide el codigo SMS de Firebase.');
    }

    this.busy.set(true);
    try {
      const credential = await this.confirmationResult.confirm(code.trim());
      const firebaseToken = await credential.user.getIdToken();
      await this.completeFirebasePhoneSignIn(phone, firebaseToken);
      this.confirmationResult = null;
    } catch (error) {
      throw new Error(this.firebasePhoneAuthErrorMessage(error, 'No se pudo entrar por telefono.'));
    } finally {
      this.busy.set(false);
    }
  }

  async completePhoneAlias(alias: string, displayName = ''): Promise<void> {
    const pending = this.pendingPhoneAlias();
    const normalizedAlias = alias.trim();
    if (!pending?.token || !pending.keys || !normalizedAlias) {
      throw new Error('Escoge tu alias para terminar la cuenta.');
    }

    this.busy.set(true);
    try {
      const device = await this.deviceProfile();
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
      this.pendingPhoneAlias.set(null);
      await this.completeAuth(auth, pending.keys);
    } finally {
      this.busy.set(false);
    }
  }

  async startQrLogin(): Promise<QrLoginChallenge> {
    await this.stopQrLogin();
    const ephemeral = await this.crypto.createQrEphemeralKeys();
    const device = await this.deviceProfile();
    const serverChallenge = await firstValueFrom(
      this.api.post<QrLoginStartResponse>('/auth/qr/start', {
        deviceName: device.name,
        hardwareId: device.hardwareId,
        keyBundle: null,
        publicKey: this.crypto.base64UrlJson(ephemeral.publicJwk),
      }, { skipAuth: true }),
    );

    const connection = new HubConnectionBuilder()
      .withUrl(this.api.url(`/hubs/realtime?${new URLSearchParams({
        qr_login_id: serverChallenge.qrId,
        qr_code: serverChallenge.code,
      }).toString()}`), { withCredentials: false })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .configureLogging(LogLevel.None)
      .build();

    let finished = false;
    const finish = async (authorization: QrLoginAuthorizedResponse | { encryptedPayload?: string | null; auth?: AuthSession | null }) => {
      if (finished) {
        return;
      }
      const auth = authorization.auth;
      const encryptedPayload = authorization.encryptedPayload;
      if (!auth?.tokens?.accessToken || !encryptedPayload) {
        throw new Error('La autorizacion QR no contiene una sesion valida.');
      }
      finished = true;
      const payload = await this.crypto.decryptQrPayload<{ keyMaterial?: Pick<StoredDeviceKeys, 'privateJwk' | 'publicJwk'> }>(
        encryptedPayload,
        ephemeral.privateKey,
      );
      if (!payload.keyMaterial?.privateJwk || !payload.keyMaterial.publicJwk) {
        throw new Error('El paquete QR no contiene llaves locales.');
      }
      await this.stopQrLogin();
      await this.completeImportedAuth(auth, payload.keyMaterial);
    };

    connection.on('QrAuthorized', (authorization: QrLoginAuthorizedResponse) => void finish(authorization));
    connection.on('auth.qrAuthorized', (authorization: QrLoginAuthorizedResponse) => void finish(authorization));
    connection.on('qr-login-success', (encryptedPayload: string) => {
      void this.crypto.decryptQrPayload<{
        auth?: AuthSession;
        keyMaterial?: Pick<StoredDeviceKeys, 'privateJwk' | 'publicJwk'>;
      }>(encryptedPayload, ephemeral.privateKey)
        .then(async (payload) => {
          if (!payload.auth?.tokens?.accessToken || !payload.keyMaterial?.privateJwk || !payload.keyMaterial.publicJwk) {
            throw new Error('El paquete QR no contiene una sesion valida.');
          }
          await this.stopQrLogin();
          await this.completeImportedAuth(payload.auth, payload.keyMaterial);
        });
    });

    await connection.start();
    this.qrConnection = connection;
    const expiresAt = serverChallenge.expiresAt;
    this.qrPollTimer = window.setInterval(() => {
      if (finished || Date.parse(expiresAt) <= Date.now()) {
        void this.stopQrLogin();
        return;
      }
      void firstValueFrom(this.api.get<QrLoginStatusResponse>(
        `/auth/qr/status/${encodeURIComponent(serverChallenge.qrId)}?code=${encodeURIComponent(serverChallenge.code)}`,
        { skipAuth: true },
      ))
        .then((status) => {
          if (status.status === 'authorized') {
            return finish(status);
          }
          return undefined;
        })
        .catch(() => undefined);
    }, 2500);
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
    const device = await this.deviceProfile();
    const payload = {
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
    if (challenge.qrId && challenge.code) {
      await firstValueFrom(this.api.post('/api/auth/qr-login', {
        qrId: challenge.qrId,
        code: challenge.code,
        encryptedPayload: sealed,
      }));
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
    await this.restoreProtectedSession();
    const refreshToken = this.session()?.tokens.refreshToken;
    if (!refreshToken) {
      this.refreshHardFailure = true;
      return false;
    }
    if (Date.now() < this.refreshBackoffUntil) {
      this.refreshHardFailure = false;
      return false;
    }

    const currentSession = this.session();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (currentSession?.device?.id) {
      headers['X-Nivra-Device-Id'] = currentSession.device.id;
    }

    this.authRefreshPromise ??= fetch(this.api.url('/auth/refresh'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (response) => {
        if (!response.ok) {
          if (await this.isForceWipeResponse(response)) {
            this.forceWipeRequested.update((value) => value + 1);
            this.refreshHardFailure = true;
            return false;
          }
          this.refreshHardFailure = response.status === 401 || response.status === 403;
          if (response.status === 429 || response.status >= 500) {
            this.refreshBackoffUntil = Date.now() + this.refreshRetryDelayMs(response);
          }
          return false;
        }
        const tokens = await response.json() as AuthSession['tokens'];
        const current = this.session();
        if (!current?.tokens || !tokens.accessToken) {
          this.refreshHardFailure = true;
          return false;
        }
        this.refreshHardFailure = false;
        this.refreshBackoffUntil = 0;
        const next = { ...current, tokens };
        await this.persistSession(next);
        return true;
      })
      .catch(() => {
        this.refreshHardFailure = false;
        this.refreshBackoffUntil = Date.now() + 30000;
        return false;
      })
      .finally(() => {
        this.authRefreshPromise = null;
      });

    return this.authRefreshPromise;
  }

  lastRefreshFailedPermanently(): boolean {
    return this.refreshHardFailure;
  }

  async ensureFreshSession(options: { force?: boolean; skewMs?: number } = {}): Promise<boolean> {
    await this.restoreProtectedSession();
    const current = this.session();
    if (!current?.tokens?.accessToken || !current.tokens.refreshToken) {
      return false;
    }
    if (!options.force && this.hasUsableAccessToken(current, options.skewMs ?? TOKEN_REFRESH_SKEW_MS)) {
      return true;
    }
    return this.refreshToken();
  }

  async logout(skipServer = false): Promise<void> {
    if (!skipServer && this.accessToken()) {
      await firstValueFrom(this.api.post('/auth/logout', {}, {})).catch(() => null);
    }
    await this.stopQrLogin();
    await this.resetRecaptcha({ clear: true });
    await this.clearNativePhoneListeners();
    await this.nativeFirebaseSignOut();
    this.session.set(null);
    this.pendingPhoneAlias.set(null);
    // Logout only removes credentials; NivraDB chat history and conversations must stay local.
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PROTECTED_SESSION_KEY);
    await this.secureVault.clearSecret('auth-session').catch(() => undefined);
    await this.router.navigateByUrl('/auth');
  }

  async completeAuth(auth: AuthSession, keys: DeviceKeys): Promise<void> {
    if (!auth?.tokens?.accessToken || !auth.user?.alias || !auth.device?.id) {
      throw new Error('La respuesta de autenticacion no contiene una sesion valida.');
    }
    await this.crypto.saveDeviceKeys(auth.user.alias, auth.device.id, keys, { userId: auth.user.id });
    this.markFreshAuthNavigation();
    await this.persistSession(auth);
    await this.router.navigateByUrl(this.consumePostAuthUrl());
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

  private async sendNativeFirebaseOtp(normalizedPhone: string): Promise<void> {
    this.nativePhoneVerificationId = '';
    await this.clearNativePhoneListeners();

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

    try {
      const codeSentHandle = await FirebaseAuthentication.addListener('phoneCodeSent', (event) => {
        this.nativePhoneVerificationId = event.verificationId;
        resolveOnce();
      });
      const completedHandle = await FirebaseAuthentication.addListener('phoneVerificationCompleted', () => {
        void this.completeNativeAutoVerifiedPhone(normalizedPhone)
          .then(resolveOnce)
          .catch(rejectOnce);
      });
      const failedHandle = await FirebaseAuthentication.addListener('phoneVerificationFailed', (event) => {
        rejectOnce(new Error(event.message || 'Firebase no pudo verificar este telefono en Android.'));
      });
      this.nativePhoneListenerHandles.push(codeSentHandle, completedHandle, failedHandle);

      await FirebaseAuthentication.signInWithPhoneNumber({
        phoneNumber: normalizedPhone,
        timeout: 60,
      });
      await waitForCode;
    } catch (error) {
      this.nativePhoneVerificationId = '';
      await this.clearNativePhoneListeners();
      throw error;
    }
  }

  private async verifyNativeFirebaseOtp(phone: string, code: string): Promise<void> {
    if (!this.nativePhoneVerificationId) {
      throw new Error('Primero pide el codigo SMS de Firebase.');
    }

    this.busy.set(true);
    try {
      await FirebaseAuthentication.confirmVerificationCode({
        verificationId: this.nativePhoneVerificationId,
        verificationCode: code.trim(),
      });
      const result = await FirebaseAuthentication.getIdToken({ forceRefresh: true });
      await this.completeFirebasePhoneSignIn(phone, result.token);
      this.nativePhoneVerificationId = '';
      await this.clearNativePhoneListeners();
    } catch (error) {
      throw new Error(this.firebasePhoneAuthErrorMessage(error, 'No se pudo entrar por telefono.'));
    } finally {
      this.busy.set(false);
    }
  }

  private async completeNativeAutoVerifiedPhone(phone: string): Promise<void> {
    const result = await FirebaseAuthentication.getIdToken({ forceRefresh: true });
    await this.completeFirebasePhoneSignIn(phone, result.token);
    this.nativePhoneVerificationId = '';
    await this.clearNativePhoneListeners();
  }

  private async completeFirebasePhoneSignIn(phone: string, firebaseToken: string): Promise<void> {
    if (!firebaseToken) {
      throw new Error('Firebase no entrego un token valido para este telefono.');
    }

    const keys = await this.crypto.prepareDeviceKeys(null, false);
    const device = await this.deviceProfile();
    const response = await firstValueFrom(
      this.api.post<FirebasePhoneVerifyResponse>('/api/auth/phone/verify-firebase', {
        firebaseToken,
        deviceName: device.name,
        hardwareId: device.hardwareId,
        keyBundle: keys.keyBundle,
      }, { skipAuth: true }),
    );

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
    await this.completeAuth(auth, keys);
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

  private async completeImportedAuth(
    auth: AuthSession,
    keyMaterial: Pick<StoredDeviceKeys, 'privateJwk' | 'publicJwk'>,
  ): Promise<void> {
    const keys = this.crypto.materialToDeviceKeys(keyMaterial);
    await this.crypto.saveDeviceKeys(auth.user.alias, auth.device.id, keys, { userId: auth.user.id });
    this.markFreshAuthNavigation();
    await this.persistSession(auth);
    await this.router.navigateByUrl(this.consumePostAuthUrl());
  }

  private markFreshAuthNavigation(): void {
    try {
      sessionStorage.setItem(SKIP_ROUTE_RESTORE_ONCE_KEY, '1');
    } catch {
      // Route restore is a convenience only.
    }
  }

  async ensureSessionRestored(): Promise<boolean> {
    await this.restoreProtectedSession();
    return this.isAuthenticated();
  }

  private async persistSession(auth: AuthSession): Promise<void> {
    this.session.set(auth);
    if (this.secureVault.requiresProtection()) {
      await this.persistProtectedSession(auth);
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(auth));
    localStorage.removeItem(PROTECTED_SESSION_KEY);
  }

  private async restoreProtectedSession(): Promise<void> {
    if (!this.secureVault.requiresProtection()) {
      return;
    }
    this.protectedSessionRestorePromise ??= (async () => {
      const encrypted = this.readProtectedSessionEnvelope();
      if (encrypted) {
        try {
          const restored = await this.decryptProtectedSession(encrypted);
          if (this.isValidAuthSession(restored)) {
            this.session.set(restored);
            localStorage.removeItem(SESSION_KEY);
            return;
          }
        } catch {
          // A wiped or rotated native secret makes the protected session intentionally unusable.
        }
        this.session.set(null);
        localStorage.removeItem(PROTECTED_SESSION_KEY);
        localStorage.removeItem(SESSION_KEY);
        return;
      }

      const legacy = this.readPlainSession();
      if (legacy) {
        this.session.set(legacy);
        try {
          await this.persistProtectedSession(legacy);
        } catch {
          this.session.set(null);
          localStorage.removeItem(PROTECTED_SESSION_KEY);
          localStorage.removeItem(SESSION_KEY);
        }
        return;
      }

      localStorage.removeItem(SESSION_KEY);
    })().finally(() => {
      this.protectedSessionRestorePromise = null;
    });
    await this.protectedSessionRestorePromise;
  }

  private async persistProtectedSession(auth: AuthSession): Promise<void> {
    const key = await this.authSessionProtectorKey();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      authTextEncoder.encode(JSON.stringify(auth)),
    );
    const envelope: ProtectedAuthSessionEnvelope = {
      v: 1,
      alg: 'NIVRA-AUTH-SESSION-A256GCM',
      iv: this.crypto.b64(iv),
      ciphertext: this.crypto.b64(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(PROTECTED_SESSION_KEY, JSON.stringify(envelope));
    localStorage.removeItem(SESSION_KEY);
  }

  private async decryptProtectedSession(envelope: ProtectedAuthSessionEnvelope): Promise<unknown> {
    if (envelope.v !== 1 || envelope.alg !== 'NIVRA-AUTH-SESSION-A256GCM') {
      throw new Error('Envelope de sesion protegida no soportado.');
    }
    const key = await this.authSessionProtectorKey();
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.toArrayBuffer(this.crypto.ub64(envelope.iv)) },
      key,
      this.toArrayBuffer(this.crypto.ub64(envelope.ciphertext)),
    );
    return JSON.parse(authTextDecoder.decode(plain));
  }

  private async authSessionProtectorKey(): Promise<CryptoKey> {
    const secret = await this.secureVault.getOrCreateSecret('auth-session').catch(() => null);
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
    const text = rawText.trim();
    if (!text) {
      throw new Error('Pega o escanea un QR de Nivra.');
    }
    let payload: Record<string, unknown> | null = null;
    try {
      const url = new URL(text);
      const params = url.searchParams;
      payload = {
        type: params.get('type') || 'nivra-qr-login',
        qrId: params.get('qrId'),
        code: params.get('code'),
        syncToken: params.get('syncToken'),
        publicKey: params.get('publicKey'),
        publicSpki: params.get('publicSpki'),
        pk: params.get('pk'),
        k: params.get('k'),
        connectionId: params.get('connectionId'),
        expiresAt: params.get('exp') || params.get('expiresAt'),
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
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
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
}
