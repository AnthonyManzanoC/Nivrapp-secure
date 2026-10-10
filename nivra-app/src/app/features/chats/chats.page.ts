import { CommonModule } from '@angular/common';
import { Component, EffectRef, ElementRef, NgZone, OnDestroy, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import {
  ActionSheetController,
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
  IonPopover,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, archiveOutline, chatbubbleEllipsesOutline, checkmarkOutline, chevronForwardOutline, closeOutline, ellipsisVerticalOutline, imageOutline, notificationsOffOutline, notificationsOutline, peopleOutline, personOutline, pinOutline, playCircleOutline, searchOutline, settingsOutline, shareSocialOutline, syncOutline, trashOutline } from 'ionicons/icons';
import { Subscription } from 'rxjs';
import { ChatMessageVm, Contact, Conversation, Story, StoryComment, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ChatFolderFilter, ChatService } from '../../core/services/chat.service';
import { SocialService } from '../../core/services/social.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { StoryViewerComponent } from '../story-viewer/story-viewer.component';
import { ImageCropperComponent } from '../image-cropper/image-cropper.component';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { LocalHistoryService } from '../../core/services/local-history.service';
import { ChatStoryHighlight, chatStoryRingColor, groupChatStoryHighlights, withOwnChatStoryHighlight } from './chat-story-highlights';
import { StoryComposerComponent } from '../../shared/story-composer/story-composer.component';
import { HistorySyncNoticeComponent } from '../../shared/history-sync-notice.component';
import { ChatWelcomeComponent } from './chat-welcome.component';
import { ChatPassComponent } from './chat-pass.component';
import { PushService } from '../../core/services/push.service';
import { Capacitor } from '@capacitor/core';

type ChatSearchScope = 'all' | 'chats' | 'people';
type ChatMenuAction = 'new-chat' | 'new-group' | 'new-story' | 'share-pass' | 'refresh' | 'settings';

@Component({
  selector: 'app-chats',
  standalone: true,
  imports: [
    LocalizedDatePipe,
    CommonModule,
    FormsModule,
    RouterOutlet,
    TranslatePipe,
    StoryViewerComponent,
    StoryComposerComponent,
    HistorySyncNoticeComponent,
    ChatWelcomeComponent,
    ChatPassComponent,
    ImageCropperComponent,
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
    IonPopover,
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
  readonly localHistory = inject(LocalHistoryService);
  readonly visibleStorageError = signal('');
  private readonly translate = inject(TranslateService);
  private readonly ngZone = inject(NgZone);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly actionSheetController = inject(ActionSheetController);
  private readonly nativeDevice = inject(NativeDeviceService);
  private readonly push = inject(PushService);
  private readonly nativeAndroid = Capacitor.getPlatform() === 'android';
  private readonly storyStripNow = signal(Date.now());
  readonly storyHighlights = computed(() => {
    const currentUser = this.auth.session()?.user;
    if (!currentUser) {
      return [];
    }
    const groups = new Map(this.chat.conversations()
      .filter((conversation) => this.chat.isGroup(conversation))
      .map((conversation) => [conversation.id.toLowerCase(), conversation]));
    return withOwnChatStoryHighlight(groupChatStoryHighlights([...this.social.stories(), ...this.social.worldStories()], currentUser.id, this.storyStripNow()), currentUser.id)
      .filter((highlight) => !highlight.isGroup || groups.has(highlight.targetId))
      .map((highlight) => {
        const group = groups.get(highlight.targetId);
        const storyOwner = highlight.stories[highlight.stories.length - 1]?.owner;
        const owner = highlight.isOwn ? currentUser : this.chat.profileSummary(storyOwner!);
        const title = highlight.isOwn
          ? this.tr('CHATS.MY_STORY', 'Mi historia')
          : highlight.isGroup && group
            ? this.chat.conversationTitle(group)
            : owner.displayName || owner.alias;
        return {
          ...highlight,
          title,
          photo: highlight.isGroup && group ? this.chat.conversationPhoto(group) : owner.profilePhotoDataUrl,
          initials: (highlight.isOwn ? owner.displayName || owner.alias : title).slice(0, 2).toUpperCase(),
          ringColor: chatStoryRingColor(highlight),
        };
      });
  });
  query = '';
  searchResults: UserSummary[] = [];
  searching = false;
  searchScope: ChatSearchScope = 'all';
  searchError = '';
  startingPersonId = '';
  refreshing = false;
  syncNotice = '';
  chatMenuOpen = false;
  chatMenuEvent: Event | null = null;
  sharePassOpen = false;
  enablingCallAlerts = false;
  callAlertsNotice = '';
  private pendingMenuAction: { action: ChatMenuAction; scope: string } | null = null;
  recentSearches = this.loadRecent();
  showRecentSearches = false;
  recentCollapsed = true;
  detailActive = false;
  groupModalOpen = false;
  groupName = '';
  groupAvatar: string | null = null;
  groupAvatarCropFile: File | null = null;
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
  storyComposerOpen = false;
  storyPublishNotice = '';
  avatarActionsOpen = false;
  avatarActionsEvent: Event | null = null;
  avatarActionsConversation: Conversation | null = null;
  profilePhotoViewerUrl = '';
  profilePhotoViewerTitle = '';
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
  private storyTransitionInFlight = false;
  private pointerStartedAt = 0;
  private pointerStartY = 0;
  private avatarPressTimer: number | null = null;
  private suppressAvatarClickUntil = 0;
  private storyStripTimer: number | null = null;
  private storageWarningTimer: number | null = null;
  private readonly storageWarningEffect: EffectRef;
  private readonly accountScopeEffect: EffectRef;
  private accountScope = this.searchContext();
  private alive = true;
  storyHighlightOpening = '';
  storiesCollapsed = false;
  @ViewChild('conversationList', { read: ElementRef }) private conversationList?: ElementRef<HTMLElement>;
  @ViewChild('chatSearchInput') private chatSearchInput?: IonInput;

  constructor() {
    this.accountScopeEffect = effect(() => {
      const scope = this.searchContext();
      if (scope !== this.accountScope) {
        this.accountScope = scope;
        this.searchSeq += 1;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        this.query = '';
        this.searchResults = [];
        this.searching = false;
        this.searchError = '';
        this.startingPersonId = '';
        this.syncNotice = '';
        this.refreshing = false;
        this.showRecentSearches = false;
        this.recentSearches = this.loadRecent();
        this.selectedFolder = 'all';
        this.sharePassOpen = false;
        this.enablingCallAlerts = false;
        this.callAlertsNotice = '';
        this.chatMenuOpen = false;
        this.pendingMenuAction = null;
        this.groupModalOpen = false;
        this.groupName = '';
        this.groupAvatar = null;
        this.groupAvatarCropFile = null;
        this.selectedGroupUserIds = new Set<string>();
        this.storyComposerOpen = false;
        this.storyViewerQueue = [];
        this.stopStoryProgress();
      }
    });
    this.storageWarningEffect = effect((onCleanup) => {
      const warning = this.localHistory.storageError();
      const loading = this.chat.loading();
      this.visibleStorageError.set('');
      if (warning && !loading) {
        // Brief native vault errors can recover during foreground sync. Avoid
        // flashing a warning for an episode that resolves by itself.
        this.storageWarningTimer = window.setTimeout(() => {
          this.storageWarningTimer = null;
          if (this.localHistory.storageError() === warning && !this.chat.loading()) {
            this.ngZone.run(() => this.visibleStorageError.set(warning));
          }
        }, 900);
        onCleanup(() => {
          if (this.storageWarningTimer !== null) window.clearTimeout(this.storageWarningTimer);
          this.storageWarningTimer = null;
        });
      }
    });
    addIcons({
      addOutline,
      archiveOutline,
      chatbubbleEllipsesOutline,
      checkmarkOutline,
      chevronForwardOutline,
      closeOutline,
      ellipsisVerticalOutline,
      imageOutline,
      notificationsOffOutline,
      notificationsOutline,
      peopleOutline,
      personOutline,
      pinOutline,
      playCircleOutline,
      searchOutline,
      settingsOutline,
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
    this.storyStripTimer = window.setInterval(() => this.storyStripNow.set(Date.now()), 30_000);
    queueMicrotask(() => this.syncSelectedConversationFromUrl(this.router.url));
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.searchSeq += 1;
    this.accountScopeEffect.destroy();
    this.storageWarningEffect.destroy();
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.stopStoryProgress();
    this.cancelAvatarPress();
    if (this.storyStripTimer !== null) {
      window.clearInterval(this.storyStripTimer);
    }
    if (this.storageWarningTimer !== null) {
      window.clearTimeout(this.storageWarningTimer);
    }
    this.routeSub?.unsubscribe();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    const scope = this.searchContext();
    this.refreshing = true;
    this.syncNotice = '';
    this.localHistory.retryNativeStorage();
    void this.social.load().catch(() => undefined);
    try {
      await this.chat.bootstrap();
      if (!this.isCurrentScope(scope)) return;
      // Capacitor's SQLite promise may resolve outside Angular's zone.  The
      // explicit zone entry makes the encrypted-history warning disappear as
      // soon as a manual reload succeeds.
      this.ngZone.run(() => this.localHistory.clearStorageError());
      this.syncNotice = this.tr('CHATS.SYNCED', 'Tus chats están al día.');
    } catch {
      // Keep the warning visible when either local storage or the remote
      // reload failed.  It contains the action the user can take next.
      if (this.isCurrentScope(scope)) this.syncNotice = this.tr('CHATS.SYNC_ERROR', 'No se pudo actualizar. Inténtalo cuando tengas conexión.');
    } finally {
      if (this.isCurrentScope(scope)) this.refreshing = false;
    }
  }

  ionViewDidEnter(): void {
    this.storyStripNow.set(Date.now());
    void this.social.load().catch(() => undefined);
    void this.refreshRecentProfiles();
  }

  async openShareAccount(): Promise<void> {
    if (this.auth.session()) this.sharePassOpen = true;
  }

  openChatMenu(event: Event): void {
    this.chatMenuEvent = event;
    this.pendingMenuAction = null;
    this.chatMenuOpen = true;
  }

  chooseChatMenuAction(action: ChatMenuAction): void {
    this.pendingMenuAction = { action, scope: this.searchContext() };
    this.chatMenuOpen = false;
  }

  onChatMenuDismiss(): void {
    const pending = this.pendingMenuAction;
    this.chatMenuOpen = false;
    this.chatMenuEvent = null;
    this.pendingMenuAction = null;
    if (!pending || !this.isCurrentScope(pending.scope)) return;
    switch (pending.action) {
      case 'new-chat': this.startNewChat(); break;
      case 'new-group': this.openGroupModal(); break;
      case 'new-story': this.openStoryComposer(); break;
      case 'share-pass': void this.openShareAccount(); break;
      case 'refresh': void this.refresh(); break;
      case 'settings': void this.router.navigateByUrl('/app/account'); break;
    }
  }

  onChatMenuKeydown(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const menu = event.currentTarget as HTMLElement;
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % buttons.length
      : (index - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  startNewChat(): void {
    this.query = '';
    this.searchScope = 'people';
    this.invalidateSearch();
    this.onSearchFocus();
    void this.chatSearchInput?.setFocus();
  }

  closeSearch(): void {
    this.clearSearch();
    this.hideRecent();
    this.searchScope = 'all';
  }

  ionViewWillLeave(): void {
    this.showRecentSearches = false;
    this.recentCollapsed = true;
    this.chatMenuOpen = false;
    this.pendingMenuAction = null;
    this.invalidateSearch();
  }

  onSearchFocus(): void {
    this.storiesCollapsed = false;
    if (!this.query.trim()) {
      this.showRecentSearches = true;
      this.recentCollapsed = false;
      void this.refreshRecentProfiles();
    }
  }

  onSearchChange(): void {
    this.invalidateSearch();
    this.syncNotice = '';
    if (this.query.trim().length >= 2) {
      this.showRecentSearches = false;
      this.recentCollapsed = true;
    }
    if (this.query.trim().length >= 2 && this.searchScope !== 'chats') {
      this.searching = true;
      this.timer = window.setTimeout(() => { this.timer = null; void this.search(); }, 280);
    }
  }

  setSearchScope(scope: ChatSearchScope): void {
    if (this.searchScope === scope) return;
    this.searchScope = scope;
    this.onSearchChange();
  }

  matchingConversations(): Conversation[] {
    if (this.searchScope === 'people') return [];
    const term = this.normalizeSearch(this.query);
    if (!term) return [];
    const visible = [...this.chat.chatFolderConversations('all'), ...this.chat.chatFolderConversations('archived')];
    return visible.filter((conversation) => this.normalizeSearch(this.chat.conversationTitle(conversation)).includes(term));
  }

  async search(): Promise<void> {
    const term = this.query.trim();
    if (term.length < 2 || this.searchScope === 'chats') {
      this.searchResults = [];
      this.searching = false;
      return;
    }
    const seq = ++this.searchSeq;
    const scope = this.searchContext();
    this.searching = true;
    this.searchError = '';
    try {
      const results = await this.chat.searchPeople(term);
      if (seq === this.searchSeq && this.query.trim() === term && this.isCurrentScope(scope)) {
        this.searchResults = results;
      }
    } catch {
      if (seq === this.searchSeq && this.isCurrentScope(scope)) {
        this.searchResults = [];
        this.searchError = this.tr('CHATS.SEARCH_ERROR', 'No se pudo buscar personas. Tus chats siguen disponibles.');
      }
    } finally {
      if (seq === this.searchSeq && this.isCurrentScope(scope)) {
        this.searching = false;
      }
    }
  }

  private invalidateSearch(): void {
    this.searchSeq += 1;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.searchResults = [];
    this.searching = false;
    this.searchError = '';
  }

  private normalizeSearch(value: string): string {
    return value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  }

  private searchContext(): string {
    const session = this.auth.session();
    return JSON.stringify([session?.user.id ?? '', session?.device?.id ?? '']);
  }

  private isCurrentScope(scope: string): boolean {
    return this.alive && this.searchContext() === scope;
  }

  firstConversation(): boolean { return this.chat.conversations().length === 0; }

  showCallAlertsSetup(): boolean {
    return this.nativeAndroid && this.push.permission() !== 'granted' && this.push.permission() !== 'unsupported';
  }

  callAlertsBusy(): boolean { return this.enablingCallAlerts || this.push.registering(); }

  async enableCallAlerts(): Promise<void> {
    if (this.callAlertsBusy() || !this.showCallAlertsSetup()) return;
    const scope = this.searchContext();
    this.enablingCallAlerts = true;
    this.callAlertsNotice = '';
    try {
      const ready = await this.push.requestPermissionAndRegister();
      if (this.isCurrentScope(scope)) {
        this.callAlertsNotice = ready
          ? this.tr('CHATS.CALL_ALERTS_READY', 'Avisos activados en este teléfono.')
          : this.tr('CHATS.CALL_ALERTS_ERROR', 'No se activaron los avisos. Revisa el permiso de notificaciones en los ajustes del teléfono y vuelve a intentar.');
      }
    } catch {
      if (this.isCurrentScope(scope)) this.callAlertsNotice = this.tr('CHATS.CALL_ALERTS_ERROR', 'No se activaron los avisos. Revisa el permiso de notificaciones en los ajustes del teléfono y vuelve a intentar.');
    } finally {
      if (this.isCurrentScope(scope)) this.enablingCallAlerts = false;
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

  activateStoryHighlight(highlight: ChatStoryHighlight): void {
    if (highlight.isOwn && !highlight.stories.length) {
      this.openStoryComposer();
      return;
    }
    void this.openStoryHighlight(highlight);
  }

  openStoryComposer(event?: Event): void {
    event?.stopPropagation();
    this.storyPublishNotice = '';
    this.storyComposerOpen = true;
  }

  storyPublished(message: string): void {
    this.storyPublishNotice = message;
    this.storyStripNow.set(Date.now());
  }

  onChatListScroll(event: Event): void {
    const list = event.target as HTMLElement;
    if (list.scrollTop <= 8) {
      this.storiesCollapsed = false;
    } else if (list.scrollTop > 80 && list.scrollHeight - list.clientHeight > 180) {
      // Short lists stay expanded so changing the viewport cannot trigger a collapse/expand loop.
      this.storiesCollapsed = true;
    }
  }

  expandStories(): void {
    this.storiesCollapsed = false;
    this.conversationList?.nativeElement.scrollTo({ top: 0, behavior: 'instant' });
  }

  async openStoryHighlight(highlight: ChatStoryHighlight): Promise<void> {
    if (this.storyHighlightOpening) {
      return;
    }
    this.storyHighlightOpening = highlight.id;
    try {
      // Refresh through the existing audience checks before opening the shared viewer.
      if (highlight.isGroup) {
        await this.social.loadGroupStories(highlight.targetId).catch(() => []);
      } else {
        await this.social.load().catch(() => undefined);
      }
      this.storyStripNow.set(Date.now());
      const current = this.storyHighlights().find((item) => item.id === highlight.id);
      if (!current?.stories.length) {
        return;
      }
      this.storyViewerQueue = this.storiesForPlayback(current.stories, current.isOwn);
      this.storyViewerIndex = 0;
      await this.openQueuedStory();
    } finally {
      this.storyHighlightOpening = '';
    }
  }

  async abrirHistoria(conversation: Conversation, event: Event): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    if (Date.now() < this.suppressAvatarClickUntil) {
      return;
    }
    if (this.chat.isGroup(conversation)) {
      await this.social.loadGroupStories(conversation.id).catch(() => []);
    } else {
      await this.social.load().catch(() => undefined);
    }
    const stories = this.conversationStories(conversation);
    const photoUrl = this.chat.conversationPhoto(conversation);
    if (stories.length && photoUrl && !this.usesTouchAvatarPattern()) {
      this.avatarActionsConversation = conversation;
      this.avatarActionsEvent = event;
      this.avatarActionsOpen = true;
      return;
    }
    if (!stories.length) {
      if (photoUrl) {
        this.openListPhoto(conversation);
      } else {
        await this.openConversation(conversation.id);
      }
      return;
    }
    await this.openListStories(conversation);
  }

  startAvatarPress(conversation: Conversation, event: TouchEvent): void {
    if (!this.usesTouchAvatarPattern() || !this.chat.conversationPhoto(conversation) || !this.conversationHasStory(conversation)) {
      return;
    }
    event.stopPropagation();
    this.cancelAvatarPress();
    this.avatarPressTimer = window.setTimeout(() => {
      this.avatarPressTimer = null;
      this.suppressAvatarClickUntil = Date.now() + 750;
      void this.presentAvatarActionSheet(conversation);
    }, 460);
  }

  cancelAvatarPress(): void {
    if (this.avatarPressTimer !== null) {
      window.clearTimeout(this.avatarPressTimer);
      this.avatarPressTimer = null;
    }
  }

  async chooseListAvatarStory(): Promise<void> {
    const conversation = this.avatarActionsConversation;
    this.closeListAvatarActions();
    if (conversation) {
      await this.openListStories(conversation);
    }
  }

  chooseListAvatarPhoto(): void {
    const conversation = this.avatarActionsConversation;
    this.closeListAvatarActions();
    if (conversation) {
      this.openListPhoto(conversation);
    }
  }

  closeListAvatarActions(): void {
    this.avatarActionsOpen = false;
    this.avatarActionsEvent = null;
    this.avatarActionsConversation = null;
  }

  openListPhoto(conversation: Conversation): void {
    const photoUrl = this.chat.conversationPhoto(conversation);
    if (!photoUrl) {
      return;
    }
    this.profilePhotoViewerUrl = photoUrl;
    this.profilePhotoViewerTitle = this.chat.conversationTitle(conversation);
  }

  closeListPhoto(): void {
    this.profilePhotoViewerUrl = '';
    this.profilePhotoViewerTitle = '';
  }

  private async openListStories(conversation: Conversation): Promise<void> {
    const stories = this.conversationStories(conversation);
    if (!stories.length) {
      return;
    }
    this.storyViewerQueue = this.storiesForPlayback(stories, false);
    this.storyViewerIndex = 0;
    await this.openQueuedStory();
  }

  async previousStory(): Promise<void> {
    if (this.storyTransitionInFlight) return;
    this.storyTransitionInFlight = true;
    this.stopStoryProgress();
    try {
    if (this.storyViewerIndex > 0) {
      this.storyViewerIndex -= 1;
      await this.openQueuedStory();
      return;
    }
    this.restartStoryProgress();
    } finally {
      this.storyTransitionInFlight = false;
    }
  }

  async nextStory(): Promise<void> {
    if (this.storyTransitionInFlight || !this.storyViewerQueue.length) return;
    this.storyTransitionInFlight = true;
    this.stopStoryProgress();
    try {
    if (this.storyViewerIndex < this.storyViewerQueue.length - 1) {
      this.storyViewerIndex += 1;
      await this.openQueuedStory();
      return;
    }
    this.closeStoryViewer();
    } finally {
      this.storyTransitionInFlight = false;
    }
  }

  private storiesForPlayback(stories: Story[], isOwn: boolean): Story[] {
    if (isOwn) return [...stories];
    const unseen = stories.filter((story) => !story.viewedByMe && !this.isMine(story));
    return unseen.length ? unseen : [...stories];
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
      this.expandStories();
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
    if (this.startingPersonId) return;
    const scope = this.searchContext();
    this.startingPersonId = person.id;
    this.searchError = '';
    try {
      const conversation = await this.chat.createDirectConversation(person);
      if (!this.isCurrentScope(scope)) return;
      this.rememberRecent(person);
      this.closeSearch();
      await this.router.navigate(['/app/chats', conversation.id]);
    } catch {
      if (this.isCurrentScope(scope)) this.searchError = this.tr('CHATS.OPEN_CHAT_ERROR', 'No se pudo abrir el chat. Vuelve a intentarlo.');
    } finally {
      if (this.isCurrentScope(scope)) this.startingPersonId = '';
    }
  }

  clearSearch(): void {
    this.invalidateSearch();
    this.query = '';
    this.searchResults = [];
    this.searching = false;
    this.showRecentSearches = true;
    this.recentCollapsed = false;
  }

  removeRecent(person: UserSummary, event: Event): void {
    event.stopPropagation();
    this.recentSearches = this.recentSearches.filter((item) => item.id !== person.id);
    this.persistRecent();
  }

  clearRecent(): void {
    this.recentSearches = [];
    try { localStorage.removeItem(this.recentKey()); } catch { /* Private browsers may block storage. */ }
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
    this.groupAvatarCropFile = null;
    this.selectedGroupUserIds = new Set<string>();
    this.groupModalOpen = true;
  }

  closeGroupModal(): void {
    if (this.groupBusy) {
      return;
    }
    this.groupModalOpen = false;
    this.groupAvatarCropFile = null;
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
    this.groupError = '';
    this.groupAvatarCropFile = file;
  }

  applyNewGroupAvatarCrop(dataUrl: string): void {
    this.groupAvatar = dataUrl;
    this.groupAvatarCropFile = null;
  }

  cancelNewGroupAvatarCrop(): void {
    this.groupAvatarCropFile = null;
  }

  clearGroupAvatar(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.groupAvatar = null;
  }

  private usesTouchAvatarPattern(): boolean {
    return this.nativeDevice.native || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  }

  private async presentAvatarActionSheet(conversation: Conversation): Promise<void> {
    const photoUrl = this.chat.conversationPhoto(conversation);
    const sheet = await this.actionSheetController.create({
      header: this.chat.isGroup(conversation)
        ? this.tr('CHAT.GROUP_PHOTO_AND_STORIES', 'Foto e historias del grupo')
        : this.tr('CHAT.PROFILE_PHOTO_AND_STORIES', 'Foto e historias'),
      cssClass: 'nivra-avatar-action-sheet',
      buttons: [
        {
          text: this.tr('CHAT.OPEN_STORIES', 'Ver historia'),
          icon: 'play-circle-outline',
          handler: () => {
            void this.openListStories(conversation);
          },
        },
        {
          text: this.chat.isGroup(conversation)
            ? this.tr('CHAT.VIEW_GROUP_PHOTO', 'Ver foto del grupo')
            : this.tr('CHAT.VIEW_PROFILE_PHOTO', 'Ver foto de perfil'),
          icon: 'image-outline',
          handler: () => {
            if (photoUrl) {
              this.openListPhoto(conversation);
            }
          },
        },
        {
          text: this.tr('COMMON.CANCEL', 'Cancelar'),
          icon: 'close-outline',
          role: 'cancel',
        },
      ],
    });
    await sheet.present();
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
    const current = this.chat.profileSummary(person);
    const next = [current, ...this.recentSearches.filter((item) => item.id !== current.id)].slice(0, 8);
    this.recentSearches = next;
    this.persistRecent();
  }

  private async refreshRecentProfiles(): Promise<void> {
    if (!this.recentSearches.length) {
      return;
    }
    const scope = this.searchContext();
    try { await this.chat.refreshProfiles(this.recentSearches.map((person) => person.id)); }
    catch { return; }
    if (!this.isCurrentScope(scope)) return;
    this.recentSearches = this.recentSearches.map((person) => this.chat.profileSummary(person));
    this.persistRecent();
  }

  private loadRecent(): UserSummary[] {
    if (!this.auth.session()?.user.id) return [];
    try {
      const scoped = JSON.parse(localStorage.getItem(this.recentKey()) || 'null') as UserSummary[] | null;
      if (Array.isArray(scoped)) {
        return scoped;
      }
      // The old unscoped key may belong to another account on a shared device.
      return [];
    } catch {
      return [];
    }
  }

  private recentKey(): string {
    const session = this.auth.session();
    return session?.user?.id ? `nivra_recent_searches.${session.user.id}` : 'nivra_recent_searches';
  }

  private persistRecent(): void {
    if (!this.auth.session()?.user.id) return;
    try { localStorage.setItem(this.recentKey(), JSON.stringify(this.recentSearches)); }
    catch { /* Recents remain useful in memory when storage is unavailable. */ }
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
      this.preloadAdjacentStories();
    } catch {
      this.closeStoryViewer();
    }
  }

  private conversationStories(conversation: Conversation): Story[] {
    const isGroup = String(conversation.type || '').toLowerCase() === 'group';
    const stories = isGroup
      ? this.social.activeStoriesForGroup(conversation.id)
      : this.social.activeStoriesForOwner(this.directPeerId(conversation));
    return stories
      .slice()
      .sort((left, right) => Date.parse(left.createdAt || '') - Date.parse(right.createdAt || ''));
  }

  private preloadAdjacentStories(): void {
    const adjacent = [
      this.storyViewerQueue[this.storyViewerIndex - 1],
      this.storyViewerQueue[this.storyViewerIndex + 1],
    ];
    for (const story of adjacent) {
      void this.social.preloadStory(story).catch(() => undefined);
    }
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
