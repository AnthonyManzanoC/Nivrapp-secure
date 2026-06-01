import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, ViewChild, computed, inject } from '@angular/core';
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
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonToggle,
  IonToolbar,
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
  attachOutline,
  arrowRedoOutline,
  checkmarkOutline,
  closeOutline,
  createOutline,
  playCircleOutline,
  sendOutline,
  searchOutline,
  trashOutline,
  videocamOutline,
} from 'ionicons/icons';
import { Subscription } from 'rxjs';
import { ChatMessageVm, Conversation } from '../../core/models/nivra.models';
import { ChatService } from '../../core/services/chat.service';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { SignalrService } from '../../core/services/signalr.service';

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
    IonSelect,
    IonSelectOption,
    IonSpinner,
    IonTextarea,
    IonToggle,
    IonToolbar,
  ],
  templateUrl: './chat-detail.page.html',
  styleUrls: ['./chat-detail.page.scss'],
})
export class ChatDetailPage implements OnInit, OnDestroy {
  @ViewChild(IonContent) private content?: IonContent;
  readonly chat = inject(ChatService);
  readonly realtime = inject(SignalrService);
  private readonly auth = inject(AuthService);
  private readonly calls = inject(CallsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
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
  forwardQuery = '';
  selectedForwardIds = new Set<string>();
  chatMenuOpen = false;
  busyAction = '';
  notice = '';
  deleteAfterRead = false;
  ttlSeconds: number | null = null;
  recordingVoice = false;
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
      attachOutline,
      arrowRedoOutline,
      checkmarkOutline,
      closeOutline,
      createOutline,
      playCircleOutline,
      sendOutline,
      searchOutline,
      trashOutline,
      videocamOutline,
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

  ngOnDestroy(): void {
    const conversationId = this.conversation()?.id;
    if (conversationId) {
      void this.chat.sendTyping(conversationId, 'stopped', { force: true });
    }
    this.routeSub?.unsubscribe();
    this.keyboardHandles.forEach((handle) => void handle.remove());
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
    const text = this.draft;
    this.draft = '';
    this.sending = true;
    try {
      await this.chat.sendTyping(conversation.id, 'stopped', { force: true });
      await this.chat.sendText(conversation, text, this.currentPolicy());
      this.scrollBottom();
    } finally {
      this.sending = false;
    }
  }

  async back(): Promise<void> {
    await this.router.navigateByUrl('/app/chats');
  }

  async attachFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    const conversation = this.conversation();
    if (!conversation || !files.length || this.sending) {
      return;
    }

    this.attachmentError = '';
    this.sending = true;
    try {
      for (const file of files) {
        await this.chat.sendFile(conversation, file, { policy: this.currentPolicy() });
      }
      this.scrollBottom();
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo subir el adjunto.';
    } finally {
      this.sending = false;
    }
  }

  async download(message: ChatMessageVm): Promise<void> {
    if (this.downloadingId) {
      return;
    }
    this.downloadingId = message.id;
    this.attachmentError = '';
    try {
      await this.chat.downloadAttachment(message.payload);
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
    } catch (error) {
      this.attachmentError = error instanceof Error ? error.message : 'No se pudo previsualizar el adjunto.';
    } finally {
      this.downloadingId = null;
    }
  }

  async react(message: ChatMessageVm, emoji: string): Promise<void> {
    const conversation = this.conversation();
    if (!conversation) {
      return;
    }
    await this.chat.sendReaction(conversation, message, emoji);
  }

  toggleActions(message: ChatMessageVm): void {
    this.actionMessageId = this.actionMessageId === message.id ? null : message.id;
    this.chatMenuOpen = false;
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
    this.actionMessageId = null;
  }

  cancelEdit(): void {
    this.editingMessage = null;
    this.editDraft = '';
    this.draft = '';
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
      this.actionMessageId = null;
      this.notice = 'Mensaje eliminado para ti.';
    });
  }

  async deleteForEveryone(message: ChatMessageVm): Promise<void> {
    if (!message.mine || !window.confirm('Eliminar este mensaje para todos?')) {
      return;
    }
    await this.runAction(`delete-all:${message.id}`, async () => {
      await this.chat.deleteMessage(message, true);
      this.actionMessageId = null;
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
    this.actionMessageId = null;
    this.chatMenuOpen = false;
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
      this.chatMenuOpen = false;
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
      this.chatMenuOpen = false;
      await this.router.navigateByUrl('/app/chats');
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
      await this.chat.sendFile(conversation, file, { voiceNote: true, policy: this.currentPolicy() });
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

  private scrollBottom(): void {
    setTimeout(() => {
      void this.content?.scrollToBottom(220);
    }, 40);
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

  private currentPolicy(): { deleteAfterRead: boolean; ttlSeconds: number | null } {
    const ttlSeconds = Number(this.ttlSeconds || 0);
    return {
      deleteAfterRead: this.deleteAfterRead,
      ttlSeconds: ttlSeconds > 0 ? ttlSeconds : null,
    };
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
