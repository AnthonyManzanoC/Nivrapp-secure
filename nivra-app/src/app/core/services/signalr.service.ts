import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { PresenceResponse, RealtimeEvent, RecipientCipherRequest } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';

@Injectable({ providedIn: 'root' })
export class SignalrService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly api = inject(NivraApiService);
  private connection: HubConnection | null = null;
  private reconnectTimer: number | null = null;
  private startPromise: Promise<void> | null = null;

  readonly connectionState = signal<HubConnectionState>(HubConnectionState.Disconnected);
  readonly connected = computed(() => this.connectionState() === HubConnectionState.Connected);
  readonly events$ = new Subject<RealtimeEvent>();

  ngOnDestroy(): void {
    void this.disconnect();
    this.events$.complete();
  }

  async connect(): Promise<void> {
    if (!await this.auth.ensureFreshSession()) {
      return;
    }
    const token = this.auth.accessToken();
    if (!token) {
      return;
    }
    this.clearReconnectTimer();
    if (
      this.connection &&
      [HubConnectionState.Connected, HubConnectionState.Connecting, HubConnectionState.Reconnecting].includes(this.connection.state)
    ) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.openConnection(false).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async disconnect(options: { clearReconnect?: boolean } = {}): Promise<void> {
    if (options.clearReconnect !== false) {
      this.clearReconnectTimer();
    }
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      this.unbind(connection);
      await connection.stop().catch(() => undefined);
    }
    this.connectionState.set(HubConnectionState.Disconnected);
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
    const connection = new HubConnectionBuilder()
      .withUrl(this.api.url('/hubs/realtime'), {
        accessTokenFactory: () => this.auth.accessToken(),
        withCredentials: false,
      })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .configureLogging(LogLevel.None)
      .build();

    this.bind(connection);
    this.connection = connection;
    this.connectionState.set(connection.state);

    try {
      await connection.start();
      this.connectionState.set(connection.state);
      this.events$.next({ type: 'connected', payload: null });
    } catch {
      this.connection = null;
      this.connectionState.set(HubConnectionState.Disconnected);
      await connection.stop().catch(() => undefined);
      if (!hasRefreshedToken && await this.auth.refreshToken()) {
        await this.openConnection(true);
        return;
      }
      this.scheduleReconnect();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection?.state === HubConnectionState.Connected) {
      return;
    }
    await this.connect();
  }

  private bind(connection: HubConnection): void {
    const forward = (type: string) => (payload: unknown) => this.events$.next({ type, payload });
    [
      'message.received',
      'message.receipt',
      'conversation.typing',
      'presence.changed',
      'MessageDeleted',
      'ChatCleared',
      'conversation.created',
      'conversation.updated',
      'friend.requested',
      'friend.updated',
      'story.created',
      'story.worldCreated',
      'story.viewed',
      'vault.invited',
      'vault.approved',
      'vault.joinRequested',
      'vault.message',
      'vault.closed',
      'vault.left',
      'incomingCall',
      'call.started',
      'call.signal',
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
    ].forEach((eventName) => connection.on(eventName, forward(eventName)));

    connection.onreconnecting(() => this.connectionState.set(HubConnectionState.Reconnecting));
    connection.onreconnected(() => {
      this.clearReconnectTimer();
      this.connectionState.set(HubConnectionState.Connected);
      this.events$.next({ type: 'reconnected', payload: null });
    });
    connection.onclose(() => {
      if (this.connection === connection) {
        this.connectionState.set(HubConnectionState.Disconnected);
        this.scheduleReconnect();
      }
    });
  }

  private unbind(connection: HubConnection): void {
    [
      'message.received',
      'message.receipt',
      'conversation.typing',
      'presence.changed',
      'MessageDeleted',
      'ChatCleared',
      'conversation.created',
      'conversation.updated',
      'friend.requested',
      'friend.updated',
      'story.created',
      'story.worldCreated',
      'story.viewed',
      'vault.invited',
      'vault.approved',
      'vault.joinRequested',
      'vault.message',
      'vault.closed',
      'vault.left',
      'incomingCall',
      'call.started',
      'call.signal',
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
    ].forEach((eventName) => connection.off(eventName));
  }

  private scheduleReconnect(delayMs = 2500): void {
    if (this.reconnectTimer !== null || !this.auth.accessToken()) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
