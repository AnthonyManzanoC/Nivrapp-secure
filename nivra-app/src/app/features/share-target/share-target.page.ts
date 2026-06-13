import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonContent, IonIcon, IonSpinner, IonTextarea } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  checkmarkOutline,
  closeOutline,
  documentAttachOutline,
  imageOutline,
  searchOutline,
  sendOutline,
  videocamOutline,
} from 'ionicons/icons';
import { Subscription } from 'rxjs';
import { Contact, Conversation, UserSummary } from '../../core/models/nivra.models';
import { ChatService } from '../../core/services/chat.service';
import { AuthService } from '../../core/services/auth.service';
import { NativeDeviceService, type NativeShareFile, type NativeShareIntent } from '../../core/services/native-device.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';

type ShareTargetKind = 'conversation' | 'contact';

interface ShareTarget {
  id: string;
  kind: ShareTargetKind;
  title: string;
  subtitle: string;
  photo: string;
  initials: string;
  conversation?: Conversation;
  contact?: Contact;
}

@Component({
  selector: 'app-share-target',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe, IonButton, IonContent, IonIcon, IonSpinner, IonTextarea],
  templateUrl: './share-target.page.html',
  styleUrls: ['./share-target.page.scss'],
})
export class ShareTargetPage implements OnInit, OnDestroy {
  readonly chat = inject(ChatService);
  private readonly auth = inject(AuthService);
  private readonly nativeDevice = inject(NativeDeviceService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private routeSub?: Subscription;
  share: NativeShareIntent | null = null;
  query = '';
  note = '';
  error = '';
  notice = '';
  sending = false;
  loading = true;
  sendProgress = '';
  selectedTargetIds = new Set<string>();
  private preparedFiles: File[] | null = null;
  private loadedShareId = '';

  constructor() {
    addIcons({
      arrowBackOutline,
      checkmarkOutline,
      closeOutline,
      documentAttachOutline,
      imageOutline,
      searchOutline,
      sendOutline,
      videocamOutline,
    });
  }

  ngOnInit(): void {
    this.routeSub = this.route.queryParamMap.subscribe(() => {
      void this.loadPendingShare();
    });
    void this.chat.resumeSoftSync();
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.revokePreparedFiles();
  }

  async back(): Promise<void> {
    await this.router.navigateByUrl('/app/chats');
  }

  async refreshShare(): Promise<void> {
    await this.loadPendingShare(true);
  }

  async discardShare(): Promise<void> {
    await this.nativeDevice.clearPendingShareIntent(this.share?.id);
    this.share = null;
    this.note = '';
    this.selectedTargetIds.clear();
    this.revokePreparedFiles();
    await this.router.navigateByUrl('/app/chats');
  }

  visibleTargets(): ShareTarget[] {
    const query = this.normalize(this.query);
    return this.targets()
      .filter((target) => !query || this.normalize(`${target.title} ${target.subtitle}`).includes(query))
      .slice(0, 120);
  }

  selectedTargets(): ShareTarget[] {
    const selected = this.selectedTargetIds;
    return this.targets().filter((target) => selected.has(target.id));
  }

  toggleTarget(target: ShareTarget): void {
    const next = new Set(this.selectedTargetIds);
    if (next.has(target.id)) {
      next.delete(target.id);
    } else {
      next.add(target.id);
    }
    this.selectedTargetIds = next;
    this.error = '';
  }

  selectedCount(): number {
    return this.selectedTargetIds.size;
  }

  sharedFiles(): NativeShareFile[] {
    return this.share?.files ?? [];
  }

  sharedText(): string {
    return this.firstText(this.share?.text, this.share?.subject);
  }

  hasShareContent(): boolean {
    return Boolean(this.sharedFiles().length || this.sharedText());
  }

  fileIcon(item: NativeShareFile): string {
    const mime = item.mimeType || '';
    if (mime.startsWith('image/')) {
      return 'image-outline';
    }
    if (mime.startsWith('video/')) {
      return 'videocam-outline';
    }
    return 'document-attach-outline';
  }

  fileKindLabel(item: NativeShareFile): string {
    const mime = item.mimeType || '';
    if (mime.startsWith('image/')) {
      return this.tr('COMMON.IMAGE', 'Imagen');
    }
    if (mime.startsWith('video/')) {
      return this.tr('COMMON.VIDEO', 'Video');
    }
    return this.tr('COMMON.FILE', 'Archivo');
  }

  fileSize(item: NativeShareFile): string {
    const size = Number(item.size || 0);
    if (!Number.isFinite(size) || size <= 0) {
      return this.tr('COMMON.UNKNOWN_SIZE', 'Tamano pendiente');
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  }

  async sendShare(): Promise<void> {
    if (this.sending) {
      return;
    }
    const share = this.share;
    const targets = this.selectedTargets();
    if (!share || !this.hasShareContent()) {
      this.error = this.tr('SHARE.NO_CONTENT', 'No hay contenido compartido para enviar.');
      return;
    }
    if (!targets.length) {
      this.error = this.tr('SHARE.SELECT_CONTACTS', 'Selecciona al menos un contacto.');
      return;
    }

    this.sending = true;
    this.error = '';
    this.notice = '';
    let sentTargets = 0;
    try {
      const files = await this.prepareFiles();
      const message = files.length ? this.note.trim() : this.firstText(this.note, this.sharedText());
      for (const [targetIndex, target] of targets.entries()) {
        const conversation = await this.ensureConversation(target);
        if (this.chat.isConversationBlocked(conversation.id) || !this.chat.canSendToConversation(conversation)) {
          continue;
        }
        this.sendProgress = `${targetIndex + 1}/${targets.length} ${target.title}`;
        if (files.length) {
          for (const [fileIndex, file] of files.entries()) {
            await this.chat.sendFile(conversation, file, {
              mode: this.fileUploadMode(file),
              caption: fileIndex === 0 ? message : '',
            });
          }
        } else if (message) {
          await this.chat.sendText(conversation, message);
        }
        sentTargets += 1;
      }

      if (!sentTargets) {
        this.error = this.tr('SHARE.NO_ALLOWED_TARGETS', 'No se pudo enviar a los contactos seleccionados.');
        return;
      }

      await this.nativeDevice.clearPendingShareIntent(share.id);
      this.notice = sentTargets === 1
        ? this.tr('SHARE.SENT_ONE', 'Enviado.')
        : `${this.tr('SHARE.SENT_TO', 'Enviado a')} ${sentTargets}`;
      const firstConversation = await this.ensureConversation(targets[0]);
      await this.router.navigate(['/app/chats', firstConversation.id]);
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.tr('SHARE.ERROR_SEND', 'No se pudo enviar el contenido compartido.');
    } finally {
      this.sendProgress = '';
      this.sending = false;
    }
  }

  private async loadPendingShare(force = false): Promise<void> {
    this.loading = true;
    try {
      const share = await this.nativeDevice.getPendingShareIntent();
      if (!this.shareHasContent(share)) {
        this.share = null;
        this.loadedShareId = '';
        this.revokePreparedFiles();
        return;
      }
      if (!force && share.id === this.loadedShareId) {
        return;
      }
      this.share = share;
      this.loadedShareId = share.id;
      this.note = this.firstText(share.text, share.subject);
      this.error = '';
      this.notice = '';
      this.selectedTargetIds.clear();
      this.selectedTargetIds = new Set<string>();
      this.revokePreparedFiles();
    } finally {
      this.loading = false;
    }
  }

  private targets(): ShareTarget[] {
    const directUserIds = new Set<string>();
    const conversations = this.chat.conversations()
      .filter((conversation) => !this.chat.isConversationBlocked(conversation.id))
      .map((conversation) => {
        if (String(conversation.type || '').toLowerCase() === 'direct') {
          this.otherParticipantIds(conversation).forEach((userId) => directUserIds.add(userId));
        }
        return this.conversationTarget(conversation);
      });

    const contacts = this.chat.contacts()
      .filter((contact) => !directUserIds.has(contact.userId))
      .map((contact) => this.contactTarget(contact));

    return [...conversations, ...contacts].sort((left, right) => left.title.localeCompare(right.title));
  }

  private conversationTarget(conversation: Conversation): ShareTarget {
    const title = this.chat.conversationTitle(conversation);
    return {
      id: `conversation:${conversation.id}`,
      kind: 'conversation',
      title,
      subtitle: this.chat.conversationSubtitle(conversation),
      photo: this.chat.conversationPhoto(conversation),
      initials: this.chat.avatarLabel(conversation),
      conversation,
    };
  }

  private contactTarget(contact: Contact): ShareTarget {
    const title = this.contactLabel(contact);
    return {
      id: `contact:${contact.userId}`,
      kind: 'contact',
      title,
      subtitle: this.contactSubtitle(contact),
      photo: contact.profilePhotoDataUrl || '',
      initials: this.initials(title),
      contact,
    };
  }

  private async ensureConversation(target: ShareTarget): Promise<Conversation> {
    if (target.conversation) {
      return target.conversation;
    }
    if (!target.contact) {
      throw new Error(this.tr('SHARE.INVALID_TARGET', 'Contacto no valido.'));
    }
    return this.chat.createDirectConversation(this.contactAsUserSummary(target.contact));
  }

  private async prepareFiles(): Promise<File[]> {
    if (this.preparedFiles) {
      return this.preparedFiles;
    }
    const files: File[] = [];
    for (const [index, item] of this.sharedFiles().entries()) {
      this.sendProgress = `${this.tr('SHARE.PREPARING', 'Preparando')} ${index + 1}/${this.sharedFiles().length}`;
      files.push(await this.nativeDevice.sharedFileToFile(item));
    }
    this.preparedFiles = files;
    return files;
  }

  private revokePreparedFiles(): void {
    this.preparedFiles = null;
  }

  private fileUploadMode(file: File): 'media' | 'document' {
    return file.type.startsWith('image/') || file.type.startsWith('video/') ? 'media' : 'document';
  }

  private shareHasContent(share: NativeShareIntent | null): share is NativeShareIntent {
    return Boolean(share?.id && ((share.files?.length ?? 0) > 0 || this.firstText(share.text, share.subject)));
  }

  private otherParticipantIds(conversation: Conversation): string[] {
    const currentUserId = this.auth.session()?.user.id;
    return conversation.participants
      .filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
      .map((participant) => participant.userId);
  }

  private contactAsUserSummary(contact: Contact): UserSummary {
    return {
      id: contact.userId,
      alias: contact.alias || '',
      displayName: contact.displayName,
      phone: contact.phone,
      bio: contact.bio,
      profilePhotoDataUrl: contact.profilePhotoDataUrl,
      isDiscoverable: true,
      isContact: true,
      isMutualContact: true,
      isFavorite: contact.isFavorite,
      friendshipState: 'contact',
    };
  }

  private contactLabel(contact: Contact): string {
    return this.firstText(contact.displayName, contact.phone, contact.alias, this.tr('COMMON.CONTACT', 'Contacto'));
  }

  private contactSubtitle(contact: Contact): string {
    return this.firstText(contact.phone, contact.alias ? `@${contact.alias}` : '', contact.bio, this.tr('CALLS.ENCRYPTED_CONTACT', 'Contacto cifrado'));
  }

  private initials(value: string): string {
    return (value || 'N')
      .split(/\s|,|-/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'N';
  }

  private normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  private firstText(...values: Array<string | null | undefined>): string {
    return values.map((value) => (value || '').trim()).find(Boolean) || '';
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }
}
