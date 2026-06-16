import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonButton, IonContent, IonIcon, IonInput, IonModal, IonSpinner, IonTextarea, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addOutline,
  barChartOutline,
  chatbubbleEllipsesOutline,
  checkmarkOutline,
  closeOutline,
  documentAttachOutline,
  eyeOutline,
  fingerPrintOutline,
  happyOutline,
  heart,
  heartOutline,
  imageOutline,
  personAddOutline,
  personRemoveOutline,
  phonePortraitOutline,
  refreshOutline,
  repeatOutline,
  scanOutline,
  searchOutline,
  sendOutline,
  shieldCheckmarkOutline,
  star,
  starOutline,
  timeOutline,
  trashOutline,
} from 'ionicons/icons';
import { ChatMessageVm, Contact, Conversation, Story, StoryComment, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { ContactSyncService } from '../../core/services/contact-sync.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { SocialService } from '../../core/services/social.service';
import { Router } from '@angular/router';

interface StoryBucket {
  id: string;
  owner: UserSummary;
  title: string;
  subtitle: string;
  stories: Story[];
  latestAt: string;
  unviewedCount: number;
  isGroup: boolean;
  targetId: string | null;
}

@Component({
  selector: 'app-world',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, TranslatePipe, IonButton, IonContent, IonIcon, IonInput, IonModal, IonSpinner, IonTextarea],
  templateUrl: './world.page.html',
  styleUrls: ['./world.page.scss'],
})
export class WorldPage implements OnInit, OnDestroy {
  readonly social = inject(SocialService);
  readonly auth = inject(AuthService);
  readonly chat = inject(ChatService);
  readonly contactSync = inject(ContactSyncService);
  readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly toastController = inject(ToastController);
  query = '';
  storyText = '';
  visibility = 'Contacts';
  storyAudience = 'contacts';
  durationSeconds = 24 * 60 * 60;
  viewOnce = false;
  storyFile: File | null = null;
  radarPhones = '';
  busyId = '';
  error = '';
  notice = '';
  storyReply = '';
  reactionsOpen = false;
  statsOpen = false;
  viewerQueue: Story[] = [];
  viewerIndex = 0;
  viewerBuckets: StoryBucket[] = [];
  viewerBucketIndex = 0;
  storyProgress = 0;
  viewerUiHidden = false;
  readonly storyReactionOptions = ['\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F44F}', '\u{1F525}'];
  private readonly defaultStoryDurationMs = 5000;
  private currentStoryDurationMs = this.defaultStoryDurationMs;
  private timer: number | null = null;
  private progressTimer: number | null = null;
  private progressStartedAt = 0;
  private progressElapsed = 0;
  private storyPaused = false;
  private pointerStartedAt = 0;
  private pointerStartY = 0;

  constructor() {
    addIcons({
      addOutline,
      barChartOutline,
      chatbubbleEllipsesOutline,
      checkmarkOutline,
      closeOutline,
      documentAttachOutline,
      eyeOutline,
      fingerPrintOutline,
      happyOutline,
      heart,
      heartOutline,
      imageOutline,
      personAddOutline,
      personRemoveOutline,
      phonePortraitOutline,
      refreshOutline,
      repeatOutline,
      scanOutline,
      searchOutline,
      sendOutline,
      shieldCheckmarkOutline,
      star,
      starOutline,
      timeOutline,
      trashOutline,
    });
  }

  async ngOnInit(): Promise<void> {
    await this.social.load();
    void this.contactSync.syncCachedContactsInBackground();
  }

  ngOnDestroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.stopStoryProgress();
  }

  searchChanged(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => void this.social.search(this.query), 300);
  }

  storyFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.storyFile = input.files?.[0] ?? null;
    input.value = '';
  }

  clearStoryFile(): void {
    this.storyFile = null;
  }

  async request(person: UserSummary): Promise<void> {
    await this.run(person.id, async () => {
      await this.social.requestFriend(person);
      this.notice = this.tr('WORLD.NOTICE_REQUEST_SENT', 'Solicitud enviada.');
    });
  }

  async addContact(person: UserSummary): Promise<void> {
    await this.run(`contact:${person.id}`, async () => {
      await this.social.addContact(person);
      this.notice = this.tr('WORLD.NOTICE_CONTACT_SAVED', 'Contacto guardado.');
    });
  }

  async scanRadar(): Promise<void> {
    await this.run('radar', async () => {
      const response = await this.social.scanPhoneRadar(this.radarPhones);
      if (response.matched) {
        this.notice = this.social.radarNewCount()
          ? `${this.social.radarNewCount()} contacto nuevo en Nivra.`
          : `${response.matched} contacto${response.matched === 1 ? '' : 's'} detectado${response.matched === 1 ? '' : 's'}.`;
      } else {
        this.notice = response.submitted ? this.tr('WORLD.NO_MATCHES_NOW', 'Sin coincidencias por ahora.') : this.tr('WORLD.ADD_PHONES_SCAN', 'Agrega telefonos para escanear.');
      }
      this.contactSync.clearContactJoinedHint();
    });
  }

  async pickDeviceContacts(): Promise<void> {
    await this.run('radar:picker', async () => {
      const phones = await this.contactSync.pickAndSyncDeviceContacts();
      this.radarPhones = phones.join('\n');
      await this.scanRadar();
      if (!this.social.radarMatches().length && this.contactSync.lastDeviceContactCount()) {
        this.notice = `${this.contactSync.lastDeviceContactCount()} ${this.tr('WORLD.CONTACTS_SYNCED_HINT', 'telefonos sincronizados. Si alguno visible usa Nivra, aparecera aqui.')}`;
      }
    });
  }

  async openPerson(person: UserSummary): Promise<void> {
    await this.run(`open:${person.id}`, async () => {
      const conversation = await this.chat.createDirectConversation(person);
      await this.router.navigateByUrl(`/app/chats/${conversation.id}`);
    });
  }

  async openContact(contact: Contact): Promise<void> {
    await this.openPerson(this.contactAsPerson(contact));
  }

  async toggleFavorite(contact: Contact): Promise<void> {
    await this.run(`favorite:${contact.userId}`, () => this.social.toggleFavorite(contact));
  }

  async deleteContact(contact: Contact): Promise<void> {
    if (!window.confirm(`Eliminar @${contact.alias} de tus contactos?`)) {
      return;
    }
    await this.run(`remove:${contact.userId}`, async () => {
      await this.social.deleteContact(contact);
      this.notice = this.tr('WORLD.NOTICE_CONTACT_DELETED', 'Contacto eliminado.');
    });
  }

  async accept(id: string): Promise<void> {
    await this.run(id, () => this.social.accept(id));
  }

  async reject(id: string): Promise<void> {
    await this.run(id, () => this.social.reject(id));
  }

  async cancel(id: string): Promise<void> {
    await this.run(id, () => this.social.cancel(id));
  }

  async publishStory(): Promise<void> {
    const text = this.storyText.trim();
    if (!text && !this.storyFile) {
      return;
    }
    const group = this.selectedStoryGroup();
    const targetType = group ? 'group' : 'contacts';
    const allowedUserIds = group
      ? group.participants.filter((participant) => !participant.removedAt).map((participant) => participant.userId)
      : [];
    await this.run('story', async () => {
      await this.social.publishStory({
        text,
        visibility: group ? 'SelectedUsers' : this.visibility,
        file: this.storyFile,
        durationSeconds: Number(this.durationSeconds),
        viewOnce: this.viewOnce,
        targetType,
        targetId: group?.id ?? null,
        allowedUserIds,
      });
      this.storyText = '';
      this.storyFile = null;
      this.viewOnce = false;
      this.storyAudience = 'contacts';
      this.notice = this.tr('WORLD.NOTICE_STORY_PUBLISHED', 'Historia publicada.');
    });
  }

  async openStory(story: Story): Promise<void> {
    const bucket = this.storyBuckets().find((item) => item.stories.some((candidate) => candidate.id === story.id));
    await this.openStoryBucket(bucket, story);
  }

  async openStoryBucket(bucket: StoryBucket | undefined, explicitStory: Story | null = null): Promise<void> {
    if (!bucket) {
      return;
    }
    this.viewerBuckets = this.playbackBuckets();
    this.viewerBucketIndex = Math.max(0, this.viewerBuckets.findIndex((item) => item.id === bucket.id));
    const activeBucket = this.viewerBuckets[this.viewerBucketIndex] ?? bucket;
    this.viewerQueue = activeBucket.stories;
    this.viewerIndex = explicitStory
      ? Math.max(0, this.viewerQueue.findIndex((item) => item.id === explicitStory.id))
      : this.firstUnviewedIndex(activeBucket);
    await this.run(`story:${activeBucket.id}`, () => this.openQueuedStory());
  }

  async previousStory(): Promise<void> {
    if (this.viewerIndex > 0) {
      this.viewerIndex -= 1;
      await this.openQueuedStory();
      return;
    }
    if (this.viewerBucketIndex > 0) {
      this.viewerBucketIndex -= 1;
      const bucket = this.viewerBuckets[this.viewerBucketIndex];
      this.viewerQueue = bucket.stories;
      this.viewerIndex = Math.max(0, bucket.stories.length - 1);
      await this.openQueuedStory();
      return;
    }
    this.restartStoryProgress();
  }

  async nextStory(): Promise<void> {
    if (this.viewerIndex < this.viewerQueue.length - 1) {
      this.viewerIndex += 1;
      await this.openQueuedStory();
      return;
    }
    if (this.viewerBucketIndex < this.viewerBuckets.length - 1) {
      this.viewerBucketIndex += 1;
      const bucket = this.viewerBuckets[this.viewerBucketIndex];
      this.viewerQueue = bucket.stories;
      this.viewerIndex = this.firstUnviewedIndex(bucket);
      await this.openQueuedStory();
      return;
    }
    this.closeStoryViewer();
  }

  onStoryPointerDown(event: PointerEvent): void {
    this.pointerStartedAt = Date.now();
    this.pointerStartY = event.clientY;
    this.viewerUiHidden = true;
    this.pauseStoryProgress();
  }

  onStoryPointerUp(event: PointerEvent, side: 'left' | 'right'): void {
    const held = Date.now() - this.pointerStartedAt > 420;
    const swipedUp = this.pointerStartY - event.clientY > 58;
    this.viewerUiHidden = false;
    this.resumeStoryProgress();
    if (swipedUp) {
      if (this.social.activeStory() && this.isMine(this.social.activeStory()!)) {
        this.openStats();
      }
      return;
    }
    if (held) {
      return;
    }
    void (side === 'left' ? this.previousStory() : this.nextStory());
  }

  onStoryPointerCancel(): void {
    this.viewerUiHidden = false;
    this.resumeStoryProgress();
  }

  progressFor(index: number): number {
    if (index < this.viewerIndex) {
      return 100;
    }
    if (index > this.viewerIndex) {
      return 0;
    }
    return this.storyProgress;
  }

  closeStoryViewer(): void {
    this.stopStoryProgress();
    this.social.closeStory();
    this.viewerQueue = [];
    this.viewerIndex = 0;
    this.viewerBuckets = [];
    this.viewerBucketIndex = 0;
    this.viewerUiHidden = false;
    this.storyReply = '';
    this.reactionsOpen = false;
    this.statsOpen = false;
  }

  openStats(): void {
    this.pauseStoryProgress();
    this.statsOpen = true;
  }

  closeStats(): void {
    this.statsOpen = false;
    this.resumeStoryProgress();
  }

  syncStoryMediaDuration(event: Event): void {
    const video = event.target as HTMLVideoElement | null;
    const duration = Number(video?.duration);
    if (Number.isFinite(duration) && duration > 0) {
      this.currentStoryDurationMs = Math.max(this.defaultStoryDurationMs, Math.ceil(duration * 1000));
    }
  }

  storyMediaEnded(): void {
    void this.nextStory();
  }

  async reactToStory(story: Story, emoji: string): Promise<void> {
    if (this.isMine(story)) {
      return;
    }
    await this.run(`react:${story.id}`, async () => {
      await this.social.reactStory(story, emoji);
      this.reactionsOpen = false;
      this.notice = emoji === '\u2764\uFE0F' ? this.tr('WORLD.NOTICE_LOVE_SENT', 'Me encanta enviado.') : this.tr('WORLD.NOTICE_REACTION_SENT', 'Reaccion enviada.');
    });
  }

  async repostStory(story: Story): Promise<void> {
    if (this.isMine(story)) {
      return;
    }
    await this.run(`repost:${story.id}`, async () => {
      await this.social.repostStory(story);
      this.notice = `${this.tr('WORLD.REPOSTED_FROM', 'Reposteado de')} @${story.owner.alias}.`;
    });
  }

  async sendStoryReply(story: Story): Promise<void> {
    const text = this.storyReply.trim();
    if (!text || this.isMine(story)) {
      return;
    }
    await this.run(`reply:${story.id}`, async () => {
      const conversation = await this.chat.createDirectConversation(story.owner);
      const message = await this.chat.sendText(conversation, text, {
        replyTo: this.storyReplyReference(story),
      });
      await this.social.commentStory(story, message?.id ?? null);
      this.storyReply = '';
      this.notice = this.tr('WORLD.NOTICE_REPLY_SENT', 'Respuesta enviada al chat.');
    });
  }

  async deleteStory(story: Story): Promise<void> {
    await this.run(`delete:${story.id}`, async () => {
      await this.social.deleteStory(story);
      this.notice = this.tr('WORLD.NOTICE_STORY_DELETED', 'Historia eliminada.');
    });
  }

  isMine(story: Story): boolean {
    return story.owner.id === this.auth.session()?.user.id;
  }

  viewerSubtitle(story: Story): string {
    if (story.originalAuthor?.alias) {
      return `Reposteado de @${story.originalAuthor.alias}`;
    }
    return story.expiresAt ? `Hasta ${new Date(story.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  }

  statsViews(story: Story): number {
    return story.views?.length || story.viewCount || 0;
  }

  statsReactions(story: Story): number {
    return story.reactions?.length || 0;
  }

  statsComments(story: Story): number {
    return story.comments?.length || 0;
  }

  latestStory(bucket: StoryBucket): Story {
    return bucket.stories[bucket.stories.length - 1]!;
  }

  storyCommentText(story: Story, comment: StoryComment): string {
    const message = this.findStoryCommentMessage(story, comment);
    const text = typeof message?.payload.text === 'string' ? message.payload.text.trim() : '';
    return text || 'Comentario cifrado en el chat';
  }

  storyGroups(): Conversation[] {
    const currentUserId = this.auth.session()?.user.id;
    return this.chat.conversations()
      .filter((conversation) => this.chat.isGroup(conversation))
      .filter((conversation) => conversation.participants.some((participant) =>
        !participant.removedAt && participant.userId === currentUserId))
      .sort((left, right) => this.chat.conversationTitle(left).localeCompare(this.chat.conversationTitle(right)));
  }

  selectedStoryGroup(): Conversation | null {
    if (this.storyAudience === 'contacts') {
      return null;
    }
    return this.storyGroups().find((conversation) => conversation.id === this.storyAudience) ?? null;
  }

  contactStories(): Story[] {
    return this.social.contactStories();
  }

  groupStories(): Story[] {
    return this.social.groupStories();
  }

  myStoryBuckets(): StoryBucket[] {
    const currentUserId = this.auth.session()?.user.id;
    return this.storyBuckets().filter((bucket) => bucket.owner.id === currentUserId);
  }

  recentStoryBuckets(): StoryBucket[] {
    const currentUserId = this.auth.session()?.user.id;
    return this.storyBuckets()
      .filter((bucket) => bucket.owner.id !== currentUserId)
      .filter((bucket) => bucket.unviewedCount > 0);
  }

  viewedStoryBuckets(): StoryBucket[] {
    const currentUserId = this.auth.session()?.user.id;
    return this.storyBuckets()
      .filter((bucket) => bucket.owner.id !== currentUserId)
      .filter((bucket) => bucket.unviewedCount === 0);
  }

  storyGroupTitle(story: Story): string {
    const group = this.chat.conversations().find((conversation) => conversation.id === story.targetId);
    return group ? this.chat.conversationTitle(group) : 'Grupo';
  }

  storyAudienceLabel(): string {
    const group = this.selectedStoryGroup();
    return group ? `Publicar en ${this.chat.conversationTitle(group)}` : 'Publicar para tus contactos';
  }

  isGhostMode(): boolean {
    const user = this.auth.session()?.user;
    return !user?.phone || user.isDiscoverable === false;
  }

  radarCountLabel(): string {
    const count = this.social.radarMatches().length;
    return `${count} coincidencia${count === 1 ? '' : 's'}`;
  }

  radarStateIcon(): string {
    if (this.contactSync.syncing()) {
      return 'refresh-outline';
    }
    return this.isGhostMode() ? 'finger-print-outline' : 'shield-checkmark-outline';
  }

  radarStateLabel(): string {
    if (this.contactSync.syncing()) {
      return this.tr('WORLD.SYNCING_AGENDA', 'Sincronizando agenda');
    }
    const contactCount = this.contactSync.lastDeviceContactCount();
    if (contactCount > 0) {
      return `${contactCount} ${this.tr('WORLD.PHONES_READY', 'telefonos listos')}`;
    }
    return this.isGhostMode() ? this.tr('WORLD.INVISIBLE_AGENDAS', 'Invisible para agendas') : this.tr('WORLD.AVAILABLE_MATCHES', 'Disponible para coincidencias');
  }

  async openAccount(): Promise<void> {
    await this.router.navigateByUrl('/app/account');
  }

  contactAsPerson(contact: Contact): UserSummary {
    return {
      id: contact.userId,
      alias: contact.alias,
      displayName: contact.displayName,
      profilePhotoDataUrl: contact.profilePhotoDataUrl,
      bio: null,
      isDiscoverable: true,
      isContact: true,
      isMutualContact: true,
      isFavorite: contact.isFavorite,
      friendshipState: 'friends',
    };
  }

  private async run(id: string, action: () => Promise<void>): Promise<void> {
    this.busyId = id;
    this.error = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la accion.');
      if (this.isUploadLimitError(this.error)) {
        await this.showPremiumToast(this.error);
      }
    } finally {
      this.busyId = '';
    }
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }

  private isUploadLimitError(message: string): boolean {
    return message.includes('limite robusto de cifrado local');
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

  private async openQueuedStory(): Promise<void> {
    const story = this.viewerQueue[this.viewerIndex];
    if (!story) {
      this.closeStoryViewer();
      return;
    }
    this.reactionsOpen = false;
    this.statsOpen = false;
    this.storyReply = '';
    await this.social.viewStory(story);
    this.viewerQueue = this.viewerQueue.map((item) => item.id === this.social.activeStory()?.id ? this.social.activeStory()! : item);
    if (this.viewerBuckets[this.viewerBucketIndex]) {
      this.viewerBuckets[this.viewerBucketIndex] = {
        ...this.viewerBuckets[this.viewerBucketIndex],
        stories: this.viewerQueue,
      };
    }
    this.restartStoryProgress();
  }

  private storyBuckets(): StoryBucket[] {
    const groups = new Map<string, StoryBucket>();
    for (const story of [...this.contactStories(), ...this.groupStories()]) {
      const isGroup = this.social.isGroupStory(story);
      const id = isGroup ? `group:${story.targetId || 'unknown'}:${story.owner.id}` : `contact:${story.owner.id}`;
      const groupTitle = isGroup ? this.storyGroupTitle(story) : '';
      const bucket = groups.get(id) ?? {
        id,
        owner: story.owner,
        title: story.owner.displayName || story.owner.alias,
        subtitle: isGroup ? groupTitle : `@${story.owner.alias}`,
        stories: [],
        latestAt: story.createdAt,
        unviewedCount: 0,
        isGroup,
        targetId: story.targetId ?? null,
      };
      bucket.stories.push(story);
      bucket.latestAt = this.latestDate(bucket.latestAt, story.createdAt);
      groups.set(id, bucket);
    }

    return [...groups.values()]
      .map((bucket) => {
        const stories = bucket.stories
          .sort((left, right) => Date.parse(left.createdAt || '') - Date.parse(right.createdAt || ''));
        const unviewedCount = stories.filter((story) => !story.viewedByMe && !this.isMine(story)).length;
        return {
          ...bucket,
          stories,
          latestAt: stories[stories.length - 1]?.createdAt ?? bucket.latestAt,
          unviewedCount,
        };
      })
      .sort((left, right) => Date.parse(right.latestAt || '') - Date.parse(left.latestAt || ''));
  }

  private playbackBuckets(): StoryBucket[] {
    return [
      ...this.myStoryBuckets(),
      ...this.recentStoryBuckets(),
      ...this.viewedStoryBuckets(),
    ];
  }

  private firstUnviewedIndex(bucket: StoryBucket): number {
    const index = bucket.stories.findIndex((story) => !story.viewedByMe && !this.isMine(story));
    return index >= 0 ? index : 0;
  }

  private latestDate(left: string, right: string): string {
    return Date.parse(right || '') > Date.parse(left || '') ? right : left;
  }

  private restartStoryProgress(): void {
    this.stopStoryProgress();
    this.storyProgress = 0;
    this.progressElapsed = 0;
    this.storyPaused = false;
    this.currentStoryDurationMs = this.defaultStoryDurationMs;
    this.progressStartedAt = Date.now();
    this.progressTimer = window.setInterval(() => this.tickStoryProgress(), 80);
  }

  private pauseStoryProgress(): void {
    if (this.storyPaused || this.progressTimer === null) {
      return;
    }
    this.progressElapsed += Date.now() - this.progressStartedAt;
    this.storyPaused = true;
  }

  private resumeStoryProgress(): void {
    if (!this.storyPaused || this.statsOpen || this.progressTimer === null) {
      return;
    }
    this.storyPaused = false;
    this.progressStartedAt = Date.now();
  }

  private stopStoryProgress(): void {
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    this.storyProgress = 0;
    this.progressElapsed = 0;
    this.storyPaused = false;
  }

  private tickStoryProgress(): void {
    if (this.storyPaused) {
      return;
    }
    const elapsed = this.progressElapsed + Date.now() - this.progressStartedAt;
    this.storyProgress = Math.min(100, (elapsed / this.currentStoryDurationMs) * 100);
    if (this.storyProgress >= 100) {
      void this.nextStory();
    }
  }

  private storyReplyReference(story: Story): unknown {
    const payload = this.social.storyPayload(story);
    return {
      kind: 'story',
      storyId: story.id,
      ownerUserId: story.owner.id,
      ownerAlias: story.owner.alias,
      preview: this.social.storyText(story).slice(0, 120),
      mediaMime: payload.media?.mime ?? null,
      mediaFileObjectId: story.mediaFileObjectId ?? null,
      originalAuthorAlias: story.originalAuthor?.alias ?? null,
      at: story.createdAt,
    };
  }

  private findStoryCommentMessage(story: Story, comment: StoryComment): ChatMessageVm | null {
    const messages = Object.values(this.chat.messagesByConversation()).flat();
    return messages.find((message) => message.id === comment.messageId)
      ?? messages.find((message) => {
        const reply = message.payload.replyTo as { kind?: unknown; storyId?: unknown } | null | undefined;
        return message.senderUserId === comment.user.id && reply?.kind === 'story' && reply.storyId === story.id;
      })
      ?? null;
  }
}
