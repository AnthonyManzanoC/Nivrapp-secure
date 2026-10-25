import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { ApiEndpointPool } from './api-endpoint-pool.service';
import { PresenceResponse, RealtimeEvent, RecipientCipherRequest } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { NetworkPolicyService } from './network-policy.service';

@Injectable({ providedIn: 'root' })
export class SignalrService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly api = inject(NivraApiService);
  private readonly pool = inject(ApiEndpointPool);
  private readonly network = inject(NetworkPolicyService);
  private readonly endpointChanges = this.pool.changes$.subscribe(() => {
    void this.reconnectForEndpointChange();
  });
  private connection: HubConnection | null = null;
  private reconnectTimer: number | null = null;
  private startPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private startScope = '';
  private connectionScope = '';
  private reconnectScope = '';
  private reconnectAttempt = 0;
  private wakeTimer: number | null = null;
  private lastWakeAt = 0;
  private readonly wake = () => this.scheduleNetworkWake();
  private readonly visible = () => { if (document.visibilityState !== 'hidden') this.scheduleNetworkWake(); };

  readonly connectionState = signal<HubConnectionState>(HubConnectionState.Disconnected);
  readonly connected = computed(() => this.connectionState() === HubConnectionState.Connected);
  readonly events$ = new Subject<RealtimeEvent>();

  constructor() {
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.visible);
  }

  ngOnDestroy(): void {
    this.endpointChanges.unsubscribe();
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.visible);
    if (this.wakeTimer !== null) window.clearTimeout(this.wakeTimer);
    void this.disconnect();
    this.events$.complete();
  }

  connect(): Promise<void> {
    const session = this.auth.session();
    const scope = session ? `${session.user.id}:${session.device.id}` : '';
    if (this.connection?.state === HubConnectionState.Connected && this.connectionScope === scope) return Promise.resolve();
    if (this.startPromise && this.startScope === scope) return this.startPromise;
    if (this.reconnectTimer !== null) {
      if (this.reconnectScope === scope) return Promise.resolve();
      this.clearReconnectTimer();
    }
    this.startScope = scope;
    const generation = this.connectionGeneration;
    const operation = this.connectCore(generation, session?.user.id, session?.device.id).finally(() => {
      if (this.startPromise === operation) this.startPromise = null;
    });
    this.startPromise = operation;
    return operation;
  }

  private async connectCore(generation: number, userId?: string, deviceId?: string): Promise<void> {
    if (!await this.auth.ensureFreshSession()) {
      return;
    }
    const session = this.auth.session();
    if (generation !== this.connectionGeneration || (userId && (session?.user.id !== userId || session?.device.id !== deviceId))) return;
    await this.pool.prepareForRequest();
    if (generation !== this.connectionGeneration) return;
    if (!session || this.auth.session()?.user.id !== session.user.id
      || this.auth.session()?.device.id !== session.device.id) return;
    const token = this.auth.accessToken();
    if (!token) {
      return;
    }
    this.clearReconnectTimer();
    if (
      this.connection &&
      this.connectionScope === `${session.user.id}:${session.device.id}` &&
      [HubConnectionState.Connected, HubConnectionState.Connecting, HubConnectionState.Reconnecting].includes(this.connection.state)
    ) {
      return;
    }
    await this.openConnection(false);
  }

  async disconnect(options: { clearReconnect?: boolean } = {}): Promise<void> {
    const generation = ++this.connectionGeneration;
    if (options.clearReconnect !== false) {
      this.clearReconnectTimer();
    }
    const connection = this.connection;
    this.connection = null;
    this.connectionScope = '';
    if (connection) {
      this.unbind(connection);
      await connection.stop().catch(() => undefined);
    }
    if (generation === this.connectionGeneration && this.connection === null) {
      this.connectionState.set(HubConnectionState.Disconnected);
    }
  }

  private async reconnectForEndpointChange(): Promise<void> {
    const session = this.auth.session();
    const stopping = this.disconnect();
    const generation = this.connectionGeneration;
    await stopping;
    // A reconnect timer that fires while an old handshake is pending only joins
    // that old startPromise. Wait until it releases the connection slot first.
    await this.startPromise?.catch(() => undefined);
    if (generation !== this.connectionGeneration || !session
      || this.auth.session()?.user.id !== session.user.id
      || this.auth.session()?.device.id !== session.device.id) return;
    this.scheduleReconnect(0);
  }

  async joinConversation(conversationId: string): Promise<void> {
    await this.ensureConnected();
    await this.connection?.invoke('JoinConversation', conversationId).catch(() => undefined);
  }

  async typing(conversationId: string, encryptedState: string): Promise<void> {
    await this.ensureConnected();
    await this.connection?.invoke('Typing', conversationId, encryptedState).catch(() => undefined);
  }

  async presence(userIds: string[]): Promise<PresenceResponse[]> {
    const ids = [...new Set(userIds.filter(Boolean))].slice(0, 80);
    if (!ids.length) {
      return [];
    }
    await this.ensureConnected();
    return this.connection?.invoke<PresenceResponse[]>('Presence', ids).catch(() => []) ?? [];
  }

  async callUser(payload: { type: 'Voice' | 'Video'; conversationId?: string | null; participantUserIds?: string[] }): Promise<void> {
    await this.ensureConnected();
    await this.connection?.invoke('CallUser', {
      type: payload.type,
      conversationId: payload.conversationId ?? null,
      participantUserIds: payload.participantUserIds ?? [],
    }).catch(() => undefined);
  }

  async syncReadReceipts(conversationId: string, messageIds: string[], options: { openedMessageIds?: string[] } = {}): Promise<void> {
    const ids = [...new Set((messageIds ?? []).filter(Boolean))].slice(0, 500);
    if (!conversationId || !ids.length) {
      return;
    }
    const openedIds = [...new Set((options.openedMessageIds ?? []).filter((id) => ids.includes(id)))].slice(0, 500);
    await this.ensureConnected();
    await this.connection?.invoke('SyncReadReceipts', conversationId, ids, openedIds).catch(() => undefined);
  }

  async callAnsweredElsewhere(callId: string): Promise<void> {
    if (!callId) {
      return;
    }
    await this.ensureConnected();
    await this.connection?.invoke('CallAnsweredElsewhere', callId).catch(() => undefined);
  }

  async updateGroupRoles(conversationId: string, admins: string[]): Promise<void> {
    await this.ensureConnected();
    await this.connection?.invoke('UpdateGroupRoles', conversationId, admins).catch(() => undefined);
  }

  async updateGroupParticipants(conversationId: string, participantIds: string[]): Promise<void> {
    await this.ensureConnected();
    await this.connection?.invoke('UpdateGroupParticipants', conversationId, participantIds).catch(() => undefined);
  }

  async joinVaultRoom(roomId: string): Promise<void> {
    await this.ensureConnected();
    await this.connection?.invoke('JoinVaultRoom', roomId).catch(() => undefined);
  }

  async sendVaultRoomMessage(
    roomId: string,
    payload: {
      clientMessageId: string;
      kind: string;
      recipients: RecipientCipherRequest[];
      fileObjectId?: string | null;
    },
  ): Promise<void> {
    await this.ensureConnected();
    await this.connection?.invoke('SendVaultRoomMessage', roomId, {
      clientMessageId: payload.clientMessageId,
      kind: payload.kind,
      recipients: payload.recipients,
      fileObjectId: payload.fileObjectId ?? null,
    });
  }

  private async openConnection(hasRefreshedToken: boolean): Promise<void> {
    await this.disconnect({ clearReconnect: false });
    const session = this.auth.session();
    const sameSession = () => this.auth.session()?.user.id === session?.user.id && this.auth.session()?.device.id === session?.device.id;
    if (!session || !this.auth.accessToken()) return;
    const endpoint = this.api.url('/hubs/realtime');
    const connection = new HubConnectionBuilder()
      .withUrl(endpoint, {
        accessTokenFactory: () => sameSession() ? this.auth.accessToken() : '',
        withCredentials: false,
        timeout: this.network.readTimeoutMs(),
      })
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: context => {
        if (context.previousRetryCount >= 5 || !this.network.onlineHint() || !sameSession()) return null;
        return this.network.retryDelayMs(context.previousRetryCount, 1000, 60_000);
      } })
      .configureLogging(LogLevel.None)
      .build();

    connection.serverTimeoutInMilliseconds = this.network.serverTimeoutMs();

    this.bind(connection);
    this.connection = connection;
    this.connectionScope = `${session.user.id}:${session.device.id}`;
    this.connectionState.set(connection.state);

    try {
      await connection.start();
      if (this.connection !== connection || !sameSession()) { await connection.stop().catch(() => undefined); return; }
      this.connectionState.set(connection.state);
      this.reconnectAttempt = 0;
      this.pool.reportSuccess(endpoint);
      this.events$.next({ type: 'connected', payload: null });
    } catch (error) {
      if (this.connection !== connection || !sameSession()) return;
      this.connection = null;
      this.connectionState.set(HubConnectionState.Disconnected);
      await connection.stop().catch(() => undefined);
      const status = (error as { statusCode?: number })?.statusCode;
      const unauthorized = status === 401;
      const infrastructureFailure = status === undefined || [0, 502, 503, 504].includes(status);
      if (!hasRefreshedToken && ((unauthorized && await this.auth.refreshToken()) || (infrastructureFailure && await this.pool.recover(endpoint))) && sameSession()) {
        await this.openConnection(true);
        return;
      }
      this.scheduleReconnect(status === 429 ? 30000 : undefined);
    }
  }

  private async ensureConnected(): Promise<void> {
    const session = this.auth.session();
    if (this.connection?.state === HubConnectionState.Connected && session && this.connectionScope === `${session.user.id}:${session.device.id}`) {
      return;
    }
    await this.connect();
  }

  private bind(connection: HubConnection): void {
    const session = this.auth.session();
    const endpoint = this.api.url('/hubs/realtime');
    const current = () => this.connection === connection && this.auth.session()?.user.id === session?.user.id && this.auth.session()?.device.id === session?.device.id;
    const forward = (type: string) => (payload: unknown) => { if (current()) this.events$.next({ type, payload }); };
    [
      'message.received',
      'message.receipt',
      'sync_read_receipts',
      'conversation.typing',
      'presence.changed',
      'MessageDeleted',
      'ChatCleared',
      'conversation.created',
      'conversation.updated',
      'profile.updated',
      'friend.requested',
      'friend.updated',
      'story.created',
      'story.worldCreated',
      'story.deleted',
      'story.viewed',
      'story.reacted',
      'story.commented',
      'vault.invited',
      'vault.approved',
      'vault.joinRequested',
      'vault.message',
      'vault.closed',
      'vault.left',
      'incomingCall',
      'call.started',
      'call.updated',
      'GroupCallStarted',
      'group.call.started',
      'groupCallStarted',
      'call.signal',
      'call_answered_elsewhere',
      'call.ended',
      'CallEnded',
      'call.rejected',
      'CallRejected',
      'call.timeout',
      'CallTimeout',
      'call.failed',
      'FORCE_WIPE',
      'device.revoked',
      'device.listChanged',
      'account.app-lock.updated',
      'history.requested',
      'history.available',
    ].forEach((eventName) => connection.on(eventName, forward(eventName)));

    connection.onreconnecting(error => {
      if (!current()) return;
      this.connectionState.set(HubConnectionState.Reconnecting);
      const status = (error as { statusCode?: number })?.statusCode;
      if (status === undefined || [0, 502, 503, 504].includes(status)) {
        // Rebuild on a verified replacement instead of waiting through every old-host retry.
        void this.pool.recover(endpoint).catch(() => undefined);
      }
    });
    connection.onreconnected(() => {
      if (!current()) return;
      this.clearReconnectTimer();
      this.reconnectAttempt = 0;
      this.connectionState.set(HubConnectionState.Connected);
      this.events$.next({ type: 'reconnected', payload: null });
    });
    connection.onclose(() => {
      if (current()) {
        this.connectionState.set(HubConnectionState.Disconnected);
        this.scheduleReconnect();
      }
    });
  }

  private unbind(connection: HubConnection): void {
    [
      'message.received',
      'message.receipt',
      'sync_read_receipts',
      'conversation.typing',
      'presence.changed',
      'MessageDeleted',
      'ChatCleared',
      'conversation.created',
      'conversation.updated',
      'profile.updated',
      'friend.requested',
      'friend.updated',
      'story.created',
      'story.worldCreated',
      'story.deleted',
      'story.viewed',
      'story.reacted',
      'story.commented',
      'vault.invited',
      'vault.approved',
      'vault.joinRequested',
      'vault.message',
      'vault.closed',
      'vault.left',
      'incomingCall',
      'call.started',
      'call.updated',
      'GroupCallStarted',
      'group.call.started',
      'groupCallStarted',
      'call.signal',
      'call_answered_elsewhere',
      'call.ended',
      'CallEnded',
      'call.rejected',
      'CallRejected',
      'call.timeout',
      'CallTimeout',
      'call.failed',
      'FORCE_WIPE',
      'device.revoked',
      'device.listChanged',
      'account.app-lock.updated',
      'history.requested',
      'history.available',
    ].forEach((eventName) => connection.off(eventName));
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.reconnectTimer !== null || !this.auth.accessToken() || !this.network.onlineHint()) {
      return;
    }
    const session = this.auth.session();
    this.reconnectScope = session ? `${session.user.id}:${session.device.id}` : '';
    const scope = this.reconnectScope;
    const delay = delayMs === 0 ? 0 : Math.max(delayMs ?? 0, this.network.retryDelayMs(this.reconnectAttempt++));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const current = this.auth.session();
      if (!current || `${current.user.id}:${current.device.id}` !== scope) return;
      void this.connect();
    }, delay);
  }

  private scheduleNetworkWake(): void {
    if (this.wakeTimer !== null || !this.auth.accessToken() || !this.network.onlineHint()) return;
    if (Date.now() - this.lastWakeAt < 2000) return;
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = null;
      this.lastWakeAt = Date.now();
      if (!this.auth.accessToken() || !this.network.onlineHint()) return;
      this.clearReconnectTimer();
      void this.connect();
    }, 400);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
