import { DestroyRef, Injectable, Injector, computed, effect, inject, signal, untracked, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Room } from 'livekit-client';
import { loadLiveKit } from './livekit-loader';
import { firstValueFrom, timeout } from 'rxjs';
import {
  ChatPayload,
  DecodedVaultItem,
  DirectorySearchResponse,
  FileChatPayload,
  FileResponse,
  MediaPreview,
  PublicKeyDirectory,
  RecipientCipherRequest,
  UserSummary,
  VaultInviteLink,
  VaultItem,
  VaultNoteAttachment,
  VaultRealtimeMessageResponse,
  VaultRoom,
  VaultRoomMember,
  VaultRoomMessageVm,
} from '../models/nivra.models';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { EncryptedDownloadService } from './encrypted-download.service';
import { RatchetMessagingService, RatchetTarget } from './ratchet-messaging.service';
import { ratchetTransport } from './ratchet-runtime';
import { IdentityTrustService } from './identity-trust.service';

const VAULT_META_PREFIX = 'nivra.vault.';
const MAX_VAULT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_NOTE_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_NOTE_ATTACHMENTS = 8;

interface LiveKitRoomTokenResponse {
  serverUrl: string;
  token: string;
}

type VaultVoicePhase = 'idle' | 'connecting' | 'connected' | 'failed';
interface VaultSessionContext { scope: string; epoch: number; userId: string; deviceId: string; alias: string; }

@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly injector = inject(Injector);
  private get ratchet(): RatchetMessagingService { return this.injector.get(RatchetMessagingService); }
  private readonly api = inject(NivraApiService);
  private readonly downloads = inject(EncryptedDownloadService);
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly crypto = inject(CryptoService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly directories = new Map<string, PublicKeyDirectory>();
  private key: CryptoKey | null = null;
  private voiceRoom: Room | null = null;
  private readonly stateScope = signal(this.sessionScope());
  private readonly resetters: Array<() => void> = [];
  private scopeEpoch = 0;
  private destroyed = false;
  private readonly roomRevisions = new Map<string, number>();
  private searchRevision = 0;
  private loadRevision = 0;
  private voiceRevision = 0;
  private privacyRevision = 0;
  private privacyDesired = { scope: this.sessionScope(), enabled: false, revision: 0 };
  private privacyWork: Promise<void> | null = null;

  // Reads conceal stale values synchronously, before Angular effects run.
  // Writable methods are retained for the existing page's local search reset.
  readonly unlocked = this.scopedSignal(() => false);
  readonly items = this.scopedSignal<DecodedVaultItem[]>(() => []);
  readonly rooms = this.scopedSignal<VaultRoom[]>(() => []);
  readonly messagesByRoom = this.scopedSignal<Record<string, VaultRoomMessageVm[]>>(() => ({}));
  readonly mediaPreviews = this.scopedSignal<Record<string, MediaPreview>>(() => ({}), previews => {
    Object.values(previews).forEach(preview => { if (preview.url) URL.revokeObjectURL(preview.url); });
  });
  readonly people = this.scopedSignal<UserSummary[]>(() => []);
  private readonly pendingRoomLeaves = new Set<string>();
  readonly roomConnected = computed(() => this.realtime.connected?.() ?? true);
  readonly loadError = this.scopedSignal<string>(() => '');
  readonly activeRoomId = this.scopedSignal<string | null>(() => null);
  readonly joinedRoomId = this.scopedSignal<string | null>(() => null);
  readonly loading = this.scopedSignal(() => false);
  readonly sending = this.scopedSignal(() => false);
  readonly uploading = this.scopedSignal(() => false);
  readonly noteBusy = this.scopedSignal(() => false);
  readonly voicePhase = this.scopedSignal<VaultVoicePhase>(() => 'idle');
  readonly voiceRoomId = this.scopedSignal<string | null>(() => null);
  readonly voiceMuted = this.scopedSignal(() => false);
  readonly voiceError = this.scopedSignal(() => '');
  readonly voiceRemoteStreams = this.scopedSignal<Record<string, MediaStream>>(() => ({}), streams => {
    Object.values(streams).forEach(stream => stream.getTracks().forEach(track => { track.enabled = false; track.stop(); }));
  });
  readonly voiceActiveSpeakers = this.scopedSignal<string[]>(() => []);
  readonly voiceRemoteEntries = computed(() => Object.entries(this.voiceRemoteStreams()));
  readonly voiceConnected = computed(() => this.voicePhase() === 'connected' && Boolean(this.voiceRoomId()));

  readonly activeRoom = computed(() => {
    const id = this.activeRoomId();
    return id ? this.rooms().find((room) => room.id === id) ?? null : null;
  });
  readonly activeMessages = computed(() => {
    const id = this.activeRoomId();
    return id ? this.messagesByRoom()[id] ?? [] : [];
  });

  constructor() {
    this.restoreActiveRoom();
    this.realtime.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
      if (event.type === 'vault.message') {
        void this.ingestRealtimeMessage(event.payload as VaultRealtimeMessageResponse);
      }
      if (event.type === 'vault.invited' || event.type === 'vault.approved' || event.type === 'vault.joinRequested') {
        this.syncRoom(event.payload as VaultRoom);
      }
      if (event.type === 'vault.left' || event.type === 'vault.closed') {
        this.handleRoomClosedOrLeft(event.payload);
      }
      if (event.type === 'connected' || event.type === 'reconnected') {
        void this.rejoinActiveRoom();
      }
      if (event.type === 'disconnected') this.joinedRoomId.set(null);
    });

    effect(() => {
      const scope = this.sessionScope();
      untracked(() => {
        this.ensureCurrentScope();
        if (scope && this.auth.isAuthenticated()) {
          void this.load();
          void this.rejoinActiveRoom();
        }
      });
    });
    this.destroyRef.onDestroy(() => { this.destroyed = true; this.resetScopeState(); });
  }

  private sessionScope(): string {
    const session = this.auth.session?.();
    return session ? JSON.stringify([session.user.id, session.device.id, this.auth.sessionGeneration?.() ?? 0]) : '';
  }

  private scopedSignal<T>(empty: () => T, discard?: (value: T) => void): WritableSignal<T> {
    const state = signal(empty());
    const read = computed(() => this.stateScope() === this.sessionScope() && !this.destroyed ? state() : empty());
    this.resetters.push(() => { discard?.(state()); state.set(empty()); });
    return Object.assign(read, {
      set: (value: T) => { this.ensureCurrentScope(); state.set(value); },
      update: (update: (value: T) => T) => { this.ensureCurrentScope(); state.update(update); },
      asReadonly: () => read,
    }) as WritableSignal<T>;
  }

  private ensureCurrentScope(): void {
    const scope = this.sessionScope();
    if (this.stateScope() === scope) return;
    this.resetScopeState();
    this.stateScope.set(scope);
    this.restoreActiveRoom();
  }

  private resetScopeState(): void {
    this.roomRevisions.clear();
    this.scopeEpoch++;
    this.pendingRoomLeaves.clear();
    this.searchRevision++;
    this.loadRevision++;
    this.voiceRevision++;
    this.key = null;
    this.directories.clear();
    this.disconnectVoiceRoom();
    for (const reset of this.resetters) reset();
    void this.setPrivacyScreen(false);
  }

  private captureContext(): VaultSessionContext {
    this.ensureCurrentScope();
    const session = this.auth.session?.();
    if (!session || this.destroyed) throw new Error('Sesion no disponible.');
    return { scope: this.sessionScope(), epoch: this.scopeEpoch, userId: session.user.id, deviceId: session.device.id, alias: session.user.alias };
  }

  private isCurrent(context: VaultSessionContext): boolean {
    return !this.destroyed && context.scope === this.sessionScope() && context.scope === this.stateScope() && context.epoch === this.scopeEpoch;
  }

  private checkContext(context: VaultSessionContext): void {
    if (!this.isCurrent(context)) throw new Error('La cuenta cambió. Vuelve a abrir la bóveda.');
  }

  private activeRoomStorageKey(): string | null {
    const session = this.auth.session?.();
    return session ? `nivra.activeVaultRoomId.v2.${encodeURIComponent(JSON.stringify([session.user.id, session.device.id]))}` : null;
  }

  private restoreActiveRoom(): void {
    const key = this.activeRoomStorageKey();
    try { this.activeRoomId.set(key ? localStorage.getItem(key) : null); }
    catch { this.activeRoomId.set(null); }
  }

  async load(): Promise<void> {
    this.ensureCurrentScope();
    if (!this.auth.isAuthenticated()) {
      return;
    }
    const context = this.captureContext();
    const revision = ++this.loadRevision;
    this.loading.set(true);
    try {
      const [items, rooms] = await Promise.all([
        firstValueFrom(this.api.get<VaultItem[]>('/vault/items').pipe(timeout(12000))).catch(() => null),
        firstValueFrom(this.api.get<VaultRoom[]>('/vault/rooms').pipe(timeout(12000))).catch(() => null),
      ]);
      if (!this.isCurrent(context) || revision !== this.loadRevision) return;
      this.loadError.set(items === null || rooms === null ? 'No se pudo actualizar todo. Conservamos lo que ya estaba abierto. Revisa tu conexión y reintenta.' : '');
      const key = this.key;
      const decoded = items === null ? this.items() : key ? await this.decodeItems(items, key, context) : items.map((item) => ({ ...item }));
      if (!this.isCurrent(context) || revision !== this.loadRevision) return;
      if (rooms !== null) this.rooms.set(rooms.filter(room => !this.pendingRoomLeaves.has(room.id)));
      this.items.set(decoded);
      const activeId = this.activeRoomId();
      if (activeId && rooms !== null && !rooms.some((room) => room.id === activeId && !room.closedAt && this.currentMember(room)?.status === 'Active')) {
        this.clearRoomMessages(activeId);
        this.setActiveRoom(null);
      }
    } catch (error) {
      if (this.isCurrent(context)) throw error;
    } finally {
      if (this.isCurrent(context) && revision === this.loadRevision) this.loading.set(false);
    }
  }

  async unlock(pin: string): Promise<void> {
    const context = this.captureContext();
    const userId = context.userId;
    const metaKey = `${VAULT_META_PREFIX}${userId}`;
    const existing = this.loadJson<{ salt: string; verifier: { iv: string; ciphertext: string } }>(metaKey);
    if (!existing) {
      const salt = this.crypto.randomBytes(16);
      const key = await this.crypto.deriveVaultKey(pin, salt);
      this.checkContext(context);
      const verifier = await this.crypto.encryptWithKey(key, { ok: true, createdAt: new Date().toISOString() });
      this.checkContext(context);
      localStorage.setItem(metaKey, JSON.stringify({ salt: this.crypto.b64(salt), verifier }));
      this.key = key;
    } else {
      const key = await this.crypto.deriveVaultKey(pin, this.crypto.ub64(existing.salt));
      this.checkContext(context);
      await this.crypto.decryptWithKey(key, existing.verifier);
      this.checkContext(context);
      this.key = key;
    }
    this.unlocked.set(true);
    await this.load();
    this.checkContext(context);
  }

  lock(): void {
    this.ensureCurrentScope();
    this.scopeEpoch++;
    this.loadRevision++;
    this.key = null;
    this.unlocked.set(false);
    this.items.update((items) => items.map(({ decoded: _decoded, decodeError: _decodeError, ...item }) => ({ ...item })));
    this.messagesByRoom.set({});
    Object.values(this.mediaPreviews()).forEach(preview => { if (preview.url) URL.revokeObjectURL(preview.url); });
    this.mediaPreviews.set({});
    this.loading.set(false);
    this.sending.set(false);
    this.uploading.set(false);
    this.noteBusy.set(false);
    this.leaveVoiceChat();
  }

  async createNote(title: string, body: string, files: File[] = []): Promise<void> {
    const context = this.captureContext();
    const key = this.key;
    if (!key || !this.unlocked()) {
      throw new Error('Desbloquea la boveda primero.');
    }
    const attachments = await this.encryptNoteAttachments(files, context);
    this.checkContext(context);
    const encryptedMetadata = JSON.stringify(await this.crypto.encryptWithKey(key, {
      title,
      body,
      attachments,
      schema: 2,
    }));
    this.checkContext(context);
    await firstValueFrom(this.api.post('/vault/items', {
      kind: 'Note',
      encryptedMetadata,
      parentId: null,
      fileObjectId: null,
    }));
    this.checkContext(context);
    await this.load();
  }

  async deleteItem(itemId: string): Promise<void> {
    const context = this.captureContext();
    await firstValueFrom(this.api.delete(`/vault/items/${encodeURIComponent(itemId)}`));
    this.checkContext(context);
    this.items.update((items) => items.filter((item) => item.id !== itemId));
  }

  async createRoom(options: {
    name: string;
    pin?: string | null;
    accessMode?: string;
    retentionMode: string;
    encryptedWelcome?: string | null;
    invitedUserIds?: string[];
    ttlSeconds?: number | null;
    notifyInChat?: boolean;
  }): Promise<VaultRoom> {
    const context = this.captureContext();
    const room = await firstValueFrom(this.api.post<VaultRoom>('/vault/rooms', {
      name: options.name,
      pin: options.pin || null,
      accessMode: options.accessMode || (options.pin ? 'PinOnly' : 'InviteOnly'),
      retentionMode: options.retentionMode,
      encryptedWelcome: options.encryptedWelcome || null,
      invitedUserIds: options.invitedUserIds ?? [],
      ttlSeconds: options.retentionMode === 'ExpiresAfterTtl' ? options.ttlSeconds ?? 3600 : null,
    }).pipe(timeout(15000)));
    this.checkContext(context);
    this.syncRoom(room);
    if (this.currentMember(room)?.status === 'Active') {
      await this.selectRoom(room.id);
      this.checkContext(context);
    }
    if (options.notifyInChat !== false) await this.notifyVaultInvites(room, this.invitedUserIdsFromRoom(room, options.invitedUserIds ?? []), options.pin || null, context);
    this.checkContext(context);
    return room;
  }

  async joinRoom(room: VaultRoom, pin?: string | null): Promise<VaultRoom> {
    const context = this.captureContext();
    if (!this.canAttemptJoin(room)) {
      throw new Error('No estas invitado a esta sala. Pidele al dueno que te agregue primero.');
    }
    const joined = await firstValueFrom(this.api.post<VaultRoom>(`/vault/rooms/${encodeURIComponent(room.id)}/join`, {
      pin: pin || null,
    }));
    this.checkContext(context);
    this.syncRoom(joined);
    if (this.currentMember(joined)?.status === 'Active') {
      await this.selectRoom(joined.id);
      this.checkContext(context);
    }
    return joined;
  }

  async selectRoom(roomId: string): Promise<void> {
    const context = this.captureContext();
    const room = this.rooms().find((candidate) => candidate.id === roomId);
    if (!room || room.closedAt || this.currentMember(room)?.status !== 'Active') {
      throw new Error('Debes entrar a la sala primero.');
    }
    const previous = this.activeRoom();
    if (previous && previous.id !== roomId && previous.retentionMode === 'BurnOnExit') {
      await this.leaveRoom(previous.id);
      this.checkContext(context);
    }
    this.setActiveRoom(roomId);
    this.joinedRoomId.set(null);
    await this.realtime.joinVaultRoom(roomId);
    this.checkContext(context);
    this.joinedRoomId.set(roomId);
    this.messagesByRoom.update((state) => ({ ...state, [roomId]: state[roomId] ?? [] }));
  }

  async leaveRoom(roomId: string): Promise<void> {
    const context = this.captureContext();
    const ephemeral = this.rooms().find(room => room.id === roomId)?.retentionMode === 'BurnOnExit';
    if (ephemeral) {
      this.pendingRoomLeaves.add(roomId);
      this.clearRoomMessages(roomId);
      if (this.activeRoomId() === roomId) this.setActiveRoom(null);
      this.rooms.update(rooms => rooms.filter(room => room.id !== roomId));
    }
    try {
      await firstValueFrom(this.api.post(`/vault/rooms/${encodeURIComponent(roomId)}/leave`, {}).pipe(timeout(12000)));
      if (this.isCurrent(context)) this.pendingRoomLeaves.delete(roomId);
    } catch (error) {
      if (!ephemeral || !this.isCurrent(context)) throw error;
      await this.realtime.leaveVaultRoom(roomId).catch(() => undefined);
    }
    this.checkContext(context);
    if (this.activeRoomId() === roomId) {
      this.setActiveRoom(null);
    }
    this.clearRoomMessages(roomId);
    if (this.voiceRoomId() === roomId) {
      this.leaveVoiceChat();
    }
    this.rooms.update((rooms) => rooms.filter((room) => room.id !== roomId));
  }

  async inviteUsers(roomId: string, userIds: string[]): Promise<VaultRoom> {
    const context = this.captureContext();
    const currentRoom = this.rooms().find((candidate) => candidate.id === roomId) ?? this.activeRoom();
    if (!this.canInviteGuests(currentRoom)) {
      throw new Error('Solo el dueno de la sala puede agregar invitados.');
    }
    const existing = new Set((currentRoom?.members ?? [])
      .filter((member) => member.status !== 'Left' && member.status !== 'Rejected')
      .map((member) => member.userId));
    const ids = [...new Set(userIds.filter((id) => Boolean(id) && !existing.has(id)))];
    if (!ids.length) {
      throw new Error('Selecciona un contacto que todavia no este en la sala.');
    }
    const room = await firstValueFrom(this.api.post<VaultRoom>(`/vault/rooms/${encodeURIComponent(roomId)}/invite`, {
      userIds: ids,
    }));
    this.checkContext(context);
    this.syncRoom(room);
    await this.notifyVaultInvites(room, this.invitedUserIdsFromRoom(room, ids), null, context);
    this.checkContext(context);
    return room;
  }

  async createInviteLink(room: VaultRoom, options: { ttlSeconds?: number; maxUses?: number; requireApproval?: boolean } = {}): Promise<VaultInviteLink> {
    const context = this.captureContext();
    if (!this.canInviteGuests(room)) {
      throw new Error('Solo el dueno de la sala puede crear enlaces.');
    }
    const invite = await firstValueFrom(this.api.post<VaultInviteLink>(`/vault/rooms/${encodeURIComponent(room.id)}/invite-links`, {
      ttlSeconds: options.ttlSeconds ?? 24 * 60 * 60,
      maxUses: options.maxUses ?? 1,
      requireApproval: options.requireApproval ?? room.accessMode === 'WaitingRoom',
    }));
    this.checkContext(context);
    return invite;
  }

  async acceptInviteCode(code: string, pin = ''): Promise<VaultRoom> {
    const context = this.captureContext();
    const value = code.trim();
    if (!value) {
      throw new Error('Codigo de invitacion invalido.');
    }
    const room = await firstValueFrom(this.api.post<VaultRoom>(`/vault/invites/${encodeURIComponent(value)}/accept`, {
      pin: pin || null,
    }));
    this.checkContext(context);
    this.syncRoom(room);
    if (this.currentMember(room)?.status === 'Active') {
      await this.selectRoom(room.id);
      this.checkContext(context);
    }
    return room;
  }

  inviteShareText(room: VaultRoom, invite: VaultInviteLink): string {
    const owner = this.auth.session()?.user.alias;
    return [
      `Te invite a la sala Vault "${room.name}" en Nivra.`,
      owner ? `Mi alias es @${owner}.` : '',
      'El enlace solo abre acceso a la sala; el contenido se cifra en cada dispositivo.',
      room.accessMode === 'PinOnly' || room.accessMode === 'WaitingRoom' ? 'Te paso el PIN por un canal separado.' : '',
      invite.acceptUrl,
    ].filter(Boolean).join('\n');
  }

  async approveMember(roomId: string, memberUserId: string): Promise<VaultRoom> {
    const context = this.captureContext();
    const room = await firstValueFrom(
      this.api.post<VaultRoom>(`/vault/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberUserId)}/approve`, {}),
    );
    this.checkContext(context);
    this.syncRoom(room);
    return room;
  }

  async searchPeople(query: string): Promise<UserSummary[]> {
    const context = this.captureContext();
    const revision = ++this.searchRevision;
    const value = query.trim();
    if (value.length < 2) {
      this.people.set([]);
      return [];
    }
    const response = await firstValueFrom(this.api.get<DirectorySearchResponse>(`/directory/search?q=${encodeURIComponent(value)}`));
    if (!this.isCurrent(context) || revision !== this.searchRevision) return [];
    this.people.set(response.people ?? []);
    return response.people ?? [];
  }

  async sendRoomText(text: string): Promise<void> {
    const body = text.trim();
    if (!body) {
      return;
    }
    await this.sendVaultPayload({ type: 'text', text: body }, 'Text');
  }

  async sendRoomFile(file: File): Promise<void> {
    const context = this.captureContext();
    const room = this.activeRoom();
    if (!room) {
      throw new Error('Abre una sala Vault primero.');
    }
    if (file.size > MAX_VAULT_FILE_BYTES) {
      throw new Error('Maximo 256 MB por archivo cifrado.');
    }

    this.uploading.set(true);
    try {
      const bytes = await file.arrayBuffer();
      this.checkContext(context);
      const encrypted = await this.crypto.encryptAttachment(bytes);
      this.checkContext(context);
      const mime = file.type || 'application/octet-stream';
      const fileRecord = await firstValueFrom(this.api.post<FileResponse>('/files', {
        encryptedSize: encrypted.bytes.byteLength,
        mimeTypeCiphertext: this.crypto.b64(new TextEncoder().encode(mime)),
        clientSha256: null,
        allowedUserIds: this.activeMemberIds(room),
        expiresAt: this.vaultFileExpiry(room),
        vaultRoomId: room.id,
      }));
      this.checkContext(context);
      await firstValueFrom(this.api.putRaw<FileResponse>(`/files/${encodeURIComponent(fileRecord.id)}/blob`, encrypted.bytes));
      this.checkContext(context);
      this.rememberMediaPreview(fileRecord.id, file, mime, file.name);
      await this.sendVaultPayload({
        type: 'file',
        fileId: fileRecord.id,
        fileName: file.name,
        mime,
        size: file.size,
        fileKey: encrypted.key,
        fileIv: encrypted.iv,
      }, this.fileKind(file), fileRecord.id, context, room);
    } finally {
      if (this.isCurrent(context)) this.uploading.set(false);
    }
  }

  async ensureMediaPreview(payload: ChatPayload): Promise<MediaPreview | null> {
    const context = this.captureContext();
    if (!this.unlocked()) return null;
    const file = this.asFile(payload);
    const fileId = this.fileId(file);
    if (!file || !fileId || !file.fileKey || !file.fileIv) {
      return null;
    }
    const cached = this.mediaPreviews()[fileId];
    if (cached) {
      return cached;
    }
    const current = () => this.isCurrent(context) && this.unlocked();
    const encrypted = await this.downloads.file(fileId, current);
    if (!current()) return null;
    const plain = await this.crypto.decryptAttachment(encrypted, file.fileKey, file.fileIv);
    if (!current()) return null;
    return this.rememberMediaPreview(fileId, new Blob([plain], { type: this.fileMime(file) }), this.fileMime(file), this.fileName(file));
  }

  async downloadAttachment(payload: ChatPayload): Promise<void> {
    const context = this.captureContext();
    const preview = await this.ensureMediaPreview(payload);
    if (!this.isCurrent(context)) return;
    const file = this.asFile(payload);
    if (!preview || !file) {
      return;
    }

    const link = document.createElement('a');
    link.href = preview.url;
    link.download = this.fileName(file);
    link.click();
  }

  noteAttachments(item: DecodedVaultItem | null | undefined): VaultNoteAttachment[] {
    if (!this.unlocked() || !item?.id || !this.items().some(candidate => candidate.id === item.id)) return [];
    return Array.isArray(item?.decoded?.attachments) ? item.decoded.attachments : [];
  }

  noteAttachmentKey(item: DecodedVaultItem, attachment: VaultNoteAttachment): string {
    return `note:${item.id}:${attachment.id}`;
  }

  noteAttachmentSummary(item: DecodedVaultItem): string {
    const attachments = this.noteAttachments(item);
    if (!attachments.length) {
      return '';
    }
    const total = attachments.reduce((sum, attachment) => sum + Number(attachment.size || 0), 0);
    return `${attachments.length} adjunto${attachments.length === 1 ? '' : 's'} - ${this.formatBytes(total)}`;
  }

  async ensureNoteAttachmentPreview(item: DecodedVaultItem, attachment: VaultNoteAttachment): Promise<MediaPreview | null> {
    this.captureContext();
    const ownedItem = this.items().find(candidate => candidate.id === item.id);
    const ownedAttachment = this.noteAttachments(ownedItem).find(candidate => candidate.id === attachment.id);
    if (!ownedItem || !ownedAttachment) return null;
    const key = this.noteAttachmentKey(item, attachment);
    const cached = this.mediaPreviews()[key];
    if (cached) {
      return cached;
    }
    const blob = this.noteAttachmentBlob(ownedAttachment);
    return this.rememberMediaPreview(key, blob, ownedAttachment.mime, ownedAttachment.name);
  }

  async downloadNoteAttachment(item: DecodedVaultItem, attachment: VaultNoteAttachment): Promise<void> {
    const context = this.captureContext();
    const preview = await this.ensureNoteAttachmentPreview(item, attachment);
    if (!this.isCurrent(context)) return;
    if (!preview) {
      return;
    }
    const link = document.createElement('a');
    link.href = preview.url;
    link.download = attachment.name;
    link.click();
  }

  isNoteAttachmentImage(attachment: VaultNoteAttachment): boolean {
    return (attachment.mime || '').startsWith('image/');
  }

  isNoteAttachmentAudio(attachment: VaultNoteAttachment): boolean {
    return (attachment.mime || '').startsWith('audio/');
  }

  isNoteAttachmentVideo(attachment: VaultNoteAttachment): boolean {
    return (attachment.mime || '').startsWith('video/');
  }

  noteAttachmentSize(attachment: VaultNoteAttachment): string {
    return this.formatBytes(Number(attachment.size || 0));
  }

  async startVoiceChat(room: VaultRoom | null = this.activeRoom()): Promise<void> {
    const context = this.captureContext();
    const revision = ++this.voiceRevision;
    const current = () => this.isCurrent(context) && revision === this.voiceRevision;
    if (!room?.id) {
      throw new Error('Abre una sala Vault primero.');
    }
    if (this.currentMember(room)?.status !== 'Active') {
      throw new Error('Debes entrar a la sala para unirte al audio.');
    }

    this.voiceError.set('');
    this.disconnectVoiceRoom();
    this.resetVoiceState();
    this.voicePhase.set('connecting');
    let liveRoom: Room | null = null;
    try {
      const credentials = await firstValueFrom(this.api.get<LiveKitRoomTokenResponse>(`/vault/rooms/${encodeURIComponent(room.id)}/voice-token`));
      if (!current()) throw new Error('La cuenta o la sala de audio cambió.');
      if (!credentials?.serverUrl || !credentials.token) {
        throw new Error('El servidor no devolvio credenciales LiveKit validas.');
      }

      const { Room, RoomEvent } = await loadLiveKit();
      if (!current()) throw new Error('La cuenta o la sala de audio cambió.');
      liveRoom = new Room();
      this.voiceRoom = liveRoom;
      liveRoom.on(RoomEvent.TrackSubscribed, (track: unknown, _publication: unknown, participant: { identity?: string }) => {
        if (current() && this.voiceRoom === liveRoom) this.addVoiceRemoteTrack(participant?.identity || crypto.randomUUID(), track);
      });
      liveRoom.on(RoomEvent.TrackUnsubscribed, (track: unknown, _publication: unknown, participant: { identity?: string }) => {
        if (current() && this.voiceRoom === liveRoom) this.removeVoiceRemoteTrack(participant?.identity || '', track);
      });
      liveRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers: Array<{ identity?: string }>) => {
        if (current() && this.voiceRoom === liveRoom) this.voiceActiveSpeakers.set(speakers.map((speaker) => speaker.identity).filter((id): id is string => Boolean(id)));
      });
      liveRoom.on(RoomEvent.Disconnected, () => {
        if (current() && this.voiceRoom === liveRoom) {
          this.resetVoiceState();
        }
      });

      await liveRoom.connect(credentials.serverUrl, credentials.token);
      if (!current() || this.voiceRoom !== liveRoom) throw new Error('La cuenta o la sala de audio cambió.');
      await (liveRoom.localParticipant as unknown as {
        setMicrophoneEnabled: (enabled: boolean) => Promise<unknown>;
        setCameraEnabled?: (enabled: boolean) => Promise<unknown>;
      }).setMicrophoneEnabled(true);
      if (!current() || this.voiceRoom !== liveRoom) throw new Error('La cuenta o la sala de audio cambió.');
      await (liveRoom.localParticipant as unknown as {
        setCameraEnabled?: (enabled: boolean) => Promise<unknown>;
      }).setCameraEnabled?.(false);
      if (!current() || this.voiceRoom !== liveRoom) throw new Error('La cuenta o la sala de audio cambió.');
      this.voiceRoomId.set(room.id);
      this.voiceMuted.set(false);
      this.voicePhase.set('connected');
    } catch (error) {
      if (current()) {
        this.disconnectVoiceRoom();
        this.resetVoiceState();
        this.voicePhase.set('failed');
        this.voiceError.set(error instanceof Error ? error.message : 'No se pudo iniciar el chat de voz.');
      } else if (liveRoom) {
        liveRoom.removeAllListeners();
        void liveRoom.disconnect();
      }
      throw error;
    }
  }

  async toggleVoiceMute(): Promise<void> {
    const context = this.captureContext();
    const room = this.voiceRoom;
    if (!room) {
      return;
    }
    const nextMuted = !this.voiceMuted();
    await (room.localParticipant as unknown as {
      setMicrophoneEnabled: (enabled: boolean) => Promise<unknown>;
    }).setMicrophoneEnabled(!nextMuted);
    if (!this.isCurrent(context) || this.voiceRoom !== room) return;
    this.voiceMuted.set(nextMuted);
  }

  leaveVoiceChat(): void {
    this.ensureCurrentScope();
    this.voiceRevision++;
    this.disconnectVoiceRoom();
    this.resetVoiceState();
  }

  voiceMemberLabel(userId: string | null | undefined): string {
    if (!userId) {
      return 'Miembro';
    }
    if (userId === this.auth.session()?.user.id) {
      return 'Tu';
    }
    const room = this.activeRoom();
    const member = room?.members?.find((candidate) => candidate.userId === userId);
    return member ? this.memberLabel(member) : userId.slice(0, 6);
  }

  voiceMemberInitials(userId: string | null | undefined): string {
    return this.initials(this.voiceMemberLabel(userId));
  }

  voiceRoster(room: VaultRoom | null = this.activeRoom()): VaultRoomMember[] {
    const connectedIds = new Set([
      this.auth.session()?.user.id,
      ...Object.keys(this.voiceRemoteStreams()),
      ...this.voiceActiveSpeakers(),
    ].filter(Boolean) as string[]);
    return (room?.members ?? [])
      .filter((member) => member.status === 'Active' && connectedIds.has(member.userId))
      .slice(0, 8);
  }

  currentMember(room: VaultRoom | null | undefined): VaultRoomMember | null {
    const userId = this.auth.session()?.user.id;
    return room?.members?.find((member) => member.userId === userId) ?? null;
  }

  isCurrentUser(userId: string | null | undefined): boolean {
    return Boolean(userId && this.auth.session()?.user.id === userId);
  }

  canModerate(room: VaultRoom | null | undefined): boolean {
    return this.isRoomOwner(room);
  }

  isRoomOwner(room: VaultRoom | null | undefined): boolean {
    const userId = this.auth.session()?.user.id;
    return Boolean(userId && room?.owner?.id === userId);
  }

  canInviteGuests(room: VaultRoom | null | undefined): boolean {
    return this.isRoomOwner(room);
  }

  canAttemptJoin(room: VaultRoom | null | undefined): boolean {
    if (!room) {
      return false;
    }
    if (this.isRoomOwner(room)) {
      return true;
    }
    const userId = this.auth.session()?.user.id;
    if (!userId) {
      return false;
    }
    if (room.participantIds?.length && !room.participantIds.includes(userId)) {
      return false;
    }
    const member = this.currentMember(room);
    return member?.status === 'Invited' || member?.status === 'Active';
  }

  memberLabel(member: VaultRoomMember): string {
    return member.displayName || member.alias || member.userId.slice(0, 6);
  }

  messageSender(message: VaultRoomMessageVm): string {
    if (message.mine) {
      return 'Tu';
    }
    const room = this.rooms().find((candidate) => candidate.id === message.vaultRoomId);
    const member = room?.members?.find((candidate) => candidate.userId === message.senderUserId);
    return member?.displayName || member?.alias || message.senderAlias || 'Miembro';
  }

  asFile(payload: ChatPayload): FileChatPayload | null {
    if (payload.type !== 'file' && !payload['fileId'] && !payload['downloadFile']) {
      return null;
    }
    return payload as FileChatPayload;
  }

  preview(payload: ChatPayload): string {
    const file = this.asFile(payload);
    if (file) {
      return this.fileName(file);
    }
    if (payload.type === 'system') {
      return payload.text || payload.title || 'Evento Vault';
    }
    return payload.text || payload.title || 'Mensaje cifrado';
  }

  fileName(payload: FileChatPayload): string {
    return payload.fileName || 'nivra-vault.bin';
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

  isVideo(payload: FileChatPayload): boolean {
    return this.fileMime(payload).startsWith('video/');
  }

  isAudio(payload: FileChatPayload): boolean {
    return this.fileMime(payload).startsWith('audio/');
  }

  accessLabel(value?: string | null): string {
    return {
      PinOnly: 'Invitados + PIN',
      InviteOnly: 'Solo invitados',
      WaitingRoom: 'Invitados + aprobacion',
    }[value || ''] || value || 'Privado';
  }

  retentionLabel(value?: string | null): string {
    return {
      Persistent: 'Cierre manual',
      BurnOnExit: 'Se destruye al salir',
      ExpiresAfterTtl: 'Expira por tiempo',
    }[value || ''] || value || 'Temporal';
  }

  roomStatusLabel(room: VaultRoom): string {
    const status = this.currentMember(room)?.status;
    return {
      Active: 'Abierta',
      Invited: 'Invitado',
      Waiting: 'En espera',
      Left: 'Saliste',
      Rejected: 'Rechazada',
    }[status || ''] || status || 'Sin acceso';
  }

  async enablePrivacyShield(): Promise<void> {
    this.captureContext();
    await this.setPrivacyScreen(true);
  }

  async disablePrivacyShield(): Promise<void> {
    this.ensureCurrentScope();
    await this.setPrivacyScreen(false);
  }

  private async sendVaultPayload(payload: ChatPayload, kind = 'Text', fileObjectId: string | null = null,
    context = this.captureContext(), targetRoom?: VaultRoom): Promise<void> {
    this.checkContext(context);
    const room = targetRoom ?? this.activeRoom();
    if (!room) {
      throw new Error('Abre una sala Vault primero.');
    }
    const roomRevision = this.roomRevisions.get(room.id) ?? 0;
    const checkRoom = () => {
      this.checkContext(context);
      if (room.closedAt || this.pendingRoomLeaves.has(room.id) || (this.roomRevisions.get(room.id) ?? 0) !== roomRevision) throw new Error('La sala ya se cerró.');
    };
    if (room.retentionMode === 'BurnOnExit' && !room.members.some(member => member.userId !== context.userId && member.status === 'Active')) {
      throw new Error('Espera a que tu contacto entre al chat incógnito. Los mensajes temporales no se guardan para entregarlos después.');
    }
    this.sending.set(true);
    const clientMessageId = `vault-${crypto.randomUUID()}`;
    try {
      await this.realtime.joinVaultRoom(room.id);
      checkRoom();
      const recipients = await this.encryptedRecipients(room, payload, fileObjectId, context, clientMessageId);
      checkRoom();
      if (!recipients.length) {
        throw new Error('No hay llaves publicas disponibles para esta boveda.');
      }
      await this.realtime.sendVaultRoomMessage(room.id, {
        clientMessageId,
        kind,
        ...ratchetTransport(recipients),
        fileObjectId,
      });
      checkRoom();
      if (this.isCurrent(context)) {
        this.upsertMessage({
          id: clientMessageId,
          vaultRoomId: room.id,
          mine: true,
          senderUserId: context.userId,
          senderDeviceId: context.deviceId,
          senderAlias: context.alias,
          at: new Date().toISOString(),
          kind,
          payload,
          fileObjectId,
        });
      }
    } finally {
      // Vault plaintext stays in memory. Keep only the encrypted ratchet packet
      // until the realtime attempt completes, without a permanent history copy.
      if (this.isCurrent(context)) await this.ratchet.discardEphemeral(room.id, clientMessageId).catch(() => undefined);
      if (this.isCurrent(context)) this.sending.set(false);
    }
  }

  private async encryptedRecipients(room: VaultRoom, payload: ChatPayload, fileObjectId: string | null, context: VaultSessionContext, clientMessageId: string): Promise<RecipientCipherRequest[]> {
    this.checkContext(context);
    const own = await this.crypto.currentKeyMaterial(context.alias, context.deviceId); this.checkContext(context);
    const members = (room.members ?? []).filter(member => member.status === 'Active');
    const directories: PublicKeyDirectory[] = [];
    for (let offset = 0; offset < members.length; offset += 128) {
      directories.push(...await firstValueFrom(this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: members.slice(offset, offset + 128).map(member => member.userId), aliases: [] }))); this.checkContext(context);
    }
    const targets: RatchetTarget[] = [];
    for (const member of members) {
      const directory = directories.find(directory => directory.userId === member.userId);
      let published = directory?.devices.filter(device => device.keyBundle?.identityKey) ?? [];
      if (!published.length && member.userId !== context.userId) throw Error('Un miembro necesita abrir Nivra y completar la actualización del cifrado.');
      if (directory && member.userId !== context.userId) {
        const fresh={...directory,devices:published};
        const trusted=await this.injector.get(IdentityTrustService).forDelivery(JSON.stringify([context.userId, context.deviceId]), fresh,
          () => this.isCurrent(context),await this.ratchet.deviceContinuities?.(fresh) ?? []);
        published=trusted.devices;
      }
      this.checkContext(context);
      for (const device of published) {
        const publicJwk = this.crypto.parsePublicJwk(device.keyBundle.identityKey);
        if (!publicJwk || !device.deviceId) throw Error('No se pudo comprobar un dispositivo de la sala.');
        targets.push({ userId: member.userId, deviceId: device.deviceId, publicJwk });
      }
    }
    if (!targets.some(target => target.deviceId === context.deviceId)) targets.push({ userId: context.userId, deviceId: context.deviceId, publicJwk: own.publicJwk });
    const packets = await this.ratchet.encrypt(room.id, clientMessageId, payload, targets, fileObjectId, true); this.checkContext(context);
    if (!packets) throw Error('El cifrado actualizado no está disponible.');
    return packets;
  }

  private isHybridEnvelope(header?: string | null): boolean {
    try { const value = JSON.parse(header || '{}'); return value.v === 4 && value.alg === 'NIVRA-HYBRID-RATCHET-MESSAGE-1'; } catch { return false; }
  }

  private async directoriesForUsers(userIds: string[], context = this.captureContext()): Promise<Map<string, PublicKeyDirectory>> {
    this.checkContext(context);
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    const missing = uniqueIds.filter((id) => !this.directories.has(id));
    if (missing.length) {
      const directories = await firstValueFrom(
        this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: missing, aliases: [] }),
      ).catch(() => []);
      this.checkContext(context);
      for (const directory of directories ?? []) {
        this.directories.set(directory.userId, directory);
      }
    }
    return new Map(uniqueIds.map((id) => [id, this.directories.get(id)]).filter((entry): entry is [string, PublicKeyDirectory] => Boolean(entry[1])));
  }

  private async ownKeyDirectory(context = this.captureContext()): Promise<PublicKeyDirectory | null> {
    this.checkContext(context);
    if (!context.alias) {
      return null;
    }
    const cached = this.directories.get(context.userId);
    if (cached) {
      return cached;
    }
    const directory = await firstValueFrom(this.api.get<PublicKeyDirectory>(`/keys/${encodeURIComponent(context.alias)}`)).catch(() => null);
    this.checkContext(context);
    if (directory) {
      this.directories.set(directory.userId, directory);
    }
    return directory;
  }

  private async directoryForMember(member: VaultRoomMember, context = this.captureContext()): Promise<PublicKeyDirectory | null> {
    this.checkContext(context);
    if (this.directories.has(member.userId)) {
      return this.directories.get(member.userId) ?? null;
    }
    const directory = await firstValueFrom(this.api.get<PublicKeyDirectory>(`/keys/${encodeURIComponent(member.alias)}`));
    this.checkContext(context);
    this.directories.set(directory.userId, directory);
    return directory;
  }

  private async ingestRealtimeMessage(message: VaultRealtimeMessageResponse): Promise<void> {
    this.ensureCurrentScope();
    const current = this.auth.session();
    if (!current || !message?.id) {
      return;
    }
    const context = this.captureContext();
    const roomRevision = this.roomRevisions.get(message.vaultRoomId) ?? 0;
    const room = this.rooms().find(room => room.id === message.vaultRoomId);
    if (room?.retentionMode === 'BurnOnExit' && this.activeRoomId() !== room.id) return;
    if (message.senderDeviceId === current.device.id) {
      return;
    }

    const recipient = message.recipients?.find((item) => item.userId === current.user.id && item.deviceId === current.device.id)
      ?? message.recipients?.find((item) => item.userId === current.user.id);
    let payload: ChatPayload;
    let decryptError = false;
    if (recipient?.ciphertext) {
      try {
        const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
        if (!this.isCurrent(context)) return;
        if (this.isHybridEnvelope(recipient.header)) {
          payload = await this.ratchet.decrypt({ ...message, conversationId: message.vaultRoomId, serverReceivedAt: message.sentAt, deleteAfterRead: false, receipts: [] }, recipient, () => this.isCurrent(context), true);
        } else payload = await this.crypto.decryptEnvelope<ChatPayload>(own, recipient.header, recipient.ciphertext);
        if (!this.isCurrent(context)) return;
      } catch {
        if (!this.isCurrent(context)) return;
        decryptError = true;
        payload = { type: 'system', title: 'Contenido protegido', text: 'No se pudo descifrar en este dispositivo.' };
      }
    } else {
      payload = { type: 'system', text: 'Paquete cifrado no disponible para este dispositivo.' };
    }

    if (!this.isCurrent(context)) return;
    if ((this.roomRevisions.get(message.vaultRoomId) ?? 0) !== roomRevision) return;
    this.upsertMessage({
      id: message.id,
      vaultRoomId: message.vaultRoomId,
      mine: message.senderUserId === current.user.id,
      senderUserId: message.senderUserId,
      senderDeviceId: message.senderDeviceId,
      at: message.sentAt,
      kind: message.kind,
      payload,
      fileObjectId: message.fileObjectId,
      decryptError,
    });
  }

  private upsertMessage(message: VaultRoomMessageVm): void {
    this.messagesByRoom.update((state) => {
      const current = state[message.vaultRoomId] ?? [];
      const next = [...current.filter((item) => item.id !== message.id), message]
        .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
      return { ...state, [message.vaultRoomId]: next };
    });
  }

  private syncRoom(room: VaultRoom | null | undefined): void {
    this.ensureCurrentScope();
    if (!this.auth.session?.()) return;
    if (!room?.id) {
      void this.load();
      return;
    }
    if (this.pendingRoomLeaves.has(room.id)) return;
    this.rooms.update((rooms) => [room, ...rooms.filter((candidate) => candidate.id !== room.id)]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()));
  }

  private handleRoomClosedOrLeft(payload: unknown): void {
    this.ensureCurrentScope();
    if (!this.auth.session?.()) return;
    const value = payload as { roomId?: string; vaultRoomId?: string; closedAt?: string | null };
    const roomId = value?.roomId || value?.vaultRoomId;
    if (!roomId) {
      void this.load();
      return;
    }
    if (this.activeRoomId() === roomId && value.closedAt) {
      this.setActiveRoom(null);
    }
    if (value.closedAt) {
      this.clearRoomMessages(roomId);
      if (this.voiceRoomId() === roomId) {
        this.leaveVoiceChat();
      }
    }
    void this.load();
  }

  private async rejoinActiveRoom(): Promise<void> {
    this.ensureCurrentScope();
    if (!this.auth.session?.()) return;
    const context = this.captureContext();
    for (const pendingId of [...this.pendingRoomLeaves]) {
      try {
        await firstValueFrom(this.api.post(`/vault/rooms/${encodeURIComponent(pendingId)}/leave`, {}).pipe(timeout(12000)));
        if (!this.isCurrent(context)) return;
        this.pendingRoomLeaves.delete(pendingId);
      } catch { /* Keep the local tombstone until this session confirms the leave. */ }
      if (!this.isCurrent(context)) return;
    }
    const roomId = this.activeRoomId();
    const room = roomId ? this.rooms().find((candidate) => candidate.id === roomId) : null;
    if (roomId && (!room || this.currentMember(room)?.status === 'Active')) {
      this.joinedRoomId.set(null);
      try {
        await this.realtime.joinVaultRoom(roomId);
        if (this.isCurrent(context) && this.activeRoomId() === roomId) this.joinedRoomId.set(roomId);
      } catch { if (this.isCurrent(context)) await this.load(); }
      if (!this.isCurrent(context)) return;
    }
  }

  private setActiveRoom(roomId: string | null): void {
    this.ensureCurrentScope();
    const key = this.activeRoomStorageKey();
    this.activeRoomId.set(roomId);
    if (!key) return;
    const ephemeral = this.rooms().find(room => room.id === roomId)?.retentionMode === 'BurnOnExit';
    try { if (roomId && !ephemeral) localStorage.setItem(key, roomId); else localStorage.removeItem(key); }
    catch { /* Room selection is optional and never crosses account scopes. */ }
  }

  private clearRoomMessages(roomId: string): void {
    this.roomRevisions.set(roomId, (this.roomRevisions.get(roomId) ?? 0) + 1);
    const fileIds = new Set((this.messagesByRoom()[roomId] ?? []).map(message => message.fileObjectId).filter(Boolean));
    this.mediaPreviews.update(previews => {
      const next = {...previews};
      for (const id of fileIds) if (id && next[id]) { if (next[id].url) URL.revokeObjectURL(next[id].url!); delete next[id]; }
      return next;
    });
    void this.ratchet.forgetConversation(roomId).catch(() => undefined);
    this.messagesByRoom.update((state) => {
      if (!state[roomId]) {
        return state;
      }
      const next = { ...state };
      delete next[roomId];
      return next;
    });
  }

  private activeMemberIds(room: VaultRoom): string[] {
    return (room.members ?? [])
      .filter((member) => member.status === 'Active')
      .map((member) => member.userId);
  }

  private vaultFileExpiry(room: VaultRoom): string | null {
    if (room.expiresAt) {
      return room.expiresAt;
    }
    if (room.retentionMode === 'BurnOnExit') {
      return new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
    return null;
  }

  private async encryptNoteAttachments(files: File[], context: VaultSessionContext): Promise<VaultNoteAttachment[]> {
    this.checkContext(context);
    if (!files.length) {
      return [];
    }
    if (files.length > MAX_NOTE_ATTACHMENTS) {
      throw new Error(`Maximo ${MAX_NOTE_ATTACHMENTS} adjuntos por nota.`);
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_NOTE_ATTACHMENT_BYTES) {
      throw new Error(`Maximo ${this.formatBytes(MAX_NOTE_ATTACHMENT_BYTES)} por nota segura.`);
    }
    const now = new Date().toISOString();
    const attachments: VaultNoteAttachment[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.checkContext(context);
      attachments.push({
        id: `vna-${crypto.randomUUID()}`,
        name: file.name || 'archivo-vault',
        mime: file.type || 'application/octet-stream',
        size: file.size,
        dataBase64: this.crypto.b64(bytes),
        createdAt: now,
      });
    }
    return attachments;
  }

  private noteAttachmentBlob(attachment: VaultNoteAttachment): Blob {
    const bytes = this.crypto.ub64(attachment.dataBase64);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([buffer], {
      type: attachment.mime || 'application/octet-stream',
    });
  }

  private async decodeItems(items: VaultItem[], key: CryptoKey, context: VaultSessionContext): Promise<DecodedVaultItem[]> {
    this.checkContext(context);
    const decoded: DecodedVaultItem[] = [];
    for (const item of items) {
      try {
        const content = await this.crypto.decryptWithKey<NonNullable<DecodedVaultItem['decoded']>>(key, JSON.parse(item.encryptedMetadata) as { iv: string; ciphertext: string });
        this.checkContext(context);
        decoded.push({
          ...item,
          decoded: content,
        });
      } catch {
        this.checkContext(context);
        decoded.push({ ...item, decodeError: true });
      }
    }
    return decoded;
  }

  private async notifyVaultInvites(room: VaultRoom, invitedUserIds: string[], pin: string | null, context: VaultSessionContext): Promise<void> {
    this.checkContext(context);
    const current = this.auth.session();
    if (!current || !invitedUserIds.length) {
      return;
    }
    const members = invitedUserIds
      .map((userId) => room.members.find((member) => member.userId === userId))
      .filter((member): member is VaultRoomMember => Boolean(member?.userId && member.userId !== current.user.id));
    if (!members.length) {
      return;
    }

    const text = [
      `Nivra Vault: Te he invitado a mi Sala Privada "${room.name}".`,
      (room.requiresPin ?? room.accessMode !== 'InviteOnly') ? 'Usa el PIN acordado para entrar. Nivra comprueba tu invitación antes de desbloquear el contenido.' : 'Abre la invitación con tu cuenta para entrar.',
      'Los mensajes siguen las reglas de retencion de la sala.',
      `https://nivrapp-secure.vercel.app/app/vault?room=${encodeURIComponent(room.id)}`,
    ].join('\n');

    // Limit connection work; persist each encrypted invitation before sending it.
    const send = async (member: VaultRoomMember) => {
      try {
        this.checkContext(context);
        const conversation = await this.chat.createDirectConversation(this.memberAsPerson(member));
        this.checkContext(context);
        const ttlSeconds = this.ttlSecondsForRoom(room);
        if (room.expiresAt && !ttlSeconds) return;
        await this.chat.enqueueText(conversation, text, {
          ttlSeconds,
        });
        this.checkContext(context);
      } catch {
        // Best-effort E2EE invite: backend push + vault.invited still notify the member.
      }
    };
    for (let offset = 0; offset < members.length; offset += 3) {
      this.checkContext(context);
      await Promise.all(members.slice(offset, offset + 3).map(send));
    }
  }

  private invitedUserIdsFromRoom(room: VaultRoom, fallbackIds: string[]): string[] {
    const requested = new Set(fallbackIds.filter(Boolean));
    return room.members
      .filter((member) => member.status === 'Invited' && requested.has(member.userId))
      .map((member) => member.userId);
  }

  private memberAsPerson(member: VaultRoomMember): UserSummary {
    return {
      id: member.userId,
      alias: member.alias,
      displayName: member.displayName,
      phone: null,
      bio: null,
      profilePhotoDataUrl: member.profilePhotoDataUrl,
      isDiscoverable: true,
      allowStoryReposts: true,
      isContact: true,
      isMutualContact: true,
      isFavorite: false,
      friendshipState: 'contact',
    };
  }

  private ttlSecondsForRoom(room: VaultRoom): number | null {
    if (!room.expiresAt) {
      return null;
    }
    const seconds = Math.floor((new Date(room.expiresAt).getTime() - Date.now()) / 1000);
    return seconds > 0 ? seconds : null;
  }

  private addVoiceRemoteTrack(participantId: string, track: unknown): void {
    const mediaTrack = (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
    if (!participantId || !mediaTrack) {
      return;
    }
    const stream = this.voiceRemoteStreams()[participantId] ?? new MediaStream();
    if (!stream.getTracks().some((item) => item.id === mediaTrack.id)) {
      stream.addTrack(mediaTrack);
    }
    this.voiceRemoteStreams.update((items) => ({ ...items, [participantId]: stream }));
  }

  private removeVoiceRemoteTrack(participantId: string, track: unknown): void {
    const mediaTrack = (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
    if (!participantId || !mediaTrack) {
      return;
    }
    const stream = this.voiceRemoteStreams()[participantId];
    stream?.removeTrack(mediaTrack);
    if (!stream || !stream.getTracks().length) {
      this.voiceRemoteStreams.update((items) => {
        const next = { ...items };
        delete next[participantId];
        return next;
      });
    }
  }

  private disconnectVoiceRoom(): void {
    const room = this.voiceRoom;
    this.voiceRoom = null;
    if (!room) {
      return;
    }
    room.removeAllListeners();
    room.disconnect();
  }

  private resetVoiceState(): void {
    this.voiceRemoteStreams.update((streams) => {
      Object.values(streams).forEach((stream) => {
        stream.getTracks().forEach((track) => {
          track.enabled = false;
          track.stop();
        });
      });
      return {};
    });
    this.voiceActiveSpeakers.set([]);
    this.voiceRoomId.set(null);
    this.voiceMuted.set(false);
    this.voicePhase.set('idle');
  }

  private async setPrivacyScreen(enabled: boolean): Promise<void> {
    this.privacyDesired = { scope: this.sessionScope(), enabled, revision: ++this.privacyRevision };
    if (this.privacyWork) return this.privacyWork;
    const work = (async () => {
      for (;;) {
        const desired = this.privacyDesired;
        await this.applyPrivacyScreen(desired);
        if (desired.revision === this.privacyDesired.revision) return;
      }
    })().finally(() => { if (this.privacyWork === work) this.privacyWork = null; });
    this.privacyWork = work;
    return work;
  }

  private async loadPrivacyScreen(): Promise<Record<string, unknown>> {
    const loader = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;
    const module = await loader('@capacitor-community/privacy-screen');
    return (module['PrivacyScreen'] ?? module['default'] ?? module) as Record<string, unknown>;
  }

  private async applyPrivacyScreen(desired: { scope: string; enabled: boolean; revision: number }): Promise<void> {
    try {
      const privacy = await this.loadPrivacyScreen();
      if (desired.scope !== this.sessionScope() || desired.revision !== this.privacyDesired.revision) return;
      const methodNames = desired.enabled
        ? ['enable', 'preventScreenshots', 'setEnabled']
        : ['disable', 'allowScreenshots', 'setDisabled'];
      for (const name of methodNames) {
        const method = privacy[name];
        if (typeof method === 'function') {
          await (method as (value?: boolean) => Promise<unknown>).call(privacy, desired.enabled);
          return;
        }
      }
    } catch {
      // Optional native hardening. Web builds continue with CSS protections.
    }
  }

  private initials(value: string | null | undefined): string {
    return (value || 'NV')
      .split(/\s|,|-/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'NV';
  }

  private formatBytes(size: number): string {
    if (!size) {
      return '0 B';
    }
    if (size < 1024) {
      return `${size} B`;
    }
    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
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

  private loadJson<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null') as T | null;
    } catch {
      return null;
    }
  }
}
