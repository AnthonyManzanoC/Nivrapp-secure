import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnDestroy, Output, inject } from '@angular/core';
import {
  IonButton,
  IonIcon,
  IonModal,
  IonSpinner,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  closeOutline,
  documentAttachOutline,
  imageOutline,
  micOutline,
  playCircleOutline,
  videocamOutline,
  volumeHighOutline,
} from 'ionicons/icons';
import { ChatMessageVm, FileChatPayload, MediaPreview } from '../../core/models/nivra.models';
import { ChatService } from '../../core/services/chat.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';

@Component({
  selector: 'app-chat-media-gallery',
  standalone: true,
  imports: [
    CommonModule,
    TranslatePipe,
    IonButton,
    IonIcon,
    IonModal,
    IonSpinner,
  ],
  templateUrl: './chat-media-gallery.component.html',
  styleUrls: ['./chat-media-gallery.component.scss'],
})
export class ChatMediaGalleryComponent implements OnDestroy {
  @Input() messages: ChatMessageVm[] = [];
  @Output() dismiss = new EventEmitter<void>();

  readonly chat = inject(ChatService);
  readonly translate = inject(TranslateService);
  loadingId: string | null = null;
  error = '';
  audioPreview: MediaPreview | null = null;
  audioName = '';
  viewerPreview: MediaPreview | null = null;
  viewerFile: FileChatPayload | null = null;
  private readonly ownedPreviewIds = new Set<string>();

  constructor() {
    addIcons({
      closeOutline,
      documentAttachOutline,
      imageOutline,
      micOutline,
      playCircleOutline,
      videocamOutline,
      volumeHighOutline,
    });
  }

  get items(): ChatMessageVm[] {
    return [...this.messages]
      .filter((message) => this.isSupportedMediaFile(this.chat.asFile(message.payload)))
      .sort((left, right) => this.messageTime(right) - this.messageTime(left));
  }

  ngOnDestroy(): void {
    this.closeAudioPlayer();
    this.closeViewer();
    this.ownedPreviewIds.forEach((fileId) => this.chat.releaseMediaPreview(fileId));
    this.ownedPreviewIds.clear();
  }

  previewFor(file: FileChatPayload): MediaPreview | null {
    return this.chat.mediaPreview(this.fileId(file));
  }

  isAudio(file: FileChatPayload): boolean {
    return this.chat.isAudio(file) || Boolean(file.voiceNote);
  }

  async open(message: ChatMessageVm): Promise<void> {
    const file = this.chat.asFile(message.payload);
    if (!file || this.loadingId) {
      return;
    }

    const fileId = this.fileId(file);
    const hadPreview = Boolean(this.chat.mediaPreview(fileId));

    this.loadingId = message.id;
    this.error = '';
    try {
      const preview = await this.chat.ensureMediaPreview(message.payload);
      await this.chat.markMessageOpened(message);
      if (!preview) {
        this.error = this.tr('CHAT_MEDIA.DECRYPT_ERROR', 'No se pudo descifrar este archivo en este dispositivo.');
        return;
      }
      if (!hadPreview && fileId) {
        this.ownedPreviewIds.add(fileId);
      }

      if (this.isAudio(file)) {
        this.audioPreview = preview;
        this.audioName = file.voiceNote ? this.tr('CHAT.VOICE_NOTE', 'Nota de voz') : this.chat.fileName(file);
        return;
      }

      this.viewerPreview = preview;
      this.viewerFile = file;
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.tr('CHAT_MEDIA.OPEN_ERROR', 'No se pudo abrir el archivo.');
    } finally {
      this.loadingId = null;
    }
  }

  closeAudioPlayer(): void {
    this.audioPreview = null;
    this.audioName = '';
  }

  closeViewer(): void {
    this.viewerPreview = null;
    this.viewerFile = null;
  }

  private isSupportedMediaFile(file: FileChatPayload | null): file is FileChatPayload {
    return Boolean(file && (
      this.chat.isImage(file) ||
      this.chat.isVideo(file) ||
      this.chat.isAudio(file) ||
      file.voiceNote
    ));
  }

  private fileId(file: FileChatPayload): string | null {
    return file.fileId || file.downloadFile || file.previewFile || null;
  }

  private messageTime(message: ChatMessageVm): number {
    const value = Date.parse(message.at);
    return Number.isFinite(value) ? value : 0;
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }
}
