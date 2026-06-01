import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
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
  IonNote,
  IonSpinner,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, closeOutline, searchOutline, syncOutline, trashOutline } from 'ionicons/icons';
import { UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';

@Component({
  selector: 'app-chats',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
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
    IonNote,
    IonSpinner,
  ],
  templateUrl: './chats.page.html',
  styleUrls: ['./chats.page.scss'],
})
export class ChatsPage implements OnDestroy {
  readonly chat = inject(ChatService);
  private readonly auth = inject(AuthService);
  query = '';
  searchResults: UserSummary[] = [];
  searching = false;
  recentSearches = this.loadRecent();
  private timer: number | null = null;
  private searchSeq = 0;

  constructor() {
    addIcons({ addOutline, closeOutline, searchOutline, syncOutline, trashOutline });
  }

  ngOnDestroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
  }

  refresh(): void {
    void this.chat.bootstrap();
  }

  onSearchChange(): void {
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
    await this.chat.selectConversation(conversationId);
  }

  async startConversation(person: UserSummary): Promise<void> {
    await this.chat.createDirectConversation(person);
    this.rememberRecent(person);
    this.query = '';
    this.searchResults = [];
  }

  clearSearch(): void {
    this.searchSeq += 1;
    this.query = '';
    this.searchResults = [];
    this.searching = false;
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
}
