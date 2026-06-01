import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
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
  VaultItem,
  VaultRealtimeMessageResponse,
  VaultRoom,
  VaultRoomMember,
  VaultRoomMessageVm,
} from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

const VAULT_META_PREFIX = 'nivra.vault.';
const MAX_VAULT_FILE_BYTES = 50 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly directories = new Map<string, PublicKeyDirectory>();
  private key: CryptoKey | null = null;

  readonly unlocked = signal(false);
  readonly items = signal<DecodedVaultItem[]>([]);
  readonly rooms = signal<VaultRoom[]>([]);
  readonly messagesByRoom = signal<Record<string, VaultRoomMessageVm[]>>({});
  readonly mediaPreviews = signal<Record<string, MediaPreview>>({});
  readonly people = signal<UserSummary[]>([]);
  readonly activeRoomId = signal<string | null>(localStorage.getItem('nivra.activeVaultRoomId'));
  readonly loading = signal(false);
  readonly sending = signal(false);
  readonly uploading = signal(false);

  readonly activeRoom = computed(() => {
    const id = this.activeRoomId();
    return id ? this.rooms().find((room) => room.id === id) ?? null : null;
  });
  readonly activeMessages = computed(() => {
    const id = this.activeRoomId();
    return id ? this.messagesByRoom()[id] ?? [] : [];
  });

  constructor() {
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
      if (event.type === 'reconnected') {
        void this.rejoinActiveRoom();
      }
    });

    effect(() => {
      if (this.auth.isAuthenticated()) {
        untracked(() => {
          void this.load();
          void this.rejoinActiveRoom();
        });
      }
    });
  }

  async load(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }
    this.loading.set(true);
    try {
      const [items, rooms] = await Promise.all([
        firstValueFrom(this.api.get<VaultItem[]>('/vault/items')).catch(() => []),
        firstValueFrom(this.api.get<VaultRoom[]>('/vault/rooms')).catch(() => []),
      ]);
      this.rooms.set(rooms);
      this.items.set(this.key ? await this.decodeItems(items) : items.map((item) => ({ ...item })));
      const activeId = this.activeRoomId();
      if (activeId && !rooms.some((room) => room.id === activeId && this.currentMember(room)?.status === 'Active')) {
        this.setActiveRoom(null);
      }
    } finally {
      this.loading.set(false);
    }
  }

  async unlock(pin: string): Promise<void> {
    const userId = this.auth.session()?.user.id;
    if (!userId) {
      throw new Error('Sesion no disponible.');
    }
    const metaKey = `${VAULT_META_PREFIX}${userId}`;
    const existing = this.loadJson<{ salt: string; verifier: { iv: string; ciphertext: string } }>(metaKey);
    if (!existing) {
      const salt = this.crypto.randomBytes(16);
      const key = await this.crypto.deriveVaultKey(pin, salt);
      const verifier = await this.crypto.encryptWithKey(key, { ok: true, createdAt: new Date().toISOString() });
      localStorage.setItem(metaKey, JSON.stringify({ salt: this.crypto.b64(salt), verifier }));
      this.key = key;
    } else {
      const key = await this.crypto.deriveVaultKey(pin, this.crypto.ub64(existing.salt));
      await this.crypto.decryptWithKey(key, existing.verifier);
      this.key = key;
    }
    this.unlocked.set(true);
    await this.load();
  }

  lock(): void {
    this.key = null;
    this.unlocked.set(false);
    this.items.update((items) => items.map(({ decoded: _decoded, decodeError: _decodeError, ...item }) => ({ ...item })));
  }

  async createNote(title: string, body: string): Promise<void> {
    if (!this.key) {
      throw new Error('Desbloquea la boveda primero.');
    }
    const encryptedMetadata = JSON.stringify(await this.crypto.encryptWithKey(this.key, { title, body }));
    await firstValueFrom(this.api.post('/vault/items', {
      kind: 'Note',
      encryptedMetadata,
      parentId: null,
      fileObjectId: null,
    }));
    await this.load();
  }

  async deleteItem(itemId: string): Promise<void> {
    await firstValueFrom(this.api.delete(`/vault/items/${encodeURIComponent(itemId)}`));
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
  }): Promise<VaultRoom> {
    const room = await firstValueFrom(this.api.post<VaultRoom>('/vault/rooms', {
      name: options.name,
      pin: options.pin || null,
      accessMode: options.accessMode || (options.pin ? 'PinOnly' : 'InviteOnly'),
      retentionMode: options.retentionMode,
      encryptedWelcome: options.encryptedWelcome || null,
      invitedUserIds: options.invitedUserIds ?? [],
      ttlSeconds: options.retentionMode === 'ExpiresAfterTtl' ? options.ttlSeconds ?? 3600 : null,
    }));
    this.syncRoom(room);
    if (this.currentMember(room)?.status === 'Active') {
      await this.selectRoom(room.id);
    }
    return room;
  }

  async joinRoom(room: VaultRoom, pin?: string | null): Promise<VaultRoom> {
    const joined = await firstValueFrom(this.api.post<VaultRoom>(`/vault/rooms/${encodeURIComponent(room.id)}/join`, {
      pin: pin || null,
    }));
    this.syncRoom(joined);
    if (this.currentMember(joined)?.status === 'Active') {
      await this.selectRoom(joined.id);
    }
    return joined;
  }

  async selectRoom(roomId: string): Promise<void> {
    const room = this.rooms().find((candidate) => candidate.id === roomId);
    if (!room || this.currentMember(room)?.status !== 'Active') {
      throw new Error('Debes entrar a la sala primero.');
    }
    this.setActiveRoom(roomId);
    await this.realtime.joinVaultRoom(roomId);
    this.messagesByRoom.update((state) => ({ ...state, [roomId]: state[roomId] ?? [] }));
  }

  async leaveRoom(roomId: string): Promise<void> {
    await firstValueFrom(this.api.post(`/vault/rooms/${encodeURIComponent(roomId)}/leave`, {}));
    if (this.activeRoomId() === roomId) {
      this.setActiveRoom(null);
    }
    this.rooms.update((rooms) => rooms.filter((room) => room.id !== roomId));
  }

  async inviteUsers(roomId: string, userIds: string[]): Promise<VaultRoom> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) {
      throw new Error('Selecciona al menos un contacto.');
    }
    const room = await firstValueFrom(this.api.post<VaultRoom>(`/vault/rooms/${encodeURIComponent(roomId)}/invite`, {
      userIds: ids,
    }));
    this.syncRoom(room);
    return room;
  }

  async approveMember(roomId: string, memberUserId: string): Promise<VaultRoom> {
    const room = await firstValueFrom(
      this.api.post<VaultRoom>(`/vault/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberUserId)}/approve`, {}),
    );
    this.syncRoom(room);
    return room;
  }

  async searchPeople(query: string): Promise<UserSummary[]> {
    const value = query.trim();
    if (value.length < 2) {
      this.people.set([]);
      return [];
    }
    const response = await firstValueFrom(this.api.get<DirectorySearchResponse>(`/directory/search?q=${encodeURIComponent(value)}`));
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
    const room = this.activeRoom();
    if (!room) {
      throw new Error('Abre una sala Vault primero.');
    }
    if (file.size > MAX_VAULT_FILE_BYTES) {
      throw new Error('Maximo 50 MB por archivo cifrado.');
    }

    this.uploading.set(true);
    try {
      const encrypted = await this.crypto.encryptAttachment(await file.arrayBuffer());
      const mime = file.type || 'application/octet-stream';
      const fileRecord = await firstValueFrom(this.api.post<FileResponse>('/files', {
        encryptedSize: encrypted.bytes.byteLength,
        mimeTypeCiphertext: this.crypto.b64(new TextEncoder().encode(mime)),
        clientSha256: null,
        allowedUserIds: this.activeMemberIds(room),
        expiresAt: this.vaultFileExpiry(room),
        vaultRoomId: room.id,
      }));
      await firstValueFrom(this.api.putRaw<FileResponse>(`/files/${encodeURIComponent(fileRecord.id)}/blob`, encrypted.bytes));
      this.rememberMediaPreview(fileRecord.id, file, mime, file.name);
      await this.sendVaultPayload({
        type: 'file',
        fileId: fileRecord.id,
        fileName: file.name,
        mime,
        size: file.size,
        fileKey: encrypted.key,
        fileIv: encrypted.iv,
      }, this.fileKind(file), fileRecord.id);
    } finally {
      this.uploading.set(false);
    }
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

  currentMember(room: VaultRoom | null | undefined): VaultRoomMember | null {
    const userId = this.auth.session()?.user.id;
    return room?.members?.find((member) => member.userId === userId) ?? null;
  }

  canModerate(room: VaultRoom | null | undefined): boolean {
    return this.currentMember(room)?.role === 'Owner';
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
      PinOnly: 'PIN requerido',
      InviteOnly: 'Solo invitados',
      WaitingRoom: 'Lobby con aprobacion',
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

  private async sendVaultPayload(payload: ChatPayload, kind = 'Text', fileObjectId: string | null = null): Promise<void> {
    const room = this.activeRoom();
    if (!room) {
      throw new Error('Abre una sala Vault primero.');
    }
    this.sending.set(true);
    try {
      await this.realtime.joinVaultRoom(room.id);
      const recipients = await this.encryptedRecipients(room, payload, fileObjectId);
      if (!recipients.length) {
        throw new Error('No hay llaves publicas disponibles para esta boveda.');
      }
      const current = this.auth.session();
      const clientMessageId = `vault-${crypto.randomUUID()}`;
      await this.realtime.sendVaultRoomMessage(room.id, {
        clientMessageId,
        kind,
        recipients,
        fileObjectId,
      });
      if (current) {
        this.upsertMessage({
          id: clientMessageId,
          vaultRoomId: room.id,
          mine: true,
          senderUserId: current.user.id,
          senderDeviceId: current.device.id,
          senderAlias: current.user.alias,
          at: new Date().toISOString(),
          kind,
          payload,
          fileObjectId,
        });
      }
    } finally {
      this.sending.set(false);
    }
  }

  private async encryptedRecipients(
    room: VaultRoom,
    payload: ChatPayload,
    fileObjectId: string | null = null,
  ): Promise<RecipientCipherRequest[]> {
    const current = this.auth.session();
    if (!current) {
      return [];
    }
    const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const recipients: RecipientCipherRequest[] = [];
    const activeMembers = (room.members ?? []).filter((member) => member.status === 'Active');
    const directories = await this.directoriesForUsers(activeMembers.map((member) => member.userId));

    for (const member of activeMembers) {
      const directory = member.userId === current.user.id
        ? await this.ownKeyDirectory()
        : directories.get(member.userId) ?? await this.directoryForMember(member).catch(() => null);
      const usedDeviceIds = new Set<string>();

      for (const device of directory?.devices ?? []) {
        const publicKey = this.crypto.parsePublicJwk(device.keyBundle?.identityKey);
        if (!device.deviceId || !publicKey || usedDeviceIds.has(device.deviceId)) {
          continue;
        }
        const sealed = await this.crypto.encryptForPublicKey(own, publicKey, payload);
        recipients.push({
          userId: member.userId,
          deviceId: device.deviceId,
          ciphertext: sealed.ciphertext,
          header: sealed.header,
          fileObjectId,
        });
        usedDeviceIds.add(device.deviceId);
      }

      if (member.userId === current.user.id && !usedDeviceIds.has(current.device.id)) {
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
    const session = this.auth.session();
    if (!session?.user.alias) {
      return null;
    }
    const cached = this.directories.get(session.user.id);
    if (cached) {
      return cached;
    }
    const directory = await firstValueFrom(this.api.get<PublicKeyDirectory>(`/keys/${encodeURIComponent(session.user.alias)}`)).catch(() => null);
    if (directory) {
      this.directories.set(directory.userId, directory);
    }
    return directory;
  }

  private async directoryForMember(member: VaultRoomMember): Promise<PublicKeyDirectory | null> {
    if (this.directories.has(member.userId)) {
      return this.directories.get(member.userId) ?? null;
    }
    const directory = await firstValueFrom(this.api.get<PublicKeyDirectory>(`/keys/${encodeURIComponent(member.alias)}`));
    this.directories.set(directory.userId, directory);
    return directory;
  }

  private async ingestRealtimeMessage(message: VaultRealtimeMessageResponse): Promise<void> {
    const current = this.auth.session();
    if (!current || !message?.id) {
      return;
    }
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
        payload = await this.crypto.decryptEnvelope<ChatPayload>(own, recipient.header, recipient.ciphertext);
      } catch {
        decryptError = true;
        payload = { type: 'system', title: 'Contenido protegido', text: 'No se pudo descifrar en este dispositivo.' };
      }
    } else {
      payload = { type: 'system', text: 'Paquete cifrado no disponible para este dispositivo.' };
    }

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
    if (!room?.id) {
      void this.load();
      return;
    }
    this.rooms.update((rooms) => [room, ...rooms.filter((candidate) => candidate.id !== room.id)]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()));
  }

  private handleRoomClosedOrLeft(payload: unknown): void {
    const value = payload as { roomId?: string; vaultRoomId?: string; closedAt?: string | null };
    const roomId = value?.roomId || value?.vaultRoomId;
    if (!roomId) {
      void this.load();
      return;
    }
    if (this.activeRoomId() === roomId && value.closedAt) {
      this.setActiveRoom(null);
    }
    void this.load();
  }

  private async rejoinActiveRoom(): Promise<void> {
    const roomId = this.activeRoomId();
    const room = roomId ? this.rooms().find((candidate) => candidate.id === roomId) : null;
    if (roomId && (!room || this.currentMember(room)?.status === 'Active')) {
      await this.realtime.joinVaultRoom(roomId).catch(() => undefined);
    }
  }

  private setActiveRoom(roomId: string | null): void {
    this.activeRoomId.set(roomId);
    if (roomId) {
      localStorage.setItem('nivra.activeVaultRoomId', roomId);
    } else {
      localStorage.removeItem('nivra.activeVaultRoomId');
    }
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

  private async decodeItems(items: VaultItem[]): Promise<DecodedVaultItem[]> {
    if (!this.key) {
      return items;
    }
    const decoded: DecodedVaultItem[] = [];
    for (const item of items) {
      try {
        decoded.push({
          ...item,
          decoded: await this.crypto.decryptWithKey(this.key, JSON.parse(item.encryptedMetadata) as { iv: string; ciphertext: string }),
        });
      } catch {
        decoded.push({ ...item, decodeError: true });
      }
    }
    return decoded;
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
