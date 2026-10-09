import { Injectable, computed, effect, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';

const BASE_TITLE = 'Nivra - Private Messenger';

@Injectable({ providedIn: 'root' })
export class UnreadTabService {
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly title = inject(Title);
  readonly unreadChats = computed(() => this.auth.isAuthenticated()
    ? this.chat.visibleConversations().filter(conversation => this.chat.hasUnreadConversation(conversation)).length
    : 0);

  constructor() {
    effect(() => {
      const unread = this.unreadChats();
      this.title.setTitle(unread ? `(${unread > 999 ? '999+' : unread}) ${BASE_TITLE}` : BASE_TITLE);
    });
  }
}
