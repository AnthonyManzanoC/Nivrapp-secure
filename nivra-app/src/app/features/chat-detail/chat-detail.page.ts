import { CommonModule, DatePipe } from '@angular/common';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Keyboard } from '@capacitor/keyboard';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  ActionSheetController,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonModal,
  IonPopover,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonToggle,
  IonToolbar,
  GestureController,
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
  cameraOutline,
  checkmarkOutline,
  chevronForwardOutline,
  closeOutline,
  createOutline,
  informationCircleOutline,
  languageOutline,
  lockClosedOutline,
  lockOpenOutline,
  logOutOutline,
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
import { ChatMessageVm, Contact, Conversation, DeliveryReceipt, FileChatPayload, GroupSettings, MediaPreview, MessageReaction, Participant, Story } from '../../core/models/nivra.models';
import { ChatService, MessagePolicyOptions } from '../../core/services/chat.service';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { SignalrService } from '../../core/services/signalr.service';
import { SocialService } from '../../core/services/social.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { NativeDeviceService, type RaiseGestureEvent } from '../../core/services/native-device.service';
import { PerformanceModeService } from '../../core/services/performance-mode.service';
import { PrivacyEnforcementService } from '../../core/services/privacy-enforcement.service';
import { ChatMediaGalleryComponent } from './chat-media-gallery.component';

type AttachmentMode = 'media' | 'document' | 'audio';

interface PendingAttachmentPreview {
  file: File;
  url: string | null;
}

type VoiceComposerMode = 'idle' | 'holding' | 'locked' | 'cancelling';

type QuotedReplyKind = 'text' | 'image' | 'video' | 'audio' | 'file' | 'story' | 'unavailable';

interface ReplyReferenceVm {
  messageId?: string;
  senderUserId?: string;
  preview?: string;
  kind?: string;
  mediaMime?: string;
}

interface QuotedReplyVm {
  messageId: string;
  found: boolean;
  senderName: string;
  isMine: boolean;
  kind: QuotedReplyKind;
  snippet: string;
  thumbnailUrl: string | null;
  fallbackText: string;
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
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonModal,
    IonPopover,
    IonSelect,
    IonSelectOption,
    IonSpinner,
    IonTextarea,
    IonToggle,
    IonToolbar,
    TranslatePipe,
    ChatMediaGalleryComponent,
  ],
  templateUrl: './chat-detail.page.html',
  styleUrls: ['./chat-detail.page.scss'],
})
export class ChatDetailPage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(IonContent) private content?: IonContent;
  @ViewChild('micButton', { read: ElementRef }) private micButton?: ElementRef<HTMLElement>;
  readonly chat = inject(ChatService);
  readonly appSettings = inject(AppSettingsService);
  readonly realtime = inject(SignalrService);
  readonly calls = inject(CallsService);
  readonly social = inject(SocialService);
  readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly gestureController = inject(GestureController);
  private readonly toastController = inject(ToastController);
  private readonly actionSheetController = inject(ActionSheetController);
  private readonly nativeDevice = inject(NativeDeviceService);
  private readonly performanceMode = inject(PerformanceModeService);
  private readonly privacyEnforcement = inject(PrivacyEnforcementService);
  private routeSub?: Subscription;
  private keyboardHandles: PluginListenerHandle[] = [];
  private raiseGestureHandle: PluginListenerHandle | null = null;
  private micGesture?: ReturnType<GestureController['create']>;
  private initialScrollRequestId = 0;
  private initialScrollDoneForConversation = '';
  private initialScrollTimers: number[] = [];
  initialUnreadMessageId: string | null = null;

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
  reactionViewerMessage: ChatMessageVm | null = null;
  messageInfoMessage: ChatMessageVm | null = null;
  quotedReplies: Record<string, QuotedReplyVm> = {};
  contactInfoOpen = false;
  profilePhotoViewerUrl = '';
  profilePhotoViewerTitle = '';
  mediaGalleryOpen = false;
  activeAudioPreview: MediaPreview | null = null;
  activeAudioName = '';
  activeMediaPreview: MediaPreview | null = null;
  activeMediaFile: FileChatPayload | null = null;
  activeMediaMessage: ChatMessageVm | null = null;
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
  ttlSeconds = -1;
  recordingVoice = false;
  voiceMode: VoiceComposerMode = 'idle';
  voiceElapsedSeconds = 0;
  voicePaused = false;
  voiceSlideX = 0;
  audioState: Record<string, { current: number; duration: number; playing: boolean }> = {};
  readonly ttlOptions = [
    { label: 'Predeterminado', labelKey: 'CHAT.TTL_DEFAULT', value: -1 },
    { label: 'Sin expirar', labelKey: 'CHAT.TTL_NONE', value: 0 },
    { label: '1 h', labelKey: 'COMMON.1_HOUR_SHORT', value: 3600 },
    { label: '24 h', labelKey: 'COMMON.24_HOURS_SHORT', value: 86400 },
    { label: '7 dias', labelKey: 'COMMON.7_DAYS', value: 604800 },
  ];
  readonly conversation = computed(() => this.chat.selectedConversation());
  readonly messages = computed(() => this.chat.selectedMessages());
  private voiceRecorder: MediaRecorder | null = null;
  private voiceStream: MediaStream | null = null;
  private voiceChunks: Blob[] = [];
  private voiceStartedAt = 0;
  private voicePauseStartedAt = 0;
  private voicePausedDurationMs = 0;
  private voiceTimer: number | null = null;
  private voiceStartPromise: Promise<void> | null = null;
  private messagePressTimer: number | null = null;
  private readonly quotedReplyCache = new Map<string, QuotedReplyVm>();
  private readonly quotedReplyLoads = new Set<string>();
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
      cameraOutline,
      checkmarkOutline,
      chevronForwardOutline,
      closeOutline,
      createOutline,
      informationCircleOutline,
      languageOutline,
      lockClosedOutline,
      lockOpenOutline,
      logOutOutline,
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

    effect(() => {
      const conversation = this.conversation();
      untracked(() => this.privacyEnforcement.setActiveConversation(conversation));
    });

    effect(() => {
      const conversationId = this.conversation()?.id ?? '';
      const messages = this.messages();
      untracked(() => this.refreshQuotedReplies(conversationId, messages));
    });
  }

  ngOnInit(): void {
    this.routeSub = this.route.paramMap.subscribe((params) => {
      const id = params.get('conversationId');
      if (id) {
        const requestId = ++this.initialScrollRequestId;
        void this.chat.selectConversation(id).then(() => {
          if (requestId === this.initialScrollRequestId) {
            this.scheduleInitialScroll(id, { force: true });
          }
        });
      }
    });
    void this.bindKeyboard();
    void this.bindRaiseGestures();
    queueMicrotask(() => this.cdr.detectChanges());
  }

  ngAfterViewInit(): void {
    this.bindVoiceGesture();
    window.requestAnimationFrame(() => {
      this.bindVoiceGesture();
      this.cdr.detectChanges();
    });
  }

  ionViewDidEnter(): void {
    window.requestAnimationFrame(() => {
      this.cdr.detectChanges();
      this.scheduleInitialScroll(this.conversation()?.id);
    });
  }

  async loadOlderMessages(event: Event): Promise<void> {
    const infinite = event.target as HTMLIonInfiniteScrollElement | null;
    const conversationId = this.conversation()?.id;
    if (!conversationId) {
      await infinite?.complete();
      return;
    }
    const scrollElement = await this.content?.getScrollElement().catch(() => null);
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const previousTop = scrollElement?.scrollTop ?? 0;
    try {
      await this.chat.loadOlderMessages(conversationId);
      this.cdr.detectChanges();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (scrollElement && previousHeight > 0) {
        const delta = scrollElement.scrollHeight - previousHeight;
        await this.content?.scrollToPoint(0, previousTop + Math.max(0, delta), 0);
      }
    } finally {
      await infinite?.complete();
    }
  }

  ngOnDestroy(): void {
    const conversationId = this.conversation()?.id;
    if (conversationId) {
      void this.chat.sendTyping(conversationId, 'stopped', { force: true });
    }
    this.routeSub?.unsubscribe();
    this.keyboardHandles.forEach((handle) => void handle.remove());
    void this.raiseGestureHandle?.remove();
    this.micGesture?.destroy();
    this.clearInitialScrollTimers();
    this.cancelMessagePress();
    this.closeAudioPreview();
    this.closeMediaViewer();
    this.privacyEnforcement.clearActiveConversation(conversationId);
    this.clearPendingAttachments(false);
    this.stopVoiceTimer();
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
      this.attachmentError = this.tr('CHAT.ADMINS_ONLY_MESSAGES', 'Solo los admins pueden enviar mensajes en este grupo.');
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
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_SEND_MESSAGE', 'No se pudo enviar el mensaje.');
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
      this.attachmentError = this.tr('CHAT.ADMINS_ONLY_FILES', 'Solo los admins pueden enviar archivos en este grupo.');
      return;
    }

    this.attachmentError = '';
    this.preparePendingAttachments(files, mode);
  }

  @HostListener('paste', ['$event'])
  handlePaste(event: ClipboardEvent): void {
    const files = this.clipboardImageFiles(event);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const conversation = this.conversation();
    if (!conversation || this.sending || this.chat.uploading() || this.voiceComposerActive()) {
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = this.tr('CHAT.ADMINS_ONLY_FILES', 'Solo los admins pueden enviar archivos en este grupo.');
      return;
    }

    this.attachmentError = '';
    this.notice = '';
    this.closeAttachmentMenu();
    this.closeChatMenu();
    this.closeMessageActions();
    this.emojiPanelOpen = false;
    this.preparePendingAttachments(files, 'media');
    this.cdr.detectChanges();
  }

  async sendPendingAttachments(): Promise<void> {
    const conversation = this.conversation();
    const items = [...this.pendingAttachmentFiles];
    if (!conversation || !items.length || this.sending) {
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = this.tr('CHAT.ADMINS_ONLY_FILES', 'Solo los admins pueden enviar archivos en este grupo.');
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
          lastError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_UPLOAD_ATTACHMENT', 'No se pudo subir el adjunto.');
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
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_UPLOAD_ATTACHMENT', 'No se pudo subir el adjunto.');
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
      return this.tr('CHAT.ATTACHMENT', 'Adjunto');
    }
    return count === 1 ? this.pendingAttachmentFiles[0].file.name : `${count} ${this.tr('COMMON.FILES', 'archivos')}`;
  }

  pendingAttachmentSubtitle(): string {
    const total = this.pendingAttachmentFiles.reduce((sum, item) => sum + item.file.size, 0);
    return `${this.formatBytes(total)} ${this.tr('COMMON.E2EE_ENCRYPTED', 'cifrado extremo a extremo')}`;
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
      await this.chat.downloadAttachment(message.payload, this.conversation());
      await this.chat.markMessageOpened(message);
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_OPEN_ATTACHMENT', 'No se pudo abrir el adjunto.');
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
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_PREVIEW_ATTACHMENT', 'No se pudo previsualizar el adjunto.');
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
        this.activeMediaMessage = message;
      }
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_OPEN_ATTACHMENT', 'No se pudo abrir el adjunto.');
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
        this.activeAudioName = file.voiceNote ? this.tr('CHAT.VOICE_NOTE', 'Nota de voz') : this.chat.fileName(file);
      }
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_PLAY_AUDIO', 'No se pudo reproducir el audio.');
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
    this.activeMediaMessage = null;
  }

  async downloadActiveMedia(): Promise<void> {
    if (this.activeMediaMessage) {
      await this.download(this.activeMediaMessage);
    }
  }

  async markMessageOpened(message: ChatMessageVm): Promise<void> {
    await this.chat.markMessageOpened(message);
  }

  async toggleAudio(audio: HTMLAudioElement, message: ChatMessageVm): Promise<void> {
    this.syncAudioState(message, audio);
    if (audio.paused) {
      if (this.appSettings.settings().pauseMediaOnPlayback) {
        await this.nativeDevice.setAudioFocus(true, 'playback');
        this.pauseAmbientMedia(audio);
      } else {
        this.pauseOtherAudio(audio);
      }
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
    void this.nativeDevice.setAudioFocus(false, 'playback');
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
    void this.nativeDevice.setAudioFocus(false, 'playback');
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

  async openMessageActionSheet(message: ChatMessageVm): Promise<void> {
    this.actionMessage = message;
    this.actionMessageId = message.id;
    this.messageActionsOpen = false;
    this.messageActionEvent = null;
    this.closeChatMenu();
    this.emojiPanelOpen = false;
    const buttons = [
      {
        text: this.tr('CHAT_ACTIONS.REPLY', 'Responder'),
        icon: 'return-down-back-outline',
        handler: () => this.beginReply(message),
      },
      ...(this.canTranslate(message) ? [{
        text: this.tr('CHAT_ACTIONS.TRANSLATE', 'Traducir'),
        icon: 'language-outline',
        handler: () => {
          void this.translateMessage(message);
        },
      }] : []),
      ...(this.canEdit(message) ? [{
        text: this.tr('CHAT_ACTIONS.EDIT', 'Editar'),
        icon: 'create-outline',
        handler: () => this.beginEdit(message),
      }] : []),
      ...(this.canForward(message) ? [{
        text: this.tr('CHAT_ACTIONS.FORWARD', 'Reenviar'),
        icon: 'arrow-redo-outline',
        handler: () => this.openForward(message),
      }] : []),
      ...(this.canShowMessageInfo(message) ? [{
        text: this.tr('CHAT_ACTIONS.MESSAGE_INFO', 'Info. del mensaje'),
        icon: 'information-circle-outline',
        handler: () => this.openMessageInfo(message),
      }] : []),
      {
        text: this.tr('CHAT.DELETE_FOR_ME', 'Eliminar para mi'),
        icon: 'trash-outline',
        role: 'destructive',
        handler: () => {
          void this.deleteForMe(message);
        },
      },
      ...(message.mine ? [{
        text: this.tr('CHAT.DELETE_FOR_EVERYONE', 'Eliminar para todos'),
        icon: 'trash-outline',
        role: 'destructive',
        handler: () => {
          void this.deleteForEveryone(message);
        },
      }] : []),
      {
        text: this.tr('COMMON.CANCEL', 'Cancelar'),
        role: 'cancel',
      },
    ];
    const sheet = await this.actionSheetController.create({
      header: this.tr('CHAT.MESSAGE', 'Mensaje'),
      cssClass: 'nivra-message-action-sheet',
      buttons,
    });
    sheet.onDidDismiss().then(() => {
      if (this.actionMessageId === message.id && !this.messageActionsOpen && !this.reactionViewerMessage && !this.messageInfoMessage) {
        this.actionMessage = null;
        this.actionMessageId = null;
      }
    });
    await sheet.present();
  }

  closeMessageActions(): void {
    this.messageActionsOpen = false;
    this.messageActionEvent = null;
    this.actionMessage = null;
    this.actionMessageId = null;
  }

  openReactionViewer(message: ChatMessageVm, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!message.payload.reactions?.length) {
      return;
    }
    this.reactionViewerMessage = message;
    this.closeMessageActions();
  }

  closeReactionViewer(): void {
    this.reactionViewerMessage = null;
  }

  openMessageInfo(message: ChatMessageVm): void {
    if (!this.canShowMessageInfo(message)) {
      return;
    }
    this.messageInfoMessage = message;
    this.closeMessageActions();
  }

  closeMessageInfo(): void {
    this.messageInfoMessage = null;
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

  async openCameraMenu(photoInput: HTMLInputElement, videoInput: HTMLInputElement, event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.sending || this.chat.uploading() || !this.canSendMessages()) {
      return;
    }
    this.closeAttachmentMenu();
    this.closeChatMenu();
    this.closeMessageActions();
    const sheet = await this.actionSheetController.create({
      header: this.tr('COMMON.CAMERA', 'Camara'),
      cssClass: 'nivra-camera-sheet',
      buttons: [
        {
          text: this.tr('CHAT.TAKE_PHOTO', 'Tomar foto'),
          icon: 'camera-outline',
          handler: () => {
            void this.captureNativePhotoOrFallback(photoInput);
          },
        },
        {
          text: this.tr('CHAT.RECORD_VIDEO', 'Grabar video'),
          icon: 'videocam-outline',
          handler: () => {
            videoInput.click();
          },
        },
        {
          text: this.tr('COMMON.CANCEL', 'Cancelar'),
          role: 'cancel',
        },
      ],
    });
    await sheet.present();
  }

  captureCameraFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file) {
      void this.sendCameraCapture(file);
    }
  }

  private async captureNativePhotoOrFallback(input: HTMLInputElement): Promise<void> {
    const file = await this.captureNativePhoto().catch(() => null);
    if (file) {
      await this.sendCameraCapture(file);
      return;
    }
    input.click();
  }

  private async captureNativePhoto(): Promise<File | null> {
    let photo: { webPath?: string; path?: string; format?: string };
    try {
      photo = await Camera.getPhoto({
        quality: 86,
        allowEditing: false,
        saveToGallery: false,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
      });
    } catch {
      return null;
    }
    const source = photo.webPath || photo.path;
    if (!source) {
      return null;
    }
    const response = await fetch(source);
    const blob = await response.blob();
    const format = (photo.format || blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const mime = blob.type || `image/${format === 'jpg' ? 'jpeg' : format}`;
    return new File([blob], `nivra-camera-${Date.now()}.${format}`, { type: mime });
  }

  private async sendCameraCapture(file: File): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || this.sending) {
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = this.tr('CHAT.ADMINS_ONLY_FILES', 'Solo los admins pueden enviar archivos en este grupo.');
      return;
    }
    this.attachmentError = '';
    this.sending = true;
    try {
      await this.chat.sendFile(conversation, file, {
        policy: this.currentPolicy(),
        mode: 'media',
      });
      this.scrollBottom();
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_SEND_CAPTURE', 'No se pudo enviar la captura.');
    } finally {
      this.sending = false;
    }
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

  openProfilePhotoViewer(event?: Event, photoUrl = this.conversationPhoto()): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!photoUrl) {
      return;
    }
    this.profilePhotoViewerUrl = photoUrl;
    this.profilePhotoViewerTitle = this.conversation() ? this.chat.conversationTitle(this.conversation()!) : this.tr('COMMON.CONTACT', 'Contacto');
  }

  closeProfilePhotoViewer(): void {
    this.profilePhotoViewerUrl = '';
    this.profilePhotoViewerTitle = '';
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
    event.stopPropagation();
    if (this.messagePressTimer !== null) {
      window.clearTimeout(this.messagePressTimer);
    }
    this.messagePressTimer = window.setTimeout(() => {
      void this.openMessageActionSheet(message);
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

  canForward(message: ChatMessageVm | null | undefined): boolean {
    return this.chat.forwardAvailability(message).ok;
  }

  canShowMessageInfo(message: ChatMessageVm | null | undefined): boolean {
    return Boolean(message?.mine);
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
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_EDIT_MESSAGE', 'No se pudo editar el mensaje.');
    } finally {
      this.sending = false;
    }
  }

  async deleteForMe(message: ChatMessageVm): Promise<void> {
    if (!window.confirm(this.tr('CHAT.CONFIRM_DELETE_FOR_ME', 'Eliminar este mensaje solo para ti?'))) {
      return;
    }
    await this.runAction(`delete-me:${message.id}`, async () => {
      await this.chat.deleteMessage(message, false);
      this.closeMessageActions();
      this.notice = this.tr('CHAT.MESSAGE_DELETED_FOR_ME', 'Mensaje eliminado para ti.');
    });
  }

  async deleteForEveryone(message: ChatMessageVm): Promise<void> {
    if (!message.mine || !window.confirm(this.tr('CHAT.CONFIRM_DELETE_FOR_EVERYONE', 'Eliminar este mensaje para todos?'))) {
      return;
    }
    await this.runAction(`delete-all:${message.id}`, async () => {
      await this.chat.deleteMessage(message, true);
      this.closeMessageActions();
      this.notice = this.tr('CHAT.MESSAGE_DELETED_FOR_EVERYONE', 'Mensaje eliminado para todos.');
    });
  }

  openForward(message: ChatMessageVm): void {
    const availability = this.chat.forwardAvailability(message);
    if (!availability.ok) {
      this.attachmentError = availability.reason || this.tr('CHAT.CANNOT_FORWARD', 'Ese mensaje no se puede reenviar.');
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
      this.notice = sent ? `${this.tr('CHAT.FORWARDED_TO', 'Reenviado a')} ${sent} ${sent === 1 ? this.tr('CHAT.CHAT_SINGULAR', 'chat') : this.tr('CHAT.CHAT_PLURAL', 'chats')}.` : this.tr('CHAT.ERROR_FORWARD', 'No se pudo reenviar.');
      this.closeForward();
    });
  }

  async clearChat(scope: 'me' | 'everyone'): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !window.confirm(scope === 'everyone' ? this.tr('CHAT.CONFIRM_CLEAR_EVERYONE', 'Vaciar este chat para todos?') : this.tr('CHAT.CONFIRM_CLEAR_ME', 'Vaciar este chat solo para ti?'))) {
      return;
    }
    await this.runAction(`clear:${scope}`, async () => {
      await this.chat.clearConversation(conversation, scope);
      this.closeChatMenu();
      this.notice = scope === 'everyone' ? this.tr('CHAT.CLEARED_EVERYONE', 'Chat vaciado para todos.') : this.tr('CHAT.CLEARED_ME', 'Chat vaciado para ti.');
    });
  }

  async deleteChat(scope: 'me' | 'everyone'): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !window.confirm(scope === 'everyone' ? this.tr('CHAT.CONFIRM_DELETE_CHAT_EVERYONE', 'Eliminar este chat para todos?') : this.tr('CHAT.CONFIRM_DELETE_CHAT_ME', 'Eliminar este chat solo para ti?'))) {
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
      this.notice = archived ? this.tr('CHAT.ARCHIVED_DEVICE', 'Chat archivado en este dispositivo.') : this.tr('CHAT.UNARCHIVED', 'Chat desarchivado.');
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
      this.notice = blocked ? this.tr('CHAT.BLOCKED_DEVICE', 'Chat bloqueado en este dispositivo.') : this.tr('CHAT.UNBLOCKED', 'Chat desbloqueado.');
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
    if (this.voiceMode === 'locked') {
      await this.sendLockedVoiceNote();
      return;
    }
    if (this.recordingVoice || this.voiceMode === 'holding') {
      await this.cancelVoiceGesture();
      return;
    }
    this.beginVoiceHold();
  }

  async startVoiceNote(): Promise<void> {
    if (this.recordingVoice || this.sending) {
      return;
    }
    const conversation = this.conversation();
    if (!conversation || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.attachmentError = this.tr('CHAT.ERROR_RECORDING_UNSUPPORTED', 'Este dispositivo no permite grabar audio desde la app.');
      return;
    }
    if (!this.canSendMessages()) {
      this.attachmentError = this.tr('CHAT.ADMINS_ONLY_VOICE', 'Solo los admins pueden enviar notas de voz en este grupo.');
      return;
    }
    this.attachmentError = '';
    try {
      if (this.appSettings.settings().pauseMediaOnRecord) {
        await this.nativeDevice.setAudioFocus(true, 'record');
        this.pauseAmbientMedia();
      }
      this.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mimeType = this.supportedVoiceMimeType();
      this.voiceRecorder = mimeType
        ? new MediaRecorder(this.voiceStream, { mimeType })
        : new MediaRecorder(this.voiceStream);
      this.voiceChunks = [];
      this.voiceStartedAt = Date.now();
      this.voicePausedDurationMs = 0;
      this.voicePauseStartedAt = 0;
      this.voicePaused = false;
      this.voiceElapsedSeconds = 0;
      this.voiceRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.voiceChunks.push(event.data);
        }
      };
      this.voiceRecorder.start();
      this.recordingVoice = true;
      this.startVoiceTimer();
      this.cdr.detectChanges();
    } catch (error) {
      this.cleanupVoiceRecorder();
      this.resetVoiceUi();
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_OPEN_MIC', 'No se pudo abrir el microfono.');
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
      this.resetVoiceUi();
      return;
    }
    this.sending = true;
    try {
      await this.chat.sendFile(conversation, file, { voiceNote: true, policy: this.currentPolicy(), mode: 'document' });
      this.scrollBottom();
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_SEND_VOICE', 'No se pudo enviar la nota de voz.');
    } finally {
      this.sending = false;
      this.resetVoiceUi();
    }
  }

  async cancelVoiceNote(): Promise<void> {
    await this.stopVoiceCapture(false);
  }

  voiceComposerActive(): boolean {
    return this.voiceMode !== 'idle';
  }

  voiceTimerLabel(): string {
    return this.formatAudioTime(this.voiceElapsedSeconds);
  }

  voiceSlideTransform(): string {
    return `translateX(${Math.round(this.voiceSlideX)}px)`;
  }

  async sendLockedVoiceNote(): Promise<void> {
    if (this.voiceMode !== 'locked' && !this.recordingVoice) {
      return;
    }
    await this.voiceStartPromise?.catch(() => undefined);
    await this.stopVoiceNote();
  }

  async cancelLockedVoiceNote(): Promise<void> {
    await this.cancelVoiceGesture();
  }

  toggleVoicePause(): void {
    const recorder = this.voiceRecorder;
    if (!recorder || this.voiceMode !== 'locked') {
      return;
    }
    if (recorder.state === 'recording') {
      recorder.pause();
      this.voicePaused = true;
      this.voicePauseStartedAt = Date.now();
    } else if (recorder.state === 'paused') {
      recorder.resume();
      if (this.voicePauseStartedAt) {
        this.voicePausedDurationMs += Date.now() - this.voicePauseStartedAt;
      }
      this.voicePauseStartedAt = 0;
      this.voicePaused = false;
    }
    this.cdr.detectChanges();
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

  reactionRows(message: ChatMessageVm | null = this.reactionViewerMessage): MessageReaction[] {
    return message?.payload.reactions ?? [];
  }

  reactionDisplayName(reaction: MessageReaction): string {
    return reaction.displayName
      || reaction.alias
      || this.chat.participantDisplayName(reaction.userId)
      || this.tr('COMMON.SOMEONE', 'Alguien');
  }

  reactionSubtitle(reaction: MessageReaction): string {
    const alias = reaction.alias || this.chat.participantAlias(reaction.userId);
    const at = reaction.at ? this.shortDateTime(reaction.at) : '';
    return [alias ? `@${alias.replace(/^@/, '')}` : '', at].filter(Boolean).join(' - ');
  }

  reactionAvatar(reaction: MessageReaction): string {
    return reaction.profilePhotoDataUrl || this.chat.participantPhoto(reaction.userId);
  }

  reactionInitials(reaction: MessageReaction): string {
    return this.initialsFromName(this.reactionDisplayName(reaction));
  }

  messageInfoRows(message: ChatMessageVm | null = this.messageInfoMessage): DeliveryReceipt[] {
    if (!message?.mine) {
      return [];
    }
    const currentUserId = this.auth.session()?.user.id;
    const grouped = new Map<string, DeliveryReceipt>();
    for (const receipt of message.receipts ?? []) {
      if (!receipt.userId || receipt.userId === currentUserId) {
        continue;
      }
      const previous = grouped.get(receipt.userId);
      grouped.set(receipt.userId, {
        userId: receipt.userId,
        deviceId: 'recipient',
        deliveredAt: this.latestIso(previous?.deliveredAt, receipt.deliveredAt),
        readAt: this.latestIso(previous?.readAt, receipt.readAt),
        deletedAt: this.latestIso(previous?.deletedAt, receipt.deletedAt),
      });
    }
    return [...grouped.values()].sort((left, right) =>
      this.receiptDisplayName(left).localeCompare(this.receiptDisplayName(right)));
  }

  receiptDisplayName(receipt: DeliveryReceipt): string {
    return this.chat.participantDisplayName(receipt.userId) || this.tr('COMMON.DEVICE', 'Dispositivo');
  }

  receiptAvatar(receipt: DeliveryReceipt): string {
    return this.chat.participantPhoto(receipt.userId);
  }

  receiptInitials(receipt: DeliveryReceipt): string {
    return this.initialsFromName(this.receiptDisplayName(receipt));
  }

  receiptStatus(receipt: DeliveryReceipt): string {
    if (receipt.deletedAt) {
      return `${this.tr('CHAT.DELETED', 'Eliminado')} ${this.shortDateTime(receipt.deletedAt)}`;
    }
    if (receipt.readAt) {
      return `${this.tr('CHAT.READ', 'Leido')} ${this.shortDateTime(receipt.readAt)}`;
    }
    if (receipt.deliveredAt) {
      return `${this.tr('CHAT.DELIVERED', 'Entregado')} ${this.shortDateTime(receipt.deliveredAt)}`;
    }
    return this.tr('CHAT.PENDING', 'Pendiente');
  }

  messageInfoSummary(message: ChatMessageVm | null = this.messageInfoMessage): string {
    if (!message?.mine) {
      return '';
    }
    const rows = this.messageInfoRows(message);
    const read = rows.filter((receipt) => receipt.readAt).length;
    const delivered = rows.filter((receipt) => receipt.deliveredAt).length;
    return `${delivered} ${delivered === 1 ? this.tr('CHAT.DELIVERED_ONE', 'entregado') : this.tr('CHAT.DELIVERED_MANY', 'entregados')} - ${read} ${read === 1 ? this.tr('CHAT.READ_ONE', 'leido') : this.tr('CHAT.READ_MANY', 'leidos')}`;
  }

  private latestIso(left?: string | null, right?: string | null): string | null {
    if (!left) {
      return right ?? null;
    }
    if (!right) {
      return left;
    }
    return Date.parse(right) > Date.parse(left) ? right : left;
  }

  forwardedLabel(message: ChatMessageVm): string {
    const value = message.payload.forwardedFrom;
    if (typeof value === 'object' && value !== null && 'senderAlias' in value) {
      return `${this.tr('CHAT.FORWARDED_FROM', 'Reenviado de')} ${String((value as { senderAlias?: unknown }).senderAlias || 'Nivra')}`;
    }
    return value ? this.tr('CHAT.FORWARDED', 'Reenviado') : '';
  }

  replyPreview(message: ChatMessageVm | null): string {
    return message ? this.chat.preview(message.payload) : '';
  }

  quotedReply(message: ChatMessageVm): QuotedReplyVm | null {
    if (!message.payload.replyTo) {
      return null;
    }
    return this.quotedReplies[message.id] ?? this.replyQuoteFromReference(this.replyReferenceVm(message));
  }

  quotedReplyIcon(quote: QuotedReplyVm): string {
    if (quote.kind === 'image' || quote.kind === 'story') {
      return 'image-outline';
    }
    if (quote.kind === 'video') {
      return 'videocam-outline';
    }
    if (quote.kind === 'audio') {
      return 'mic-outline';
    }
    if (quote.kind === 'file') {
      return 'document-attach-outline';
    }
    return 'return-down-back-outline';
  }

  async jumpToReply(quote: QuotedReplyVm, event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    if (!quote.messageId) {
      return;
    }
    const element = document.getElementById(this.messageElementId(quote.messageId));
    if (element) {
      this.scrollToMessage(quote.messageId);
      element.classList.add('reply-target-highlight');
      window.setTimeout(() => element.classList.remove('reply-target-highlight'), 1400);
      return;
    }
    await this.showPremiumToast(this.tr('CHAT.ORIGINAL_MESSAGE_NOT_VISIBLE', 'Mensaje original no visible en este momento.'));
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

  private refreshQuotedReplies(conversationId: string, messages: ChatMessageVm[]): void {
    if (!conversationId) {
      this.quotedReplyCache.clear();
      this.syncQuotedReplySnapshot();
      return;
    }

    const currentMessageIds = new Set(messages.map((message) => message.id));
    const localMessages = new Map(messages.map((message) => [message.id, message]));
    let changed = false;
    for (const key of [...this.quotedReplyCache.keys()]) {
      if (!currentMessageIds.has(key)) {
        this.quotedReplyCache.delete(key);
        changed = true;
      }
    }

    for (const message of messages) {
      const reference = this.replyReferenceVm(message);
      if (!reference) {
        if (this.quotedReplyCache.delete(message.id)) {
          changed = true;
        }
        continue;
      }

      const local = reference.messageId ? localMessages.get(reference.messageId) : null;
      if (local) {
        const quote = this.replyQuoteFromMessage(local, reference);
        const previous = this.quotedReplyCache.get(message.id);
        this.quotedReplyCache.set(message.id, quote);
        changed = changed || JSON.stringify(previous) !== JSON.stringify(quote);
        continue;
      }

      if (!this.quotedReplyCache.has(message.id)) {
        const fallback = this.replyQuoteFromReference(reference);
        if (fallback) {
          this.quotedReplyCache.set(message.id, fallback);
          changed = true;
        }
      }

      if (reference.messageId && !this.quotedReplyLoads.has(message.id)) {
        this.quotedReplyLoads.add(message.id);
        void this.loadQuotedReplyFromHistory(conversationId, message.id, reference);
      }
    }

    if (changed) {
      this.syncQuotedReplySnapshot();
    }
  }

  private async loadQuotedReplyFromHistory(conversationId: string, ownerMessageId: string, reference: ReplyReferenceVm): Promise<void> {
    try {
      const original = await this.chat.localMessageById(conversationId, reference.messageId);
      if (!original) {
        return;
      }
      this.quotedReplyCache.set(ownerMessageId, this.replyQuoteFromMessage(original, reference));
      this.syncQuotedReplySnapshot();
      this.cdr.detectChanges();
    } finally {
      this.quotedReplyLoads.delete(ownerMessageId);
    }
  }

  private syncQuotedReplySnapshot(): void {
    this.quotedReplies = Object.fromEntries(this.quotedReplyCache.entries());
  }

  private replyReferenceVm(message: ChatMessageVm): ReplyReferenceVm | null {
    const value = message.payload.replyTo;
    if (!value || typeof value !== 'object') {
      return null;
    }
    const reference = value as {
      messageId?: unknown;
      senderUserId?: unknown;
      preview?: unknown;
      kind?: unknown;
      mediaMime?: unknown;
    };
    return {
      messageId: this.stringValue(reference.messageId),
      senderUserId: this.stringValue(reference.senderUserId),
      preview: this.stringValue(reference.preview),
      kind: this.stringValue(reference.kind),
      mediaMime: this.stringValue(reference.mediaMime),
    };
  }

  private replyQuoteFromMessage(message: ChatMessageVm, reference: ReplyReferenceVm | null): QuotedReplyVm {
    const file = this.chat.asFile(message.payload);
    const kind = this.replyKindForMessage(message);
    const fileId = file ? (file.fileId || file.downloadFile || file.previewFile || '') : '';
    const media = kind === 'image' || kind === 'video' ? this.chat.mediaPreview(fileId) : null;
    return {
      messageId: message.id,
      found: true,
      senderName: this.senderName(message.senderUserId, message.mine),
      isMine: message.mine,
      kind,
      snippet: this.replySnippetForMessage(message, reference),
      thumbnailUrl: media?.url ?? null,
      fallbackText: this.tr('CHAT.ORIGINAL_MESSAGE_UNAVAILABLE', 'Mensaje original no disponible'),
    };
  }

  private replyQuoteFromReference(reference: ReplyReferenceVm | null): QuotedReplyVm | null {
    if (!reference) {
      return null;
    }
    if (reference.kind === 'story') {
      const preview = reference.preview || reference.mediaMime || this.tr('STORY.SNAPSHOT', 'Instantanea');
      return {
        messageId: reference.messageId || '',
        found: true,
        senderName: this.tr('STORY.TITLE', 'Historia'),
        isMine: false,
        kind: 'story',
        snippet: preview,
        thumbnailUrl: null,
        fallbackText: this.tr('CHAT.ORIGINAL_MESSAGE_UNAVAILABLE', 'Mensaje original no disponible'),
      };
    }

    const kind = this.replyKindForMime(reference.mediaMime);
    return {
      messageId: reference.messageId || '',
      found: false,
      senderName: this.senderName(reference.senderUserId, false),
      isMine: reference.senderUserId === this.auth.session()?.user.id,
      kind: reference.preview ? kind : 'unavailable',
      snippet: reference.preview || this.tr('CHAT.ORIGINAL_MESSAGE_UNAVAILABLE', 'Mensaje original no disponible'),
      thumbnailUrl: null,
      fallbackText: this.tr('CHAT.ORIGINAL_MESSAGE_UNAVAILABLE', 'Mensaje original no disponible'),
    };
  }

  private replyKindForMessage(message: ChatMessageVm): QuotedReplyKind {
    const file = this.chat.asFile(message.payload);
    if (!file) {
      return 'text';
    }
    if (this.chat.isImage(file)) {
      return 'image';
    }
    if (this.chat.isVideo(file)) {
      return 'video';
    }
    if (this.chat.isAudio(file) || file.voiceNote) {
      return 'audio';
    }
    return 'file';
  }

  private replyKindForMime(mime: string | undefined): QuotedReplyKind {
    if (!mime) {
      return 'text';
    }
    if (mime.startsWith('image/')) {
      return 'image';
    }
    if (mime.startsWith('video/')) {
      return 'video';
    }
    if (mime.startsWith('audio/')) {
      return 'audio';
    }
    return 'file';
  }

  private replySnippetForMessage(message: ChatMessageVm, reference: ReplyReferenceVm | null): string {
    const file = this.chat.asFile(message.payload);
    if (!file) {
      return this.chat.preview(message.payload);
    }
    const caption = typeof file.text === 'string' && file.text.trim() ? file.text.trim() : '';
    if (this.chat.isImage(file)) {
      return caption || this.tr('CHAT.PHOTO', 'Foto');
    }
    if (this.chat.isVideo(file)) {
      return caption || this.tr('CHAT.VIDEO', 'Video');
    }
    if (this.chat.isAudio(file) || file.voiceNote) {
      return caption || (file.voiceNote ? this.tr('CHAT.VOICE_NOTE', 'Nota de voz') : this.chat.fileName(file));
    }
    return caption || reference?.preview || this.chat.fileName(file);
  }

  private senderName(userId: string | undefined, isMine: boolean): string {
    const currentUserId = this.auth.session()?.user.id;
    if (isMine || (userId && userId === currentUserId)) {
      return this.tr('COMMON.YOU', 'Tu');
    }
    return this.chat.participantDisplayName(userId || '') || this.tr('COMMON.CONTACT', 'Contacto');
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
    const role = this.isGroupAdmin(participant.userId) ? this.tr('CHAT.ADMIN', 'Admin') : this.tr('CHAT.MEMBER', 'Miembro');
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
      this.groupInfoError = this.tr('CHAT.ERROR_GROUP_PHOTO', 'No se pudo cargar la foto del grupo.');
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
      this.notice = this.tr('CHAT.GROUP_UPDATED', 'Grupo actualizado.');
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
      this.notice = this.tr('CHAT.PARTICIPANTS_ADDED', 'Participantes agregados.');
      this.prepareGroupInfoDraft(this.conversation() ?? conversation);
    });
  }

  async leaveGroup(): Promise<void> {
    const conversation = this.conversation();
    if (!conversation || !this.isGroupConversation()) {
      return;
    }
    const title = this.chat.conversationTitle(conversation);
    const confirmCopy = this.tr('CHAT.LEAVE_GROUP_CONFIRM', 'Salir de este grupo? No podras volver a entrar a menos que un administrador te agregue.');
    if (!window.confirm(`${confirmCopy}\n\n${title}`)) {
      return;
    }
    await this.runGroupInfoAction(async () => {
      await this.chat.leaveGroupConversation(conversation);
      this.notice = this.tr('CHAT.LEFT_GROUP', 'Saliste del grupo.');
      this.closeContactInfo();
      await this.router.navigateByUrl('/app/chats');
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

  onComposerEnter(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (!this.appSettings.settings().enterToSend || keyboardEvent.shiftKey || keyboardEvent.isComposing) {
      return;
    }
    keyboardEvent.preventDefault();
    void this.send();
  }

  canTranslate(message: ChatMessageVm | null): boolean {
    return Boolean(this.appSettings.settings().showTranslateButton && (message?.payload.text || this.chat.preview(message?.payload ?? { type: 'text', text: '' }).trim()));
  }

  messageElementId(messageId: string): string {
    return `nivra-message-${this.safeDomId(messageId)}`;
  }

  shouldShowUnreadDivider(messageId: string): boolean {
    return Boolean(this.initialUnreadMessageId && this.initialUnreadMessageId === messageId);
  }

  async translateMessage(message: ChatMessageVm): Promise<void> {
    const text = (message.payload.text || this.chat.preview(message.payload)).trim();
    if (!text) {
      return;
    }
    const target = this.targetTranslateLanguage();
    const url = `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(target)}&text=${encodeURIComponent(text)}&op=translate`;
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      await navigator.clipboard.writeText(text).catch(() => undefined);
      this.notice = this.tr('CHAT.TEXT_COPIED', 'Texto copiado.');
    }
    this.closeMessageActions();
  }

  private scheduleInitialScroll(conversationId: string | null | undefined, options: { force?: boolean } = {}): void {
    const id = conversationId || this.conversation()?.id;
    if (!id) {
      return;
    }
    if (!options.force && this.initialScrollDoneForConversation === id) {
      return;
    }
    this.initialScrollDoneForConversation = id;
    this.clearInitialScrollTimers();
    [0, 80, 220, 520].forEach((delay, index) => {
      const timer = window.setTimeout(() => this.scrollToInitialPosition(id, index), delay);
      this.initialScrollTimers.push(timer);
    });
  }

  private scrollToInitialPosition(conversationId: string | null | undefined, attempt = 0): void {
    const id = conversationId || this.conversation()?.id;
    const unreadMessageId = this.chat.initialScrollMessageId(id);
    if (unreadMessageId) {
      this.initialUnreadMessageId = unreadMessageId;
      this.scrollToMessage(unreadMessageId, attempt);
      return;
    }
    this.initialUnreadMessageId = null;
    this.scrollBottom({ strong: true });
  }

  private scrollToMessage(messageId: string, attempt = 0): void {
    const run = async () => {
      const element = document.getElementById(this.messageElementId(messageId));
      const content = this.content;
      if (element && content) {
        const scrollElement = await content.getScrollElement().catch(() => null);
        if (!scrollElement) {
          return;
        }
        const elementRect = element.getBoundingClientRect();
        const scrollRect = scrollElement.getBoundingClientRect();
        const elementTop = elementRect.top - scrollRect.top + scrollElement.scrollTop;
        const topOffset = Math.max(72, Math.round(scrollElement.clientHeight * 0.28));
        const targetTop = Math.max(0, elementTop - topOffset);
        await content.scrollToPoint(0, targetTop, this.performanceMode.efficiencyMode() || attempt ? 0 : 180);
        return;
      }
      if (attempt < 8) {
        window.setTimeout(() => this.scrollToMessage(messageId, attempt + 1), 80);
        return;
      }
      this.scrollBottom({ strong: true });
    };
    window.setTimeout(run, attempt ? 0 : 60);
  }

  private scrollBottom(options: { strong?: boolean } = {}): void {
    const delays = options.strong ? [40, 140, 320, 700] : [40];
    delays.forEach((delay, index) => {
      window.setTimeout(() => {
        const duration = this.performanceMode.efficiencyMode() || index ? 0 : 220;
        void this.content?.scrollToBottom(duration);
      }, delay);
    });
  }

  private clearInitialScrollTimers(): void {
    this.initialScrollTimers.forEach((timer) => window.clearTimeout(timer));
    this.initialScrollTimers = [];
  }

  private safeDomId(value: string): string {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  private bindVoiceGesture(): void {
    const element = this.micButton?.nativeElement;
    if (!element) {
      return;
    }
    this.micGesture?.destroy();
    this.micGesture = this.gestureController.create({
      el: element,
      gestureName: 'nivra-voice-recorder',
      threshold: 0,
      disableScroll: true,
      onStart: () => this.beginVoiceHold(),
      onMove: (event: { deltaX: number; deltaY: number }) => this.handleVoiceMove(event.deltaX, event.deltaY),
      onEnd: () => void this.finishVoiceHold(),
    }, true);
    this.micGesture.enable(true);
  }

  private beginVoiceHold(): void {
    if (this.voiceMode !== 'idle' || this.sending || this.isBlocked() || !this.canSendMessages()) {
      return;
    }
    this.voiceMode = 'holding';
    this.voiceSlideX = 0;
    this.attachmentError = '';
    this.notice = '';
    this.voiceStartPromise = this.startVoiceNote();
    void this.voiceStartPromise.finally(() => {
      if (!this.recordingVoice && this.voiceMode !== 'cancelling') {
        this.resetVoiceUi();
      }
      this.cdr.detectChanges();
    });
    this.cdr.detectChanges();
  }

  private handleVoiceMove(deltaX: number, deltaY: number): void {
    if (this.voiceMode !== 'holding') {
      return;
    }
    this.voiceSlideX = Math.max(-96, Math.min(0, deltaX));
    if (deltaX <= -82) {
      void this.cancelVoiceGesture();
      return;
    }
    if (deltaY <= -72) {
      this.voiceMode = 'locked';
      this.voiceSlideX = 0;
    }
    this.cdr.detectChanges();
  }

  private async finishVoiceHold(): Promise<void> {
    if (this.voiceMode === 'locked' || this.voiceMode === 'cancelling' || this.voiceMode === 'idle') {
      return;
    }
    await this.voiceStartPromise?.catch(() => undefined);
    if (this.voiceMode !== 'holding') {
      return;
    }
    await this.stopVoiceNote();
  }

  private async cancelVoiceGesture(): Promise<void> {
    if (this.voiceMode === 'idle') {
      return;
    }
    this.voiceMode = 'cancelling';
    this.voiceSlideX = -110;
    this.cdr.detectChanges();
    await this.voiceStartPromise?.catch(() => undefined);
    await this.cancelVoiceNote();
    window.setTimeout(() => {
      if (this.voiceMode === 'cancelling') {
        this.resetVoiceUi();
        this.cdr.detectChanges();
      }
    }, 260);
  }

  private resetVoiceUi(): void {
    this.voiceMode = 'idle';
    this.voiceSlideX = 0;
    this.voiceStartPromise = null;
    this.voiceElapsedSeconds = 0;
    this.voicePaused = false;
    this.voicePauseStartedAt = 0;
    this.voicePausedDurationMs = 0;
    window.requestAnimationFrame(() => this.bindVoiceGesture());
  }

  private startVoiceTimer(): void {
    this.stopVoiceTimer();
    this.voiceTimer = window.setInterval(() => {
      if (!this.recordingVoice) {
        this.stopVoiceTimer();
        return;
      }
      this.voiceElapsedSeconds = Math.floor(this.currentVoiceDurationMs() / 1000);
      this.cdr.detectChanges();
    }, 250);
  }

  private stopVoiceTimer(): void {
    if (this.voiceTimer !== null) {
      window.clearInterval(this.voiceTimer);
      this.voiceTimer = null;
    }
  }

  private currentVoiceDurationMs(): number {
    if (!this.voiceStartedAt) {
      return 0;
    }
    const now = Date.now();
    const activePauseMs = this.voicePaused && this.voicePauseStartedAt ? now - this.voicePauseStartedAt : 0;
    return Math.max(0, now - this.voiceStartedAt - this.voicePausedDurationMs - activePauseMs);
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

  private preparePendingAttachments(files: File[], mode: AttachmentMode): void {
    this.clearPendingAttachments(false);
    this.pendingAttachmentMode = mode;
    this.pendingAttachmentDraftSeed = this.draft.trim();
    this.pendingAttachmentCaption = this.pendingAttachmentDraftSeed;
    this.pendingAttachmentFiles = files.map((file) => ({
      file,
      url: this.canPreviewPendingFile(file) ? URL.createObjectURL(file) : null,
    }));
  }

  private clipboardImageFiles(event: ClipboardEvent): File[] {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return [];
    }
    const files: File[] = [];
    const items = Array.from(clipboard.items ?? []);
    for (const item of items) {
      if (item.kind !== 'file' || !item.type.toLowerCase().includes('image')) {
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        files.push(this.normalizeClipboardImageFile(file, files.length));
      }
    }
    if (files.length) {
      return files;
    }
    for (const file of Array.from(clipboard.files ?? [])) {
      if (file.type.toLowerCase().startsWith('image/')) {
        files.push(this.normalizeClipboardImageFile(file, files.length));
      }
    }
    return files;
  }

  private normalizeClipboardImageFile(file: File, index: number): File {
    if (file.name?.trim()) {
      return file;
    }
    const mime = file.type || 'image/png';
    const extension = this.clipboardImageExtension(mime);
    const suffix = index > 0 ? `-${index + 1}` : '';
    return new File([file], `nivra-clipboard-${Date.now()}${suffix}.${extension}`, {
      type: mime,
      lastModified: file.lastModified || Date.now(),
    });
  }

  private clipboardImageExtension(mime: string): string {
    const normalized = mime.toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) {
      return 'jpg';
    }
    if (normalized.includes('webp')) {
      return 'webp';
    }
    if (normalized.includes('gif')) {
      return 'gif';
    }
    if (normalized.includes('heic')) {
      return 'heic';
    }
    if (normalized.includes('bmp')) {
      return 'bmp';
    }
    return 'png';
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

  private shortDateTime(value: string | null | undefined): string {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleString([], {
      hour: 'numeric',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
    });
  }

  private initialsFromName(value: string): string {
    return value
      .split(/\s|,|-/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'N';
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

  private async bindRaiseGestures(): Promise<void> {
    await this.raiseGestureHandle?.remove().catch(() => undefined);
    this.raiseGestureHandle = await this.nativeDevice.onRaiseGesture((event) => {
      void this.handleRaiseGesture(event);
    }).catch(() => null);
  }

  private async handleRaiseGesture(event: RaiseGestureEvent): Promise<void> {
    if (!event.near || !this.conversation()) {
      return;
    }
    const settings = this.appSettings.settings();
    if (event.kind === 'talk' && settings.raiseToTalk) {
      await this.startLockedVoiceFromRaise();
      return;
    }
    if (settings.raiseToListen) {
      await this.playLatestIncomingVoice();
    }
  }

  private async startLockedVoiceFromRaise(): Promise<void> {
    if (this.voiceMode !== 'idle' || this.recordingVoice || this.sending || this.draft.trim() || this.isBlocked() || !this.canSendMessages()) {
      return;
    }
    this.voiceMode = 'locked';
    this.voiceSlideX = 0;
    this.attachmentError = '';
    this.notice = '';
    this.voiceStartPromise = this.startVoiceNote();
    await this.voiceStartPromise.catch(() => undefined);
    if (!this.recordingVoice) {
      this.resetVoiceUi();
    }
    this.cdr.detectChanges();
  }

  private async playLatestIncomingVoice(): Promise<void> {
    const audios = Array.from(document.querySelectorAll<HTMLAudioElement>('article.message:not(.mine) audio.voice-source'));
    const audio = audios.reverse().find((item) => item.src && !item.ended) ?? audios[0];
    if (!audio) {
      return;
    }
    const messageId = audio.dataset['messageId'] || '';
    const message = this.messages().find((item) => item.id === messageId);
    if (this.appSettings.settings().pauseMediaOnPlayback) {
      await this.nativeDevice.setAudioFocus(true, 'playback');
      this.pauseAmbientMedia(audio);
    } else {
      this.pauseOtherAudio(audio);
    }
    await audio.play().catch(() => undefined);
    if (message) {
      this.markAudioPlaying(message, audio);
    }
  }

  private isUploadLimitError(message: string): boolean {
    return message.includes('limite robusto de cifrado local') || message.includes('local encryption limit');
  }

  private async showPremiumToast(message: string): Promise<void> {
    const toast = await this.toastController.create({
      message,
      duration: 2500,
      animated: true,
      position: 'top',
      cssClass: 'nivra-premium-toast nivra-safe-toast',
    });
    await toast.present();
  }

  private currentPolicy(): MessagePolicyOptions {
    const selectedTtl = Number(this.ttlSeconds);
    const defaultTtl = Number(this.auth.session()?.user.privacySettings?.defaultMessageTtlSeconds || 0);
    const ttlSeconds = selectedTtl < 0 ? defaultTtl : selectedTtl;
    return {
      deleteAfterRead: this.deleteAfterRead,
      ttlSeconds: ttlSeconds > 0 ? ttlSeconds : null,
      replyTo: this.replyReference(this.replyingMessage),
    };
  }

  private targetTranslateLanguage(): string {
    const language = this.appSettings.settings().language;
    if (language === 'zh-Hans') {
      return 'zh-CN';
    }
    if (language === 'zh-Hant') {
      return 'zh-TW';
    }
    return language.split('-')[0] || 'es';
  }

  private pauseAmbientMedia(except?: HTMLMediaElement): void {
    document.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => {
      if (media !== except && !media.paused) {
        media.pause();
      }
    });
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
      this.groupInfoError = error instanceof Error ? error.message : this.tr('CHAT.ERROR_UPDATE_GROUP', 'No se pudo actualizar el grupo.');
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
        const durationMs = this.currentVoiceDurationMs();
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
    this.voicePauseStartedAt = 0;
    this.voicePausedDurationMs = 0;
    this.voicePaused = false;
    this.stopVoiceTimer();
    this.recordingVoice = false;
    void this.nativeDevice.setAudioFocus(false, 'record');
  }

  private supportedVoiceMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }

  private async runAction(id: string, action: () => Promise<void>): Promise<void> {
    this.busyAction = id;
    this.attachmentError = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la accion.');
    } finally {
      this.busyAction = '';
    }
  }
}
