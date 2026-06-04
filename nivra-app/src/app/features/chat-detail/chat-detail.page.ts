import { CommonModule, DatePipe } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, ViewChild, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Keyboard } from '@capacitor/keyboard';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonModal,
  IonPopover,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonToggle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  callOutline,
  checkmarkDoneOutline,
  documentAttachOutline,
  downloadOutline,
  ellipsisHorizontalOutline,
  happyOutline,
  imageOutline,
  micOutline,
  pauseCircleOutline,
  attachOutline,
  arrowRedoOutline,
  archiveOutline,
  albumsOutline,
  atOutline,
  banOutline,
  checkmarkOutline,
  chevronForwardOutline,
  closeOutline,
  createOutline,
  informationCircleOutline,
  lockOpenOutline,
  personCircleOutline,
  personAddOutline,
  playCircleOutline,
  returnDownBackOutline,
  sendOutline,
  searchOutline,
  shieldCheckmarkOutline,
  trashOutline,
  videocamOutline,
  volumeHighOutline,
} from 'ionicons/icons';
import { Subscription } from 'rxjs';
import { ChatMessageVm, Contact, Conversation, FileChatPayload, GroupSettings, MediaPreview, Participant, Story } from '../../core/models/nivra.models';
import { ChatService, MessagePolicyOptions } from '../../core/services/chat.service';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { SignalrService } from '../../core/services/signalr.service';
import { SocialService } from '../../core/services/social.service';
import { ChatMediaGalleryComponent } from './chat-media-gallery.component';

type AttachmentMode = 'media' | 'document' | 'audio';

interface PendingAttachmentPreview {
  file: File;
  url: string | null;
}

@Component({
  selector: 'app-chat-detail',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    IonButton,
    IonButtons,
    IonContent,
    IonFooter,
    IonHeader,
    IonIcon,
    IonModal,
    IonPopover,
    IonSelect,
    IonSelectOption,
    IonSpinner,
    IonTextarea,
    IonToggle,
    IonToolbar,
    ChatMediaGalleryComponent,
  ],
  templateUrl: './chat-detail.page.html',
  styleUrls: ['./chat-detail.page.scss'],
})
export class ChatDetailPage implements OnInit, OnDestroy {
  @ViewChild(IonContent) private content?: IonContent;
  readonly chat = inject(ChatService);
  readonly realtime = inject(SignalrService);
  readonly calls = inject(CallsService);
  readonly social = inject(SocialService);
  private readonly auth = inject(AuthService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toastController = inject(ToastController);
  private routeSub?: Subscription;
  private keyboardHandles: PluginListenerHandle[] = [];

  draft = '';
  sending = false;
  downloadingId: string | null = null;
  attachmentError = '';
  actionMessageId: string | null = null;
  editingMessage: ChatMessageVm | null = null;
  editDraft = '';
  forwardingMessage: ChatMessageVm | null = null;
  replyingMessage: ChatMessageVm | null = null;
  forwardQuery = '';
  selectedForwardIds = new Set<string>();
  chatMenuOpen = false;
  chatMenuEvent: Event | null = null;
  attachmentMenuOpen = false;
  attachmentMenuEvent: Event | null = null;
  pendingAttachmentMode: AttachmentMode = 'document';
  pendingAttachmentFiles: PendingAttachmentPreview[] = [];
  pendingAttachmentCaption = '';
  private pendingAttachmentDraftSeed = '';
  messageActionsOpen = false;
  messageActionEvent: Event | null = null;
  actionMessage: ChatMessageVm | null = null;
  contactInfoOpen = false;
  mediaGalleryOpen = false;
  activeAudioPreview: MediaPreview | null = null;
  activeAudioName = '';
  activeMediaPreview: MediaPreview | null = null;
  activeMediaFile: FileChatPayload | null = null;
  groupNameDraft = '';
  groupAvatarDraft: string | null = null;
  groupSettingsDraft: GroupSettings = {
    editInfo: 'admins',
    sendMessages: 'all',
    addMembers: 'admins',
  };
  groupInfoBusy = false;
  groupInfoError = '';
  groupAddOpen = false;
  selectedGroupAddIds = new Set<string>();
  emojiPanelOpen = false;
  busyAction = '';
  notice = '';
  deleteAfterRead = false;
  ttlSeconds: number | null = null;
  recordingVoice = false;
  audioState: Record<string, { current: number; duration: number; playing: boolean }> = {};
  readonly ttlOptions = [
    { label: 'Sin expirar', value: null },
    { label: '1 h', value: 3600 },
    { label: '24 h', value: 86400 },
    { label: '7 dias', value: 604800 },
  ];
  readonly conversation = computed(() => this.chat.selectedConversation());
  readonly messages = computed(() => this.chat.selectedMessages());
  private voiceRecorder: MediaRecorder | null = null;
  private voiceStream: MediaStream | null = null;
  private voiceChunks: Blob[] = [];
  private voiceStartedAt = 0;
  private messagePressTimer: number | null = null;
  readonly emojiChoices = [
    '\u{1F600}', '\u{1F602}', '\u{1F60D}', '\u{1F914}', '\u{1F62E}', '\u{1F622}',
    '\u{1F44D}', '\u2764\uFE0F', '\u{1F525}', '\u{1F389}', '\u{1F64F}', '\u{1F4AA}',
  ];
  readonly stickerChoices = ['OK', 'LOL', 'WOW', 'Nivra'];

  constructor() {
    addIcons({
      arrowBackOutline,
      callOutline,
      checkmarkDoneOutline,
      documentAttachOutline,
      downloadOutline,
      ellipsisHorizontalOutline,
      happyOutline,
      imageOutline,
      micOutline,
      pauseCircleOutline,
      attachOutline,
      arrowRedoOutline,
      archiveOutline,
      albumsOutline,
      atOutline,
      banOutline,
      checkmarkOutline,
      chevronForwardOutline,
      closeOutline,
      createOutline,
      informationCircleOutline,
      lockOpenOutline,
      personCircleOutline,
      personAddOutline,
      playCircleOutline,
      returnDownBackOutline,
      sendOutline,
      searchOutline,
      shieldCheckmarkOutline,
      trashOutline,
      videocamOutline,
      volumeHighOutline,
    });
  }

  ngOnInit(): void {
    this.routeSub = this.route.paramMap.subscribe((params) => {
      const id = params.get('conversationId');
      if (id) {
        void this.chat.selectConversation(id).then(() => this.scrollBottom());
      }
    });
    void this.bindKeyboard();
  }

  ionViewDidEnter(): void {
    window.requestAnimationFrame(() => {
      this.cdr.detectChanges();
      this.scrollBottom();
    });
  }

  ngOnDestroy(): void {
    const conversationId = this.conversation()?.id;
    if (conversationId) {
      void this.chat.sendTyping(conversationId, 'stopped', { force: true });
    }
    this.routeSub?.unsubscribe();
    this.keyboardHandles.forEach((handle) => void handle.remove());
    this.cancelMessagePress();
    this.closeAudioPreview();
    this.closeMediaViewer();
    this.clearPendingAttachments(false);
    void this.cancelVoiceNote();
    document.documentElement.style.setProperty('--keyboard-bottom', '0px');
  }

  async send(): Promise<void> {
    const conversation = this.conversation();
    if (this.editingMessage) {
      await this.submitEdit();
      return;
    }
    if (!conversation || !this.draft.trim() || this.sending) {
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = 'Solo los admins pueden enviar mensajes en este grupo.';
      return;
    }
    const text = this.draft;
    this.draft = '';
    this.sending = true;
    this.attachmentError = '';
    try {
      await this.chat.sendTyping(conversation.id, 'stopped', { force: true });
      await this.chat.sendText(conversation, text, this.currentPolicy());
      this.replyingMessage = null;
      this.emojiPanelOpen = false;
      this.scrollBottom();
    } catch (error) {
      this.draft = text;
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo enviar el mensaje.';
    } finally {
      this.sending = false;
    }
  }

  async back(): Promise<void> {
    await this.router.navigateByUrl('/app/chats');
  }

  attachFiles(event: Event, mode: AttachmentMode = 'document'): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    const conversation = this.conversation();
    if (!conversation || !files.length || this.sending) {
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = 'Solo los admins pueden enviar archivos en este grupo.';
      return;
    }

    this.attachmentError = '';
    this.pendingAttachmentMode = mode;
    this.pendingAttachmentDraftSeed = this.draft.trim();
    this.pendingAttachmentCaption = this.pendingAttachmentDraftSeed;
    this.pendingAttachmentFiles = files.map((file) => ({
      file,
      url: this.canPreviewPendingFile(file) ? URL.createObjectURL(file) : null,
    }));
  }

  async sendPendingAttachments(): Promise<void> {
    const conversation = this.conversation();
    const items = [...this.pendingAttachmentFiles];
    if (!conversation || !items.length || this.sending) {
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = 'Solo los admins pueden enviar archivos en este grupo.';
      return;
    }

    const caption = this.pendingAttachmentCaption.trim();
    const draftSeed = this.pendingAttachmentDraftSeed;
    this.attachmentError = '';
    this.sending = true;
    let lastError = '';
    let sent = 0;
    try {
      for (const [index, item] of items.entries()) {
        try {
          await this.chat.sendFile(conversation, item.file, {
            policy: this.currentPolicy(),
            mode: this.pendingAttachmentMode === 'media' ? 'media' : 'document',
            caption: index === 0 ? caption : '',
          });
          sent += 1;
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'No se pudo subir el adjunto.';
          if (this.isUploadLimitError(lastError)) {
            await this.showPremiumToast(lastError);
          }
        }
      }
      this.attachmentError = lastError;
      if (sent > 0) {
        if (draftSeed && this.draft.trim() === draftSeed) {
          this.draft = '';
          await this.chat.sendTyping(conversation.id, 'stopped', { force: true });
        }
        this.clearPendingAttachments(false);
        this.scrollBottom();
      }
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo subir el adjunto.';
    } finally {
      this.sending = false;
    }
  }

  cancelPendingAttachments(): void {
    this.clearPendingAttachments(true);
  }

  pendingAttachmentTitle(): string {
    const count = this.pendingAttachmentFiles.length;
    if (!count) {
      return 'Adjunto';
    }
    return count === 1 ? this.pendingAttachmentFiles[0].file.name : `${count} archivos`;
  }

  pendingAttachmentSubtitle(): string {
    const total = this.pendingAttachmentFiles.reduce((sum, item) => sum + item.file.size, 0);
    return `${this.formatBytes(total)} cifrado extremo a extremo`;
  }

  pendingFileSize(file: File): string {
    return this.formatBytes(file.size);
  }

  isPendingImage(file: File): boolean {
    return file.type.startsWith('image/');
  }

  isPendingVideo(file: File): boolean {
    return file.type.startsWith('video/');
  }

  async download(message: ChatMessageVm): Promise<void> {
    if (this.downloadingId) {
      return;
    }
    this.downloadingId = message.id;
    this.attachmentError = '';
    try {
      await this.chat.downloadAttachment(message.payload);
      await this.chat.markMessageOpened(message);
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo abrir el adjunto.';
    } finally {
      this.downloadingId = null;
    }
  }

  async preview(message: ChatMessageVm): Promise<void> {
    if (this.downloadingId) {
      return;
    }
    this.downloadingId = message.id;
    this.attachmentError = '';
    try {
      await this.chat.ensureMediaPreview(message.payload);
      await this.chat.markMessageOpened(message);
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo previsualizar el adjunto.';
    } finally {
      this.downloadingId = null;
    }
  }

  async openMediaItem(message: ChatMessageVm): Promise<void> {
    const file = this.chat.asFile(message.payload);
    if (!file) {
      return;
    }
    if (this.chat.isAudio(file) || file.voiceNote) {
      await this.openAudioPreview(message);
      return;
    }
    if (!this.chat.isImage(file) && !this.chat.isVideo(file)) {
      await this.preview(message);
      return;
    }
    if (this.downloadingId) {
      return;
    }

    this.downloadingId = message.id;
    this.attachmentError = '';
    try {
      const preview = await this.chat.ensureMediaPreview(message.payload);
      await this.chat.markMessageOpened(message);
      if (preview) {
        this.activeMediaPreview = preview;
        this.activeMediaFile = file;
      }
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo abrir el adjunto.';
    } finally {
      this.downloadingId = null;
    }
  }

  async openAudioPreview(message: ChatMessageVm): Promise<void> {
    const file = this.chat.asFile(message.payload);
    if (!file || this.downloadingId) {
      return;
    }

    this.downloadingId = message.id;
    this.attachmentError = '';
    try {
      const preview = await this.chat.ensureMediaPreview(message.payload);
      await this.chat.markMessageOpened(message);
      if (preview) {
        this.activeAudioPreview = preview;
        this.activeAudioName = file.voiceNote ? 'Nota de voz' : this.chat.fileName(file);
      }
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo reproducir el audio.';
    } finally {
      this.downloadingId = null;
    }
  }

  closeAudioPreview(): void {
    this.activeAudioPreview = null;
    this.activeAudioName = '';
  }

  closeMediaViewer(): void {
    this.activeMediaPreview = null;
    this.activeMediaFile = null;
  }

  async markMessageOpened(message: ChatMessageVm): Promise<void> {
    await this.chat.markMessageOpened(message);
  }

  async toggleAudio(audio: HTMLAudioElement, message: ChatMessageVm): Promise<void> {
    this.syncAudioState(message, audio);
    if (audio.paused) {
      this.pauseOtherAudio(audio);
      await this.chat.markMessageOpened(message);
      await audio.play().catch(() => undefined);
      this.markAudioPlaying(message, audio);
      return;
    }
    audio.pause();
    this.markAudioPaused(message);
  }

  markAudioPlaying(message: ChatMessageVm, audio: HTMLAudioElement): void {
    this.setAudioState(message.id, audio, true);
  }

  markAudioPaused(message: ChatMessageVm): void {
    this.audioState = {
      ...this.audioState,
      [message.id]: {
        ...(this.audioState[message.id] ?? { current: 0, duration: 0 }),
        playing: false,
      },
    };
  }

  syncAudioState(message: ChatMessageVm, audio: HTMLAudioElement): void {
    this.setAudioState(message.id, audio, !audio.paused && !audio.ended);
  }

  audioEnded(message: ChatMessageVm): void {
    this.audioState = {
      ...this.audioState,
      [message.id]: {
        ...(this.audioState[message.id] ?? { current: 0, duration: 0 }),
        current: 0,
        playing: false,
      },
    };
  }

  seekAudio(audio: HTMLAudioElement, event: Event): void {
    const input = event.target as HTMLInputElement;
    audio.currentTime = Number(input.value || 0);
  }

  isAudioPlaying(messageId: string): boolean {
    return Boolean(this.audioState[messageId]?.playing);
  }

  audioDuration(messageId: string): number {
    return Math.max(1, this.audioState[messageId]?.duration || 0);
  }

  audioCurrent(messageId: string): number {
    return this.audioState[messageId]?.current || 0;
  }

  audioTimeLabel(messageId: string): string {
    const state = this.audioState[messageId];
    return this.formatAudioTime(state?.duration || state?.current || 0);
  }

  async react(message: ChatMessageVm, emoji: string): Promise<void> {
    const conversation = this.conversation();
    if (!conversation) {
      return;
    }
    await this.chat.sendReaction(conversation, message, emoji);
    this.closeMessageActions();
  }

  toggleActions(message: ChatMessageVm, event: Event): void {
    if (this.messageActionsOpen && this.actionMessageId === message.id) {
      this.closeMessageActions();
      return;
    }
    this.openMessageActions(message, event);
  }

  openMessageActions(message: ChatMessageVm, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.actionMessage = message;
    this.actionMessageId = message.id;
    this.messageActionEvent = event ?? null;
    this.messageActionsOpen = true;
    this.closeChatMenu();
    this.emojiPanelOpen = false;
  }

  closeMessageActions(): void {
    this.messageActionsOpen = false;
    this.messageActionEvent = null;
    this.actionMessage = null;
    this.actionMessageId = null;
  }

  openChatMenu(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.chatMenuEvent = event;
    this.chatMenuOpen = true;
    this.closeMessageActions();
    this.emojiPanelOpen = false;
  }

  closeChatMenu(): void {
    this.chatMenuOpen = false;
    this.chatMenuEvent = null;
  }

  openAttachmentMenu(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.attachmentMenuEvent = event;
    this.attachmentMenuOpen = true;
    this.closeChatMenu();
    this.closeMessageActions();
    this.emojiPanelOpen = false;
  }

  closeAttachmentMenu(): void {
    this.attachmentMenuOpen = false;
    this.attachmentMenuEvent = null;
  }

  chooseAttachment(input: HTMLInputElement): void {
    this.closeAttachmentMenu();
    input.click();
  }

  openContactInfo(): void {
    const conversation = this.conversation();
    if (!conversation) {
      return;
    }
    this.prepareGroupInfoDraft(conversation);
    this.contactInfoOpen = true;
    this.closeChatMenu();
    this.closeMessageActions();
    void this.chat.hydrateConversationProfile(conversation);
    void this.social.load();
  }

  closeContactInfo(): void {
    this.contactInfoOpen = false;
  }

  openMediaGallery(): void {
    if (!this.sharedMediaMessages().length) {
      return;
    }
    this.mediaGalleryOpen = true;
  }

  closeMediaGallery(): void {
    this.mediaGalleryOpen = false;
  }

  startMessagePress(message: ChatMessageVm, event: TouchEvent): void {
    if (this.messagePressTimer !== null) {
      window.clearTimeout(this.messagePressTimer);
    }
    this.messagePressTimer = window.setTimeout(() => {
      this.openMessageActions(message, event);
      this.messagePressTimer = null;
    }, 420);
  }

  cancelMessagePress(): void {
    if (this.messagePressTimer !== null) {
      window.clearTimeout(this.messagePressTimer);
      this.messagePressTimer = null;
    }
  }

  canEdit(message: ChatMessageVm): boolean {
    return message.mine && !this.chat.asFile(message.payload) && message.payload.type !== 'system';
  }

  beginEdit(message: ChatMessageVm): void {
    if (!this.canEdit(message)) {
      return;
    }
    this.editingMessage = message;
    this.editDraft = message.payload.text || '';
    this.draft = this.editDraft;
    this.closeMessageActions();
  }

  cancelEdit(): void {
    this.editingMessage = null;
    this.editDraft = '';
    this.draft = '';
  }

  beginReply(message: ChatMessageVm): void {
    this.replyingMessage = message;
    this.closeMessageActions();
    this.closeChatMenu();
    setTimeout(() => {
      void this.content?.scrollToBottom(120);
    }, 30);
  }

  cancelReply(): void {
    this.replyingMessage = null;
  }

  async submitEdit(): Promise<void> {
    const conversation = this.conversation();
    const message = this.editingMessage;
    const text = this.draft.trim();
    if (!conversation || !message || !text || this.sending) {
      return;
    }
    this.sending = true;
    this.attachmentError = '';
    try {
      await this.chat.editMessage(conversation, message, text);
      this.cancelEdit();
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo editar el mensaje.';
    } finally {
      this.sending = false;
    }
  }

  async deleteForMe(message: ChatMessageVm): Promise<void> {
    if (!window.confirm('Eliminar este mensaje solo para ti?')) {
      return;
    }
    await this.runAction(`delete-me:${message.id}`, async () => {
      await this.chat.deleteMessage(message, false);
      this.closeMessageActions();
      this.notice = 'Mensaje eliminado para ti.';
    });
  }

  async deleteForEveryone(message: ChatMessageVm): Promise<void> {
    if (!message.mine || !window.confirm('Eliminar este mensaje para todos?')) {
      return;
    }
    await this.runAction(`delete-all:${message.id}`, async () => {
      await this.chat.deleteMessage(message, true);
      this.closeMessageActions();
      this.notice = 'Mensaje eliminado para todos.';
    });
  }

  openForward(message: ChatMessageVm): void {
    const availability = this.chat.forwardAvailability(message);
    if (!availability.ok) {
      this.attachmentError = availability.reason || 'Ese mensaje no se puede reenviar.';
      return;
    }
    this.forwardingMessage = message;
    this.forwardQuery = '';
    this.selectedForwardIds.clear();
    this.closeMessageActions();
    this.closeChatMenu();
  }

  closeForward(): void {
    this.forwardingMessage = null;
    this.forwardQuery = '';
    this.selectedForwardIds.clear();
  }

  forwardTargets(): Conversation[] {
    const message = this.forwardingMessage;
    return message ? this.chat.forwardTargets(message.conversationId, this.forwardQuery) : [];
  }

  toggleForwardTarget(conversation: Conversation): void {
    if (this.selectedForwardIds.has(conversation.id)) {
      this.selectedForwardIds.delete(conversation.id);
    } else {
      this.selectedForwardIds.add(conversation.id);
    }
  }

  async sendForward(): Promise<void> {
    const message = this.forwardingMessage;
    if (!message || !this.selectedForwardIds.size) {
      return;
    }
    await this.runAction('forward', async () => {
      const sent = await this.chat.forwardMessageToConversations(message, [...this.selectedForwardIds]);
      this.notice = sent ? `Reenviado a ${sent} chat${sent === 1 ? '' : 's'}.` : 'No se pudo reenviar.';
      this.closeForward();
    });
  }

  async clearChat(scope: 'me' | 'everyone'): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !window.confirm(scope === 'everyone' ? 'Vaciar este chat para todos?' : 'Vaciar este chat solo para ti?')) {
      return;
    }
    await this.runAction(`clear:${scope}`, async () => {
      await this.chat.clearConversation(conversation, scope);
      this.closeChatMenu();
      this.notice = scope === 'everyone' ? 'Chat vaciado para todos.' : 'Chat vaciado para ti.';
    });
  }

  async deleteChat(scope: 'me' | 'everyone'): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !window.confirm(scope === 'everyone' ? 'Eliminar este chat para todos?' : 'Eliminar este chat solo para ti?')) {
      return;
    }
    await this.runAction(`delete-chat:${scope}`, async () => {
      await this.chat.deleteConversation(conversation, scope);
      this.closeChatMenu();
      await this.router.navigateByUrl('/app/chats');
    });
  }

  async toggleArchive(): Promise<void> {
    const conversation = this.conversation();
    if (!conversation) {
      return;
    }
    const archived = !this.chat.isConversationArchived(conversation.id);
    await this.runAction(`archive:${conversation.id}`, async () => {
      await this.chat.setConversationArchived(conversation, archived);
      this.closeChatMenu();
      this.notice = archived ? 'Chat archivado en este dispositivo.' : 'Chat desarchivado.';
    });
  }

  async toggleBlock(): Promise<void> {
    const conversation = this.conversation();
    if (!conversation) {
      return;
    }
    const blocked = !this.chat.isConversationBlocked(conversation.id);
    await this.runAction(`block:${conversation.id}`, async () => {
      await this.chat.setConversationBlocked(conversation, blocked);
      this.closeChatMenu();
      this.notice = blocked ? 'Chat bloqueado en este dispositivo.' : 'Chat desbloqueado.';
    });
  }

  async startCall(type: 'Voice' | 'Video'): Promise<void> {
    const conversation = this.conversation();
    if (!conversation) {
      return;
    }
    const currentUserId = this.auth.session()?.user.id;
    const participantUserIds = conversation.participants
      .filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
      .map((participant) => participant.userId);
    await this.calls.start(type, conversation.id, participantUserIds);
    await this.router.navigateByUrl('/app/calls');
  }

  async joinGroupCall(): Promise<void> {
    const room = this.calls.activeGroupRoomForConversation(this.conversation()?.id);
    if (!room) {
      return;
    }
    await this.calls.joinGroupRoom(room);
    await this.router.navigateByUrl('/app/calls');
  }

  async toggleVoiceNote(): Promise<void> {
    if (this.recordingVoice) {
      await this.stopVoiceNote();
      return;
    }
    await this.startVoiceNote();
  }

  async startVoiceNote(): Promise<void> {
    if (this.recordingVoice || this.sending) {
      return;
    }
    const conversation = this.conversation();
    if (!conversation || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.attachmentError = 'Este dispositivo no permite grabar audio desde la app.';
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = 'Solo los admins pueden enviar notas de voz en este grupo.';
      return;
    }
    this.attachmentError = '';
    try {
      this.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mimeType = this.supportedVoiceMimeType();
      this.voiceRecorder = mimeType
        ? new MediaRecorder(this.voiceStream, { mimeType })
        : new MediaRecorder(this.voiceStream);
      this.voiceChunks = [];
      this.voiceStartedAt = Date.now();
      this.voiceRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.voiceChunks.push(event.data);
        }
      };
      this.voiceRecorder.start();
      this.recordingVoice = true;
    } catch (error) {
      this.cleanupVoiceRecorder();
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo abrir el microfono.';
    }
  }

  async stopVoiceNote(): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !this.voiceRecorder) {
      await this.cancelVoiceNote();
      return;
    }
    const file = await this.stopVoiceCapture(true);
    if (!file) {
      return;
    }
    this.sending = true;
    try {
      await this.chat.sendFile(conversation, file, { voiceNote: true, policy: this.currentPolicy(), mode: 'document' });
      this.scrollBottom();
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo enviar la nota de voz.';
    } finally {
      this.sending = false;
    }
  }

  async cancelVoiceNote(): Promise<void> {
    await this.stopVoiceCapture(false);
  }

  onDraftInput(): void {
    const conversationId = this.conversation()?.id;
    if (!conversationId) {
      return;
    }
    if (this.draft.trim()) {
      void this.chat.sendTyping(conversationId, 'typing');
    } else {
      void this.chat.sendTyping(conversationId, 'stopped', { force: true });
    }
  }

  appendEmoji(value: string): void {
    this.draft = `${this.draft}${value}`;
    this.onDraftInput();
  }

  async sendSticker(value: string): Promise<void> {
    if (this.sending) {
      return;
    }
    this.draft = this.draft.trim() ? `${this.draft.trim()} ${value}` : value;
    this.emojiPanelOpen = false;
    await this.send();
  }

  reactions(message: ChatMessageVm): string[] {
    const reactions = message.payload.reactions ?? [];
    return [...new Set(reactions.map((reaction) => reaction.emoji).filter(Boolean))].slice(0, 4);
  }

  forwardedLabel(message: ChatMessageVm): string {
    const value = message.payload.forwardedFrom;
    if (typeof value === 'object' && value !== null && 'senderAlias' in value) {
      return `Reenviado de ${String((value as { senderAlias?: unknown }).senderAlias || 'Nivra')}`;
    }
    return value ? 'Reenviado' : '';
  }

  replyPreview(message: ChatMessageVm | null): string {
    return message ? this.chat.preview(message.payload) : '';
  }

  replyChipLabel(message: ChatMessageVm): string {
    const reply = message.payload.replyTo as { kind?: unknown; preview?: unknown; mediaMime?: unknown } | null | undefined;
    if (reply?.kind === 'story') {
      const preview = typeof reply.preview === 'string' && reply.preview.trim()
        ? reply.preview.trim()
        : typeof reply.mediaMime === 'string' && reply.mediaMime
          ? reply.mediaMime
          : 'Instantanea';
      return `Historia: ${preview}`;
    }
    return 'Respuesta cifrada';
  }

  replyReference(message: ChatMessageVm | null): unknown {
    if (!message) {
      return null;
    }
    return {
      messageId: message.id,
      senderUserId: message.senderUserId,
      at: message.at,
      preview: this.chat.preview(message.payload).slice(0, 120),
    };
  }

  isBlocked(): boolean {
    return this.chat.isConversationBlocked(this.conversation()?.id);
  }

  isArchived(): boolean {
    return this.chat.isConversationArchived(this.conversation()?.id);
  }

  conversationPhoto(): string {
    return this.chat.conversationPhoto(this.conversation());
  }

  conversationAlias(): string {
    return this.chat.conversationAlias(this.conversation());
  }

  conversationPhone(): string {
    return this.chat.conversationPhone(this.conversation());
  }

  conversationBio(): string {
    return this.chat.conversationBio(this.conversation());
  }

  isGroupConversation(): boolean {
    return this.chat.isGroup(this.conversation());
  }

  canEditGroup(): boolean {
    return this.chat.canEditGroup(this.conversation());
  }

  canSendMessages(): boolean {
    return this.chat.canSendToConversation(this.conversation());
  }

  canAddGroupMembers(): boolean {
    return this.chat.canAddGroupMembers(this.conversation());
  }

  isCurrentUserGroupAdmin(): boolean {
    return this.chat.isGroupAdmin(this.conversation());
  }

  isGroupAdmin(userId: string | null | undefined): boolean {
    return this.chat.isGroupAdmin(this.conversation(), userId || undefined);
  }

  groupParticipants(): Participant[] {
    return (this.conversation()?.participants ?? []).filter((participant) => !participant.removedAt);
  }

  participantLabel(participant: Participant): string {
    return this.chat.participantDisplayName(participant.userId, participant);
  }

  participantSubtitle(participant: Participant): string {
    const role = this.isGroupAdmin(participant.userId) ? 'Admin' : 'Miembro';
    const alias = this.chat.participantAlias(participant.userId, participant);
    const phone = participant.phone || '';
    return [role, alias || phone].filter(Boolean).join(' - ');
  }

  participantPhoto(participant: Participant): string {
    return this.chat.participantPhoto(participant.userId, participant);
  }

  participantInitials(participant: Participant): string {
    return this.participantLabel(participant)
      .split(/\s|,|-/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'N';
  }

  async onGroupAvatarSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) {
      return;
    }
    this.groupInfoError = '';
    try {
      this.groupAvatarDraft = await this.fileToDataUrl(file);
    } catch {
      this.groupInfoError = 'No se pudo cargar la foto del grupo.';
    }
  }

  async saveGroupInfo(): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !this.canEditGroup()) {
      return;
    }
    await this.runGroupInfoAction(async () => {
      await this.chat.updateGroupInfo(conversation, {
        groupName: this.groupNameDraft.trim(),
        groupAvatar: this.groupAvatarDraft,
      });
      this.notice = 'Grupo actualizado.';
      this.prepareGroupInfoDraft(this.conversation() ?? conversation);
    });
  }

  async updateGroupSetting(key: keyof GroupSettings, value: GroupSettings[keyof GroupSettings]): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !this.isCurrentUserGroupAdmin()) {
      return;
    }
    const next: GroupSettings = {
      ...this.groupSettingsDraft,
      [key]: value,
    };
    this.groupSettingsDraft = next;
    await this.runGroupInfoAction(async () => {
      await this.chat.updateGroupSettings(conversation, next);
      this.prepareGroupInfoDraft(this.conversation() ?? conversation);
    });
  }

  async toggleParticipantAdmin(participant: Participant): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !this.isCurrentUserGroupAdmin()) {
      return;
    }
    const nextAdmin = !this.isGroupAdmin(participant.userId);
    await this.runGroupInfoAction(async () => {
      await this.chat.setGroupParticipantAdmin(conversation, participant.userId, nextAdmin);
      this.prepareGroupInfoDraft(this.conversation() ?? conversation);
    });
  }

  activeGroupStories(): Story[] {
    return this.social.activeStoriesForGroup(this.conversation()?.id);
  }

  async openGroupStory(story: Story): Promise<void> {
    await this.social.viewStory(story);
  }

  availableGroupContacts(): Contact[] {
    const currentIds = new Set(this.groupParticipants().map((participant) => participant.userId));
    return this.chat.contacts()
      .filter((contact) => !currentIds.has(contact.userId))
      .sort((left, right) => (left.displayName || left.alias).localeCompare(right.displayName || right.alias));
  }

  toggleGroupAddContact(contact: Contact): void {
    if (this.selectedGroupAddIds.has(contact.userId)) {
      this.selectedGroupAddIds.delete(contact.userId);
    } else {
      this.selectedGroupAddIds.add(contact.userId);
    }
  }

  async addSelectedGroupParticipants(): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !this.selectedGroupAddIds.size) {
      return;
    }
    await this.runGroupInfoAction(async () => {
      await this.chat.addGroupParticipants(conversation, [...this.selectedGroupAddIds]);
      this.selectedGroupAddIds.clear();
      this.groupAddOpen = false;
      this.notice = 'Participantes agregados.';
      this.prepareGroupInfoDraft(this.conversation() ?? conversation);
    });
  }

  sharedMediaMessages(): ChatMessageVm[] {
    return this.messages()
      .filter((message) => {
        const file = this.chat.asFile(message.payload);
        return Boolean(file && (
          this.chat.isImage(file) ||
          this.chat.isVideo(file) ||
          this.chat.isAudio(file) ||
          file.voiceNote
        ));
      })
      .reverse();
  }

  private scrollBottom(): void {
    setTimeout(() => {
      void this.content?.scrollToBottom(220);
    }, 40);
  }

  private clearPendingAttachments(restoreDraft: boolean): void {
    this.pendingAttachmentFiles.forEach((item) => {
      if (item.url) {
        URL.revokeObjectURL(item.url);
      }
    });
    if (restoreDraft && this.pendingAttachmentDraftSeed && !this.draft.trim()) {
      this.draft = this.pendingAttachmentDraftSeed;
    }
    this.pendingAttachmentFiles = [];
    this.pendingAttachmentMode = 'document';
    this.pendingAttachmentCaption = '';
    this.pendingAttachmentDraftSeed = '';
  }

  private canPreviewPendingFile(file: File): boolean {
    return file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/');
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  }

  private pauseOtherAudio(active: HTMLAudioElement): void {
    document.querySelectorAll<HTMLAudioElement>('audio.voice-source').forEach((audio) => {
      if (audio !== active && !audio.paused) {
        audio.pause();
      }
    });
  }

  private setAudioState(messageId: string, audio: HTMLAudioElement, playing: boolean): void {
    this.audioState = {
      ...this.audioState,
      [messageId]: {
        current: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        playing,
      },
    };
  }

  private formatAudioTime(secondsValue: number): string {
    const total = Math.max(0, Math.floor(secondsValue || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private async bindKeyboard(): Promise<void> {
    try {
      const show = await Keyboard.addListener('keyboardWillShow', (info) => {
        document.documentElement.style.setProperty('--keyboard-bottom', `${info.keyboardHeight}px`);
        this.scrollBottom();
      });
      const hide = await Keyboard.addListener('keyboardWillHide', () => {
        document.documentElement.style.setProperty('--keyboard-bottom', '0px');
        this.scrollBottom();
      });
      this.keyboardHandles = [show, hide];
    } catch {
      this.keyboardHandles = [];
    }
  }

  private isUploadLimitError(message: string): boolean {
    return message.includes('limite robusto de cifrado local');
  }

  private async showPremiumToast(message: string): Promise<void> {
    const toast = await this.toastController.create({
      message,
      duration: 3200,
      position: 'bottom',
      cssClass: 'nivra-premium-toast',
    });
    await toast.present();
  }

  private currentPolicy(): MessagePolicyOptions {
    const ttlSeconds = Number(this.ttlSeconds || 0);
    return {
      deleteAfterRead: this.deleteAfterRead,
      ttlSeconds: ttlSeconds > 0 ? ttlSeconds : null,
      replyTo: this.replyReference(this.replyingMessage),
    };
  }

  private prepareGroupInfoDraft(conversation: Conversation): void {
    if (!this.chat.isGroup(conversation)) {
      this.groupInfoError = '';
      this.selectedGroupAddIds.clear();
      this.groupAddOpen = false;
      return;
    }
    this.groupNameDraft = this.chat.conversationTitle(conversation);
    this.groupAvatarDraft = this.chat.conversationPhoto(conversation) || null;
    this.groupSettingsDraft = {
      editInfo: conversation.settings?.editInfo === 'all' ? 'all' : 'admins',
      sendMessages: conversation.settings?.sendMessages === 'admins' ? 'admins' : 'all',
      addMembers: conversation.settings?.addMembers === 'all' ? 'all' : 'admins',
    };
    this.groupInfoError = '';
    this.selectedGroupAddIds.clear();
  }

  private async runGroupInfoAction(action: () => Promise<void>): Promise<void> {
    if (this.groupInfoBusy) {
      return;
    }
    this.groupInfoBusy = true;
    this.groupInfoError = '';
    try {
      await action();
    } catch (error) {
      this.groupInfoError = error instanceof Error ? error.message : 'No se pudo actualizar el grupo.';
    } finally {
      this.groupInfoBusy = false;
    }
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private stopVoiceCapture(send: boolean): Promise<File | null> {
    const recorder = this.voiceRecorder;
    if (!recorder) {
      this.cleanupVoiceRecorder();
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const mime = recorder.mimeType || this.supportedVoiceMimeType() || 'audio/webm';
        const chunks = [...this.voiceChunks];
        const durationMs = Math.max(0, Date.now() - this.voiceStartedAt);
        this.cleanupVoiceRecorder();
        if (!send || !chunks.length) {
          resolve(null);
          return;
        }
        const blob = new Blob(chunks, { type: mime });
        const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        resolve(new File([blob], `nivra-voice-${Math.max(1, Math.round(durationMs / 1000))}s.${extension}`, { type: mime }));
      };
      if (recorder.state === 'inactive') {
        recorder.onstop(new Event('stop'));
      } else {
        recorder.stop();
      }
    });
  }

  private cleanupVoiceRecorder(): void {
    this.voiceRecorder = null;
    this.voiceStream?.getTracks().forEach((track) => track.stop());
    this.voiceStream = null;
    this.voiceChunks = [];
    this.voiceStartedAt = 0;
    this.recordingVoice = false;
  }

  private supportedVoiceMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
  }

  private async runAction(id: string, action: () => Promise<void>): Promise<void> {
    this.busyAction = id;
    this.attachmentError = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo completar la accion.';
    } finally {
      this.busyAction = '';
    }
  }
}
