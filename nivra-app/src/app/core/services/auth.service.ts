import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import {
  Auth,
  ConfirmationResult,
  RecaptchaVerifier,
  getAuth,
  signInWithPhoneNumber,
  useDeviceLanguage,
} from 'firebase/auth';
import { FirebaseApp, deleteApp, getApps, initializeApp } from 'firebase/app';
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

const FIREBASE_APP_NAME = 'nivra-web-phone-auth';
const SESSION_KEY = 'nivra.auth';
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);
  private firebaseApp: FirebaseApp | null = null;
  private firebaseAuth: Auth | null = null;
  private recaptchaVerifier: RecaptchaVerifier | null = null;
  private confirmationResult: ConfirmationResult | null = null;
  private qrConnection: HubConnection | null = null;
  private qrPollTimer: number | null = null;
  private authRefreshPromise: Promise<boolean> | null = null;

  readonly session = signal<AuthSession | null>(this.loadSession());
  readonly pendingPhoneAlias = signal<PhoneAliasChallenge | null>(null);
  readonly busy = signal(false);
  readonly accessToken = computed(() => this.session()?.tokens.accessToken ?? '');
  readonly isAuthenticated = computed(() => Boolean(this.accessToken()));
  readonly hasFreshAccessToken = computed(() => this.hasUsableAccessToken(this.session()));

  ngOnDestroy(): void {
    void this.stopQrLogin();
    void this.resetRecaptcha({ clear: true });
  }

  updateUser(user: NivraUser): void {
    const current = this.session();
    if (!current) {
      return;
    }
    this.persistSession({ ...current, user });
  }

  async loginWithAlias(alias: string, password: string, mode: 'login' | 'register', displayName = ''): Promise<void> {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias || !password) {
      throw new Error('Alias y password son obligatorios.');
    }

    this.busy.set(true);
    try {
      const keys = await this.crypto.prepareDeviceKeys(normalizedAlias, mode === 'register');
      const payload = {
        alias: normalizedAlias,
        password,
        deviceName: this.deviceName(),
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
    if (!this.confirmationResult) {
      throw new Error('Primero pide el codigo SMS de Firebase.');
    }

    this.busy.set(true);
    try {
      const credential = await this.confirmationResult.confirm(code.trim());
      const firebaseToken = await credential.user.getIdToken();
      const keys = await this.crypto.prepareDeviceKeys(null, true);
      const response = await firstValueFrom(
        this.api.post<FirebasePhoneVerifyResponse>('/api/auth/phone/verify-firebase', {
          firebaseToken,
          deviceName: this.deviceName(),
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
        this.confirmationResult = null;
        return;
      }

      const auth = response.auth ?? (response as unknown as AuthSession);
      await this.completeAuth(auth, keys);
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
      const auth = await firstValueFrom(
        this.api.post<AuthSession>('/auth/phone/complete-alias', {
          phoneSetupToken: pending.token,
          alias: normalizedAlias,
          displayName: displayName.trim() || normalizedAlias,
          deviceName: this.deviceName(),
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
    const serverChallenge = await firstValueFrom(
      this.api.post<QrLoginStartResponse>('/auth/qr/start', {
        deviceName: this.deviceName(),
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
    const payload = {
      keyMaterial: {
        privateJwk: keyMaterial.privateJwk,
        publicJwk: keyMaterial.publicJwk,
      },
      sourceDeviceName: this.deviceName(),
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
    const refreshToken = this.session()?.tokens.refreshToken;
    if (!refreshToken) {
      return false;
    }

    this.authRefreshPromise ??= fetch(this.api.url('/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (response) => {
        if (!response.ok) {
          return false;
        }
        const tokens = await response.json() as AuthSession['tokens'];
        const current = this.session();
        if (!current?.tokens || !tokens.accessToken) {
          return false;
        }
        const next = { ...current, tokens };
        this.persistSession(next);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.authRefreshPromise = null;
      });

    return this.authRefreshPromise;
  }

  async ensureFreshSession(options: { force?: boolean; skewMs?: number } = {}): Promise<boolean> {
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
    this.session.set(null);
    this.pendingPhoneAlias.set(null);
    // Logout only removes credentials; NivraDB chat history and conversations must stay local.
    localStorage.removeItem(SESSION_KEY);
    await this.router.navigateByUrl('/auth');
  }

  async completeAuth(auth: AuthSession, keys: DeviceKeys): Promise<void> {
    if (!auth?.tokens?.accessToken || !auth.user?.alias || !auth.device?.id) {
      throw new Error('La respuesta de autenticacion no contiene una sesion valida.');
    }
    await this.crypto.saveDeviceKeys(auth.user.alias, auth.device.id, keys, { userId: auth.user.id });
    this.persistSession(auth);
    await this.router.navigateByUrl('/app/chats');
  }

  deviceName(): string {
    const platform = navigator.platform || 'Web';
    return `${platform} Nivra`;
  }

  private async completeImportedAuth(
    auth: AuthSession,
    keyMaterial: Pick<StoredDeviceKeys, 'privateJwk' | 'publicJwk'>,
  ): Promise<void> {
    const keys = this.crypto.materialToDeviceKeys(keyMaterial);
    await this.crypto.saveDeviceKeys(auth.user.alias, auth.device.id, keys, { userId: auth.user.id });
    this.persistSession(auth);
    await this.router.navigateByUrl('/app/chats');
  }

  private persistSession(auth: AuthSession): void {
    this.session.set(auth);
    localStorage.setItem(SESSION_KEY, JSON.stringify(auth));
  }

  private loadSession(): AuthSession | null {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as AuthSession | null;
    } catch {
      return null;
    }
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
      const [payload] = token.split('.', 1);
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
    }
    this.firebaseApp = initializeApp(environment.firebase, FIREBASE_APP_NAME);
    this.firebaseAuth = getAuth(this.firebaseApp);
    useDeviceLanguage(this.firebaseAuth);
    return this.firebaseAuth;
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
    if (code.includes('app-not-authorized') || code.includes('unauthorized-domain')) return 'Este dominio no esta autorizado en Firebase Authentication.';
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
