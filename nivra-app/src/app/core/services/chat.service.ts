import { DestroyRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, fromEvent } from 'rxjs';
import {
  ChatMessageVm,
  ChatPayload,
  Contact,
  Conversation,
  DeliveryReceipt,
  DirectorySearchResponse,
  FileChatPayload,
  FileResponse,
  MediaPreview,
  MessageReaction,
  MessageResponse,
  MessageSyncResponse,
  PresenceResponse,
  PublicKeyDirectory,
  RecipientCipherRequest,
  SyncBootstrapResponse,
  UserSummary,
} from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const QUICK_REACTIONS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F64F}'];

interface SendPayloadOptions {
  suppressLocalMessage?: boolean;
  encryptedPolicy?: string | null;
  expiresAt?: string | null;
  deleteAfterRead?: boolean;
}

export interface MessagePolicyOptions {
  deleteAfterRead?: boolean;
  ttlSeconds?: number | null;
}

@Injectable({ providedIn: 'root' })
export class ChatService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly history = inject(LocalHistoryService);
  private readonly signalr = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly directories = new Map<string, PublicKeyDirectory>();
  private readonly readReceiptSentIds = new Set<string>();
  private readonly pendingReactionSends = new Set<string>();
  private readonly pendingReactionsByMessageId = new Map<string, MessageReaction[]>();
  private readonly typingTimers = new Map<string, number>();
  private lastTypingSentAt = 0;
  private syncInFlight = false;
  private selectedConversationLoadId = 0;

  readonly quickReactions = QUICK_REACTIONS;
  readonly conversations = signal<Conversation[]>([]);
  readonly contacts = signal<Contact[]>([]);
  readonly messagesByConversation = signal<Record<string, ChatMessageVm[]>>({});
  readonly mediaPreviews = signal<Record<string, MediaPreview>>({});
  readonly directoryResults = signal<UserSummary[]>([]);
  readonly typingByConversation = signal<Record<string, string[]>>({});
  readonly presenceByUser = signal<Record<string, PresenceResponse>>({});
  readonly loading = signal(false);
  readonly uploading = signal(false);
  readonly selectedConversationId = signal<string | null>(localStorage.getItem('nivra.selectedConversationId'));
  readonly selectedConversation = computed(() => {
    const id = this.selectedConversationId();
    return this.conversations().find((conversation) => conversation.id === id) ?? null;
  });
  readonly selectedMessages = computed(() => {
    const id = this.selectedConversationId();
    return id ? this.messagesByConversation()[id] ?? [] : [];
  });

  constructor() {
    this.signalr.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event.type === 'message.received') {
        void this.ingestMessage(event.payload as MessageResponse, true);
      }
      if (event.type === 'message.receipt') {
        this.applyReceipt(event.payload);
      }
      if (event.type === 'MessageDeleted') {
        this.applyMessageDeleted(event.payload);
      }
      if (event.type === 'ChatCleared') {
        this.applyChatCleared(event.payload);
      }
      if (event.type === 'conversation.created') {
        const conversation = event.payload as Conversation;
        if (conversation?.id) {
          this.conversations.update((items) => [conversation, ...items.filter((item) => item.id !== conversation.id)].sort(this.compareConversations));
        }
      }
      if (event.type === 'conversation.updated') {
        const conversation = event.payload as Conversation;
        if (conversation?.id) {
          this.conversations.update((items) => items.map((item) => item.id === conversation.id ? conversation : item).sort(this.compareConversations));
        }
      }
      if (event.type === 'conversation.typing') {
        this.applyTyping(event.payload);
      }
      if (event.type === 'presence.changed') {
        this.applyPresence(event.payload as PresenceResponse);
      }
      if (event.type === 'connected' || event.type === 'reconnected') {
        void this.rejoinSelectedConversation();
        void this.bootstrap();
        void this.syncMissedMessages();
      }
    });

    fromEvent(document, 'visibilitychange')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (document.visibilityState === 'visible') {
          void this.syncMissedMessages();
          void this.refreshPresenceForConversations();
        }
      });

    fromEvent(window, 'online')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.signalr.connect();
        void this.syncMissedMessages();
      });

    effect(() => {
      if (this.auth.isAuthenticated()) {
        untracked(() => {
          void this.bootstrap();
          void this.signalr.connect();
        });
      } else {
        untracked(() => this.resetInMemoryState());
      }
    });
  }

  ngOnDestroy(): void {
    this.resetInMemoryState();
  }

  async bootstrap(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }

    this.loading.set(true);
    try {
      await this.loadCachedChatIndex();
      await this.loadCachedSelectedMessages();
      await this.purgeExpiredLocalMessages();
      const bootstrap = await firstValueFrom(this.api.get<SyncBootstrapResponse>('/sync/bootstrap'));
      this.contacts.set(bootstrap.contacts ?? []);
      this.conversations.set((bootstrap.conversations ?? []).sort(this.compareConversations));
      await this.persistChatIndex(bootstrap.conversations ?? [], bootstrap.contacts ?? []);
      for (const message of bootstrap.messages ?? []) {
        await this.ingestMessage(message, false);
      }
      await this.ackDelivered(bootstrap.messages ?? []);
      await this.refreshPresenceForConversations();
    } finally {
      this.loading.set(false);
    }
  }

  async syncMissedMessages(take = 200): Promise<void> {
    if (!this.auth.isAuthenticated() || this.syncInFlight) {
      return;
    }
    this.syncInFlight = true;
    try {
      const accountKey = this.localAccountKey();
      const watermark = accountKey ? await this.history.getSyncWatermark(accountKey).catch(() => null) : null;
      const params = new URLSearchParams({ take: String(Math.max(1, Math.min(take, 500))) });
      if (watermark) {
        params.set('since', watermark);
      }
      const sync = await firstValueFrom(this.api.get<MessageSyncResponse>(`/messages/sync?${params.toString()}`));
      for (const message of sync.messages ?? []) {
        await this.ingestMessage(message, false);
      }
      await this.ackDelivered(sync.messages ?? []);
      if (accountKey && sync.syncedAt) {
        await this.history.setSyncWatermark(accountKey, sync.syncedAt).catch(() => undefined);
      }
      await this.refreshPresenceForConversations();
    } catch {
      // Best-effort foreground sync; realtime/bootstrap remain authoritative.
    } finally {
      this.syncInFlight = false;
    }
  }

  async selectConversation(conversationId: string): Promise<void> {
    const loadId = ++this.selectedConversationLoadId;
    this.selectedConversationId.set(conversationId);
    localStorage.setItem('nivra.selectedConversationId', conversationId);
    await this.signalr.joinConversation(conversationId);
    if (loadId !== this.selectedConversationLoadId || this.selectedConversationId() !== conversationId) {
      return;
    }
    await this.loadCachedMessages(conversationId);
    if (loadId !== this.selectedConversationLoadId || this.selectedConversationId() !== conversationId) {
      return;
    }
    await this.loadMessages(conversationId);
    if (loadId !== this.selectedConversationLoadId || this.selectedConversationId() !== conversationId) {
      return;
    }
    await this.markConversationRead(conversationId);
    await this.refreshPresenceForConversations();
  }

  async loadMessages(conversationId: string): Promise<void> {
    const messages = await firstValueFrom(
      this.api.get<MessageResponse[]>(`/conversations/${encodeURIComponent(conversationId)}/messages?take=80`),
    );
    for (const message of messages ?? []) {
      await this.ingestMessage(message, false);
    }
  }

  async sendTyping(conversationId: string, kind: 'typing' | 'stopped' = 'typing', options: { force?: boolean } = {}): Promise<void> {
    if (!conversationId || !this.auth.isAuthenticated()) {
      return;
    }
    const now = Date.now();
    if (!options.force && kind === 'typing' && now - this.lastTypingSentAt < 900) {
      return;
    }
    this.lastTypingSentAt = now;
    await this.signalr.typing(conversationId, JSON.stringify({ kind, at: new Date().toISOString() }));
    if (kind === 'typing') {
      const existing = this.typingTimers.get(conversationId);
      if (existing) {
        window.clearTimeout(existing);
      }
      this.typingTimers.set(conversationId, window.setTimeout(() => {
        this.typingTimers.delete(conversationId);
        void this.sendTyping(conversationId, 'stopped', { force: true });
      }, 1500));
    }
  }

  typingLabel(conversationId: string): string {
    const names = this.typingByConversation()[conversationId] ?? [];
    if (!names.length) {
      return '';
    }
    return names.length === 1 ? `${names[0]} esta escribiendo` : `${names.length} personas estan escribiendo`;
  }

  presenceLabel(conversation: Conversation | null | undefined): string {
    if (!conversation) {
      return this.signalr.connected() ? 'online' : 'reconectando';
    }
    const currentUserId = this.auth.session()?.user.id;
    const otherUserId = conversation.participants.find((participant) => participant.userId !== currentUserId && !participant.removedAt)?.userId;
    const typing = this.typingLabel(conversation.id);
    if (typing) {
      return typing;
    }
    const presence = otherUserId ? this.presenceByUser()[otherUserId] : null;
    if (presence?.online) {
      return 'online';
    }
    if (presence?.lastSeenAt) {
      return `visto ${this.relativeTime(presence.lastSeenAt)}`;
    }
    return this.signalr.connected() ? 'cifrado extremo a extremo' : 'reconectando';
  }

  async searchPeople(query: string): Promise<UserSummary[]> {
    const normalized = query.trim();
    if (normalized.length < 2) {
      this.directoryResults.set([]);
      return [];
    }
    const result = await firstValueFrom(
      this.api.get<DirectorySearchResponse>(`/directory/search?q=${encodeURIComponent(normalized)}`),
    );
    this.directoryResults.set(result.people ?? []);
    return result.people ?? [];
  }

  async createDirectConversation(person: UserSummary): Promise<Conversation> {
    await firstValueFrom(this.api.post('/contacts', { alias: person.alias, nicknameCiphertext: null })).catch(() => null);
    const conversation = await firstValueFrom(this.api.post<Conversation>('/conversations', {
      type: 'Direct',
      participantUserIds: [person.id],
      titleCiphertext: null,
      privacySettings: null,
    }));
    this.conversations.update((items) => [conversation, ...items.filter((item) => item.id !== conversation.id)]);
    await this.selectConversation(conversation.id);
    return conversation;
  }

  async sendText(conversation: Conversation, text: string, policy: MessagePolicyOptions = {}): Promise<MessageResponse | null> {
    const body = text.trim();
    if (!body) {
      return null;
    }
    const payload: ChatPayload = {
      type: 'text',
      text: body,
      forwardingAllowed: conversation.privacySettings?.allowForwarding ?? true,
    };
    return this.sendPayload(conversation, payload, 'Text', null, this.policyToSendOptions(policy));
  }

  async sendFile(
    conversation: Conversation,
    file: File,
    options: { forwardedFrom?: unknown; voiceNote?: boolean; policy?: MessagePolicyOptions } = {},
  ): Promise<MessageResponse | null> {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('Maximo 50 MB por archivo cifrado.');
    }

    this.uploading.set(true);
    try {
      const sendOptions = this.policyToSendOptions(options.policy ?? {});
      const encrypted = await this.crypto.encryptAttachment(await file.arrayBuffer());
      const allowedUserIds = conversation.participants
        .filter((participant) => !participant.removedAt)
        .map((participant) => participant.userId);
      const mime = file.type || 'application/octet-stream';
      const fileRecord = await firstValueFrom(this.api.post<FileResponse>('/files', {
        encryptedSize: encrypted.bytes.byteLength,
        mimeTypeCiphertext: this.crypto.b64(new TextEncoder().encode(mime)),
        clientSha256: null,
        allowedUserIds,
        expiresAt: sendOptions.expiresAt,
      }));
      await firstValueFrom(this.api.putRaw<FileResponse>(`/files/${encodeURIComponent(fileRecord.id)}/blob`, encrypted.bytes));
      this.rememberMediaPreview(fileRecord.id, file, mime, file.name);

      return this.sendPayload(
        conversation,
        {
          type: 'file',
          fileId: fileRecord.id,
          fileName: file.name,
          mime,
          size: file.size,
          fileKey: encrypted.key,
          fileIv: encrypted.iv,
          voiceNote: options.voiceNote ?? false,
          forwardedFrom: options.forwardedFrom,
        },
        this.fileKind(file),
        fileRecord.id,
        sendOptions,
      );
    } finally {
      this.uploading.set(false);
    }
  }

  async sendPayload(
    conversation: Conversation,
    payload: ChatPayload,
    kind: string = 'Text',
    fileObjectId: string | null = null,
    options: SendPayloadOptions = {},
  ): Promise<MessageResponse | null> {
    const outgoingPayload = this.normalizeOutgoingPayload(conversation, payload);
    const recipients = await this.encryptedRecipients(conversation, outgoingPayload, fileObjectId);
    if (!recipients.length) {
      throw new Error('No hay llaves publicas disponibles para enviar.');
    }
    const response = await firstValueFrom(this.api.post<MessageResponse>(
      `/conversations/${conversation.id}/messages`,
      {
        clientMessageId: `web-${crypto.randomUUID()}`,
        kind,
        recipients,
        encryptedPolicy: options.encryptedPolicy ?? (outgoingPayload.replyTo ? 'reply' : outgoingPayload.forwardedFrom ? 'forward' : null),
        expiresAt: options.expiresAt ?? null,
        deleteAfterRead: options.deleteAfterRead ?? false,
      },
    ));
    if (!options.suppressLocalMessage) {
      await this.ingestLocalSent(response, outgoingPayload);
    }
    return response;
  }

  async sendReaction(conversation: Conversation, message: ChatMessageVm, emoji: string): Promise<void> {
    const current = this.auth.session();
    if (!current || !emoji) {
      return;
    }
    const reaction: MessageReaction = {
      emoji,
      userId: current.user.id,
      deviceId: current.device.id,
      alias: current.user.alias,
      displayName: current.user.displayName || current.user.alias,
      profilePhotoDataUrl: current.user.profilePhotoDataUrl || '',
      at: new Date().toISOString(),
      reactionId: `local-${crypto.randomUUID()}`,
    };
    const pendingKey = `${message.id}:${this.reactionActorKey(reaction)}:${emoji}`;
    if (this.pendingReactionSends.has(pendingKey)) {
      return;
    }
    const added = this.applyReaction(message.id, reaction, conversation.id);
    if (!added) {
      return;
    }
    this.persistExistingMessage(message.id);

    this.pendingReactionSends.add(pendingKey);
    try {
      await this.sendPayload(
        conversation,
        {
          type: 'reaction',
          targetMessageId: message.id,
          emoji,
          userId: reaction.userId,
          deviceId: reaction.deviceId,
          alias: reaction.alias,
          displayName: reaction.displayName,
          profilePhotoDataUrl: reaction.profilePhotoDataUrl,
          reactionAt: reaction.at,
        },
        'System',
        null,
        {
          suppressLocalMessage: true,
          deleteAfterRead: false,
          expiresAt: null,
        },
      );
    } finally {
      this.pendingReactionSends.delete(pendingKey);
    }
  }

  async recordCallSystemMessage(
    call: { id: string; conversationId?: string | null; type?: string; startedAt?: string; endedAt?: string | null; initiatorUserId?: string | null },
    event: 'call-rejected' | 'call-ended' | 'missed-call' | 'call-failed',
    durationMs = 0,
  ): Promise<void> {
    if (!call.conversationId) {
      return;
    }
    const conversation = this.conversations().find((item) => item.id === call.conversationId);
    if (!conversation) {
      return;
    }
    const payload: ChatPayload = {
      type: 'call_log',
      event,
      title: event === 'call-rejected'
        ? 'Llamada rechazada'
        : event === 'call-failed'
          ? 'Llamada fallida'
          : event === 'missed-call' ? 'Llamada perdida' : 'Llamada finalizada',
      text: event === 'call-ended' ? `Duracion ${this.formatCallDuration(durationMs)}` : this.callEventText(event),
      status: event === 'call-ended' ? 'ended' : event === 'missed-call' ? 'missed' : event === 'call-rejected' ? 'rejected' : 'failed',
      durationMs,
      callId: call.id,
      callType: call.type || 'Voice',
      conversationId: call.conversationId,
      initiatorUserId: call.initiatorUserId || '',
      startedAt: call.startedAt || new Date().toISOString(),
      endedAt: call.endedAt || new Date().toISOString(),
    };
    await this.sendPayload(conversation, payload, 'System', null, {
      encryptedPolicy: 'client:call-log',
      deleteAfterRead: false,
      suppressLocalMessage: false,
    }).catch(() => undefined);
  }

  async editMessage(conversation: Conversation, message: ChatMessageVm, newText: string): Promise<void> {
    const text = newText.trim();
    if (!message.mine || !text || this.asFile(message.payload) || message.payload.type === 'system') {
      throw new Error('Ese mensaje no se puede editar.');
    }
    this.applyEditPayload({ type: 'edit', targetMessageId: message.id, newText: text }, conversation.id);
    this.persistExistingMessage(message.id);
    await this.sendPayload(
      conversation,
      { type: 'edit', targetMessageId: message.id, newText: text },
      'System',
      null,
      { suppressLocalMessage: true, deleteAfterRead: false, expiresAt: null },
    );
  }

  async deleteMessage(message: ChatMessageVm, forEveryone: boolean): Promise<void> {
    await firstValueFrom(this.api.delete(`/api/messages/${encodeURIComponent(message.id)}?forEveryone=${forEveryone ? 'true' : 'false'}`));
    this.applyMessageDeleted({ messageId: message.id, conversationId: message.conversationId });
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.removeMessage(accountKey, message.conversationId, message.id).catch(() => undefined);
    }
  }

  async clearConversation(conversation: Conversation, scope: 'me' | 'everyone'): Promise<void> {
    await firstValueFrom(this.api.post(`/api/chats/${encodeURIComponent(conversation.id)}/clear`, { scope }));
    this.messagesByConversation.update((state) => ({ ...state, [conversation.id]: [] }));
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.removeConversationMessages(accountKey, conversation.id).catch(() => undefined);
    }
  }

  async deleteConversation(conversation: Conversation, scope: 'me' | 'everyone'): Promise<void> {
    await firstValueFrom(this.api.delete(`/api/chats/${encodeURIComponent(conversation.id)}?scope=${encodeURIComponent(scope)}`));
    this.conversations.update((items) => items.filter((item) => item.id !== conversation.id));
    this.messagesByConversation.update((state) => {
      const next = { ...state };
      delete next[conversation.id];
      return next;
    });
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.removeConversationMessages(accountKey, conversation.id).catch(() => undefined);
    }
    if (this.selectedConversationId() === conversation.id) {
      const nextId = this.conversations()[0]?.id ?? null;
      this.selectedConversationId.set(nextId);
      if (nextId) {
        localStorage.setItem('nivra.selectedConversationId', nextId);
      } else {
        localStorage.removeItem('nivra.selectedConversationId');
      }
    }
  }

  forwardAvailability(message: ChatMessageVm | null | undefined): { ok: boolean; reason?: string } {
    if (!message) {
      return { ok: false, reason: 'Mensaje no disponible.' };
    }
    if (['reaction', 'edit', 'delete', 'system'].includes(message.payload?.type)) {
      return { ok: false, reason: 'Ese evento no se puede reenviar.' };
    }
    if (message.deleteAfterRead) {
      return { ok: false, reason: 'Los mensajes de una sola vez no se pueden reenviar.' };
    }
    if (!message.mine && message.payload?.forwardingAllowed === false) {
      return { ok: false, reason: 'El remitente bloqueo el reenvio.' };
    }
    return { ok: true };
  }

  forwardTargets(sourceConversationId: string, query = ''): Conversation[] {
    const normalized = query.trim().toLowerCase();
    return [...this.conversations()]
      .filter((conversation) => conversation.id !== sourceConversationId)
      .filter((conversation) => conversation.participants.some((participant) => !participant.removedAt))
      .sort(this.compareConversations)
      .filter((conversation) => !normalized || this.conversationTitle(conversation).toLowerCase().includes(normalized));
  }

  async forwardMessageToConversations(message: ChatMessageVm, conversationIds: string[]): Promise<number> {
    const uniqueIds = [...new Set(conversationIds.filter(Boolean))];
    let sent = 0;
    for (const conversationId of uniqueIds) {
      const target = this.conversations().find((conversation) => conversation.id === conversationId);
      if (!target) {
        continue;
      }
      if (await this.forwardMessageToConversation(message, target).catch(() => false)) {
        sent += 1;
      }
      await this.yieldToMainThread();
    }
    return sent;
  }

  asFile(payload: ChatPayload): FileChatPayload | null {
    if (payload.type !== 'file' && !payload['fileId'] && !payload['downloadFile']) {
      return null;
    }
    return payload as FileChatPayload;
  }

  mediaPreview(fileId?: string | null): MediaPreview | null {
    return fileId ? this.mediaPreviews()[fileId] ?? null : null;
  }

  async ensureMediaPreview(payload: ChatPayload): Promise<MediaPreview | null> {
    const file = this.asFile(payload);
    const fileId = this.fileId(file);
    if (!file || !fileId || !file.fileKey || !file.fileIv) {
      return null;
    }

    const cached = this.mediaPreviews()[fileId];
    if (cached) {
      return cached;
    }

    const encrypted = await firstValueFrom(this.api.getArrayBuffer(`/files/${encodeURIComponent(fileId)}/blob`));
    const plain = await this.crypto.decryptAttachment(encrypted, file.fileKey, file.fileIv);
    return this.rememberMediaPreview(fileId, new Blob([plain], { type: this.fileMime(file) }), this.fileMime(file), this.fileName(file));
  }

  async downloadAttachment(payload: ChatPayload): Promise<void> {
    const preview = await this.ensureMediaPreview(payload);
    const file = this.asFile(payload);
    if (!preview || !file) {
      return;
    }

    const link = document.createElement('a');
    link.href = preview.url;
    link.download = this.fileName(file);
    link.click();
  }

  conversationTitle(conversation: Conversation): string {
    const currentUserId = this.auth.session()?.user.id;
    const other = conversation.participants.find((participant) => participant.userId !== currentUserId);
    const contact = this.contacts().find((candidate) => candidate.userId === other?.userId);
    return contact?.displayName || contact?.alias || (conversation.type === 'Group' ? 'Grupo Nivra' : 'Chat privado');
  }

  conversationSubtitle(conversation: Conversation): string {
    const messages = this.messagesByConversation()[conversation.id] ?? [];
    const last = messages[messages.length - 1];
    if (!last) {
      return conversation.type === 'Group' ? 'Espacio cifrado listo' : 'Cifrado extremo a extremo';
    }
    return this.preview(last.payload);
  }

  preview(payload: ChatPayload): string {
    if (payload.type === 'system') {
      return payload.text || payload.title || 'Evento de sistema';
    }
    if (this.isCallLog(payload)) {
      return payload.title || (payload.event === 'missed-call' ? 'Llamada perdida' : 'Llamada finalizada');
    }
    if (payload.type === 'reaction') {
      return `Reaccion ${payload.emoji ?? ''}`.trim();
    }
    const file = this.asFile(payload);
    if (file) {
      return file.voiceNote ? 'Nota de voz' : this.fileName(file);
    }
    return payload.text || payload.title || 'Mensaje cifrado';
  }

  isCallLog(payload: ChatPayload): boolean {
    return payload.type === 'call_log' || (payload.type === 'system' && ['missed-call', 'call-ended'].includes(String(payload.event || '')));
  }

  callLogTitle(payload: ChatPayload): string {
    const missed = payload.event === 'missed-call' || payload['status'] === 'missed';
    const rejected = payload.event === 'call-rejected' || payload['status'] === 'rejected';
    const failed = payload.event === 'call-failed' || payload['status'] === 'failed';
    return payload.title || (rejected ? 'Llamada rechazada' : failed ? 'Llamada fallida' : missed ? 'Llamada perdida' : 'Llamada finalizada');
  }

  callLogText(payload: ChatPayload): string {
    const missed = payload.event === 'missed-call' || payload['status'] === 'missed';
    const rejected = payload.event === 'call-rejected' || payload['status'] === 'rejected';
    const failed = payload.event === 'call-failed' || payload['status'] === 'failed';
    return payload.text || (rejected ? 'Rechazada' : failed ? 'No se pudo conectar' : missed ? 'No hubo respuesta' : 'Registro de llamada cifrado');
  }

  reactionGroups(message: ChatMessageVm): { emoji: string; count: number }[] {
    const groups = new Map<string, number>();
    for (const reaction of message.payload.reactions ?? []) {
      if (reaction.emoji) {
        groups.set(reaction.emoji, (groups.get(reaction.emoji) ?? 0) + 1);
      }
    }
    return [...groups.entries()].map(([emoji, count]) => ({ emoji, count })).slice(0, 4);
  }

  reactionSummary(message: ChatMessageVm): string {
    return (message.payload.reactions ?? [])
      .map((reaction) => `${reaction.displayName || reaction.alias || 'Alguien'} ${reaction.emoji}`.trim())
      .filter(Boolean)
      .join(', ');
  }

  avatarLabel(conversation: Conversation): string {
    const title = this.conversationTitle(conversation);
    return title.split(/\s|,|-/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'N';
  }

  private async ingestMessage(message: MessageResponse, markDelivered: boolean): Promise<void> {
    const current = this.auth.session();
    if (!current) {
      return;
    }
    const recipient = message.recipients.find((item) => item.userId === current.user.id && item.deviceId === current.device.id)
      ?? message.recipients.find((item) => item.userId === current.user.id);
    let payload: ChatPayload;
    let decryptError = false;
    if (message.encryptedPolicy?.startsWith('system:') || recipient?.header?.startsWith('system:')) {
      payload = this.decodeSystemPayload(recipient?.ciphertext);
    } else if (recipient?.ciphertext) {
      try {
        const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
        payload = await this.crypto.decryptEnvelope<ChatPayload>(own, recipient.header, recipient.ciphertext);
      } catch {
        decryptError = true;
        payload = { type: 'system', title: 'Mensaje protegido', text: 'No se pudo descifrar en este dispositivo.' };
      }
    } else if (message.senderUserId === current.user.id) {
      payload = { type: 'system', text: 'Mensaje enviado desde otro dispositivo.' };
    } else {
      payload = { type: 'system', text: 'Paquete cifrado no disponible para este dispositivo.' };
    }

    const vm: ChatMessageVm = {
      id: message.id,
      conversationId: message.conversationId,
      mine: message.senderUserId === current.user.id,
      senderUserId: message.senderUserId,
      senderDeviceId: message.senderDeviceId,
      at: message.serverReceivedAt,
      payload,
      receipts: message.receipts,
      expiresAt: message.expiresAt,
      deleteAfterRead: message.deleteAfterRead,
      decryptError,
    };
    if (payload.type === 'reaction') {
      this.applyReactionPayload(payload, message.conversationId, message.id, message.serverReceivedAt);
      this.persistExistingMessage(this.stringPayload(payload, 'targetMessageId'));
      if (markDelivered && !vm.mine) {
        void this.sendReceipt(message.id, 'Delivered');
      }
      return;
    }
    if (payload.type === 'edit') {
      this.applyEditPayload(payload, message.conversationId);
      this.persistExistingMessage(this.stringPayload(payload, 'targetMessageId'));
      if (markDelivered && !vm.mine) {
        void this.sendReceipt(message.id, 'Delivered');
      }
      return;
    }
    if (payload.type === 'delete') {
      this.applyMessageDeleted({
        messageId: payload['targetMessageId'],
        conversationId: message.conversationId,
      });
      this.removeLocalMessage(message.conversationId, this.stringPayload(payload, 'targetMessageId'));
      if (markDelivered && !vm.mine) {
        void this.sendReceipt(message.id, 'Delivered');
      }
      return;
    }
    this.upsertMessage(vm);
    if (markDelivered && !vm.mine) {
      void this.sendReceipt(message.id, 'Delivered');
    }
  }

  private async ingestLocalSent(response: MessageResponse, payload: ChatPayload): Promise<void> {
    const current = this.auth.session();
    if (!current) {
      return;
    }
    this.upsertMessage({
      id: response.id,
      conversationId: response.conversationId,
      mine: true,
      senderUserId: current.user.id,
      senderDeviceId: current.device.id,
      at: response.serverReceivedAt,
      status: 'enviado',
      payload,
      receipts: response.receipts,
      expiresAt: response.expiresAt,
      deleteAfterRead: response.deleteAfterRead,
    });
  }

  private upsertMessage(message: ChatMessageVm, options: { persist?: boolean } = {}): void {
    const messageWithPendingReactions = this.applyPendingReactions(message);
    this.messagesByConversation.update((state) => {
      const current = state[messageWithPendingReactions.conversationId] ?? [];
      const next = [...current.filter((item) => item.id !== messageWithPendingReactions.id), messageWithPendingReactions]
        .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
      return { ...state, [messageWithPendingReactions.conversationId]: next };
    });
    if (options.persist !== false) {
      this.persistLocalMessage(messageWithPendingReactions);
    }
  }

  async markConversationRead(conversationId: string): Promise<void> {
    const current = this.auth.session();
    if (!current || current.user.privacySettings?.readReceipts === false || document.visibilityState === 'hidden') {
      return;
    }
    const unread = (this.messagesByConversation()[conversationId] ?? []).filter((message) => {
      if (message.mine || this.readReceiptSentIds.has(message.id)) {
        return false;
      }
      const ownReceipt = message.receipts?.find((receipt) => receipt.userId === current.user.id && receipt.deviceId === current.device.id);
      return !ownReceipt?.readAt;
    });

    const viewOnceIds = unread.filter((message) => message.deleteAfterRead).map((message) => message.id);
    if (viewOnceIds.length) {
      const accountKey = this.localAccountKey();
      if (accountKey) {
        await this.history.markMessagesOpened(accountKey, conversationId, viewOnceIds).catch(() => undefined);
      }
    }

    for (const message of unread) {
      this.readReceiptSentIds.add(message.id);
      this.applyReceipt({
        messageId: message.id,
        userId: current.user.id,
        deviceId: current.device.id,
        kind: 'Read',
        at: new Date().toISOString(),
      });
      await this.sendReceipt(message.id, 'Read').catch(() => this.readReceiptSentIds.delete(message.id));
    }
  }

  fileName(payload: FileChatPayload): string {
    return payload.fileName || 'nivra-file.bin';
  }

  fileMime(payload: FileChatPayload): string {
    return payload.fileMime || payload.mime || 'application/octet-stream';
  }

  fileSize(payload: FileChatPayload): string {
    const size = Number(payload.size || 0);
    if (!size) {
      return 'Archivo cifrado';
    }
    if (size < 1024) {
      return `${size} B`;
    }
    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  isImage(payload: FileChatPayload): boolean {
    return this.fileMime(payload).startsWith('image/');
  }

  isAudio(payload: FileChatPayload): boolean {
    return this.fileMime(payload).startsWith('audio/');
  }

  isVideo(payload: FileChatPayload): boolean {
    return this.fileMime(payload).startsWith('video/');
  }

  private async loadCachedSelectedMessages(): Promise<void> {
    const conversationId = this.selectedConversationId();
    if (conversationId) {
      await this.loadCachedMessages(conversationId);
    }
  }

  private async loadCachedChatIndex(): Promise<void> {
    const accountKey = this.localAccountKey();
    if (!accountKey) {
      return;
    }
    const [conversations, contacts] = await Promise.all([
      this.history.conversations(accountKey).catch(() => []),
      this.history.contacts(accountKey).catch(() => []),
    ]);
    if (contacts.length) {
      this.contacts.set(contacts);
    }
    if (conversations.length) {
      this.conversations.set(conversations.sort(this.compareConversations));
    }
  }

  private async persistChatIndex(conversations: Conversation[], contacts: Contact[]): Promise<void> {
    const accountKey = this.localAccountKey();
    if (!accountKey) {
      return;
    }
    await Promise.all([
      this.history.putConversations(accountKey, conversations).catch(() => undefined),
      this.history.putContacts(accountKey, contacts).catch(() => undefined),
    ]);
  }

  private async loadCachedMessages(conversationId: string): Promise<void> {
    const accountKey = this.localAccountKey();
    if (!accountKey || !conversationId) {
      return;
    }
    const messages = await this.history.conversationMessagesPage(accountKey, conversationId, 80).catch(() => []);
    for (const message of messages) {
      this.upsertMessage(message, { persist: false });
    }
  }

  private async purgeExpiredLocalMessages(): Promise<void> {
    const accountKey = this.localAccountKey();
    if (!accountKey) {
      return;
    }
    const expired = await this.history.purgeExpired(accountKey).catch(() => []);
    if (!expired.length) {
      return;
    }
    const idsByConversation = new Map<string, Set<string>>();
    for (const message of expired) {
      const ids = idsByConversation.get(message.conversationId) ?? new Set<string>();
      ids.add(message.id);
      idsByConversation.set(message.conversationId, ids);
    }
    this.messagesByConversation.update((state) => {
      const next = { ...state };
      for (const [conversationId, ids] of idsByConversation) {
        next[conversationId] = (next[conversationId] ?? []).filter((message) => !ids.has(message.id));
      }
      return next;
    });
  }

  private persistLocalMessage(message: ChatMessageVm): void {
    const accountKey = this.localAccountKey();
    if (accountKey) {
      void this.history.putMessage(accountKey, message).catch(() => undefined);
    }
  }

  private persistExistingMessage(messageId: string): void {
    if (!messageId) {
      return;
    }
    const message = this.findMessage(messageId);
    if (message) {
      this.persistLocalMessage(message);
    }
  }

  private removeLocalMessage(conversationId: string, messageId: string): void {
    const accountKey = this.localAccountKey();
    if (accountKey && conversationId && messageId) {
      void this.history.removeMessage(accountKey, conversationId, messageId).catch(() => undefined);
    }
  }

  private findMessage(messageId: string): ChatMessageVm | null {
    for (const messages of Object.values(this.messagesByConversation())) {
      const found = messages.find((message) => message.id === messageId);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private localAccountKey(): string | null {
    const session = this.auth.session();
    return session?.user.id && session.device.id ? `${session.user.id}:${session.device.id}` : null;
  }

  private normalizeOutgoingPayload(conversation: Conversation, payload: ChatPayload): ChatPayload {
    const outgoing = { ...(payload || {}) };
    const controlTypes = new Set(['reaction', 'edit', 'delete', 'system']);
    if (outgoing.type && !controlTypes.has(outgoing.type) && outgoing.forwardingAllowed === undefined) {
      outgoing.forwardingAllowed = conversation.privacySettings?.allowForwarding ?? true;
    }
    return outgoing;
  }

  private policyToSendOptions(policy: MessagePolicyOptions): SendPayloadOptions {
    const ttlSeconds = Number(policy.ttlSeconds || 0);
    return {
      deleteAfterRead: Boolean(policy.deleteAfterRead),
      expiresAt: ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
      encryptedPolicy: policy.deleteAfterRead
        ? 'view-once'
        : ttlSeconds > 0 ? `ttl:${ttlSeconds}` : null,
    };
  }

  private async ackDelivered(messages: MessageResponse[]): Promise<void> {
    const current = this.auth.session();
    if (!current) {
      return;
    }
    const ids = messages
      .filter((message) => message.senderUserId !== current.user.id)
      .filter((message) => message.recipients.some((recipient) => recipient.userId === current.user.id))
      .map((message) => message.id);
    if (!ids.length) {
      return;
    }
    await firstValueFrom(this.api.post('/messages/sync/ack', { messageIds: ids })).catch(() => null);
  }

  private async sendReceipt(messageId: string, kind: 'Delivered' | 'Read' | 'Deleted'): Promise<void> {
    await firstValueFrom(this.api.post(`/messages/${encodeURIComponent(messageId)}/receipt`, { kind })).then((response) => {
      const message = response as MessageResponse;
      if (message?.id) {
        this.mergeMessageReceipts(message.id, message.receipts ?? []);
      }
    });
  }

  private applyReceipt(payload: unknown): void {
    const value = payload as { messageId?: string; userId?: string; deviceId?: string; kind?: string; at?: string };
    if (!value?.messageId || !value.userId || !value.deviceId) {
      return;
    }

    const kind = String(value.kind || '').toLowerCase();
    const at = value.at || new Date().toISOString();
    this.messagesByConversation.update((state) => {
      let changed = false;
      const nextState: Record<string, ChatMessageVm[]> = {};
      for (const [conversationId, messages] of Object.entries(state)) {
        nextState[conversationId] = messages.map((message) => {
          if (message.id !== value.messageId) {
            return message;
          }
          changed = true;
          const receipts = this.mergeReceipt(message.receipts ?? [], value.userId!, value.deviceId!, kind, at);
          return {
            ...message,
            receipts,
            status: kind.includes('read') ? 'visto' : kind.includes('deliver') ? 'entregado' : message.status,
          };
        });
      }
      return changed ? nextState : state;
    });
    this.persistExistingMessage(value.messageId);
  }

  private mergeMessageReceipts(messageId: string, receipts: DeliveryReceipt[]): void {
    this.messagesByConversation.update((state) => {
      let changed = false;
      const nextState: Record<string, ChatMessageVm[]> = {};
      for (const [conversationId, messages] of Object.entries(state)) {
        nextState[conversationId] = messages.map((message) => {
          if (message.id !== messageId) {
            return message;
          }
          changed = true;
          return { ...message, receipts };
        });
      }
      return changed ? nextState : state;
    });
    this.persistExistingMessage(messageId);
  }

  private mergeReceipt(
    receipts: DeliveryReceipt[],
    userId: string,
    deviceId: string,
    kind: string,
    at: string,
  ): DeliveryReceipt[] {
    const next = [...receipts];
    let receipt = next.find((item) => item.userId === userId && item.deviceId === deviceId);
    if (!receipt) {
      receipt = { userId, deviceId };
      next.push(receipt);
    }
    const index = next.indexOf(receipt);
    const updated: DeliveryReceipt = { ...receipt };
    if (kind.includes('read')) {
      updated.readAt = at;
      updated.deliveredAt ||= at;
    } else if (kind.includes('deliver')) {
      updated.deliveredAt ||= at;
    } else if (kind.includes('delete')) {
      updated.deletedAt = at;
    }
    next[index] = updated;
    return next;
  }

  private applyReactionPayload(payload: ChatPayload, conversationId: string, reactionMessageId: string, fallbackAt: string): void {
    const targetMessageId = this.stringPayload(payload, 'targetMessageId');
    const emoji = typeof payload.emoji === 'string' ? payload.emoji : '';
    if (!targetMessageId || !emoji) {
      return;
    }
    const reaction: MessageReaction = {
      emoji,
      userId: this.stringPayload(payload, 'userId'),
      deviceId: this.stringPayload(payload, 'deviceId'),
      alias: this.stringPayload(payload, 'alias'),
      displayName: this.stringPayload(payload, 'displayName'),
      profilePhotoDataUrl: this.stringPayload(payload, 'profilePhotoDataUrl'),
      at: this.stringPayload(payload, 'reactionAt') || fallbackAt,
      reactionId: reactionMessageId,
    };
    const applied = this.applyReaction(targetMessageId, reaction, conversationId);
    if (!applied) {
      this.queuePendingReaction(targetMessageId, reaction);
    }
  }

  private applyReaction(targetMessageId: string, reaction: MessageReaction, conversationId?: string | null): boolean {
    let changed = false;
    this.messagesByConversation.update((state) => {
      const conversationIds = conversationId ? [conversationId] : Object.keys(state);
      const nextState = { ...state };
      for (const id of conversationIds) {
        const messages = state[id] ?? [];
        const index = messages.findIndex((message) => message.id === targetMessageId);
        if (index < 0) {
          continue;
        }
        const target = messages[index];
        const existing = target.payload.reactions ?? [];
        const actorKey = this.reactionActorKey(reaction);
        const alreadyApplied = existing.some((item) =>
          item.reactionId === reaction.reactionId ||
          `${this.reactionActorKey(item)}:${item.emoji}` === `${actorKey}:${reaction.emoji}`);
        if (alreadyApplied) {
          return state;
        }
        const nextMessages = [...messages];
        nextMessages[index] = {
          ...target,
          payload: {
            ...target.payload,
            reactions: [...existing, reaction],
          },
        };
        nextState[id] = nextMessages;
        changed = true;
        break;
      }
      return changed ? nextState : state;
    });
    return changed;
  }

  private applyEditPayload(payload: ChatPayload, conversationId: string): void {
    const targetMessageId = this.stringPayload(payload, 'targetMessageId');
    const newText = this.stringPayload(payload, 'newText');
    if (!targetMessageId || !newText) {
      return;
    }
    this.messagesByConversation.update((state) => {
      const messages = state[conversationId] ?? [];
      let changed = false;
      const next = messages.map((message) => {
        if (message.id !== targetMessageId) {
          return message;
        }
        changed = true;
        return {
          ...message,
          status: 'editado',
          payload: {
            ...message.payload,
            text: newText,
          },
        };
      });
      return changed ? { ...state, [conversationId]: next } : state;
    });
  }

  private applyMessageDeleted(payload: unknown): void {
    const value = payload as { messageId?: unknown; conversationId?: unknown };
    const messageId = typeof value?.messageId === 'string' ? value.messageId : null;
    const conversationId = typeof value?.conversationId === 'string' ? value.conversationId : null;
    if (!messageId) {
      return;
    }
    this.messagesByConversation.update((state) => {
      const ids = conversationId ? [conversationId] : Object.keys(state);
      let changed = false;
      const nextState = { ...state };
      for (const id of ids) {
        const nextMessages = (state[id] ?? []).filter((message) => message.id !== messageId);
        if (nextMessages.length !== (state[id] ?? []).length) {
          nextState[id] = nextMessages;
          changed = true;
        }
      }
      return changed ? nextState : state;
    });
    if (conversationId) {
      this.removeLocalMessage(conversationId, messageId);
    } else {
      for (const id of Object.keys(this.messagesByConversation())) {
        this.removeLocalMessage(id, messageId);
      }
    }
  }

  private applyChatCleared(payload: unknown): void {
    const value = payload as { conversationId?: unknown; mode?: unknown };
    const conversationId = typeof value?.conversationId === 'string' ? value.conversationId : null;
    if (!conversationId) {
      return;
    }
    if (value.mode === 'deleted') {
      this.conversations.update((items) => items.filter((conversation) => conversation.id !== conversationId));
      if (this.selectedConversationId() === conversationId) {
        this.selectedConversationId.set(null);
        localStorage.removeItem('nivra.selectedConversationId');
      }
    }
    this.messagesByConversation.update((state) => ({ ...state, [conversationId]: [] }));
    const accountKey = this.localAccountKey();
    if (accountKey) {
      void this.history.removeConversationMessages(accountKey, conversationId).catch(() => undefined);
    }
  }

  private applyTyping(payload: unknown): void {
    const current = this.auth.session();
    const value = payload as {
      conversationId?: string;
      senderUserId?: string;
      senderDeviceId?: string;
      encryptedState?: string;
    };
    if (!value?.conversationId || !value.senderUserId || value.senderUserId === current?.user.id) {
      return;
    }
    let kind = 'typing';
    try {
      kind = String((JSON.parse(value.encryptedState || '{}') as { kind?: string }).kind || 'typing');
    } catch {
      kind = String(value.encryptedState || 'typing');
    }
    const label = this.contactLabel(value.senderUserId);
    this.typingByConversation.update((state) => {
      const names = new Set(state[value.conversationId!] ?? []);
      if (kind === 'stopped') {
        names.delete(label);
      } else {
        names.add(label);
      }
      return { ...state, [value.conversationId!]: [...names] };
    });

    const timerKey = `typing:${value.conversationId}:${value.senderUserId}:${value.senderDeviceId || ''}`;
    const existing = this.typingTimers.get(timerKey);
    if (existing) {
      window.clearTimeout(existing);
    }
    if (kind !== 'stopped') {
      this.typingTimers.set(timerKey, window.setTimeout(() => {
        this.typingTimers.delete(timerKey);
        this.typingByConversation.update((state) => {
          const names = new Set(state[value.conversationId!] ?? []);
          names.delete(label);
          return { ...state, [value.conversationId!]: [...names] };
        });
      }, 3700));
    }
  }

  private applyPresence(payload: PresenceResponse | unknown): void {
    const value = payload as PresenceResponse;
    if (!value?.userId) {
      return;
    }
    this.presenceByUser.update((state) => ({ ...state, [value.userId]: value }));
  }

  private async refreshPresenceForConversations(): Promise<void> {
    if (!this.auth.isAuthenticated() || !this.signalr.connected()) {
      return;
    }
    const currentUserId = this.auth.session()?.user.id;
    const userIds = this.conversations()
      .flatMap((conversation) => conversation.participants)
      .filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
      .map((participant) => participant.userId);
    const presence = await this.signalr.presence(userIds).catch(() => []);
    if (presence.length) {
      this.presenceByUser.update((state) => ({
        ...state,
        ...Object.fromEntries(presence.map((item) => [item.userId, item])),
      }));
    }
  }

  private async rejoinSelectedConversation(): Promise<void> {
    const conversationId = this.selectedConversationId();
    if (conversationId) {
      await this.signalr.joinConversation(conversationId).catch(() => undefined);
    }
  }

  private contactLabel(userId: string): string {
    const contact = this.contacts().find((candidate) => candidate.userId === userId);
    return contact?.displayName || contact?.alias || 'Contacto';
  }

  private relativeTime(value: string): string {
    const delta = Date.now() - Date.parse(value);
    if (!Number.isFinite(delta) || delta < 0) {
      return 'recientemente';
    }
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) {
      return 'ahora';
    }
    if (minutes < 60) {
      return `hace ${minutes} min`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `hace ${hours} h`;
    }
    const days = Math.floor(hours / 24);
    return `hace ${days} d`;
  }

  private resetInMemoryState(): void {
    this.revokeMediaPreviews();
    this.conversations.set([]);
    this.contacts.set([]);
    this.messagesByConversation.set({});
    this.mediaPreviews.set({});
    this.directoryResults.set([]);
    this.typingByConversation.set({});
    this.presenceByUser.set({});
    this.directories.clear();
    this.readReceiptSentIds.clear();
    this.pendingReactionsByMessageId.clear();
    this.pendingReactionSends.clear();
    this.lastTypingSentAt = 0;
    this.syncInFlight = false;
    this.selectedConversationLoadId += 1;
    this.selectedConversationId.set(null);
    localStorage.removeItem('nivra.selectedConversationId');
    this.typingTimers.forEach((timer) => window.clearTimeout(timer));
    this.typingTimers.clear();
  }

  private revokeMediaPreviews(): void {
    Object.values(this.mediaPreviews()).forEach((preview) => {
      if (preview?.url) {
        URL.revokeObjectURL(preview.url);
      }
    });
  }

  private applyPendingReactions(message: ChatMessageVm): ChatMessageVm {
    const pending = this.pendingReactionsByMessageId.get(message.id);
    if (!pending?.length) {
      return message;
    }

    const nextReactions = [...(message.payload.reactions ?? [])];
    let changed = false;
    for (const reaction of pending) {
      const actorKey = this.reactionActorKey(reaction);
      const exists = nextReactions.some((item) =>
        item.reactionId === reaction.reactionId ||
        `${this.reactionActorKey(item)}:${item.emoji}` === `${actorKey}:${reaction.emoji}`);
      if (!exists) {
        nextReactions.push(reaction);
        changed = true;
      }
    }

    this.pendingReactionsByMessageId.delete(message.id);
    return changed
      ? { ...message, payload: { ...message.payload, reactions: nextReactions } }
      : message;
  }

  private queuePendingReaction(messageId: string, reaction: MessageReaction): void {
    if (!messageId) {
      return;
    }
    const pending = this.pendingReactionsByMessageId.get(messageId) ?? [];
    const actorKey = this.reactionActorKey(reaction);
    const exists = pending.some((item) =>
      item.reactionId === reaction.reactionId ||
      `${this.reactionActorKey(item)}:${item.emoji}` === `${actorKey}:${reaction.emoji}`);
    if (!exists) {
      this.pendingReactionsByMessageId.set(messageId, [...pending, reaction]);
    }
  }

  private reactionActorKey(reaction: MessageReaction): string {
    return reaction.userId || reaction.deviceId || reaction.alias || reaction.displayName || 'unknown';
  }

  private stringPayload(payload: ChatPayload, key: string): string {
    const value = payload[key];
    return typeof value === 'string' ? value : '';
  }

  private async encryptedRecipients(
    conversation: Conversation,
    payload: ChatPayload,
    fileObjectId: string | null = null,
  ): Promise<RecipientCipherRequest[]> {
    const current = this.auth.session();
    if (!current) {
      return [];
    }
    const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const recipients: RecipientCipherRequest[] = [];
    const activeParticipants = conversation.participants.filter((participant) => !participant.removedAt);
    const directories = await this.directoriesForUsers(activeParticipants.map((participant) => participant.userId));

    for (const participant of activeParticipants) {
      const directory = participant.userId === current.user.id
        ? await this.ownKeyDirectory()
        : directories.get(participant.userId);
      const usedDeviceIds = new Set<string>();
      for (const device of directory?.devices ?? []) {
        const publicKey = this.crypto.parsePublicJwk(device.keyBundle?.identityKey);
        if (!device.deviceId || !publicKey || usedDeviceIds.has(device.deviceId)) {
          continue;
        }
        const sealed = await this.crypto.encryptForPublicKey(own, publicKey, payload);
        recipients.push({
          userId: participant.userId,
          deviceId: device.deviceId,
          ciphertext: sealed.ciphertext,
          header: sealed.header,
          fileObjectId,
        });
        usedDeviceIds.add(device.deviceId);
      }

      if (participant.userId === current.user.id && !usedDeviceIds.has(current.device.id)) {
        const sealed = await this.crypto.encryptForPublicKey(own, own.publicJwk, payload);
        recipients.push({
          userId: current.user.id,
          deviceId: current.device.id,
          ciphertext: sealed.ciphertext,
          header: sealed.header,
          fileObjectId,
        });
      }
    }

    return recipients;
  }

  private async forwardMessageToConversation(message: ChatMessageVm, conversation: Conversation): Promise<boolean> {
    const availability = this.forwardAvailability(message);
    if (!availability.ok) {
      throw new Error(availability.reason || 'No se puede reenviar.');
    }
    const current = this.auth.session();
    const forwardedFrom = {
      messageId: message.id,
      senderAlias: message.mine ? current?.user.alias : this.senderLabel(message),
      at: message.at,
    };
    const file = this.asFile(message.payload);
    if (file) {
      const forwardedFile = await this.fileFromForwardPayload(file);
      await this.sendFile(conversation, forwardedFile, {
        forwardedFrom,
        voiceNote: Boolean(file.voiceNote),
      });
      return true;
    }

    const { reactions: _reactions, replyTo: _replyTo, ...payload } = message.payload;
    await this.sendPayload(
      conversation,
      { ...payload, forwardedFrom, replyTo: null },
      'Text',
      null,
      { deleteAfterRead: false },
    );
    return true;
  }

  private async fileFromForwardPayload(payload: FileChatPayload): Promise<File> {
    const fileId = this.fileId(payload);
    if (!fileId || !payload.fileKey || !payload.fileIv) {
      throw new Error('El adjunto cifrado no tiene metadata completa.');
    }
    const encrypted = await firstValueFrom(this.api.getArrayBuffer(`/files/${encodeURIComponent(fileId)}/blob`));
    const plain = await this.crypto.decryptAttachment(encrypted, payload.fileKey, payload.fileIv);
    const mime = this.fileMime(payload);
    const name = this.fileName(payload);
    const blob = new Blob([plain], { type: mime });
    this.rememberMediaPreview(fileId, blob, mime, name);
    return new File([blob], name, { type: mime });
  }

  private senderLabel(message: ChatMessageVm): string {
    const contact = this.contacts().find((candidate) => candidate.userId === message.senderUserId);
    return contact?.displayName || contact?.alias || 'Contacto';
  }

  private async directoriesForUsers(userIds: string[]): Promise<Map<string, PublicKeyDirectory>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    const missing = uniqueIds.filter((id) => !this.directories.has(id));
    if (missing.length) {
      const directories = await firstValueFrom(
        this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: missing, aliases: [] }),
      ).catch(() => []);
      for (const directory of directories ?? []) {
        this.directories.set(directory.userId, directory);
      }
    }
    return new Map(uniqueIds.map((id) => [id, this.directories.get(id)]).filter((entry): entry is [string, PublicKeyDirectory] => Boolean(entry[1])));
  }

  private async ownKeyDirectory(): Promise<PublicKeyDirectory | null> {
    const alias = this.auth.session()?.user.alias;
    if (!alias) {
      return null;
    }
    const directory = await firstValueFrom(this.api.get<PublicKeyDirectory>(`/keys/${encodeURIComponent(alias)}`)).catch(() => null);
    if (directory) {
      this.directories.set(directory.userId, directory);
    }
    return directory;
  }

  private decodeSystemPayload(value?: string): ChatPayload {
    if (!value) {
      return { type: 'system', text: 'Evento de sistema' };
    }
    try {
      return JSON.parse(new TextDecoder().decode(this.crypto.ub64(value))) as ChatPayload;
    } catch {
      return { type: 'system', text: value };
    }
  }

  private callEventText(event: string): string {
    if (event === 'call-rejected') {
      return 'Llamada rechazada';
    }
    if (event === 'call-failed') {
      return 'No se pudo conectar';
    }
    if (event === 'missed-call') {
      return 'No hubo respuesta';
    }
    return 'Registro de llamada cifrado';
  }

  private formatCallDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private compareConversations(left: Conversation, right: Conversation): number {
    const leftAt = left.lastMessageAt || left.updatedAt || left.createdAt;
    const rightAt = right.lastMessageAt || right.updatedAt || right.createdAt;
    return new Date(rightAt).getTime() - new Date(leftAt).getTime();
  }

  private fileId(payload: FileChatPayload | null): string | null {
    return payload?.fileId || payload?.downloadFile || payload?.previewFile || null;
  }

  private fileKind(file: File): 'Image' | 'Video' | 'Audio' | 'Document' {
    if (file.type.startsWith('image/')) {
      return 'Image';
    }
    if (file.type.startsWith('video/')) {
      return 'Video';
    }
    if (file.type.startsWith('audio/')) {
      return 'Audio';
    }
    return 'Document';
  }

  private rememberMediaPreview(fileId: string, fileOrBlob: Blob, mime: string, name: string): MediaPreview {
    const previous = this.mediaPreviews()[fileId];
    if (previous?.url) {
      URL.revokeObjectURL(previous.url);
    }
    const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob], { type: mime || 'application/octet-stream' });
    const preview: MediaPreview = {
      fileId,
      url: URL.createObjectURL(blob),
      mime: mime || blob.type || 'application/octet-stream',
      name,
      createdAt: Date.now(),
    };
    this.mediaPreviews.update((items) => ({ ...items, [fileId]: preview }));
    return preview;
  }

  private yieldToMainThread(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
