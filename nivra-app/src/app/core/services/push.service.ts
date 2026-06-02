import { Injectable, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { FirebaseMessaging, Importance, Visibility, type Notification as NativeFcmNotification } from '@capacitor-firebase/messaging';
import { LocalNotifications } from '@capacitor/local-notifications';
import { ToastController } from '@ionic/angular/standalone';
import { deleteApp, initializeApp, getApps, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getMessaging, getToken, isSupported, type MessagePayload, type Messaging, onMessage } from 'firebase/messaging';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { FirebaseWebConfigResponse, MessageResponse, PushStatusResponse, PushTokenResponse, RealtimeEvent } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

type PushSource = 'web-fcm' | 'native-fcm' | 'service-worker-click' | 'native-action' | 'realtime';

const FIREBASE_APP_NAME = 'nivra';
const FIREBASE_RESETTABLE_IDB_NAMES = ['fcm_token_details_db', 'firebase-installations-database'];
const FIREBASE_LOCAL_STORAGE_PREFIXES = ['firebase:', 'firebase-messaging', 'fcm_'];

type FirebaseWebOptions = FirebaseOptions & {
  vapidKey?: string;
};

interface ResolvedFirebaseWebConfig {
  firebase: FirebaseOptions;
  vapidKey: string;
  sdkVersion: string;
}

interface NivraRuntimeGlobals {
  NIVRA_FIREBASE_CONFIG?: Partial<FirebaseWebOptions>;
  NIVRA_FIREBASE_VAPID_KEY?: string;
  NIVRA_FIREBASE_SDK_VERSION?: string;
}

@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly realtime = inject(SignalrService);
  private readonly toastController = inject(ToastController);
  private foregroundBound = false;
  private serviceWorkerBound = false;
  private nativeBound = false;
  private initializing = false;
  private webConfigPromise?: Promise<ResolvedFirebaseWebConfig | null>;
  private readonly visualDedupe = new Map<string, number>();

  readonly supported = signal(false);
  readonly permission = signal<NotificationPermission | 'unsupported'>('default');
  readonly serverReady = signal(false);
  readonly tokenId = signal<string | null>(null);
  readonly lastMessage = signal<MessagePayload | null>(null);
  readonly error = signal('');

  async initialize(options: { requestPermission?: boolean } = {}): Promise<boolean> {
    if (this.initializing || !this.auth.isAuthenticated()) {
      return false;
    }
    this.initializing = true;
    this.error.set('');
    try {
      await this.refreshStatus();
      this.bindServiceWorkerMessages();
      if (Capacitor.isNativePlatform()) {
        return this.initializeNativeFirebase(options);
      }

      if (!('Notification' in window)) {
        this.permission.set('unsupported');
        return false;
      }

      if (!('serviceWorker' in navigator)) {
        return this.initializeDesktopNotifications(options);
      }

      const supported = await isSupported().catch(() => false);
      this.supported.set(supported);
      if (!supported) {
        return this.initializeDesktopNotifications(options);
      }

      const permission = await this.ensureWebNotificationPermission(options.requestPermission === true);
      if (permission !== 'granted') {
        return false;
      }

      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      const webConfig = await this.resolveWebFirebaseConfig();
      if (!webConfig) {
        this.error.set('Firebase Web Push no esta configurado.');
        return this.initializeDesktopNotifications(options);
      }
      const token = await this.getWebFcmToken(webConfig.firebase, registration, webConfig.vapidKey);
      if (!token) {
        this.error.set('No se obtuvo token FCM.');
        return false;
      }

      await this.registerServerToken(token);
      return true;
    } catch (error) {
      if (this.isElectronRuntime()) {
        return this.initializeDesktopNotifications(options);
      }
      if (this.shouldResetFirebaseMessagingState(error)) {
        await this.cleanupRejectedWebPushState().catch(() => undefined);
      }
      this.error.set(this.firebaseMessagingErrorMessage(error));
      return false;
    } finally {
      this.initializing = false;
    }
  }

  async requestPermissionAndRegister(): Promise<boolean> {
    return this.initialize({ requestPermission: true });
  }

  async refreshStatus(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }
    const status = await firstValueFrom(this.api.get<PushStatusResponse>('/push-tokens/status')).catch(() => null);
    if (status) {
      this.serverReady.set(status.serverReady);
    }
    if ('Notification' in window) {
      this.permission.set(Notification.permission);
    }
  }

  async revokeCurrentToken(): Promise<void> {
    const id = this.tokenId();
    if (!id) {
      return;
    }
    await firstValueFrom(this.api.delete(`/push-tokens/${encodeURIComponent(id)}`));
    this.tokenId.set(null);
  }

  async notifyRealtimeEvent(event: RealtimeEvent): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }
    const data = this.dataFromRealtimeEvent(event);
    if (!data) {
      return;
    }
    await this.handlePushData(data, 'realtime');
  }

  private bindServiceWorkerMessages(): void {
    if (this.serviceWorkerBound || !('serviceWorker' in navigator)) {
      return;
    }
    navigator.serviceWorker.addEventListener('message', (event) => {
      const payload = event.data as { type?: string; data?: Record<string, string> };
      if (payload?.type !== 'nivra.push') {
        return;
      }
      const data = this.normalizeWebData(payload.data ?? {});
      data['nivraRouteIntent'] = 'tap';
      void this.handlePushData(data, 'service-worker-click');
    });
    this.serviceWorkerBound = true;
  }

  private async initializeDesktopNotifications(options: { requestPermission?: boolean }): Promise<boolean> {
    if (!this.isElectronRuntime() || !('Notification' in window)) {
      this.supported.set(false);
      this.permission.set('unsupported');
      return false;
    }
    this.supported.set(true);
    const permission = await this.ensureWebNotificationPermission(options.requestPermission === true);
    return permission === 'granted';
  }

  private async initializeNativeFirebase(options: { requestPermission?: boolean }): Promise<boolean> {
    const support = await FirebaseMessaging.isSupported().catch(() => ({ isSupported: false }));
    this.supported.set(Boolean(support.isSupported));
    if (!support.isSupported) {
      this.permission.set('unsupported');
      return false;
    }

    let permission = (await FirebaseMessaging.checkPermissions()).receive;
    if (options.requestPermission && permission !== 'granted') {
      permission = (await FirebaseMessaging.requestPermissions()).receive;
    }
    this.permission.set(this.mapNativePermission(permission));
    if (permission !== 'granted') {
      return false;
    }

    await this.ensureNativeChannels(options.requestPermission === true);
    await this.bindNativeFirebaseListeners();
    const token = (await FirebaseMessaging.getToken()).token;
    if (!token) {
      this.error.set('No se obtuvo token FCM nativo.');
      return false;
    }
    await this.registerServerToken(token);
    return true;
  }

  private async resolveWebFirebaseConfig(): Promise<ResolvedFirebaseWebConfig | null> {
    this.webConfigPromise ??= this.loadWebFirebaseConfig();
    return this.webConfigPromise;
  }

  private async loadWebFirebaseConfig(): Promise<ResolvedFirebaseWebConfig | null> {
    const backend = await firstValueFrom(
      this.api.get<FirebaseWebConfigResponse>('/push-tokens/web-config', { skipAuth: true }),
    ).catch(() => null);
    const backendConfig = backend
      ? this.normalizeWebFirebaseConfig({
        apiKey: backend.apiKey,
        authDomain: backend.authDomain,
        projectId: backend.projectId,
        storageBucket: backend.storageBucket,
        messagingSenderId: backend.messagingSenderId,
        appId: backend.appId,
      }, backend.vapidKey, backend.sdkVersion)
      : null;
    if (backendConfig) {
      return backendConfig;
    }

    const runtime = this.runtimeWebFirebaseConfig();
    if (runtime) {
      return runtime;
    }

    return this.normalizeWebFirebaseConfig(
      environment.firebase,
      this.environmentVapidKey(),
      (globalThis as NivraRuntimeGlobals).NIVRA_FIREBASE_SDK_VERSION,
    );
  }

  private runtimeWebFirebaseConfig(): ResolvedFirebaseWebConfig | null {
    const runtime = globalThis as NivraRuntimeGlobals;
    return this.normalizeWebFirebaseConfig(
      runtime.NIVRA_FIREBASE_CONFIG,
      runtime.NIVRA_FIREBASE_VAPID_KEY,
      runtime.NIVRA_FIREBASE_SDK_VERSION,
    );
  }

  private normalizeWebFirebaseConfig(
    firebase: Partial<FirebaseOptions> | null | undefined,
    vapidKey: string | null | undefined,
    sdkVersion: string | null | undefined,
  ): ResolvedFirebaseWebConfig | null {
    const source = firebase as Partial<FirebaseWebOptions> | null | undefined;
    const config: FirebaseOptions = {
      apiKey: String(source?.apiKey || '').trim(),
      authDomain: String(source?.authDomain || '').trim(),
      projectId: String(source?.projectId || '').trim(),
      storageBucket: String(source?.storageBucket || '').trim(),
      messagingSenderId: String(source?.messagingSenderId || '').trim(),
      appId: String(source?.appId || '').trim(),
    };
    const publicVapidKey = String(vapidKey || source?.vapidKey || this.environmentVapidKey()).trim();
    if (!config.apiKey || !config.projectId || !config.messagingSenderId || !config.appId || !String(config.appId).includes(':web:') || publicVapidKey.length < 20) {
      return null;
    }
    return {
      firebase: config,
      vapidKey: publicVapidKey,
      sdkVersion: String(sdkVersion || '12.14.0').trim(),
    };
  }

  private async firebaseAppForWebConfig(config: FirebaseOptions): Promise<FirebaseApp> {
    const existing = getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME);
    if (existing && this.firebaseOptionsMatch(existing.options, config)) {
      return existing;
    }
    if (existing) {
      await deleteApp(existing).catch(() => undefined);
    }
    const stillExisting = getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME);
    if (stillExisting && this.firebaseOptionsMatch(stillExisting.options, config)) {
      return stillExisting;
    }
    return initializeApp(config, stillExisting ? `${FIREBASE_APP_NAME}-${Date.now()}` : FIREBASE_APP_NAME);
  }

  private async getWebFcmToken(
    firebaseConfig: FirebaseOptions,
    serviceWorkerRegistration: ServiceWorkerRegistration,
    vapidKey: string,
  ): Promise<string> {
    const strictVapidKey = this.environmentVapidKey() || vapidKey;
    const tokenOptions = { vapidKey: strictVapidKey, serviceWorkerRegistration };
    try {
      const messaging = await this.messagingForWebConfig(firebaseConfig);
      return await getToken(messaging, tokenOptions);
    } catch (error) {
      if (!this.shouldResetFirebaseMessagingState(error)) {
        throw error;
      }
      await this.cleanupRejectedWebPushState(serviceWorkerRegistration);
      try {
        const messaging = await this.messagingForWebConfig(firebaseConfig, true);
        return await getToken(messaging, tokenOptions);
      } catch (retryError) {
        await this.cleanupRejectedWebPushState(serviceWorkerRegistration);
        throw retryError;
      }
    }
  }

  private async messagingForWebConfig(config: FirebaseOptions, forceFresh = false): Promise<Messaging> {
    if (forceFresh) {
      await this.deleteFirebaseMessagingApp();
    }
    const app = await this.firebaseAppForWebConfig(config);
    const messaging = getMessaging(app);
    this.bindForegroundMessaging(messaging);
    return messaging;
  }

  private bindForegroundMessaging(messaging: Messaging): void {
    if (this.foregroundBound) {
      return;
    }
    onMessage(messaging, (payload) => {
      void this.handlePushData(this.normalizeWebData(payload.data), 'web-fcm');
    });
    this.foregroundBound = true;
  }

  private async cleanupRejectedWebPushState(serviceWorkerRegistration?: ServiceWorkerRegistration): Promise<void> {
    this.tokenId.set(null);
    this.webConfigPromise = undefined;
    await this.deleteFirebaseMessagingApp();
    const registration = serviceWorkerRegistration ?? await navigator.serviceWorker?.getRegistration?.('/firebase-messaging-sw.js').catch(() => undefined);
    if (registration) {
      await this.resetFirebaseMessagingState(registration);
    } else {
      await Promise.all(FIREBASE_RESETTABLE_IDB_NAMES.map((name) => this.deleteIndexedDbDatabase(name)));
    }
    this.clearFirebaseLocalStorageState();
  }

  private async deleteFirebaseMessagingApp(): Promise<void> {
    const apps = getApps().filter((candidate) =>
      candidate.name === FIREBASE_APP_NAME ||
      new RegExp(`^${FIREBASE_APP_NAME}-\\d+$`).test(candidate.name));
    await Promise.all(apps.map((app) => deleteApp(app).catch(() => undefined)));
    this.foregroundBound = false;
  }

  private async resetFirebaseMessagingState(serviceWorkerRegistration: ServiceWorkerRegistration): Promise<void> {
    const subscription = await serviceWorkerRegistration.pushManager?.getSubscription?.().catch(() => null);
    if (subscription) {
      await subscription.unsubscribe().catch(() => false);
    }
    await Promise.all(FIREBASE_RESETTABLE_IDB_NAMES.map((name) => this.deleteIndexedDbDatabase(name)));
  }

  private deleteIndexedDbDatabase(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined' || !indexedDB.deleteDatabase) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        resolve(value);
      };
      const timeout = window.setTimeout(() => finish(false), 3000);
      try {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => finish(true);
        request.onerror = () => finish(false);
        request.onblocked = () => finish(false);
      } catch {
        finish(false);
      }
    });
  }

  private clearFirebaseLocalStorageState(): void {
    try {
      for (const key of Object.keys(localStorage)) {
        const normalized = key.toLowerCase();
        if (FIREBASE_LOCAL_STORAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
          localStorage.removeItem(key);
        }
      }
    } catch {
      // LocalStorage can be unavailable in locked-down browsers.
    }
  }

  private async bindNativeFirebaseListeners(): Promise<void> {
    if (this.nativeBound) {
      return;
    }
    await FirebaseMessaging.addListener('tokenReceived', (event) => {
      void this.registerServerToken(event.token).catch(() => undefined);
    });
    await FirebaseMessaging.addListener('notificationReceived', (event) => {
      void this.handleNativeNotification(event.notification).catch(() => undefined);
    });
    await FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
      void this.handleNativeNotification(event.notification, event.actionId || 'tap').catch(() => undefined);
    });
    this.nativeBound = true;
  }

  private async registerServerToken(token: string): Promise<void> {
    const response = await firstValueFrom(this.api.post<PushTokenResponse>('/push-tokens', {
      provider: 'fcm',
      token,
    }));
    this.tokenId.set(response.id);
    this.serverReady.set(response.serverReady);
  }

  private async handleNativeNotification(notification: NativeFcmNotification, actionId = ''): Promise<void> {
    const data = this.normalizeNativeData(notification);
    const source: PushSource = actionId ? 'native-action' : 'native-fcm';
    if (actionId) {
      data['action'] = data['action'] || actionId;
      data['nivraRouteIntent'] = 'tap';
    }
    await this.handlePushData(data, source);
  }

  private async handlePushData(rawData: Record<string, string>, source: PushSource): Promise<void> {
    const data = this.normalizeWebData(rawData);
    this.lastMessage.set({ data } as MessagePayload);

    const type = this.normalizePushType(data['type']);
    if (type === 'end-call' || type === 'missed-call' || type === 'call-ended') {
      await this.cancelCallNotification(data['callId']);
    }
    if (data['action'] === 'decline') {
      await this.cancelCallNotification(data['callId']);
    }

    if (data['nivraRouteIntent'] === 'tap' || data['action'] === 'accept' || data['action'] === 'decline') {
      return;
    }
    if (source === 'web-fcm' && this.realtime.connected()) {
      return;
    }
    if (this.shouldSkipVisual(data)) {
      return;
    }
    if (this.isAppInteractive()) {
      await this.showForegroundToast(data);
      return;
    }
    await this.showBrowserNotification(data);
  }

  private async ensureNativeChannels(requestLocalPermission: boolean): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') {
      return;
    }
    if (requestLocalPermission) {
      const permission = await LocalNotifications.checkPermissions().catch(() => ({ display: 'denied' as const }));
      if (permission.display !== 'granted') {
        await LocalNotifications.requestPermissions().catch(() => undefined);
      }
    }
    await FirebaseMessaging.createChannel({
      id: 'nivra_messages',
      name: 'Nivra',
      description: 'Mensajes privados de Nivra',
      importance: Importance.High,
      visibility: Visibility.Private,
      vibration: true,
    }).catch(() => undefined);
    await FirebaseMessaging.createChannel({
      id: 'nivra_calls',
      name: 'Llamadas Nivra',
      description: 'Avisos de llamadas entrantes de Nivra',
      importance: Importance.Max,
      visibility: Visibility.Private,
      vibration: true,
    }).catch(() => undefined);
    await LocalNotifications.createChannel({
      id: 'nivra_messages',
      name: 'Nivra',
      description: 'Mensajes privados de Nivra',
      importance: 4,
      visibility: 0,
      vibration: true,
    }).catch(() => undefined);
    await LocalNotifications.createChannel({
      id: 'nivra_calls',
      name: 'Llamadas Nivra',
      description: 'Avisos de llamadas entrantes de Nivra',
      importance: 5,
      visibility: 0,
      vibration: true,
    }).catch(() => undefined);
  }

  private async showForegroundToast(data: Record<string, string>): Promise<void> {
    const visual = await this.visualForData(data);
    const toast = await this.toastController.create({
      header: visual.title,
      message: visual.body,
      duration: visual.requireInteraction ? 9000 : 3600,
      position: 'top',
      color: 'dark',
      buttons: [
        {
          text: 'Abrir',
          role: 'open',
          handler: () => {
            this.openFromPush(data);
          },
        },
        {
          text: 'Cerrar',
          role: 'cancel',
        },
      ],
    });
    await toast.present();
  }

  private async showBrowserNotification(data: Record<string, string>): Promise<void> {
    if (Capacitor.isNativePlatform() || !('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }
    const visual = await this.visualForData(data);
    const options: NotificationOptions = {
      body: visual.body,
      tag: visual.tag,
      data,
      icon: 'assets/icon/favicon.png',
      requireInteraction: visual.requireInteraction,
    };
    (options as NotificationOptions & { renotify?: boolean }).renotify = visual.requireInteraction;
    const notification = new Notification(visual.title, options);
    notification.onclick = () => {
      window.focus();
      notification.close();
      this.openFromPush(data);
    };
  }

  private openFromPush(data: Record<string, string>): void {
    this.lastMessage.set(({
      data: {
        ...data,
        nivraRouteIntent: 'tap',
      },
    } as unknown) as MessagePayload);
  }

  private dataFromRealtimeEvent(event: RealtimeEvent): Record<string, string> | null {
    const currentUserId = this.auth.session()?.user.id;
    if (event.type === 'message.received') {
      const message = event.payload as MessageResponse;
      if (!message?.id || !message.conversationId || message.senderUserId === currentUserId) {
        return null;
      }
      return {
        type: 'message',
        conversationId: message.conversationId,
        messageId: message.id,
        senderUserId: message.senderUserId,
        tag: `nivra-message-${message.conversationId}`,
      };
    }

    if (event.type === 'call.started' || event.type === 'incomingCall') {
      const call = this.recordPayload(event.payload);
      const callId = this.stringValue(call, 'id') || this.stringValue(call, 'callId');
      const initiatorUserId = this.stringValue(call, 'initiatorUserId') || this.stringValue(call, 'callerUserId');
      if (!callId || initiatorUserId === currentUserId) {
        return null;
      }
      return {
        type: 'incoming_call',
        callId,
        callerUserId: initiatorUserId,
        conversationId: this.stringValue(call, 'conversationId'),
        callType: this.stringValue(call, 'type') || this.stringValue(call, 'callType'),
        tag: `nivra-call-${callId}`,
      };
    }

    if (['call.ended', 'CallEnded', 'call.rejected', 'CallRejected', 'call.timeout', 'CallTimeout', 'call.failed'].includes(event.type)) {
      const call = this.recordPayload(event.payload);
      const callId = this.stringValue(call, 'id') || this.stringValue(call, 'callId');
      if (!callId) {
        return null;
      }
      return {
        type: event.type.toLowerCase().includes('reject') ? 'call-rejected' : 'end_call',
        callId,
        conversationId: this.stringValue(call, 'conversationId'),
        tag: `nivra-call-${callId}`,
      };
    }

    if (event.type === 'friend.requested') {
      return { type: 'friend_request', tag: `nivra-${event.type}` };
    }
    if (event.type === 'story.created' || event.type === 'story.worldCreated') {
      return { type: 'story', tag: `nivra-${event.type}` };
    }
    if (event.type.startsWith('vault.')) {
      return { type: event.type.replace('.', '_'), tag: `nivra-${event.type}` };
    }
    if (event.type === 'conversation.created') {
      const conversation = this.recordPayload(event.payload);
      const conversationId = this.stringValue(conversation, 'id');
      return conversationId ? { type: 'conversation', conversationId, tag: `nivra-conversation-${conversationId}` } : null;
    }

    return null;
  }

  private async visualForData(data: Record<string, string>): Promise<{ title: string; body: string; tag: string; requireInteraction: boolean }> {
    const type = this.normalizePushType(data['type']);
    const tag = data['tag'] || data['callId'] || data['messageId'] || 'nivra-event';
    const preview = await this.decryptPreviewIfPresent(data);
    if (preview) {
      return {
        title: preview.title || 'Nivra',
        body: preview.body || 'Nueva actividad privada',
        tag,
        requireInteraction: type === 'incoming-call' || type === 'incomingcall',
      };
    }
    if (type === 'incoming-call' || type === 'incomingcall') {
      return { title: 'Nivra', body: 'Llamada entrante', tag, requireInteraction: true };
    }
    if (type === 'missed-call') {
      return { title: 'Nivra', body: 'Llamada perdida', tag, requireInteraction: false };
    }
    if (type.includes('call')) {
      return { title: 'Nivra', body: 'Actualizacion de llamada', tag, requireInteraction: false };
    }
    if (type === 'message') {
      return { title: 'Nivra', body: 'Nuevo mensaje privado', tag, requireInteraction: false };
    }
    return { title: 'Nivra', body: 'Nueva actividad privada', tag, requireInteraction: false };
  }

  private async decryptPreviewIfPresent(data: Record<string, string>): Promise<{ title?: string; body?: string } | null> {
    const header = data['previewHeader'] || data['notificationHeader'] || data['encryptedHeader'];
    const ciphertext = data['previewCiphertext'] || data['notificationCiphertext'] || data['encryptedPreview'];
    const current = this.auth.session();
    if (!header || !ciphertext || !current) {
      return null;
    }
    try {
      const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
      const preview = await this.crypto.decryptEnvelope<{ title?: unknown; body?: unknown }>(own, header, ciphertext);
      return {
        title: typeof preview.title === 'string' ? preview.title.slice(0, 80) : undefined,
        body: typeof preview.body === 'string' ? preview.body.slice(0, 160) : undefined,
      };
    } catch {
      return null;
    }
  }

  private async cancelCallNotification(callId?: string): Promise<void> {
    if (!callId || !Capacitor.isNativePlatform()) {
      return;
    }
    await LocalNotifications.cancel({
      notifications: [{ id: this.callNotificationId(callId) }],
    }).catch(() => undefined);
  }

  private normalizeNativeData(notification: NativeFcmNotification): Record<string, string> {
    return this.normalizeWebData(notification.data && typeof notification.data === 'object'
      ? notification.data as Record<string, unknown>
      : {});
  }

  private normalizeWebData(raw: Record<string, unknown> | undefined): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (value !== undefined && value !== null) {
        data[key] = String(value);
      }
    }
    data['tag'] ||= data['callId'] || data['messageId'] || data['conversationId'] || 'nivra-event';
    return data;
  }

  private normalizePushType(type?: string): string {
    return (type || '').replace(/_/g, '-').toLowerCase();
  }

  private firebaseOptionsMatch(current: FirebaseOptions, expected: FirebaseOptions): boolean {
    return ['apiKey', 'projectId', 'messagingSenderId', 'appId'].every((key) =>
      String(current[key as keyof FirebaseOptions] || '') === String(expected[key as keyof FirebaseOptions] || ''),
    );
  }

  private shouldResetFirebaseMessagingState(error: unknown): boolean {
    const candidate = error as { code?: string; message?: string };
    const text = `${candidate?.code || ''} ${candidate?.message || error || ''}`.toLowerCase();
    return text.includes('401') ||
      text.includes('unauthorized') ||
      text.includes('authentication credential') ||
      text.includes('token-subscribe-failed');
  }

  private firebaseMessagingErrorMessage(error: unknown): string {
    const candidate = error as { code?: string; message?: string };
    const text = `${candidate?.code || ''} ${candidate?.message || error || ''}`.toLowerCase();
    if (text.includes('permission')) {
      return 'Permiso activo, pero el navegador no autorizo el token FCM.';
    }
    if (this.shouldResetFirebaseMessagingState(error)) {
      return 'Firebase rechazo el registro web. Se limpio el estado local de FCM; vuelve a tocar Activar avisos si el navegador pide reintento.';
    }
    if (text.includes('unsupported') || text.includes('not-supported')) {
      return 'Este navegador no soporta FCM Web Push remoto.';
    }
    return candidate?.message || 'No se pudo activar push.';
  }

  private environmentVapidKey(): string {
    return String((environment.firebase as FirebaseWebOptions).vapidKey || environment.firebaseVapidKey || '').trim();
  }

  private shouldSkipVisual(data: Record<string, string>): boolean {
    const key = data['tag'] || data['messageId'] || data['callId'] || JSON.stringify(data);
    const now = Date.now();
    for (const [tag, at] of this.visualDedupe.entries()) {
      if (now - at > 9000) {
        this.visualDedupe.delete(tag);
      }
    }
    const previous = this.visualDedupe.get(key);
    if (previous && now - previous < 4500) {
      return true;
    }
    this.visualDedupe.set(key, now);
    return false;
  }

  private isAppInteractive(): boolean {
    return typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      (typeof document.hasFocus !== 'function' || document.hasFocus());
  }

  private async ensureWebNotificationPermission(requestPermission: boolean): Promise<NotificationPermission> {
    let permission = Notification.permission;
    if (requestPermission && permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    this.permission.set(permission);
    return permission;
  }

  private isElectronRuntime(): boolean {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('electron');
  }

  private callNotificationId(callId: string): number {
    let hash = 0;
    for (let index = 0; index < callId.length; index += 1) {
      hash = ((hash << 5) - hash + callId.charCodeAt(index)) | 0;
    }
    return Math.abs(hash || 1);
  }

  private recordPayload(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  }

  private stringValue(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    return typeof value === 'string' ? value : '';
  }

  private mapNativePermission(permission: string): NotificationPermission | 'unsupported' {
    if (permission === 'granted') {
      return 'granted';
    }
    if (permission === 'denied') {
      return 'denied';
    }
    return 'default';
  }
}
