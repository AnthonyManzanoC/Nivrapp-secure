import { DestroyRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
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
  GroupSettings,
  LocalProfile,
  MediaPreview,
  MessageReaction,
  MessageResponse,
  MessageSyncResponse,
  PresenceResponse,
  PublicKeyDirectory,
  RecipientCipherRequest,
  StoredDeviceKeys,
  SyncBootstrapResponse,
  UserSummary,
} from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService, PublicKeyRecipient } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { E2EE_UPLOAD_LIMIT_BYTES, EncryptedUploadMode, MediaOptimizerService } from './media-optimizer.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { AppSettingsService } from './app-settings.service';
import { NativeDeviceService } from './native-device.service';

const MAX_ATTACHMENT_BYTES = E2EE_UPLOAD_LIMIT_BYTES;
const LARGE_ATTACHMENT_CHUNK_THRESHOLD_BYTES = 50 * 1024 * 1024;
const QUICK_REACTIONS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F64F}'];
const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  editInfo: 'admins',
  sendMessages: 'all',
  addMembers: 'admins',
};

type ProfileSource = {
  id?: string | null;
  userId?: string | null;
  alias?: string | null;
  displayName?: string | null;
  phone?: string | null;
  bio?: string | null;
  profilePhotoDataUrl?: string | null;
  isDiscoverable?: boolean;
  isContact?: boolean;
  isMutualContact?: boolean;
  isFavorite?: boolean;
  friendshipState?: string | null;
  updatedAt?: string;
  cachedAt?: string;
};

interface SendPayloadOptions {
  suppressLocalMessage?: boolean;
  encryptedPolicy?: string | null;
  expiresAt?: string | null;
  deleteAfterRead?: boolean;
}

export interface MessagePolicyOptions {
  deleteAfterRead?: boolean;
  ttlSeconds?: number | null;
  replyTo?: unknown;
}

export interface GroupConversationOptions {
  name: string;
  participantUserIds: string[];
  groupAvatar?: string | null;
}

export type ChatFolderFilter = 'all' | 'pinned' | 'unread' | 'archived';

type ConversationFlagKind = 'archived' | 'blocked' | 'pinned' | 'muted';

const TTL_SWEEP_INTERVAL_MS = 30_000;
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

@Injectable({ providedIn: 'root' })
export class ChatService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly history = inject(LocalHistoryService);
  private readonly mediaOptimizer = inject(MediaOptimizerService);
  private readonly signalr = inject(SignalrService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly nativeDevice = inject(NativeDeviceService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly directories = new Map<string, PublicKeyDirectory>();
  private readonly readReceiptSentIds = new Set<string>();
  private readonly missingReceiptMessageIds = new Set<string>();
  private readonly pendingReactionSends = new Set<string>();
  private readonly pendingReactionsByMessageId = new Map<string, MessageReaction[]>();
  private readonly profileFetchInFlight = new Set<string>();
  private readonly directConversationInFlight = new Map<string, Promise<Conversation>>();
  private readonly typingTimers = new Map<string, number>();
  private readonly expiryTimers = new Map<string, number>();
  private readonly openScrollAnchors = new Map<string, string>();
  private ttlSweepTimer: number | null = null;
  private lastTypingSentAt = 0;
  private syncInFlight = false;
  private selectedConversationLoadId = 0;

  readonly quickReactions = QUICK_REACTIONS;
  readonly conversations = signal<Conversation[]>([]);
  readonly contacts = signal<Contact[]>([]);
  readonly profilesByUserId = signal<Record<string, LocalProfile>>({});
  readonly messagesByConversation = signal<Record<string, ChatMessageVm[]>>({});
  readonly visibleConversations = computed(() => this.chatFolderConversations('all'));
  readonly mediaPreviews = signal<Record<string, MediaPreview>>({});
  readonly directoryResults = signal<UserSummary[]>([]);
  readonly typingByConversation = signal<Record<string, string[]>>({});
  readonly presenceByUser = signal<Record<string, PresenceResponse>>({});
  readonly loading = signal(false);
  readonly uploading = signal(false);
  readonly uploadStatus = signal('');
  readonly selectedConversationId = signal<string | null>(this.initialSelectedConversationId());
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
      if (event.type === 'sync_read_receipts') {
        void this.applyReadSync(event.payload);
      }
      if (event.type === 'MessageDeleted') {
        this.applyMessageDeleted(event.payload);
      }
      if (event.type === 'ChatCleared') {
        this.applyChatCleared(event.payload);
      }
      if (event.type === 'conversation.created') {
        const conversation = this.applyLocalConversationState([event.payload as Conversation])[0];
        if (conversation?.id) {
          this.rememberConversationParticipants([conversation]);
          this.conversations.update((items) => [conversation, ...items.filter((item) => item.id !== conversation.id)].sort(this.compareConversations));
          void this.hydrateConversationProfiles([conversation]);
        }
      }
      if (event.type === 'conversation.updated') {
        const conversation = this.applyLocalConversationState([event.payload as Conversation])[0];
        if (conversation?.id) {
          if (!this.isCurrentUserActiveInConversation(conversation)) {
            void this.removeConversationLocally(conversation.id);
            return;
          }
          this.rememberConversationParticipants([conversation]);
          this.conversations.update((items) => items.map((item) => item.id === conversation.id ? conversation : item).sort(this.compareConversations));
          void this.hydrateConversationProfiles([conversation]);
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
          void this.purgeExpiredLocalMessages();
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
          this.startTtlSweep();
          void this.bootstrap();
          void this.signalr.connect();
        });
      } else {
        untracked(() => {
          this.stopTtlSweep();
          this.pauseForLoggedOutSession();
        });
      }
    });
  }

  ngOnDestroy(): void {
    this.stopTtlSweep();
    this.resetInMemoryState();
  }

  async bootstrap(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }

    this.loading.set(true);
    try {
      this.restoreSelectedConversationId();
      await this.loadCachedChatIndex();
      await this.loadCachedSelectedMessages();
      await this.purgeExpiredLocalMessages();
      if (!await this.auth.ensureFreshSession()) {
        return;
      }
      const bootstrap = await firstValueFrom(this.api.get<SyncBootstrapResponse>('/sync/bootstrap'));
      const contacts = bootstrap.contacts ?? [];
      const conversations = this.applyLocalConversationState(bootstrap.conversations ?? []);
      this.contacts.set(contacts);
      this.rememberProfiles(contacts, true);
      this.rememberConversationParticipants(conversations);
      this.conversations.set(conversations.sort(this.compareConversations));
      this.ensureSelectedConversation();
      await this.persistChatIndex(conversations, contacts);
      void this.hydrateConversationProfiles(conversations);
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
    if (!await this.auth.ensureFreshSession()) {
      return;
    }
    this.syncInFlight = true;
    try {
      const accountKey = this.localAccountKey();
      const watermark = accountKey ? await this.history.getSyncWatermark(accountKey).catch(() => null) : null;
      const params = new URLSearchParams({ take: String(Math.max(1, Math.min(take, 500))) });
      const retryDecryptErrors = Object.values(this.messagesByConversation()).some((messages) => messages.some((message) => message.decryptError));
      if (watermark && !retryDecryptErrors) {
        params.set('since', watermark);
      }
      const sync = await firstValueFrom(this.api.get<MessageSyncResponse>(`/messages/sync?${params.toString()}`));
      let hadDecryptError = false;
      for (const message of sync.messages ?? []) {
        hadDecryptError = !(await this.ingestMessage(message, false)) || hadDecryptError;
      }
      await this.ackDelivered(sync.messages ?? []);
      if (accountKey && sync.syncedAt && !hadDecryptError) {
        await this.history.setSyncWatermark(accountKey, sync.syncedAt).catch(() => undefined);
      }
      await this.refreshPresenceForConversations();
    } catch {
      // Best-effort foreground sync; realtime/bootstrap remain authoritative.
    } finally {
      void this.purgeExpiredLocalMessages();
      this.syncInFlight = false;
    }
  }

  async hydrateConversationProfile(conversation: Conversation | null | undefined): Promise<void> {
    if (conversation) {
      await this.hydrateConversationProfiles([conversation]);
    }
  }

  async selectConversation(conversationId: string): Promise<void> {
    const loadId = ++this.selectedConversationLoadId;
    this.selectedConversationId.set(conversationId);
    this.persistSelectedConversationId(conversationId);
    await this.signalr.joinConversation(conversationId);
    if (loadId !== this.selectedConversationLoadId || this.selectedConversationId() !== conversationId) {
      return;
    }
    await this.loadCachedMessages(conversationId);
    if (loadId !== this.selectedConversationLoadId || this.selectedConversationId() !== conversationId) {
      return;
    }
    await this.loadMessages(conversationId).catch(() => undefined);
    if (loadId !== this.selectedConversationLoadId || this.selectedConversationId() !== conversationId) {
      return;
    }
    this.rememberOpenScrollAnchor(conversationId);
    await this.markConversationRead(conversationId);
    await this.refreshPresenceForConversations();
  }

  initialScrollMessageId(conversationId: string | null | undefined): string | null {
    if (!conversationId) {
      return null;
    }
    return this.openScrollAnchors.get(conversationId) ?? null;
  }

  clearSelectedConversation(): void {
    this.selectedConversationLoadId += 1;
    this.selectedConversationId.set(null);
    this.persistSelectedConversationId(null);
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
    if (this.isGroupConversation(conversation)) {
      const count = conversation.participants.filter((participant) => !participant.removedAt).length;
      return `${Math.max(count, 1)} participantes`;
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
    this.rememberProfiles(result.people ?? [], true);
    return result.people ?? [];
  }

  async createDirectConversation(person: UserSummary): Promise<Conversation> {
    this.rememberProfiles([person], true);
    const existing = await this.findExistingDirectConversation(person.id);
    if (existing) {
      await this.selectConversation(existing.id);
      return existing;
    }

    const pending = this.directConversationInFlight.get(person.id);
    if (pending) {
      const conversation = await pending;
      await this.selectConversation(conversation.id);
      return conversation;
    }

    const creation = this.createDirectConversationCore(person);
    this.directConversationInFlight.set(person.id, creation);
    try {
      return await creation;
    } finally {
      this.directConversationInFlight.delete(person.id);
    }
  }

  private async createDirectConversationCore(person: UserSummary): Promise<Conversation> {
    await firstValueFrom(this.api.post('/contacts', { alias: person.alias, nicknameCiphertext: null })).catch(() => null);
    const existing = await this.findExistingDirectConversation(person.id);
    if (existing) {
      await this.selectConversation(existing.id);
      return existing;
    }

    const conversation = this.applyLocalConversationState([await firstValueFrom(this.api.post<Conversation>('/conversations', {
      type: 'Direct',
      participantUserIds: [person.id],
      titleCiphertext: null,
      privacySettings: null,
    }))])[0];
    this.rememberConversationParticipants([conversation]);
    this.conversations.update((items) => [conversation, ...items.filter((item) => item.id !== conversation.id)].sort(this.compareConversations));
    await this.selectConversation(conversation.id);
    return conversation;
  }

  private createLocalGroupConversation(groupName: string, participantUserIds: string[], groupAvatar: string | null): Conversation {
    const current = this.auth.session()?.user;
    const now = new Date().toISOString();
    const participantIds = [...new Set([current?.id, ...participantUserIds].filter(Boolean) as string[])];
    return {
      id: `local-group-${crypto.randomUUID()}`,
      type: 'Group',
      titleCiphertext: null,
      title: groupName,
      groupName,
      groupAvatar,
      admins: current?.id ? [current.id] : [],
      settings: { ...DEFAULT_GROUP_SETTINGS },
      participantIds,
      privacySettings: current?.privacySettings ?? {},
      participants: participantIds.map((userId) => this.groupParticipant(userId, now, userId === current?.id)),
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };
  }

  private normalizeGroupConversation(
    conversation: Conversation,
    groupName: string,
    participantUserIds: string[],
    groupAvatar: string | null,
  ): Conversation {
    const currentUserId = this.auth.session()?.user.id;
    const ids = [...new Set([
      currentUserId,
      ...(conversation.participantIds ?? []),
      ...(conversation.participants ?? []).map((participant) => participant.userId),
      ...participantUserIds,
    ].filter(Boolean) as string[])];
    const now = new Date().toISOString();
    const existing = new Map((conversation.participants ?? []).map((participant) => [participant.userId, participant]));
    return {
      ...conversation,
      type: 'Group',
      title: this.firstText(conversation.title, conversation.groupName, groupName),
      groupName: this.firstText(conversation.groupName, conversation.title, groupName),
      groupAvatar: this.firstText(conversation.groupAvatar, groupAvatar),
      admins: this.normalizedGroupAdmins(conversation, currentUserId),
      settings: this.normalizedGroupSettings(conversation.settings),
      participantIds: ids,
      privacySettings: conversation.privacySettings ?? this.auth.session()?.user.privacySettings ?? {},
      participants: ids.map((userId) => ({
        ...this.groupParticipant(userId, existing.get(userId)?.joinedAt || now, userId === currentUserId),
        ...(existing.get(userId) ?? {}),
        userId,
      })),
      createdAt: conversation.createdAt || now,
      updatedAt: conversation.updatedAt || now,
    };
  }

  private groupParticipant(userId: string, joinedAt: string, owner = false) {
    const profile = userId === this.auth.session()?.user.id
      ? this.normalizeProfile(this.auth.session()?.user)
      : this.profileForUser(userId) ?? this.normalizeProfile(this.contacts().find((contact) => contact.userId === userId));
    return {
      userId,
      role: owner ? 'Owner' : 'Member',
      canInvite: true,
      canChangePrivacy: owner,
      joinedAt,
      removedAt: null,
      alias: profile?.alias ?? null,
      displayName: profile?.displayName ?? null,
      phone: profile?.phone ?? null,
      profilePhotoDataUrl: profile?.profilePhotoDataUrl ?? null,
    };
  }

  private defaultGroupName(participantUserIds: string[]): string {
    const names = participantUserIds
      .map((userId) => this.displayProfileName(this.profileForUser(userId) ?? this.normalizeProfile(this.contacts().find((contact) => contact.userId === userId))))
      .filter(Boolean)
      .slice(0, 3);
    return names.length ? names.join(', ') : 'Grupo Nivra';
  }

  async createGroupConversation(options: GroupConversationOptions): Promise<Conversation> {
    const current = this.auth.session()?.user;
    if (!current) {
      throw new Error('No hay sesion activa para crear el grupo.');
    }
    const participantUserIds = [...new Set((options.participantUserIds ?? [])
      .filter(Boolean)
      .filter((userId) => userId !== current.id))];
    if (!participantUserIds.length) {
      throw new Error('Selecciona al menos un contacto para crear el grupo.');
    }
    const groupName = options.name.trim() || this.defaultGroupName(participantUserIds);
    const groupAvatar = options.groupAvatar || null;
    let conversation: Conversation;
    try {
      conversation = await firstValueFrom(this.api.post<Conversation>('/conversations', {
        type: 'Group',
        participantUserIds,
        titleCiphertext: null,
        privacySettings: null,
        groupName,
        groupAvatar,
        admins: [current.id],
        settings: { ...DEFAULT_GROUP_SETTINGS },
      }));
    } catch {
      conversation = this.createLocalGroupConversation(groupName, participantUserIds, groupAvatar);
    }

    const normalized = this.applyLocalConversationState([
      this.normalizeGroupConversation(conversation, groupName, participantUserIds, groupAvatar),
    ])[0];
    this.rememberConversationParticipants([normalized]);
    this.conversations.update((items) => [normalized, ...items.filter((item) => item.id !== normalized.id)].sort(this.compareConversations));
    void this.hydrateConversationProfiles([normalized]);
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.putConversations(accountKey, [normalized]).catch(() => undefined);
    }
    await this.selectConversation(normalized.id).catch(() => {
      this.selectedConversationId.set(normalized.id);
      this.persistSelectedConversationId(normalized.id);
    });
    return normalized;
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
    if (policy.replyTo) {
      payload.replyTo = policy.replyTo;
    }
    return this.sendPayload(conversation, payload, 'Text', null, this.policyToSendOptions(policy));
  }

  async sendFile(
    conversation: Conversation,
    file: File,
    options: { forwardedFrom?: unknown; voiceNote?: boolean; policy?: MessagePolicyOptions; mode?: EncryptedUploadMode; caption?: string } = {},
  ): Promise<MessageResponse | null> {
    this.uploading.set(true);
    this.uploadStatus.set('Optimizando y sellando (E2EE)...');
    try {
      const sendOptions = this.policyToSendOptions(options.policy ?? {});
      const prepared = await this.mediaOptimizer.prepareForEncryptedUpload(file, {
        mode: options.mode ?? 'document',
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      const uploadFile = prepared.file;
      const encrypted = uploadFile.size > LARGE_ATTACHMENT_CHUNK_THRESHOLD_BYTES
        ? await this.crypto.encryptAttachmentFile(uploadFile, {
            onProgress: ({ processedBytes, totalBytes }) => {
              this.uploadStatus.set(`Sellando archivo grande (E2EE) ${Math.min(99, Math.round((processedBytes / Math.max(1, totalBytes)) * 100))}%...`);
            },
          })
        : await this.crypto.encryptAttachment(await uploadFile.arrayBuffer());
      const allowedUserIds = conversation.participants
        .filter((participant) => !participant.removedAt)
        .map((participant) => participant.userId);
      const mime = uploadFile.type || 'application/octet-stream';
      const fileRecord = await firstValueFrom(this.api.post<FileResponse>('/files', {
        encryptedSize: 'body' in encrypted ? encrypted.encryptedSize : encrypted.bytes.byteLength,
        mimeTypeCiphertext: this.crypto.b64(new TextEncoder().encode(mime)),
        clientSha256: null,
        allowedUserIds,
        expiresAt: sendOptions.expiresAt,
      }));
      this.uploadStatus.set(uploadFile.size > LARGE_ATTACHMENT_CHUNK_THRESHOLD_BYTES ? 'Subiendo archivo grande cifrado...' : 'Subiendo archivo cifrado...');
      await firstValueFrom(this.api.putRaw<FileResponse>(
        `/files/${encodeURIComponent(fileRecord.id)}/blob`,
        'body' in encrypted ? encrypted.body : encrypted.bytes,
      ));
      this.rememberMediaPreview(fileRecord.id, uploadFile, mime, uploadFile.name);

      return this.sendPayload(
        conversation,
        {
          type: 'file',
          text: options.caption?.trim() || undefined,
          fileId: fileRecord.id,
          fileName: uploadFile.name,
          mime,
          size: uploadFile.size,
          fileKey: encrypted.key,
          fileIv: encrypted.iv,
          voiceNote: options.voiceNote ?? false,
          forwardedFrom: options.forwardedFrom,
        },
        this.fileKind(uploadFile),
        fileRecord.id,
        sendOptions,
      );
    } finally {
      this.uploading.set(false);
      this.uploadStatus.set('');
    }
  }

  async sendPayload(
    conversation: Conversation,
    payload: ChatPayload,
    kind: string = 'Text',
    fileObjectId: string | null = null,
    options: SendPayloadOptions = {},
  ): Promise<MessageResponse | null> {
    if (this.isConversationBlocked(conversation.id)) {
      throw new Error('Este chat esta bloqueado en este dispositivo.');
    }
    if (!this.canSendToConversation(conversation)) {
      throw new Error('Solo los admins pueden enviar mensajes en este grupo.');
    }
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
    const actorKey = this.reactionActorKey(reaction);
    const previous = (message.payload.reactions ?? []).find((item) => this.reactionActorKey(item) === actorKey);
    const reactionAction: 'set' | 'remove' = previous?.emoji === emoji ? 'remove' : 'set';
    const pendingKey = `${message.id}:${actorKey}`;
    if (this.pendingReactionSends.has(pendingKey)) {
      return;
    }
    const applied = this.applyReaction(message.id, reaction, conversation.id, reactionAction);
    if (!applied) {
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
          reactionAction,
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
    const group = this.isGroupConversation(conversation);
    const groupMissed = event === 'missed-call' && group;
    const groupEnded = event === 'call-ended' && group;
    const payload: ChatPayload = {
      type: group ? 'system-call' : 'call_log',
      event,
      title: groupMissed
        ? (call.type === 'Video' ? 'Videollamada grupal perdida' : 'Llamada grupal perdida')
        : groupEnded
          ? (call.type === 'Video' ? 'Videollamada finalizada' : 'Llamada grupal finalizada')
          : event === 'call-rejected'
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
      groupCall: group,
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
      this.persistSelectedConversationId(nextId);
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
    return [...this.visibleConversations()]
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

  releaseMediaPreview(fileId?: string | null): void {
    if (!fileId) {
      return;
    }
    const previous = this.mediaPreviews()[fileId];
    if (!previous) {
      return;
    }
    if (previous.url) {
      URL.revokeObjectURL(previous.url);
    }
    this.mediaPreviews.update((items) => {
      const { [fileId]: _released, ...rest } = items;
      return rest;
    });
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

  async downloadAttachment(payload: ChatPayload, conversation?: Conversation | null): Promise<void> {
    const preview = await this.ensureMediaPreview(payload);
    const file = this.asFile(payload);
    if (!preview || !file) {
      return;
    }

    const mimeType = this.fileMime(file);
    const fileName = this.fileName(file);
    if (this.nativeDevice.native) {
      const blob = await fetch(preview.url).then((response) => response.blob());
      await this.nativeDevice.saveBlob(
        blob,
        fileName,
        mimeType,
        this.shouldSaveAttachmentPublic(file, conversation ?? this.selectedConversation()),
        this.mediaKindForMime(mimeType),
      );
      return;
    }

    const link = document.createElement('a');
    link.href = preview.url;
    link.download = fileName;
    link.click();
  }

  conversationTitle(conversation: Conversation): string {
    const people = this.conversationPeople(conversation);
    if (this.isGroupConversation(conversation)) {
      const explicit = this.firstText(conversation.groupName, conversation.title);
      if (explicit) {
        return explicit;
      }
      const title = people.map((person) => this.displayProfileName(person)).filter(Boolean).join(', ');
      return title || 'Grupo Nivra';
    }
    return this.displayProfileName(people[0]) || 'Contacto Nivra';
  }

  conversationPhoto(conversation: Conversation | null | undefined): string {
    if (conversation && this.isGroupConversation(conversation)) {
      return conversation.groupAvatar || '';
    }
    return conversation ? this.conversationPrimaryPerson(conversation)?.profilePhotoDataUrl || '' : '';
  }

  conversationPhone(conversation: Conversation | null | undefined): string {
    const person = conversation ? this.conversationPrimaryPerson(conversation) : null;
    return person?.phone || '';
  }

  conversationAlias(conversation: Conversation | null | undefined): string {
    const person = conversation ? this.conversationPrimaryPerson(conversation) : null;
    return person?.alias ? `@${person.alias}` : '';
  }

  conversationBio(conversation: Conversation | null | undefined): string {
    const person = conversation ? this.conversationPrimaryPerson(conversation) : null;
    return person?.bio || '';
  }

  conversationProfile(conversation: Conversation | null | undefined): LocalProfile | null {
    return conversation ? this.conversationPrimaryPerson(conversation) : null;
  }

  conversationSubtitle(conversation: Conversation): string {
    const messages = this.messagesByConversation()[conversation.id] ?? [];
    const last = messages[messages.length - 1];
    const state = this.isConversationBlocked(conversation.id)
      ? 'Bloqueado'
      : this.isConversationArchived(conversation.id) ? 'Archivado' : '';
    if (!last) {
      const fallback = this.isGroupConversation(conversation) ? 'Grupo cifrado listo' : 'Cifrado extremo a extremo';
      return state ? `${state} - ${fallback}` : fallback;
    }
    const preview = this.preview(last.payload);
    return state ? `${state} - ${preview}` : preview;
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
      const caption = typeof file.text === 'string' && file.text.trim() ? file.text.trim() : '';
      const label = file.voiceNote ? 'Nota de voz' : this.fileName(file);
      return caption ? `${label}: ${caption}` : label;
    }
    return payload.text || payload.title || 'Mensaje cifrado';
  }

  isCallLog(payload: ChatPayload): boolean {
    return payload.type === 'call_log'
      || payload.type === 'system-call'
      || (payload.type === 'system' && ['missed-call', 'call-ended'].includes(String(payload.event || '')));
  }

  callLogTitle(payload: ChatPayload): string {
    if (payload.type === 'system-call') {
      return payload.title || (payload['status'] === 'missed' ? 'Llamada grupal perdida' : 'Llamada grupal finalizada');
    }
    const missed = payload.event === 'missed-call' || payload['status'] === 'missed';
    const rejected = payload.event === 'call-rejected' || payload['status'] === 'rejected';
    const failed = payload.event === 'call-failed' || payload['status'] === 'failed';
    return payload.title || (rejected ? 'Llamada rechazada' : failed ? 'Llamada fallida' : missed ? 'Llamada perdida' : 'Llamada finalizada');
  }

  callLogText(payload: ChatPayload): string {
    if (payload.type === 'system-call') {
      return payload.text || (payload['status'] === 'missed' ? 'Nadie se unio' : 'Registro grupal cifrado');
    }
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

  chatFolderConversations(folder: ChatFolderFilter): Conversation[] {
    const conversations = this.dedupeVisibleConversations(this.conversations(), this.messagesByConversation());
    return conversations
      .filter((conversation) => {
        const archived = this.isArchivedConversationRecord(conversation);
        if (folder === 'archived') {
          return archived;
        }
        if (archived) {
          return false;
        }
        if (folder === 'pinned') {
          return this.isPinnedConversationRecord(conversation);
        }
        if (folder === 'unread') {
          return this.hasUnreadConversation(conversation);
        }
        return true;
      })
      .sort(this.compareConversations);
  }

  hasUnreadConversation(conversation: Conversation | null | undefined): boolean {
    const current = this.auth.session();
    if (!conversation?.id || !current?.user?.id) {
      return false;
    }
    return (this.messagesByConversation()[conversation.id] ?? []).some((message) => {
      if (message.mine || this.readReceiptSentIds.has(message.id)) {
        return false;
      }
      const ownReceipts = (message.receipts ?? []).filter((receipt) => receipt.userId === current.user.id);
      return !ownReceipts.some((receipt) => receipt.readAt);
    });
  }

  isConversationArchived(conversationId: string | null | undefined): boolean {
    if (!conversationId) {
      return false;
    }
    const conversation = this.conversations().find((item) => item.id === conversationId);
    return Boolean(conversation && this.isArchivedConversationRecord(conversation))
      || this.readConversationFlag('archived').has(conversationId);
  }

  async setConversationArchived(conversation: Conversation, archived: boolean): Promise<void> {
    this.writeConversationFlag('archived', conversation.id, archived);
    await this.updateConversationLocalState(conversation, {
      archivedAt: archived ? new Date().toISOString() : null,
      isArchived: archived,
    });
  }

  isConversationPinned(conversationId: string | null | undefined): boolean {
    if (!conversationId) {
      return false;
    }
    const conversation = this.conversations().find((item) => item.id === conversationId);
    return Boolean(conversation && this.isPinnedConversationRecord(conversation))
      || this.readConversationFlag('pinned').has(conversationId);
  }

  async setConversationPinned(conversation: Conversation, pinned: boolean): Promise<void> {
    this.writeConversationFlag('pinned', conversation.id, pinned);
    await this.updateConversationLocalState(conversation, {
      pinnedAt: pinned ? new Date().toISOString() : null,
      isPinned: pinned,
    });
  }

  isConversationMuted(conversationId: string | null | undefined): boolean {
    if (!conversationId) {
      return false;
    }
    const conversation = this.conversations().find((item) => item.id === conversationId);
    return Boolean(conversation && this.isMutedConversationRecord(conversation))
      || this.readConversationFlag('muted').has(conversationId);
  }

  async setConversationMuted(conversation: Conversation, muted: boolean): Promise<void> {
    this.writeConversationFlag('muted', conversation.id, muted);
    await this.updateConversationLocalState(conversation, {
      mutedAt: muted ? new Date().toISOString() : null,
      isMuted: muted,
    });
  }

  isConversationBlocked(conversationId: string | null | undefined): boolean {
    if (!conversationId) {
      return false;
    }
    return Boolean(this.conversations().find((conversation) => conversation.id === conversationId)?.blockedAt)
      || this.readConversationFlag('blocked').has(conversationId);
  }

  async setConversationBlocked(conversation: Conversation, blocked: boolean): Promise<void> {
    this.writeConversationFlag('blocked', conversation.id, blocked);
    await this.updateConversationLocalState(conversation, {
      blockedAt: blocked ? new Date().toISOString() : null,
    });
  }

  isGroup(conversation: Conversation | null | undefined): boolean {
    return this.isGroupConversation(conversation);
  }

  isGroupAdmin(conversation: Conversation | null | undefined, userId = this.auth.session()?.user.id): boolean {
    if (!conversation || !userId) {
      return false;
    }
    if (!this.isGroupConversation(conversation)) {
      return true;
    }
    const admins = this.normalizedGroupAdmins(conversation);
    return admins.includes(userId)
      || conversation.participants.some((participant) =>
        participant.userId === userId && ['owner', 'admin'].includes(String(participant.role || '').toLowerCase()));
  }

  participantProfile(userId: string | null | undefined): LocalProfile | null {
    if (!userId) {
      return null;
    }
    if (userId === this.auth.session()?.user.id) {
      return this.normalizeProfile(this.auth.session()?.user);
    }
    return this.profileForUser(userId) ?? this.normalizeProfile(this.contacts().find((contact) => contact.userId === userId));
  }

  participantDisplayName(userId: string | null | undefined, fallback?: ProfileSource | null): string {
    const current = this.auth.session()?.user;
    const profile = this.participantProfile(userId) ?? this.normalizeProfile(fallback);
    const name = this.displayProfileName(profile) || this.firstText(fallback?.displayName, fallback?.phone, fallback?.alias) || 'Contacto';
    if (userId && current?.id === userId) {
      const ownName = this.displayProfileName(this.normalizeProfile(current));
      return ownName ? `${ownName} (Tu)` : 'Tu';
    }
    return name;
  }

  participantPhoto(userId: string | null | undefined, fallback?: ProfileSource | null): string {
    return this.participantProfile(userId)?.profilePhotoDataUrl
      || this.normalizeProfile(fallback)?.profilePhotoDataUrl
      || '';
  }

  participantAlias(userId: string | null | undefined, fallback?: ProfileSource | null): string {
    const alias = this.participantProfile(userId)?.alias || this.normalizeProfile(fallback)?.alias || '';
    return alias ? `@${alias}` : '';
  }

  canEditGroup(conversation: Conversation | null | undefined): boolean {
    if (!conversation || !this.isGroupConversation(conversation)) {
      return false;
    }
    return this.normalizedGroupSettings(conversation.settings).editInfo === 'all' || this.isGroupAdmin(conversation);
  }

  canSendToConversation(conversation: Conversation | null | undefined): boolean {
    if (!conversation || !this.isGroupConversation(conversation)) {
      return true;
    }
    return this.normalizedGroupSettings(conversation.settings).sendMessages === 'all' || this.isGroupAdmin(conversation);
  }

  canAddGroupMembers(conversation: Conversation | null | undefined): boolean {
    if (!conversation || !this.isGroupConversation(conversation)) {
      return false;
    }
    return this.normalizedGroupSettings(conversation.settings).addMembers === 'all' || this.isGroupAdmin(conversation);
  }

  async updateGroupInfo(conversation: Conversation, patch: { groupName?: string; groupAvatar?: string | null }): Promise<void> {
    if (!this.canEditGroup(conversation)) {
      throw new Error('No tienes permisos para editar este grupo.');
    }
    const next = {
      ...conversation,
      groupName: this.firstText(patch.groupName, conversation.groupName, conversation.title),
      title: this.firstText(patch.groupName, conversation.title, conversation.groupName),
      groupAvatar: patch.groupAvatar !== undefined ? patch.groupAvatar : conversation.groupAvatar ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.persistGroupConversation(next, {
      groupName: next.groupName,
      groupAvatar: next.groupAvatar,
      title: next.title,
    });
  }

  async updateGroupSettings(conversation: Conversation, settings: GroupSettings): Promise<void> {
    if (!this.isGroupAdmin(conversation)) {
      throw new Error('Solo los admins pueden cambiar la configuracion del grupo.');
    }
    const next = {
      ...conversation,
      settings: this.normalizedGroupSettings(settings),
      updatedAt: new Date().toISOString(),
    };
    await this.persistGroupConversation(next, { settings: next.settings });
  }

  async setGroupParticipantAdmin(conversation: Conversation, userId: string, admin: boolean): Promise<void> {
    if (!this.isGroupAdmin(conversation) || !userId) {
      throw new Error('Solo los admins pueden asignar moderadores.');
    }
    const admins = new Set(this.normalizedGroupAdmins(conversation));
    if (admin) {
      admins.add(userId);
    } else if (userId !== this.auth.session()?.user.id) {
      admins.delete(userId);
    }
    const next = {
      ...conversation,
      admins: [...admins],
      participants: conversation.participants.map((participant) => participant.userId === userId
        ? {
            ...participant,
            role: admin ? 'Admin' : 'Member',
            canInvite: admin || this.normalizedGroupSettings(conversation.settings).addMembers === 'all',
            canChangePrivacy: admin,
          }
        : participant),
      updatedAt: new Date().toISOString(),
    };
    await this.persistGroupConversation(next, { admins: next.admins, participants: next.participants });
    await this.signalr.updateGroupRoles(next.id, next.admins).catch(() => undefined);
  }

  async addGroupParticipants(conversation: Conversation, userIds: string[]): Promise<void> {
    if (!this.canAddGroupMembers(conversation)) {
      throw new Error('No tienes permisos para agregar participantes.');
    }
    const normalizedIds = [...new Set(userIds.filter(Boolean))]
      .filter((userId) => !conversation.participants.some((participant) => participant.userId === userId && !participant.removedAt));
    if (!normalizedIds.length) {
      return;
    }
    const now = new Date().toISOString();
    const nextParticipants = [
      ...conversation.participants,
      ...normalizedIds.map((userId) => this.groupParticipant(userId, now, false)),
    ];
    const nextParticipantIds = [...new Set([
      ...(conversation.participantIds ?? []),
      ...conversation.participants.map((participant) => participant.userId),
      ...normalizedIds,
    ].filter(Boolean))];
    const next = {
      ...conversation,
      participantIds: nextParticipantIds,
      participants: nextParticipants,
      updatedAt: now,
    };
    this.rememberConversationParticipants([next]);
    await this.persistGroupConversation(next, {
      participantIds: next.participantIds,
      participants: next.participants,
    });
    await this.signalr.updateGroupParticipants(next.id, nextParticipantIds).catch(() => undefined);
  }

  async leaveGroupConversation(conversation: Conversation): Promise<void> {
    if (!this.isGroupConversation(conversation)) {
      throw new Error('Solo puedes salir de chats grupales.');
    }
    if (!this.auth.session()?.user.id) {
      throw new Error('No hay sesion activa.');
    }
    if (!conversation.id.startsWith('local-group-')) {
      await firstValueFrom(this.api.post<Conversation>(`/conversations/${encodeURIComponent(conversation.id)}/leave`, {}));
    }
    await this.removeConversationLocally(conversation.id);
  }

  private async ingestMessage(message: MessageResponse, markDelivered: boolean): Promise<boolean> {
    const current = this.auth.session();
    if (!current) {
      return false;
    }
    const recipients = this.ownRecipientCandidates(message.recipients, current.user.id, current.device.id);
    const recipient = recipients[0];
    let payload: ChatPayload;
    let decryptError = false;
    if (message.encryptedPolicy?.startsWith('system:') || recipient?.header?.startsWith('system:')) {
      payload = this.decodeSystemPayload(recipient?.ciphertext);
    } else if (recipients.some((item) => item.ciphertext)) {
      const decrypted = await this.decryptOwnRecipientPayload(
        current.user.id,
        current.user.alias,
        current.device.id,
        recipients,
      );
      if (decrypted) {
        payload = decrypted;
      } else {
        const cached = await this.cachedReadableMessage(message);
        if (cached?.payload && !cached.decryptError) {
          payload = cached.payload;
        } else {
          decryptError = true;
          payload = { type: 'system', title: 'Mensaje protegido', text: 'No se pudo descifrar en este dispositivo.' };
        }
      }
    } else if (message.senderUserId === current.user.id) {
      payload = { type: 'system', text: 'Mensaje enviado desde otro dispositivo.' };
    } else {
      payload = { type: 'system', text: 'Paquete cifrado no disponible para este dispositivo.' };
    }

    let vm: ChatMessageVm = {
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
    if (vm.mine) {
      vm = this.withLocalReadReceipt(vm, current.user.id, current.device.id, message.serverReceivedAt);
      this.readReceiptSentIds.add(vm.id);
    }
    if (payload.type === 'reaction') {
      this.applyReactionPayload(payload, message.conversationId, message.id, message.serverReceivedAt);
      this.persistExistingMessage(this.stringPayload(payload, 'targetMessageId'));
      if (markDelivered && !vm.mine) {
        void this.sendReceipt(message.id, 'Delivered');
      }
      return !decryptError;
    }
    if (payload.type === 'edit') {
      this.applyEditPayload(payload, message.conversationId);
      this.persistExistingMessage(this.stringPayload(payload, 'targetMessageId'));
      if (markDelivered && !vm.mine) {
        void this.sendReceipt(message.id, 'Delivered');
      }
      return !decryptError;
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
      return !decryptError;
    }
    this.upsertMessage(vm);
    if (markDelivered && !vm.mine) {
      void this.sendReceipt(message.id, 'Delivered');
    }
    return !decryptError;
  }

  private ownRecipientCandidates(
    recipients: RecipientCipherRequest[],
    userId: string,
    preferredDeviceId: string,
  ): RecipientCipherRequest[] {
    const own = (recipients ?? []).filter((recipient) => recipient.userId === userId);
    return [
      ...own.filter((recipient) => recipient.deviceId === preferredDeviceId),
      ...own.filter((recipient) => recipient.deviceId !== preferredDeviceId),
    ];
  }

  private async decryptOwnRecipientPayload(
    userId: string,
    alias: string,
    deviceId: string,
    recipients: RecipientCipherRequest[],
  ): Promise<ChatPayload | null> {
    const keys = await this.localDecryptKeyCandidates(userId, alias, deviceId);
    for (const recipient of recipients) {
      if (!recipient?.ciphertext) {
        continue;
      }
      for (const key of keys) {
        try {
          return await this.crypto.decryptEnvelope<ChatPayload>(key, recipient.header, recipient.ciphertext);
        } catch {
          // Try the next local key/device envelope.
        }
      }
    }
    return null;
  }

  private async localDecryptKeyCandidates(userId: string, alias: string, deviceId: string): Promise<StoredDeviceKeys[]> {
    const candidates: StoredDeviceKeys[] = [];
    const current = await this.crypto.currentKeyMaterial(alias, deviceId).catch(() => null);
    if (current) {
      candidates.push(current);
    }
    candidates.push(...await this.crypto.deviceKeyMaterialsForUser(userId, alias).catch(() => []));

    const seen = new Set<string>();
    return candidates.filter((key) => {
      const fingerprint = `${JSON.stringify(key.publicJwk)}:${JSON.stringify(key.privateJwk)}`;
      if (seen.has(fingerprint)) {
        return false;
      }
      seen.add(fingerprint);
      return true;
    });
  }

  private async cachedReadableMessage(message: MessageResponse): Promise<ChatMessageVm | null> {
    const inMemory = this.messagesByConversation()[message.conversationId]?.find((item) => item.id === message.id);
    if (inMemory?.payload && !inMemory.decryptError) {
      return inMemory;
    }

    const accountKeys = await this.localAccountKeys();
    for (const accountKey of accountKeys) {
      const cached = await this.history.messageById(accountKey, message.conversationId, message.id).catch(() => null);
      if (cached?.payload && !cached.decryptError) {
        return cached;
      }
    }
    return null;
  }

  private async ingestLocalSent(response: MessageResponse, payload: ChatPayload): Promise<void> {
    const current = this.auth.session();
    if (!current) {
      return;
    }
    this.upsertMessage(this.withLocalReadReceipt({
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
    }, current.user.id, current.device.id, response.serverReceivedAt));
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
    this.scheduleMessageExpiry(messageWithPendingReactions);
  }

  async markConversationRead(conversationId: string): Promise<void> {
    const current = this.auth.session();
    if (!current || document.visibilityState === 'hidden') {
      return;
    }
    const unread = (this.messagesByConversation()[conversationId] ?? []).filter((message) => {
      if (message.mine || this.readReceiptSentIds.has(message.id)) {
        return false;
      }
      const ownReceipts = (message.receipts ?? []).filter((receipt) => receipt.userId === current.user.id);
      return !ownReceipts.some((receipt) => receipt.readAt);
    });
    if (!unread.length) {
      return;
    }

    const viewOnceIds = unread.filter((message) => message.deleteAfterRead).map((message) => message.id);
    if (viewOnceIds.length) {
      const accountKey = this.localAccountKey();
      if (accountKey) {
        await this.history.markMessagesOpened(accountKey, conversationId, viewOnceIds).catch(() => undefined);
      }
      this.messagesByConversation.update((state) => ({
        ...state,
        [conversationId]: (state[conversationId] ?? []).filter((message) => !viewOnceIds.includes(message.id)),
      }));
    }

    const readAt = new Date().toISOString();
    for (const message of unread) {
      this.readReceiptSentIds.add(message.id);
      if (!viewOnceIds.includes(message.id)) {
        this.applyReceipt({
          messageId: message.id,
          userId: current.user.id,
          deviceId: current.device.id,
          kind: 'Read',
          at: readAt,
        });
      }
    }
    await this.signalr.syncReadReceipts(conversationId, unread.map((message) => message.id)).catch(() => undefined);
    if (current.user.privacySettings?.readReceipts === false) {
      return;
    }
    for (const message of unread) {
      await this.sendReceipt(message.id, 'Read').catch(() => this.readReceiptSentIds.delete(message.id));
    }
  }

  private rememberOpenScrollAnchor(conversationId: string): void {
    const current = this.auth.session();
    if (!current) {
      this.openScrollAnchors.delete(conversationId);
      return;
    }
    const firstUnread = (this.messagesByConversation()[conversationId] ?? []).find((message) => {
      if (message.mine) {
        return false;
      }
      const ownReceipts = (message.receipts ?? []).filter((receipt) => receipt.userId === current.user.id);
      return !ownReceipts.some((receipt) => receipt.readAt);
    });
    if (firstUnread?.id) {
      this.openScrollAnchors.set(conversationId, firstUnread.id);
    } else {
      this.openScrollAnchors.delete(conversationId);
    }
  }

  async markMessageOpened(message: ChatMessageVm | null | undefined): Promise<void> {
    if (!message?.deleteAfterRead) {
      return;
    }
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.markMessagesOpened(accountKey, message.conversationId, [message.id]).catch(() => undefined);
    }
    this.removeMessageFromUiAndLocal(message.conversationId, message.id);
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

  private shouldSaveAttachmentPublic(file: FileChatPayload, conversation: Conversation | null | undefined): boolean {
    const mimeType = this.fileMime(file);
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
      return false;
    }
    const settings = this.appSettings.settings();
    const type = String(conversation?.type || '').toLowerCase();
    if (type === 'group') {
      return settings.saveGroupMedia;
    }
    if (type === 'channel') {
      return settings.saveChannelMedia;
    }
    return settings.savePrivateMedia;
  }

  private mediaKindForMime(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
    if (mimeType.startsWith('image/')) {
      return 'image';
    }
    if (mimeType.startsWith('video/')) {
      return 'video';
    }
    if (mimeType.startsWith('audio/')) {
      return 'audio';
    }
    return 'document';
  }

  private async loadCachedSelectedMessages(): Promise<void> {
    const conversationId = this.selectedConversationId();
    if (conversationId) {
      await this.loadCachedMessages(conversationId);
    }
  }

  private async loadCachedChatIndex(): Promise<void> {
    const accountKeys = await this.localAccountKeys();
    if (!accountKeys.length) {
      return;
    }
    const [conversationGroups, contactGroups, profiles] = await Promise.all([
      Promise.all(accountKeys.map((accountKey) => this.history.conversations(accountKey).catch(() => []))),
      Promise.all(accountKeys.map((accountKey) => this.history.contacts(accountKey).catch(() => []))),
      this.history.profiles().catch(() => []),
    ]);
    const conversations = this.uniqueConversations(conversationGroups.flat());
    const contacts = this.uniqueContacts(contactGroups.flat());
    if (profiles.length) {
      this.rememberProfiles(profiles, false);
    }
    if (contacts.length) {
      this.contacts.set(contacts);
      this.rememberProfiles(contacts, false);
    }
    if (conversations.length) {
      const cachedConversations = this.applyLocalConversationState(conversations);
      this.rememberConversationParticipants(cachedConversations);
      this.conversations.set(cachedConversations.sort(this.compareConversations));
      this.ensureSelectedConversation();
      void this.hydrateConversationProfiles(cachedConversations);
      const primary = this.localAccountKey();
      if (primary) {
        void this.history.putConversations(primary, cachedConversations).catch(() => undefined);
      }
    }
    if (contacts.length) {
      const primary = this.localAccountKey();
      if (primary) {
        void this.history.putContacts(primary, contacts).catch(() => undefined);
      }
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
      this.history.putProfiles(Object.values(this.profilesByUserId())).catch(() => undefined),
    ]);
  }

  private async loadCachedMessages(conversationId: string): Promise<void> {
    const accountKeys = await this.localAccountKeys();
    if (!accountKeys.length || !conversationId) {
      return;
    }
    const groups = await Promise.all(accountKeys.map((accountKey) =>
      this.history.conversationMessagesPage(accountKey, conversationId, 80).catch(() => [])));
    const now = Date.now();
    const messages = this.uniqueMessages(groups.flat())
      .filter((message) => !this.isExpiredMessage(message, now))
      .slice(-80);
    for (const message of messages) {
      this.upsertMessage(message, { persist: false });
    }
    const primary = this.localAccountKey();
    if (primary && messages.length) {
      void this.history.putMessages(primary, messages).catch(() => undefined);
    }
    void this.purgeExpiredLocalMessages();
  }

  private async purgeExpiredLocalMessages(): Promise<void> {
    const accountKeys = await this.localAccountKeys();
    if (!accountKeys.length) {
      return;
    }
    const now = Date.now();
    const groups = await Promise.all(accountKeys.map((accountKey) => this.history.purgeExpired(accountKey).catch(() => [])));
    const expired = this.uniqueMessages([...groups.flat(), ...this.expiredInMemoryMessages(now)]);
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
    for (const message of expired) {
      this.clearMessageExpiryTimer(message.conversationId, message.id);
      this.removeLocalMessage(message.conversationId, message.id);
    }
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

  private removeMessageFromUiAndLocal(conversationId: string, messageId: string): void {
    if (!conversationId || !messageId) {
      return;
    }
    this.clearMessageExpiryTimer(conversationId, messageId);
    this.messagesByConversation.update((state) => ({
      ...state,
      [conversationId]: (state[conversationId] ?? []).filter((message) => message.id !== messageId),
    }));
    this.removeLocalMessage(conversationId, messageId);
  }

  private expiredInMemoryMessages(now = Date.now()): ChatMessageVm[] {
    return Object.values(this.messagesByConversation())
      .flat()
      .filter((message) => this.isExpiredMessage(message, now));
  }

  private isExpiredMessage(message: ChatMessageVm | null | undefined, now = Date.now()): boolean {
    const expiresAtMs = message?.expiresAt ? Date.parse(message.expiresAt) : NaN;
    return Number.isFinite(expiresAtMs) && expiresAtMs <= now;
  }

  private clearMessageExpiryTimer(conversationId: string, messageId: string): void {
    const timerKey = `${conversationId}:${messageId}`;
    const timer = this.expiryTimers.get(timerKey);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.expiryTimers.delete(timerKey);
    }
  }

  private scheduleMessageExpiry(message: ChatMessageVm): void {
    if (!message?.id || !message.conversationId) {
      return;
    }
    const timerKey = `${message.conversationId}:${message.id}`;
    const existing = this.expiryTimers.get(timerKey);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      this.expiryTimers.delete(timerKey);
    }
    if (message.deleteAfterRead) {
      return;
    }
    const expiresAtMs = message.expiresAt ? Date.parse(message.expiresAt) : NaN;
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }
    const delay = Math.max(0, expiresAtMs - Date.now());
    const timer = window.setTimeout(() => {
      this.expiryTimers.delete(timerKey);
      if (this.isExpiredMessage(message)) {
        this.removeMessageFromUiAndLocal(message.conversationId, message.id);
      } else {
        this.scheduleMessageExpiry(message);
      }
    }, Math.min(delay, MAX_TIMEOUT_DELAY_MS));
    this.expiryTimers.set(timerKey, timer);
  }

  private startTtlSweep(): void {
    if (this.ttlSweepTimer !== null) {
      return;
    }
    void this.purgeExpiredLocalMessages();
    this.ttlSweepTimer = window.setInterval(() => {
      void this.purgeExpiredLocalMessages();
    }, TTL_SWEEP_INTERVAL_MS);
  }

  private stopTtlSweep(): void {
    if (this.ttlSweepTimer === null) {
      return;
    }
    window.clearInterval(this.ttlSweepTimer);
    this.ttlSweepTimer = null;
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
    return session?.user.id ?? null;
  }

  private async localAccountKeys(): Promise<string[]> {
    const userId = this.auth.session()?.user.id;
    if (!userId) {
      return [];
    }
    const keys = await this.history.accountKeysForUser(userId).catch(() => [userId]);
    const legacy = this.auth.session()?.device.id ? `${userId}:${this.auth.session()!.device.id}` : '';
    return [...new Set([userId, legacy, ...keys].filter(Boolean))];
  }

  private uniqueConversations(conversations: Conversation[]): Conversation[] {
    const map = new Map<string, Conversation>();
    for (const conversation of conversations) {
      if (!conversation?.id) {
        continue;
      }
      const previous = map.get(conversation.id);
      if (!previous || this.compareConversations(conversation, previous) < 0) {
        map.set(conversation.id, conversation);
      }
    }
    return [...map.values()].sort(this.compareConversations);
  }

  private dedupeVisibleConversations(
    conversations: Conversation[],
    messagesByConversation: Record<string, ChatMessageVm[]>,
  ): Conversation[] {
    const map = new Map<string, Conversation>();
    for (const conversation of conversations) {
      if (!conversation?.id) {
        continue;
      }
      const key = this.visibleConversationKey(conversation);
      const previous = map.get(key);
      map.set(key, previous
        ? this.preferredConversation(previous, conversation, messagesByConversation)
        : conversation);
    }
    return [...map.values()].sort(this.compareConversations);
  }

  private visibleConversationKey(conversation: Conversation): string {
    const currentUserId = this.auth.session()?.user.id;
    if (this.isDirectConversation(conversation)) {
      const peers = conversation.participants
        .filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
        .map((participant) => participant.userId)
        .filter(Boolean)
        .sort();
      if (peers.length === 1) {
        return `direct:${peers[0]}`;
      }
    }
    return `conversation:${conversation.id}`;
  }

  private preferredConversation(
    left: Conversation,
    right: Conversation,
    messagesByConversation: Record<string, ChatMessageVm[]>,
  ): Conversation {
    const leftMessages = messagesByConversation[left.id]?.length ?? 0;
    const rightMessages = messagesByConversation[right.id]?.length ?? 0;
    if (leftMessages !== rightMessages) {
      return leftMessages > rightMessages ? left : right;
    }
    return this.compareConversations(left, right) <= 0 ? left : right;
  }

  private async findExistingDirectConversation(userId: string): Promise<Conversation | null> {
    const candidates = this.conversations()
      .filter((conversation) => this.isDirectConversationWith(conversation, userId));
    if (!candidates.length) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    const messagesByConversation = this.messagesByConversation();
    const accountKeys = await this.localAccountKeys();
    let best: { conversation: Conversation; score: number; time: number } | null = null;
    for (const conversation of candidates) {
      const loadedCount = messagesByConversation[conversation.id]?.length ?? 0;
      const cachedCount = loadedCount || await this.cachedMessageCount(accountKeys, conversation.id);
      const time = Date.parse(conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt || '') || 0;
      const score = (cachedCount > 0 ? 1_000_000 : 0) + Math.min(cachedCount, 999);
      if (!best || score > best.score || (score === best.score && time > best.time)) {
        best = { conversation, score, time };
      }
    }
    return best?.conversation ?? candidates.sort(this.compareConversations)[0] ?? null;
  }

  private isDirectConversationWith(conversation: Conversation, userId: string): boolean {
    return this.isDirectConversation(conversation)
      && conversation.participants.some((participant) => !participant.removedAt && participant.userId === userId);
  }

  private async cachedMessageCount(accountKeys: string[], conversationId: string): Promise<number> {
    if (!accountKeys.length || !conversationId) {
      return 0;
    }
    const groups = await Promise.all(accountKeys.map((accountKey) =>
      this.history.conversationMessagesPage(accountKey, conversationId, 2).catch(() => [])));
    return groups.reduce((total, group) => total + group.length, 0);
  }

  private uniqueContacts(contacts: Contact[]): Contact[] {
    const map = new Map<string, Contact>();
    for (const contact of contacts) {
      if (!contact?.userId) {
        continue;
      }
      map.set(contact.userId, { ...(map.get(contact.userId) ?? {}), ...contact });
    }
    return [...map.values()];
  }

  private uniqueMessages(messages: ChatMessageVm[]): ChatMessageVm[] {
    const map = new Map<string, ChatMessageVm>();
    for (const message of messages) {
      if (!message?.id) {
        continue;
      }
      map.set(message.id, message);
    }
    return [...map.values()].sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
  }

  private normalizeOutgoingPayload(conversation: Conversation, payload: ChatPayload): ChatPayload {
    const outgoing = { ...(payload || {}) };
    const controlTypes = new Set(['reaction', 'edit', 'delete', 'system', 'call_log', 'system-call']);
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
    if (this.missingReceiptMessageIds.has(messageId)) {
      return;
    }

    try {
      const response = await firstValueFrom(this.api.post(`/messages/${encodeURIComponent(messageId)}/receipt`, { kind }));
      const message = response as MessageResponse;
      if (message?.id) {
        this.mergeMessageReceipts(message.id, message.receipts ?? []);
      }
    } catch (error) {
      if (this.isMissingMessageReceipt(error)) {
        this.missingReceiptMessageIds.add(messageId);
        return;
      }
      throw error;
    }
  }

  private isMissingMessageReceipt(error: unknown): boolean {
    return error instanceof HttpErrorResponse && (error.status === 404 || error.status === 410);
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

  private async applyReadSync(payload: unknown): Promise<void> {
    const current = this.auth.session();
    const value = payload as {
      conversationId?: string;
      messageIds?: string[];
      userId?: string;
      sourceDeviceId?: string;
      at?: string;
    };
    if (!current || value.userId !== current.user.id || !value.conversationId || !Array.isArray(value.messageIds)) {
      return;
    }

    const ids = [...new Set(value.messageIds.filter(Boolean))];
    if (!ids.length) {
      return;
    }

    const at = value.at || new Date().toISOString();
    const viewOnceIds: string[] = [];
    this.messagesByConversation.update((state) => {
      const messages = state[value.conversationId!] ?? [];
      if (!messages.length) {
        return state;
      }
      let changed = false;
      const next = messages.map((message) => {
        if (!ids.includes(message.id) || message.mine) {
          return message;
        }
        this.readReceiptSentIds.add(message.id);
        if (message.deleteAfterRead) {
          viewOnceIds.push(message.id);
          changed = true;
          return message;
        }
        changed = true;
        return this.withLocalReadReceipt(message, current.user.id, current.device.id, at);
      }).filter((message) => !viewOnceIds.includes(message.id));
      return changed ? { ...state, [value.conversationId!]: next } : state;
    });

    if (viewOnceIds.length) {
      const accountKey = this.localAccountKey();
      if (accountKey) {
        await this.history.markMessagesOpened(accountKey, value.conversationId, viewOnceIds).catch(() => undefined);
      }
    }

    for (const id of ids) {
      if (!viewOnceIds.includes(id)) {
        this.persistExistingMessage(id);
      }
    }
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

  private withLocalReadReceipt(message: ChatMessageVm, userId: string, deviceId: string, at: string): ChatMessageVm {
    return {
      ...message,
      receipts: this.mergeReceipt(message.receipts ?? [], userId, deviceId, 'read', at),
      status: message.mine ? message.status : 'visto',
    };
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
    const reactionAction = this.stringPayload(payload, 'reactionAction') === 'remove' ? 'remove' : 'set';
    if (!targetMessageId || (!emoji && reactionAction !== 'remove')) {
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
    const applied = this.applyReaction(targetMessageId, reaction, conversationId, reactionAction);
    if (!applied) {
      this.queuePendingReaction(targetMessageId, reaction);
    }
  }

  private applyReaction(
    targetMessageId: string,
    reaction: MessageReaction,
    conversationId?: string | null,
    action: 'set' | 'remove' = 'set',
  ): boolean {
    let found = false;
    this.messagesByConversation.update((state) => {
      const conversationIds = conversationId ? [conversationId] : Object.keys(state);
      const nextState = { ...state };
      for (const id of conversationIds) {
        const messages = state[id] ?? [];
        const index = messages.findIndex((message) => message.id === targetMessageId);
        if (index < 0) {
          continue;
        }
        found = true;
        const target = messages[index];
        const existing = target.payload.reactions ?? [];
        const actorKey = this.reactionActorKey(reaction);
        const withoutActor = existing.filter((item) => this.reactionActorKey(item) !== actorKey);
        const nextReactions = action === 'remove' ? withoutActor : [...withoutActor, reaction];
        if (
          existing.length === nextReactions.length &&
          existing.every((item, itemIndex) =>
            item.emoji === nextReactions[itemIndex]?.emoji &&
            this.reactionActorKey(item) === this.reactionActorKey(nextReactions[itemIndex] ?? item))
        ) {
          return state;
        }
        const nextMessages = [...messages];
        nextMessages[index] = {
          ...target,
          payload: {
            ...target.payload,
            reactions: nextReactions,
          },
        };
        nextState[id] = nextMessages;
        break;
      }
      return found ? nextState : state;
    });
    return found;
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
        this.persistSelectedConversationId(null);
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
    return this.displayProfileName(this.profileForUser(userId)) || 'Contacto';
  }

  private conversationPrimaryPerson(conversation: Conversation): LocalProfile | null {
    const currentUserId = this.auth.session()?.user.id;
    const other = conversation.participants.find((participant) => participant.userId !== currentUserId && !participant.removedAt);
    return other ? this.profileForUser(other.userId) : null;
  }

  private isGroupConversation(conversation: Conversation | null | undefined): boolean {
    return String(conversation?.type || '').toLowerCase() === 'group';
  }

  private isDirectConversation(conversation: Conversation | null | undefined): boolean {
    return String(conversation?.type || '').toLowerCase() === 'direct';
  }

  private normalizedGroupSettings(settings: Partial<GroupSettings> | null | undefined): GroupSettings {
    return {
      editInfo: settings?.editInfo === 'all' ? 'all' : 'admins',
      sendMessages: settings?.sendMessages === 'admins' ? 'admins' : 'all',
      addMembers: settings?.addMembers === 'all' ? 'all' : 'admins',
    };
  }

  private normalizedGroupAdmins(conversation: Conversation | null | undefined, fallbackUserId?: string): string[] {
    const explicit = (conversation?.admins ?? []).filter(Boolean);
    if (explicit.length) {
      return [...new Set(explicit)];
    }
    const roleAdmins = (conversation?.participants ?? [])
      .filter((participant) => ['owner', 'admin'].includes(String(participant.role || '').toLowerCase()))
      .map((participant) => participant.userId)
      .filter(Boolean);
    const fallback = fallbackUserId || (conversation?.participants ?? []).find((participant) => !participant.removedAt)?.userId;
    return [...new Set([...roleAdmins, fallback].filter(Boolean) as string[])];
  }

  private async persistGroupConversation(conversation: Conversation, patch: Record<string, unknown>): Promise<void> {
    const next = this.applyLocalConversationState([conversation])[0];
    this.conversations.update((items) => items.map((item) => item.id === next.id ? next : item).sort(this.compareConversations));
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.putConversations(accountKey, [next]).catch(() => undefined);
    }
    await firstValueFrom(this.api.patch(`/conversations/${encodeURIComponent(next.id)}`, patch)).catch(() => undefined);
  }

  private conversationPeople(conversation: Conversation): LocalProfile[] {
    const currentUserId = this.auth.session()?.user.id;
    return conversation.participants
      .filter((participant) => participant.userId !== currentUserId && !participant.removedAt)
      .map((participant) => this.profileForUser(participant.userId) ?? this.normalizeProfile(participant))
      .filter((profile): profile is LocalProfile => Boolean(profile));
  }

  private profileForUser(userId: string | null | undefined): LocalProfile | null {
    if (!userId) {
      return null;
    }
    return this.profilesByUserId()[userId] ?? null;
  }

  private displayProfileName(profile: LocalProfile | null | undefined): string {
    return this.firstText(profile?.displayName, profile?.phone, profile?.alias) || '';
  }

  private rememberConversationParticipants(conversations: Conversation[]): void {
    const profiles = conversations.flatMap((conversation) => conversation.participants ?? []);
    this.rememberProfiles(profiles, true);
  }

  private rememberProfiles(profiles: Array<ProfileSource | null | undefined>, persist = false): LocalProfile[] {
    const normalized = profiles
      .map((profile) => this.normalizeProfile(profile))
      .filter((profile): profile is LocalProfile => Boolean(profile));
    if (!normalized.length) {
      return [];
    }
    this.profilesByUserId.update((state) => {
      let changed = false;
      const next = { ...state };
      for (const profile of normalized) {
        const previous: LocalProfile = next[profile.userId] ?? { userId: profile.userId };
        const merged = {
          ...previous,
          ...profile,
          alias: profile.alias || previous.alias || null,
          displayName: profile.displayName || previous.displayName || null,
          phone: profile.phone || previous.phone || null,
          bio: profile.bio || previous.bio || null,
          profilePhotoDataUrl: profile.profilePhotoDataUrl || previous.profilePhotoDataUrl || null,
          cachedAt: new Date().toISOString(),
        } satisfies LocalProfile;
        next[profile.userId] = merged;
        changed = true;
      }
      return changed ? next : state;
    });
    if (persist) {
      void this.history.putProfiles(normalized).catch(() => undefined);
    }
    return normalized;
  }

  private normalizeProfile(profile: ProfileSource | null | undefined): LocalProfile | null {
    const userId = this.firstText(profile?.userId, profile?.id);
    if (!userId) {
      return null;
    }
    const alias = this.firstText(profile?.alias);
    return {
      userId,
      id: userId,
      alias,
      aliasLower: alias.toLowerCase(),
      displayName: this.firstText(profile?.displayName),
      phone: this.firstText(profile?.phone),
      bio: this.firstText(profile?.bio),
      profilePhotoDataUrl: this.firstText(profile?.profilePhotoDataUrl),
      isDiscoverable: profile?.isDiscoverable,
      isContact: profile?.isContact,
      isMutualContact: profile?.isMutualContact,
      isFavorite: profile?.isFavorite,
      friendshipState: profile?.friendshipState ?? null,
      updatedAt: profile?.updatedAt || new Date().toISOString(),
      cachedAt: profile?.cachedAt || new Date().toISOString(),
    };
  }

  private firstText(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  private async hydrateConversationProfiles(conversations: Conversation[]): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }
    const currentUserId = this.auth.session()?.user.id;
    const userIds = [...new Set(conversations
      .flatMap((conversation) => conversation.participants)
      .filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
      .map((participant) => participant.userId)
      .filter(Boolean))];
    for (const userId of userIds) {
      const profile = this.profileForUser(userId);
      if ((profile?.displayName || profile?.phone || profile?.profilePhotoDataUrl) || this.profileFetchInFlight.has(userId)) {
        continue;
      }
      this.profileFetchInFlight.add(userId);
      firstValueFrom(this.api.get<UserSummary>(`/directory/users/${encodeURIComponent(userId)}`))
        .then((person) => this.rememberProfiles([person], true))
        .catch(() => undefined)
        .finally(() => this.profileFetchInFlight.delete(userId));
    }
  }

  private isArchivedConversationRecord(conversation: Conversation): boolean {
    return Boolean(conversation.archivedAt || conversation.isArchived);
  }

  private isPinnedConversationRecord(conversation: Conversation): boolean {
    return Boolean(conversation.pinnedAt || conversation.isPinned);
  }

  private isMutedConversationRecord(conversation: Conversation): boolean {
    return Boolean(conversation.mutedAt || conversation.isMuted);
  }

  private readConversationFlag(kind: ConversationFlagKind): Set<string> {
    try {
      const values = JSON.parse(localStorage.getItem(this.conversationFlagKey(kind)) || '[]') as string[];
      return new Set(Array.isArray(values) ? values.filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  private writeConversationFlag(kind: ConversationFlagKind, conversationId: string, enabled: boolean): void {
    const values = this.readConversationFlag(kind);
    if (enabled) {
      values.add(conversationId);
    } else {
      values.delete(conversationId);
    }
    localStorage.setItem(this.conversationFlagKey(kind), JSON.stringify([...values]));
  }

  private conversationFlagKey(kind: ConversationFlagKind): string {
    const userId = this.auth.session()?.user.id || 'anonymous';
    return `nivra.${kind}Conversations.${userId}`;
  }

  private applyLocalConversationState(conversations: Conversation[]): Conversation[] {
    const archived = this.readConversationFlag('archived');
    const blocked = this.readConversationFlag('blocked');
    const pinned = this.readConversationFlag('pinned');
    const muted = this.readConversationFlag('muted');
    const now = new Date().toISOString();
    return conversations.map((conversation) => {
      const isArchived = Boolean(conversation.archivedAt || conversation.isArchived || archived.has(conversation.id));
      const isPinned = Boolean(conversation.pinnedAt || conversation.isPinned || pinned.has(conversation.id));
      const isMuted = Boolean(conversation.mutedAt || conversation.isMuted || muted.has(conversation.id));
      const base = {
        ...conversation,
        archivedAt: isArchived ? conversation.archivedAt || now : null,
        blockedAt: conversation.blockedAt ?? (blocked.has(conversation.id) ? now : null),
        pinnedAt: isPinned ? conversation.pinnedAt || now : null,
        mutedAt: isMuted ? conversation.mutedAt || now : null,
        isArchived,
        isPinned,
        isMuted,
      };
      return this.isGroupConversation(base)
        ? {
            ...base,
            admins: this.normalizedGroupAdmins(base),
            settings: this.normalizedGroupSettings(base.settings),
            groupName: this.firstText(base.groupName, base.title) || null,
            groupAvatar: base.groupAvatar ?? null,
          }
        : base;
    });
  }

  private async updateConversationLocalState(
    conversation: Conversation,
    patch: Partial<Pick<Conversation, 'archivedAt' | 'blockedAt' | 'pinnedAt' | 'mutedAt' | 'isArchived' | 'isPinned' | 'isMuted'>>,
  ): Promise<void> {
    const current = this.conversations().find((item) => item.id === conversation.id) ?? conversation;
    const next = this.applyLocalConversationState([{
      ...current,
      ...patch,
    }])[0];
    this.conversations.update((items) => items.map((item) => item.id === next.id ? next : item).sort(this.compareConversations));
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.putConversations(accountKey, [next]).catch(() => undefined);
    }
  }

  private isCurrentUserActiveInConversation(conversation: Conversation): boolean {
    const currentUserId = this.auth.session()?.user.id;
    if (!currentUserId) {
      return true;
    }
    return conversation.participants.some((participant) => participant.userId === currentUserId && !participant.removedAt);
  }

  private async removeConversationLocally(conversationId: string): Promise<void> {
    if (!conversationId) {
      return;
    }
    this.conversations.update((items) => items.filter((item) => item.id !== conversationId));
    const accountKey = this.localAccountKey();
    if (accountKey) {
      await this.history.removeConversation(accountKey, conversationId).catch(() => undefined);
    }
    if (this.selectedConversationId() === conversationId) {
      const nextId = this.conversations()[0]?.id ?? null;
      this.selectedConversationId.set(nextId);
      this.persistSelectedConversationId(nextId);
    }
  }

  private restoreSelectedConversationId(): void {
    const conversationId = this.initialSelectedConversationId();
    if (conversationId !== this.selectedConversationId()) {
      this.selectedConversationId.set(conversationId);
    }
  }

  private ensureSelectedConversation(): void {
    const conversations = this.conversations();
    const selected = this.selectedConversationId();
    if (selected && conversations.some((conversation) => conversation.id === selected)) {
      this.persistSelectedConversationId(selected);
      return;
    }
    this.selectedConversationId.set(null);
    this.persistSelectedConversationId(null);
  }

  private initialSelectedConversationId(): string | null {
    return localStorage.getItem(this.selectedConversationStorageKey())
      || localStorage.getItem('nivra.selectedConversationId');
  }

  private persistSelectedConversationId(conversationId: string | null): void {
    const scopedKey = this.selectedConversationStorageKey();
    if (conversationId) {
      localStorage.setItem(scopedKey, conversationId);
      localStorage.setItem('nivra.selectedConversationId', conversationId);
      return;
    }
    localStorage.removeItem(scopedKey);
    localStorage.removeItem('nivra.selectedConversationId');
  }

  private selectedConversationStorageKey(): string {
    const userId = this.auth.session()?.user.id;
    return userId ? `nivra.selectedConversationId.${userId}` : 'nivra.selectedConversationId';
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
    this.profilesByUserId.set({});
    this.typingByConversation.set({});
    this.presenceByUser.set({});
    this.directories.clear();
    this.readReceiptSentIds.clear();
    this.pendingReactionsByMessageId.clear();
    this.pendingReactionSends.clear();
    this.lastTypingSentAt = 0;
    this.syncInFlight = false;
    this.selectedConversationLoadId += 1;
    this.typingTimers.forEach((timer) => window.clearTimeout(timer));
    this.typingTimers.clear();
    this.expiryTimers.forEach((timer) => window.clearTimeout(timer));
    this.expiryTimers.clear();
  }

  private pauseForLoggedOutSession(): void {
    this.directories.clear();
    this.readReceiptSentIds.clear();
    this.pendingReactionsByMessageId.clear();
    this.pendingReactionSends.clear();
    this.lastTypingSentAt = 0;
    this.syncInFlight = false;
    this.selectedConversationLoadId += 1;
    this.typingTimers.forEach((timer) => window.clearTimeout(timer));
    this.typingTimers.clear();
    this.expiryTimers.forEach((timer) => window.clearTimeout(timer));
    this.expiryTimers.clear();
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

    let nextReactions = [...(message.payload.reactions ?? [])];
    let changed = false;
    for (const reaction of pending) {
      const actorKey = this.reactionActorKey(reaction);
      const withoutActor = nextReactions.filter((item) => this.reactionActorKey(item) !== actorKey);
      if (withoutActor.length !== nextReactions.length) {
        changed = true;
      }
      nextReactions = withoutActor;
      if (reaction.emoji) {
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
    this.pendingReactionsByMessageId.set(messageId, [
      ...pending.filter((item) => this.reactionActorKey(item) !== actorKey),
      reaction,
    ]);
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
    const groupRecipients: PublicKeyRecipient[] = [];
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
        if (this.isGroupConversation(conversation)) {
          groupRecipients.push({
            userId: participant.userId,
            deviceId: device.deviceId,
            publicJwk: publicKey,
          });
          usedDeviceIds.add(device.deviceId);
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
        if (this.isGroupConversation(conversation)) {
          groupRecipients.push({
            userId: current.user.id,
            deviceId: current.device.id,
            publicJwk: own.publicJwk,
          });
          continue;
        }
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

    if (this.isGroupConversation(conversation)) {
      return this.crypto.encryptGroupPayloadForRecipients(own, groupRecipients, payload, fileObjectId);
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
        caption: typeof file.text === 'string' ? file.text : '',
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
    const leftPinned = Boolean(left.pinnedAt || left.isPinned);
    const rightPinned = Boolean(right.pinnedAt || right.isPinned);
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }
    if (leftPinned && rightPinned) {
      const leftPinnedAt = Date.parse(left.pinnedAt || '') || 0;
      const rightPinnedAt = Date.parse(right.pinnedAt || '') || 0;
      if (leftPinnedAt !== rightPinnedAt) {
        return rightPinnedAt - leftPinnedAt;
      }
    }
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
