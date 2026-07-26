import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import {
  IonAvatar,
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, archiveOutline, checkmarkOutline, closeOutline, imageOutline, notificationsOffOutline, notificationsOutline, peopleOutline, pinOutline, searchOutline, shareSocialOutline, syncOutline, trashOutline } from 'ionicons/icons';
import { Subscription } from 'rxjs';
import { ChatMessageVm, Contact, Conversation, Story, StoryComment, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ChatFolderFilter, ChatService } from '../../core/services/chat.service';
import { SocialService } from '../../core/services/social.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { StoryViewerComponent } from '../story-viewer/story-viewer.component';

@Component({
  selector: 'app-chats',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    RouterOutlet,
    TranslatePipe,
    StoryViewerComponent,
    IonAvatar,
    IonButton,
    IonContent,
    IonIcon,
    IonInput,
    IonItem,
    IonItemOption,
    IonItemOptions,
    IonItemSliding,
    IonLabel,
    IonList,
    IonModal,
    IonNote,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
  ],
  templateUrl: './chats.page.html',
  styleUrls: ['./chats.page.scss'],
})
export class ChatsPage implements OnDestroy {
  readonly chat = inject(ChatService);
  readonly social = inject(SocialService);
  readonly appSettings = inject(AppSettingsService);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  query = '';
  searchResults: UserSummary[] = [];
  searching = false;
  recentSearches = this.loadRecent();
  showRecentSearches = false;
  recentCollapsed = true;
  detailActive = false;
  groupModalOpen = false;
  groupName = '';
  groupAvatar: string | null = null;
  groupBusy = false;
  groupError = '';
  selectedGroupUserIds = new Set<string>();
  selectedFolder: ChatFolderFilter = 'all';
  storyViewerQueue: Story[] = [];
  storyViewerIndex = 0;
  storyViewerProgress = 0;
  storyReply = '';
  reactionsOpen = false;
  statsOpen = false;
  viewerUiHidden = false;
  storyBusyId = '';
  storyError = '';
  readonly storyReactionOptions = ['\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F44F}', '\u{1F525}'];
  private timer: number | null = null;
  private searchSeq = 0;
  private routeSub?: Subscription;
  private readonly defaultStoryDurationMs = 5000;
  private storyProgressDurationMs = this.defaultStoryDurationMs;
  private storyProgressTimer: number | null = null;
  private storyProgressStartedAt = 0;
  private storyProgressElapsed = 0;
  private storyPaused = false;
  private pointerStartedAt = 0;
  private pointerStartY = 0;

  constructor() {
    addIcons({
      addOutline,
      archiveOutline,
      checkmarkOutline,
      closeOutline,
      imageOutline,
      notificationsOffOutline,
      notificationsOutline,
      peopleOutline,
      pinOutline,
      searchOutline,
      shareSocialOutline,
      syncOutline,
      trashOutline,
    });
    this.routeSub = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.syncSelectedConversationFromUrl(event.urlAfterRedirects);
      }
    });
    void this.social.load().catch(() => undefined);
    queueMicrotask(() => this.syncSelectedConversationFromUrl(this.router.url));
  }

  ngOnDestroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.stopStoryProgress();
    this.routeSub?.unsubscribe();
  }

  refresh(): void {
    void this.chat.bootstrap();
  }

  async openShareAccount(): Promise<void> {
    await this.router.navigateByUrl('/app/account');
  }

  ionViewWillLeave(): void {
    this.showRecentSearches = false;
    this.recentCollapsed = true;
  }

  onSearchFocus(): void {
    if (!this.query.trim()) {
      this.showRecentSearches = true;
      this.recentCollapsed = false;
    }
  }

  onSearchChange(): void {
    if (this.query.trim().length >= 2) {
      this.showRecentSearches = false;
      this.recentCollapsed = true;
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => void this.search(), 280);
  }

  async search(): Promise<void> {
    const term = this.query.trim();
    if (term.length < 2) {
      this.searchResults = [];
      return;
    }
    const seq = ++this.searchSeq;
    this.searching = true;
    try {
      const results = await this.chat.searchPeople(term);
      if (seq === this.searchSeq && this.query.trim() === term) {
        this.searchResults = results;
      }
    } finally {
      if (seq === this.searchSeq) {
        this.searching = false;
      }
    }
  }

  async openConversation(conversationId: string): Promise<void> {
    await this.router.navigate(['/app/chats', conversationId]);
    void this.chat.selectConversation(conversationId);
  }

  conversationHasStory(conversation: Conversation): boolean {
    return this.conversationStories(conversation).length > 0;
  }

  conversationHasUnviewedStory(conversation: Conversation): boolean {
    return this.conversationStories(conversation).some((story) => !story.viewedByMe && !this.isMine(story));
  }

  async abrirHistoria(conversation: Conversation, event: Event): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    const stories = this.conversationStories(conversation);
    if (!stories.length) {
      await this.openConversation(conversation.id);
      return;
    }
    this.storyViewerQueue = stories;
    const firstUnviewed = stories.findIndex((story) => !story.viewedByMe && !this.isMine(story));
    this.storyViewerIndex = firstUnviewed >= 0 ? firstUnviewed : 0;
    await this.openQueuedStory();
  }

  async previousStory(): Promise<void> {
    if (this.storyViewerIndex > 0) {
      this.storyViewerIndex -= 1;
      await this.openQueuedStory();
      return;
    }
    this.restartStoryProgress();
  }

  async nextStory(): Promise<void> {
    if (this.storyViewerIndex < this.storyViewerQueue.length - 1) {
      this.storyViewerIndex += 1;
      await this.openQueuedStory();
      return;
    }
    this.closeStoryViewer();
  }

  closeStoryViewer(): void {
    this.stopStoryProgress();
    this.social.closeStory();
    this.storyViewerQueue = [];
    this.storyViewerIndex = 0;
    this.storyReply = '';
    this.reactionsOpen = false;
    this.statsOpen = false;
    this.viewerUiHidden = false;
    this.storyError = '';
  }

  storyProgressFor(index: number): number {
    if (index < this.storyViewerIndex) {
      return 100;
    }
    if (index > this.storyViewerIndex) {
      return 0;
    }
    return this.storyViewerProgress;
  }

  storyProgressValues(): number[] {
    return this.storyViewerQueue.map((_story, index) => this.storyProgressFor(index));
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
      const story = this.social.activeStory();
      if (story && this.isMine(story)) {
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

  syncStoryMediaDuration(event: Event): void {
    const video = event.target as HTMLVideoElement | null;
    const duration = Number(video?.duration);
    if (Number.isFinite(duration) && duration > 0) {
      this.storyProgressDurationMs = Math.max(this.defaultStoryDurationMs, Math.ceil(duration * 1000));
    }
  }

  storyMediaEnded(): void {
    void this.nextStory();
  }

  openStats(): void {
    this.pauseStoryProgress();
    this.statsOpen = true;
  }

  closeStats(): void {
    this.statsOpen = false;
    this.resumeStoryProgress();
  }

  toggleStoryReactions(): void {
    this.reactionsOpen = !this.reactionsOpen;
    if (this.reactionsOpen) {
      this.pauseStoryProgress();
    } else {
      this.resumeStoryProgress();
    }
  }

  async reactToStory(story: Story, emoji: string): Promise<void> {
    if (this.isMine(story)) {
      return;
    }
    await this.runStory(`react:${story.id}`, async () => {
      await this.social.reactStory(story, emoji);
      this.reactionsOpen = false;
      this.resumeStoryProgress();
    });
  }

  async repostStory(story: Story): Promise<void> {
    if (this.isMine(story) || !this.canRepostStory(story)) {
      return;
    }
    await this.runStory(`repost:${story.id}`, () => this.social.repostStory(story).then(() => undefined));
  }

  async sendStoryReply(story: Story): Promise<void> {
    const text = this.storyReply.trim();
    if (!text || this.isMine(story)) {
      return;
    }
    await this.runStory(`reply:${story.id}`, async () => {
      const conversation = await this.chat.createDirectConversation(story.owner);
      const message = await this.chat.sendText(conversation, text, {
        replyTo: this.storyReplyReference(story),
      });
      await this.social.commentStory(story, message?.id ?? null);
      this.storyReply = '';
    });
  }

  viewerSubtitle(story: Story): string {
    if (story.originalAuthor?.alias) {
      return `${this.tr('WORLD.REPOSTED_FROM', 'Reposteado de')} @${story.originalAuthor.alias}`;
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

  storyCommentText(story: Story, comment: StoryComment): string {
    const message = this.findStoryCommentMessage(story, comment);
    const text = typeof message?.payload.text === 'string' ? message.payload.text.trim() : '';
    return text || this.tr('WORLD.ENCRYPTED_COMMENT_IN_CHAT', 'Comentario cifrado en el chat');
  }

  canRepostStory(story: Story): boolean {
    return !this.isMine(story) && story.allowReposts !== false && story.owner.allowStoryReposts !== false;
  }

  onDetailDeactivate(): void {
    this.detailActive = false;
    this.syncSelectedConversationFromUrl(this.router.url);
  }

  conversationsForFolder(): Conversation[] {
    return this.chat.chatFolderConversations(this.selectedFolder);
  }

  setFolder(value: string | number | undefined): void {
    if (value === 'all' || value === 'pinned' || value === 'unread' || value === 'archived') {
      this.selectedFolder = value;
    }
  }

  async togglePinned(conversation: Conversation, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.chat.setConversationPinned(conversation, !this.chat.isConversationPinned(conversation.id));
  }

  async toggleMuted(conversation: Conversation, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.chat.setConversationMuted(conversation, !this.chat.isConversationMuted(conversation.id));
  }

  async toggleArchived(conversation: Conversation, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.chat.setConversationArchived(conversation, !this.chat.isConversationArchived(conversation.id));
  }

  async startConversation(person: UserSummary): Promise<void> {
    const conversation = await this.chat.createDirectConversation(person);
    this.rememberRecent(person);
    this.query = '';
    this.searchResults = [];
    this.showRecentSearches = false;
    this.recentCollapsed = true;
    await this.router.navigate(['/app/chats', conversation.id]);
  }

  clearSearch(): void {
    this.searchSeq += 1;
    this.query = '';
    this.searchResults = [];
    this.searching = false;
    this.showRecentSearches = true;
    this.recentCollapsed = false;
  }

  removeRecent(person: UserSummary, event: Event): void {
    event.stopPropagation();
    this.recentSearches = this.recentSearches.filter((item) => item.id !== person.id);
    localStorage.setItem(this.recentKey(), JSON.stringify(this.recentSearches));
  }

  clearRecent(): void {
    this.recentSearches = [];
    localStorage.removeItem(this.recentKey());
  }

  hideRecent(event?: Event): void {
    event?.stopPropagation();
    this.showRecentSearches = false;
    this.recentCollapsed = true;
  }

  openGroupModal(): void {
    this.showRecentSearches = false;
    this.recentCollapsed = true;
    this.groupError = '';
    this.groupName = '';
    this.groupAvatar = null;
    this.selectedGroupUserIds = new Set<string>();
    this.groupModalOpen = true;
  }

  closeGroupModal(): void {
    if (this.groupBusy) {
      return;
    }
    this.groupModalOpen = false;
    this.groupError = '';
  }

  isGroupSelected(contact: Contact): boolean {
    return this.selectedGroupUserIds.has(contact.userId);
  }

  toggleGroupContact(contact: Contact, event?: Event): void {
    event?.stopPropagation();
    const next = new Set(this.selectedGroupUserIds);
    if (next.has(contact.userId)) {
      next.delete(contact.userId);
    } else {
      next.add(contact.userId);
    }
    this.selectedGroupUserIds = next;
  }

  contactLabel(contact: Contact): string {
    return contact.displayName || contact.phone || contact.alias || this.tr('COMMON.CONTACT', 'Contacto');
  }

  contactSubLabel(contact: Contact): string {
    return contact.phone || (contact.alias ? `@${contact.alias}` : this.tr('CALLS.ENCRYPTED_CONTACT', 'Contacto cifrado'));
  }

  async onGroupAvatarSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/') || file.size > 4 * 1024 * 1024) {
      this.groupError = this.tr('CHATS.GROUP_PHOTO_REQUIREMENTS', 'Elige una imagen de hasta 4 MB.');
      return;
    }
    try {
      this.groupAvatar = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      this.groupError = '';
    } catch {
      this.groupError = this.tr('CHAT.ERROR_GROUP_PHOTO', 'No se pudo cargar la foto del grupo.');
    }
  }

  clearGroupAvatar(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.groupAvatar = null;
  }

  async createGroup(): Promise<void> {
    if (this.groupBusy) {
      return;
    }
    const participantUserIds = [...this.selectedGroupUserIds];
    if (!participantUserIds.length) {
      this.groupError = this.tr('CHATS.SELECT_ONE_CONTACT', 'Selecciona al menos un contacto.');
      return;
    }
    this.groupBusy = true;
    this.groupError = '';
    try {
      const conversation = await this.chat.createGroupConversation({
        name: this.groupName,
        participantUserIds,
        groupAvatar: this.groupAvatar,
      });
      this.groupModalOpen = false;
      await this.router.navigate(['/app/chats', conversation.id]);
    } catch (error) {
      this.groupError = error instanceof Error ? error.message : this.tr('CHATS.ERROR_CREATE_GROUP', 'No se pudo crear el grupo.');
    } finally {
      this.groupBusy = false;
    }
  }

  private rememberRecent(person: UserSummary): void {
    const next = [person, ...this.recentSearches.filter((item) => item.id !== person.id)].slice(0, 8);
    this.recentSearches = next;
    localStorage.setItem(this.recentKey(), JSON.stringify(next));
  }

  private loadRecent(): UserSummary[] {
    try {
      const scoped = JSON.parse(localStorage.getItem(this.recentKey()) || 'null') as UserSummary[] | null;
      if (Array.isArray(scoped)) {
        return scoped;
      }
      const legacy = JSON.parse(localStorage.getItem('nivra_recent_searches') || '[]') as UserSummary[];
      return Array.isArray(legacy) ? legacy : [];
    } catch {
      return [];
    }
  }

  private recentKey(): string {
    const session = this.auth.session();
    return session?.user?.id ? `nivra_recent_searches.${session.user.id}` : 'nivra_recent_searches';
  }

  private syncSelectedConversationFromUrl(url: string): void {
    const segments = this.router.parseUrl(url).root.children['primary']?.segments.map((segment) => segment.path) ?? [];
    const chatsIndex = segments.findIndex((segment) => segment === 'chats');
    const conversationId = chatsIndex >= 0 ? segments[chatsIndex + 1] : null;
    if (!conversationId) {
      this.chat.clearSelectedConversation();
    }
  }

  private async openQueuedStory(): Promise<void> {
    const story = this.storyViewerQueue[this.storyViewerIndex];
    if (!story) {
      this.closeStoryViewer();
      return;
    }
    try {
      this.reactionsOpen = false;
      this.statsOpen = false;
      this.storyReply = '';
      this.storyError = '';
      await this.social.viewStory(story);
      const active = this.social.activeStory();
      if (active) {
        this.storyViewerQueue = this.storyViewerQueue.map((item) => item.id === active.id ? active : item);
      }
      this.restartStoryProgress();
    } catch {
      this.closeStoryViewer();
    }
  }

  private conversationStories(conversation: Conversation): Story[] {
    const isGroup = String(conversation.type || '').toLowerCase() === 'group';
    const stories = isGroup
      ? this.social.activeStoriesForGroup(conversation.id)
      : this.social.contactStories().filter((story) => story.owner.id === this.directPeerId(conversation));
    return stories
      .slice()
      .sort((left, right) => Date.parse(left.createdAt || '') - Date.parse(right.createdAt || ''));
  }

  private restartStoryProgress(): void {
    this.stopStoryProgress();
    this.storyViewerProgress = 0;
    this.storyProgressElapsed = 0;
    this.storyPaused = false;
    this.storyProgressDurationMs = this.defaultStoryDurationMs;
    this.storyProgressStartedAt = Date.now();
    this.storyProgressTimer = window.setInterval(() => this.tickStoryProgress(), 80);
  }

  private pauseStoryProgress(): void {
    if (this.storyPaused || this.storyProgressTimer === null) {
      return;
    }
    this.storyProgressElapsed += Date.now() - this.storyProgressStartedAt;
    this.storyPaused = true;
  }

  private resumeStoryProgress(): void {
    if (!this.storyPaused || this.statsOpen || this.storyProgressTimer === null) {
      return;
    }
    this.storyPaused = false;
    this.storyProgressStartedAt = Date.now();
  }

  private stopStoryProgress(): void {
    if (this.storyProgressTimer !== null) {
      window.clearInterval(this.storyProgressTimer);
      this.storyProgressTimer = null;
    }
    this.storyViewerProgress = 0;
    this.storyProgressElapsed = 0;
    this.storyPaused = false;
  }

  private tickStoryProgress(): void {
    if (this.storyPaused) {
      return;
    }
    const elapsed = this.storyProgressElapsed + Date.now() - this.storyProgressStartedAt;
    this.storyViewerProgress = Math.min(100, (elapsed / this.storyProgressDurationMs) * 100);
    if (this.storyViewerProgress >= 100) {
      void this.nextStory();
    }
  }

  isMine(story: Story): boolean {
    return story.owner.id === this.auth.session()?.user.id;
  }

  private async runStory(id: string, action: () => Promise<void>): Promise<void> {
    this.storyBusyId = id;
    this.storyError = '';
    try {
      await action();
    } catch (error) {
      this.storyError = error instanceof Error ? error.message : this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la accion.');
    } finally {
      this.storyBusyId = '';
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

  private directPeerId(conversation: Conversation): string | null {
    const currentUserId = this.auth.session()?.user.id;
    return conversation.participants.find((participant) => participant.userId !== currentUserId && !participant.removedAt)?.userId ?? null;
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }
}
