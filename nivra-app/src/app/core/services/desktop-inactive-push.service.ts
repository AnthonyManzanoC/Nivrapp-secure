import { Injectable, InjectionToken, OnDestroy, effect, inject, signal } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState, IRetryPolicy, LogLevel } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { ApiEndpointPool } from './api-endpoint-pool.service';
import { AuthService, StoredAccountWipeRequiredError } from './auth.service';
import { NetworkPolicyService } from './network-policy.service';
import { NivraApiService } from './nivra-api.service';

export type DesktopPushConnectionFactory = (url: string, token: () => Promise<string>, retry: IRetryPolicy) => HubConnection;
export const DESKTOP_PUSH_CONNECTION_FACTORY = new InjectionToken<DesktopPushConnectionFactory>('DesktopPushConnectionFactory', {
  providedIn: 'root', factory: () => (url, token, retry) => new HubConnectionBuilder()
    .withUrl(url, { accessTokenFactory: token, withCredentials: false })
    .withAutomaticReconnect(retry).configureLogging(LogLevel.None).build(),
});
interface Scope { userId: string; deviceId: string; }
const EVENTS = ['message.received', 'call.started', 'incomingCall', 'call.ended', 'CallEnded', 'call.rejected',
  'CallRejected', 'call.timeout', 'CallTimeout', 'call.failed', 'FORCE_WIPE'];

/** One receive-only hub for the other saved account while the desktop process is open. */
@Injectable({ providedIn: 'root' })
export class DesktopInactivePushService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly api = inject(NivraApiService);
  private readonly pool = inject(ApiEndpointPool);
  private readonly network = inject(NetworkPolicyService);
  private readonly createConnection = inject(DESKTOP_PUSH_CONNECTION_FACTORY);
  private readonly enabled = signal(false);
  private connection: HubConnection | null = null;
  private connectionScope = '';
  private observation = 0;
  private epoch = 0;
  private failures = 0;
  private retryTimer: number | null = null;
  private destroyed = false;
  private readonly wake = () => { this.failures = 0; void this.synchronize(); };
  private readonly offline = () => this.clearRetry();
  private readonly visible = () => { if (document.visibilityState !== 'hidden') this.wake(); };
  private readonly endpointChanges = this.pool.changes$.subscribe(() => {
    this.connectionScope = ''; this.wake();
  });
  readonly events$ = new Subject<Record<string, string>>();

  constructor() {
    window.addEventListener('online', this.wake);
    window.addEventListener('offline', this.offline);
    document.addEventListener('visibilitychange', this.visible);
    effect(() => {
      if (!this.enabled()) return;
      this.auth.session(); this.auth.savedAccounts();
      void this.synchronize();
    });
  }

  enable(): void { if (!this.destroyed) this.enabled.set(true); }

  ngOnDestroy(): void {
    this.destroyed = true; this.observation++; this.epoch++;
    this.endpointChanges.unsubscribe();
    window.removeEventListener('online', this.wake);
    window.removeEventListener('offline', this.offline);
    document.removeEventListener('visibilitychange', this.visible);
    this.clearRetry();
    void this.stopConnection();
    this.events$.complete();
  }

  private async synchronize(): Promise<void> {
    if (!this.enabled() || this.destroyed) return;
    const observation = ++this.observation;
    const active = this.auth.session();
    const activeGeneration = this.auth.sessionGeneration();
    let sessions;
    try { sessions = await this.auth.storedSessionCredentials(); } catch { return; }
    if (this.destroyed || observation !== this.observation || activeGeneration !== this.auth.sessionGeneration()) return;
    const target = sessions.find(saved => saved.user.id !== active?.user.id || saved.device.id !== active?.device.id);
    const key = target ? JSON.stringify([target.user.id, target.device.id]) : '';
    if (this.connection && this.connectionScope === key && this.connection.state !== HubConnectionState.Disconnected) return;
    this.clearRetry();
    await this.stopConnection();
    if (!target || this.destroyed || observation !== this.observation || activeGeneration !== this.auth.sessionGeneration()) return;
    const scope = { userId: target.user.id, deviceId: target.device.id };
    const epoch = ++this.epoch;
    const current = () => !this.destroyed && this.epoch === epoch && this.enabled()
      && !(this.auth.session()?.user.id === scope.userId && this.auth.session()?.device.id === scope.deviceId)
      && this.auth.savedAccounts().some(saved => saved.id === scope.userId);
    const endpoint = this.api.url('/hubs/realtime');
    const token = async () => {
      if (!current()) return '';
      try {
        const saved = await this.auth.getFreshStoredSessionCredentials(scope.userId, scope.deviceId);
        return current() && saved ? saved.tokens.accessToken : '';
      } catch (error) {
        if (error instanceof StoredAccountWipeRequiredError && !this.destroyed) this.publishWipe(error.scope);
        return '';
      }
    };
    const connection = this.createConnection(endpoint, token, {
      nextRetryDelayInMilliseconds: context => current() && context.previousRetryCount < 5 && this.network.onlineHint()
        ? this.network.retryDelayMs(context.previousRetryCount, 1000, 60_000) : null,
    });
    connection.serverTimeoutInMilliseconds = this.network.serverTimeoutMs();
    for (const name of EVENTS) connection.on(name, payload => {
      if (current() && this.connection === connection) this.forward(scope, name, payload);
    });
    connection.onclose(() => {
      if (this.connection !== connection) return;
      this.connection = null;
      for (const name of EVENTS) connection.off(name);
      // SignalR already exhausted its five fast reconnects. A minimized app
      // still needs to recover when the API wakes without a network event.
      this.failures = Math.max(this.failures, 5);
      this.scheduleRecovery(current);
    });
    this.connection = connection; this.connectionScope = key;
    try {
      await connection.start();
      if (!current() || this.connection !== connection) { await connection.stop().catch(() => undefined); return; }
      this.failures = 0;
    } catch {
      if (this.connection !== connection) return;
      this.connection = null;
      for (const name of EVENTS) connection.off(name);
      await connection.stop().catch(() => undefined);
      this.scheduleRecovery(current);
    }
  }

  private scheduleRecovery(current: () => boolean): void {
    if (!current() || !this.network.onlineHint() || this.retryTimer !== null) return;
    const attempt = this.failures++;
    const slow = attempt >= 5;
    const delay = this.network.retryDelayMs(slow ? attempt - 5 : attempt,
      slow ? 30_000 : 2500, slow ? 120_000 : 60_000);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (current() && this.network.onlineHint()) void this.synchronize();
    }, delay);
  }

  private async stopConnection(): Promise<void> {
    this.epoch++;
    const connection = this.connection;
    this.connection = null; this.connectionScope = '';
    if (!connection) return;
    for (const name of EVENTS) connection.off(name);
    await connection.stop().catch(() => undefined);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private publishWipe(scope: Scope): void {
    this.events$.next({ type: 'force_wipe', code: 'FORCE_WIPE', deviceId: scope.deviceId,
      recipientUserId: scope.userId, recipientDeviceId: scope.deviceId });
  }

  private forward(scope: Scope, event: string, payload: unknown): void {
    const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const text = (name: string) => typeof value[name] === 'string' ? value[name] as string : '';
    if (event === 'FORCE_WIPE') {
      if (text('deviceId') === scope.deviceId && (!text('userId') || text('userId') === scope.userId)) this.publishWipe(scope);
      return;
    }
    const data: Record<string, string> = { recipientUserId: scope.userId, recipientDeviceId: scope.deviceId };
    if (event === 'message.received') {
      if (!text('id') || !text('conversationId') || text('senderUserId') === scope.userId) return;
      Object.assign(data, { type: 'message', messageId: text('id'), conversationId: text('conversationId'), tag: `nivra-message-${text('id')}` });
    } else {
      const callId = text('id') || text('callId');
      if (!callId) return;
      const incoming = event === 'incomingCall' || event === 'call.started';
      if (incoming && (text('initiatorUserId') || text('callerUserId')) === scope.userId) return;
      Object.assign(data, { type: incoming ? 'incoming_call' : 'end_call', callId,
        conversationId: text('conversationId'), callType: text('type') || text('callType'), tag: `nivra-call-${callId}` });
    }
    // No ciphertext, sender names, profile fields or message plaintext cross
    // into the notification path, and this hub never joins a conversation.
    this.events$.next(data);
  }
}
