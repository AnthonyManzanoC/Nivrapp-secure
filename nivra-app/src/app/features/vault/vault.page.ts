import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea, LoadingController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addCircleOutline,
  attachOutline,
  closeOutline,
  checkmarkCircleOutline,
  cloudDownloadOutline,
  contractOutline,
  documentAttachOutline,
  enterOutline,
  expandOutline,
  headsetOutline,
  keyOutline,
  linkOutline,
  lockClosedOutline,
  logOutOutline,
  micOffOutline,
  micOutline,
  peopleOutline,
  playCircleOutline,
  refreshOutline,
  searchOutline,
  sendOutline,
  shieldCheckmarkOutline,
  trashOutline,
} from 'ionicons/icons';
import { DecodedVaultItem, FileChatPayload, UserSummary, VaultNoteAttachment, VaultRoom, VaultRoomMember, VaultRoomMessageVm } from '../../core/models/nivra.models';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { DeviceWipeService } from '../../core/services/device-wipe.service';
import { AuthService } from '../../core/services/auth.service';
import { PanicPinService } from '../../core/services/panic-pin.service';
import { VaultService } from '../../core/services/vault.service';
import { MediaStreamDirective } from '../../shared/media-stream.directive';

@Component({
  selector: 'app-vault',
  standalone: true,
  imports: [LocalizedDatePipe, CommonModule, FormsModule, TranslatePipe, IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea, MediaStreamDirective],
  templateUrl: './vault.page.html',
  styleUrls: ['./vault.page.scss'],
})
export class VaultPage implements OnInit, OnDestroy {
  readonly vault = inject(VaultService);
  private readonly translate = inject(TranslateService);
  private readonly deviceWipe = inject(DeviceWipeService);
  private readonly auth = inject(AuthService);
  private readonly mountedSession = this.auth.session();
  private readonly mountedGeneration = this.auth.sessionGeneration();
  private readonly panicPin = inject(PanicPinService);
  private readonly loadingController = inject(LoadingController);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  pin = '';
  title = '';
  body = '';
  noteAttachments: File[] = [];
  roomName = '';
  roomPin = '';
  roomAccessMode = 'PinOnly';
  retentionMode = 'Persistent';
  inviteQuery = '';
  roomMessage = '';
  busyId = '';
  error = '';
  notice = '';
  pendingInviteCode = '';
  pendingInvitePin = '';
  roomPinById: Record<string, string> = {};
  selectedInviteIds = new Set<string>();
  isFullscreen = false;
  private searchTimer: number | null = null;
  private destroyed = false;
  private readonly fullscreenChangeHandler = () => this.syncFullscreenState();

  constructor() {
    addIcons({
      addCircleOutline,
      attachOutline,
      closeOutline,
      checkmarkCircleOutline,
      cloudDownloadOutline,
      contractOutline,
      documentAttachOutline,
      enterOutline,
      expandOutline,
      headsetOutline,
      keyOutline,
      linkOutline,
      lockClosedOutline,
      logOutOutline,
      micOffOutline,
      micOutline,
      peopleOutline,
      playCircleOutline,
      refreshOutline,
      searchOutline,
      sendOutline,
      shieldCheckmarkOutline,
      trashOutline,
    });
  }

  async ngOnInit(): Promise<void> {
    if (!this.isCurrentPage()) return;
    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    try {
      await this.vault.enablePrivacyShield();
      if (!this.isCurrentPage()) return;
      await this.vault.load();
      if (!this.isCurrentPage()) return;
      await this.acceptIncomingInvite();
    } catch (error) { if (this.isCurrentPage()) throw error; }
  }

  ngOnDestroy(): void {
    const ownsScope = this.ownsMountedScope();
    this.destroyed = true;
    document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
    }
    if (ownsScope) {
      void this.exitVaultFullscreen();
      void this.vault.disablePrivacyShield();
    }
  }

  async unlock(): Promise<void> {
    const session = this.auth.session();
    if (!session) return;
    const scope = { userId: session.user.id, deviceId: session.device.id };
    const generation = this.auth.sessionGeneration();
    const isCurrent = () => !this.destroyed && this.auth.sessionGeneration() === generation
      && this.auth.session()?.user.id === scope.userId && this.auth.session()?.device.id === scope.deviceId;
    await this.run('unlock', async () => {
      const enteredPin = this.pin;
      const isPanicPin = await this.panicPin.matches(enteredPin);
      if (!isCurrent()) return;
      if (isPanicPin) {
        await this.triggerPanicWipe(scope, isCurrent);
        return;
      }
      await this.vault.unlock(enteredPin);
      if (!isCurrent()) return;
      this.pin = '';
      this.notice = this.tr('VAULT.NOTICE_UNLOCKED', 'Boveda desbloqueada.');
    });
  }

  async createNote(): Promise<void> {
    await this.run('note', async isCurrent => {
      await this.vault.createNote(this.title || 'Nota privada', this.body, this.noteAttachments);
      if (!isCurrent()) return;
      this.title = '';
      this.body = '';
      this.noteAttachments = [];
      this.notice = this.tr('VAULT.NOTICE_NOTE_SAVED', 'Nota cifrada guardada.');
    });
  }

  noteFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (!files.length) {
      return;
    }
    const map = new Map(this.noteAttachments.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]));
    for (const file of files) {
      map.set(`${file.name}:${file.size}:${file.lastModified}`, file);
    }
    this.noteAttachments = [...map.values()].slice(0, 8);
  }

  removeNoteAttachment(file: File): void {
    this.noteAttachments = this.noteAttachments.filter((item) => item !== file);
  }

  async createRoom(): Promise<void> {
    await this.run('room:create', async isCurrent => {
      const room = await this.vault.createRoom({
        name: this.roomName || 'Boveda Nivra',
        pin: this.roomPin,
        accessMode: this.roomAccessMode,
        retentionMode: this.retentionMode,
        invitedUserIds: [...this.selectedInviteIds],
        ttlSeconds: 3600,
      });
      if (!isCurrent()) return;
      this.roomName = '';
      this.roomPin = '';
      this.inviteQuery = '';
      this.selectedInviteIds.clear();
      this.vault.people.set([]);
      this.notice = `${this.tr('VAULT.NOTICE_ROOM_READY', 'Sala')} ${room.name} ${this.tr('VAULT.NOTICE_READY', 'lista')}.`;
    });
  }

  async deleteItem(id: string): Promise<void> {
    await this.run(`item:${id}`, () => this.vault.deleteItem(id));
  }

  searchInvites(): void {
    if (!this.isCurrentPage()) return;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
    }
    this.searchTimer = window.setTimeout(() => {
      if (this.isCurrentPage()) void this.vault.searchPeople(this.inviteQuery);
    }, 280);
  }

  toggleInvite(person: UserSummary, room: VaultRoom | null = null): void {
    if (this.vault.isCurrentUser(person.id) || this.isRoomParticipant(room, person.id)) {
      return;
    }
    if (this.selectedInviteIds.has(person.id)) {
      this.selectedInviteIds.delete(person.id);
    } else {
      this.selectedInviteIds.add(person.id);
    }
  }

  inviteSelected(person: UserSummary): boolean {
    return this.selectedInviteIds.has(person.id);
  }

  async openRoom(room: VaultRoom): Promise<void> {
    if (this.vault.currentMember(room)?.status === 'Active') {
      await this.run(`room:${room.id}`, async isCurrent => {
        await this.vault.selectRoom(room.id);
        if (!isCurrent()) return;
        this.notice = this.tr('VAULT.NOTICE_ROOM_OPENED', 'Sala Vault abierta.');
      });
      return;
    }
    await this.joinRoom(room);
  }

  async joinRoom(room: VaultRoom): Promise<void> {
    await this.run(`join:${room.id}`, async isCurrent => {
      const joined = await this.vault.joinRoom(room, this.roomPinById[room.id] || null);
      if (!isCurrent()) return;
      const member = this.vault.currentMember(joined);
      this.roomPinById[room.id] = '';
      this.notice = member?.status === 'Waiting' ? this.tr('VAULT.NOTICE_REQUEST_SENT_OWNER', 'Solicitud enviada al propietario.') : this.tr('VAULT.NOTICE_OPENED', 'Boveda abierta.');
    });
  }

  async leaveRoom(room: VaultRoom): Promise<void> {
    await this.run(`leave:${room.id}`, async isCurrent => {
      if (this.isFullscreen && this.vault.activeRoomId() === room.id) {
        await this.exitVaultFullscreen();
        if (!isCurrent()) return;
      }
      await this.vault.leaveRoom(room.id);
      if (!isCurrent()) return;
      this.notice = this.tr('VAULT.NOTICE_LEFT_ROOM', 'Saliste de la sala.');
    });
  }

  async toggleVaultFullscreen(): Promise<void> {
    await this.run('vault:fullscreen', async () => {
      if (this.isFullscreen) {
        await this.exitVaultFullscreen();
        return;
      }
      await this.enterVaultFullscreen();
    });
  }

  async inviteActiveRoom(): Promise<void> {
    const room = this.vault.activeRoom();
    if (!room) {
      return;
    }
    if (!this.vault.canInviteGuests(room)) {
      this.error = this.tr('VAULT.ERROR_OWNER_INVITES', 'Solo el dueno de la sala puede agregar invitados.');
      return;
    }
    await this.run(`invite:${room.id}`, async isCurrent => {
      await this.vault.inviteUsers(room.id, [...this.selectedInviteIds]);
      if (!isCurrent()) return;
      this.selectedInviteIds.clear();
      this.inviteQuery = '';
      this.vault.people.set([]);
      this.notice = this.tr('VAULT.NOTICE_INVITES_SENT', 'Invitaciones enviadas.');
    });
  }

  async shareRoomInvite(room: VaultRoom): Promise<void> {
    await this.run(`share:${room.id}`, async isCurrent => {
      const invite = await this.vault.createInviteLink(room, {
        ttlSeconds: 24 * 60 * 60,
        maxUses: 1,
        requireApproval: room.accessMode === 'WaitingRoom',
      });
      if (!isCurrent()) return;
      const text = this.vault.inviteShareText(room, invite);
      await this.shareText(text, invite.acceptUrl);
      if (!isCurrent()) return;
      this.notice = this.tr('VAULT.NOTICE_INVITE_READY', 'Invitacion Vault lista.');
    });
  }

  async acceptPendingInvite(): Promise<void> {
    if (!this.pendingInviteCode) {
      return;
    }
    await this.run('invite:accept', async isCurrent => {
      const room = await this.vault.acceptInviteCode(this.pendingInviteCode, this.pendingInvitePin);
      if (!isCurrent()) return;
      this.pendingInviteCode = '';
      this.pendingInvitePin = '';
      await this.clearInviteQuery();
      if (!isCurrent()) return;
      const member = this.vault.currentMember(room);
      this.notice = member?.status === 'Waiting' ? this.tr('VAULT.NOTICE_REQUEST_SENT_OWNER', 'Solicitud enviada al propietario.') : this.tr('VAULT.NOTICE_ROOM_ADDED', 'Sala Vault agregada.');
    });
  }

  async approve(room: VaultRoom, member: VaultRoomMember): Promise<void> {
    await this.run(`approve:${member.userId}`, async isCurrent => {
      await this.vault.approveMember(room.id, member.userId);
      if (!isCurrent()) return;
      this.notice = this.tr('VAULT.NOTICE_ACCESS_APPROVED', 'Acceso aprobado.');
    });
  }

  async sendMessage(): Promise<void> {
    await this.run('vault:send', async isCurrent => {
      await this.vault.sendRoomText(this.roomMessage);
      if (!isCurrent()) return;
      this.roomMessage = '';
    });
  }

  async fileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) {
      return;
    }
    await this.run('vault:file', async isCurrent => {
      await this.vault.sendRoomFile(file);
      if (!isCurrent()) return;
      this.notice = this.tr('VAULT.NOTICE_FILE_SENT', 'Archivo cifrado enviado.');
    });
  }

  async previewFile(payload: FileChatPayload): Promise<void> {
    await this.run(`preview:${payload.fileId || payload.downloadFile || ''}`, () => this.vault.ensureMediaPreview(payload).then(() => undefined));
  }

  async downloadFile(payload: FileChatPayload): Promise<void> {
    await this.run(`download:${payload.fileId || payload.downloadFile || ''}`, () => this.vault.downloadAttachment(payload));
  }

  async previewNoteAttachment(item: DecodedVaultItem, attachment: VaultNoteAttachment): Promise<void> {
    await this.run(`note-preview:${attachment.id}`, () => this.vault.ensureNoteAttachmentPreview(item, attachment).then(() => undefined));
  }

  async downloadNoteAttachment(item: DecodedVaultItem, attachment: VaultNoteAttachment): Promise<void> {
    await this.run(`note-download:${attachment.id}`, () => this.vault.downloadNoteAttachment(item, attachment));
  }

  async startVoice(room: VaultRoom): Promise<void> {
    await this.run(`voice:${room.id}`, async isCurrent => {
      await this.vault.startVoiceChat(room);
      if (!isCurrent()) return;
      this.notice = this.tr('VAULT.NOTICE_VOICE_ACTIVE', 'Chat de voz activo.');
    });
  }

  async toggleVoiceMute(): Promise<void> {
    await this.run('voice:mute', () => this.vault.toggleVoiceMute());
  }

  leaveVoice(): void {
    if (!this.isCurrentPage()) return;
    this.vault.leaveVoiceChat();
    this.notice = this.tr('VAULT.NOTICE_LEFT_VOICE', 'Saliste del chat de voz.');
  }

  fullscreenLabel(): string {
    return this.isFullscreen ? 'Restablecer' : 'Pantalla completa';
  }

  messageFile(message: VaultRoomMessageVm): FileChatPayload | null {
    return this.vault.asFile(message.payload);
  }

  initials(room: VaultRoom): string {
    return room.name.split(/\s|-/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'NV';
  }

  activeMembers(room: VaultRoom | null): VaultRoomMember[] {
    return (room?.members ?? []).filter((member) => member.status === 'Active');
  }

  availableInvitePeople(room: VaultRoom | null): UserSummary[] {
    return this.vault.people().filter((person) => !this.vault.isCurrentUser(person.id) && !this.isRoomParticipant(room, person.id));
  }

  selectedNoteAttachmentSize(): string {
    const total = this.noteAttachments.reduce((sum, file) => sum + file.size, 0);
    if (!total) {
      return 'Sin adjuntos';
    }
    if (total < 1024 * 1024) {
      return `${(total / 1024).toFixed(1)} KB`;
    }
    return `${(total / 1024 / 1024).toFixed(1)} MB`;
  }

  waitingMembers(room: VaultRoom | null): VaultRoomMember[] {
    return (room?.members ?? []).filter((member) => member.status === 'Waiting');
  }

  isBusy(id: string): boolean {
    return this.busyId === id;
  }

  private ownsMountedScope(): boolean {
    return Boolean(this.mountedSession && this.auth.sessionGeneration() === this.mountedGeneration
      && this.auth.session()?.user.id === this.mountedSession.user.id
      && this.auth.session()?.device.id === this.mountedSession.device.id);
  }

  private isCurrentPage(): boolean { return !this.destroyed && this.ownsMountedScope(); }

  private async run(id: string, action: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const isCurrent = () => this.isCurrentPage();
    if (!isCurrent()) return;
    this.busyId = id;
    this.error = '';
    this.notice = '';
    try {
      await action(isCurrent);
    } catch (error) {
      if (isCurrent()) this.error = error instanceof Error ? error.message : this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la accion.');
    } finally {
      if (isCurrent()) this.busyId = '';
    }
  }

  private async acceptIncomingInvite(): Promise<void> {
    if (!this.isCurrentPage()) return;
    const code = this.route.snapshot.queryParamMap.get('invite')?.trim() ?? '';
    if (!code) {
      return;
    }
    this.pendingInviteCode = code;
    try {
      await this.acceptPendingInvite();
    } catch {
      // run() captures UI errors; keep the code visible so the user can add a PIN.
    }
  }

  private async shareText(text: string, url: string): Promise<void> {
    if (!this.isCurrentPage()) return;
    const share = navigator as Navigator & {
      share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
      clipboard?: Clipboard;
    };
    if (share.share) {
      await share.share({ title: 'Nivra Vault', text, url }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(text);
  }

  private async enterVaultFullscreen(): Promise<void> {
    if (Capacitor.getPlatform() === 'web') {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      this.isFullscreen = true;
      return;
    }

    await StatusBar.hide().catch(() => undefined);
    this.isFullscreen = true;
  }

  private async exitVaultFullscreen(): Promise<void> {
    if (Capacitor.getPlatform() === 'web') {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen().catch(() => undefined);
      }
      this.isFullscreen = false;
      return;
    }

    await StatusBar.show().catch(() => undefined);
    this.isFullscreen = false;
  }

  private syncFullscreenState(): void {
    if (Capacitor.getPlatform() === 'web') {
      this.isFullscreen = Boolean(document.fullscreenElement);
    }
  }

  private async clearInviteQuery(): Promise<void> {
    if (!this.isCurrentPage()) return;
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { invite: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }

  private async triggerPanicWipe(scope: { userId: string; deviceId: string }, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) return;
    this.error = '';
    this.notice = this.tr('VAULT.UNLOCKING', 'Desbloqueando...');
    const loading = await this.loadingController.create({
      message: this.tr('VAULT.UNLOCKING', 'Desbloqueando...'),
      spinner: 'crescent',
      backdropDismiss: false,
    });
    try {
      if (!isCurrent()) return;
      await loading.present();
      if (!isCurrent()) return;
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      if (!isCurrent()) return;
      await this.deviceWipe.wipeAccount(scope, 'PANIC_PIN');
    } finally {
      await loading.dismiss().catch(() => undefined);
    }
  }

  private isRoomParticipant(room: VaultRoom | null, userId: string): boolean {
    if (!room) {
      return false;
    }
    return (room.members ?? []).some((member) =>
      member.userId === userId &&
      member.status !== 'Left' &&
      member.status !== 'Rejected');
  }
}
