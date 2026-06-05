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
import { addOutline, archiveOutline, checkmarkOutline, closeOutline, notificationsOffOutline, notificationsOutline, peopleOutline, pinOutline, searchOutline, shareSocialOutline, syncOutline, trashOutline } from 'ionicons/icons';
import { Subscription } from 'rxjs';
import { Contact, Conversation, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ChatFolderFilter, ChatService } from '../../core/services/chat.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';

@Component({
  selector: 'app-chats',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    RouterOutlet,
    TranslatePipe,
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
  groupBusy = false;
  groupError = '';
  selectedGroupUserIds = new Set<string>();
  selectedFolder: ChatFolderFilter = 'all';
  private timer: number | null = null;
  private searchSeq = 0;
  private routeSub?: Subscription;

  constructor() {
    addIcons({
      addOutline,
      archiveOutline,
      checkmarkOutline,
      closeOutline,
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
    queueMicrotask(() => this.syncSelectedConversationFromUrl(this.router.url));
  }

  ngOnDestroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
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

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }
}
