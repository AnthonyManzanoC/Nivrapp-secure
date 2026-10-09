import { signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { UnreadTabService } from './unread-tab.service';

describe('UnreadTabService', () => {
  const signedIn = signal(true);
  const unread = signal(new Set(['direct', 'group']));
  const chats = signal([{ id: 'direct' }, { id: 'group' }, { id: 'already-read' }]);
  let oldTitle: string;

  beforeEach(() => {
    oldTitle = document.title;
    signedIn.set(true); unread.set(new Set(['direct', 'group']));
    chats.set([{ id: 'direct' }, { id: 'group' }, { id: 'already-read' }]);
    TestBed.configureTestingModule({ providers: [
      Title,
      { provide: AuthService, useValue: { isAuthenticated: signedIn } },
      { provide: ChatService, useValue: {
        visibleConversations: chats,
        hasUnreadConversation: (conversation: { id: string }) => unread().has(conversation.id),
      } },
    ] });
  });
  afterEach(() => { document.title = oldTitle; });

  it('updates the title when chats become read or a new unread chat arrives', () => {
    TestBed.inject(UnreadTabService); TestBed.flushEffects();
    expect(document.title).toBe('(2) Nivra - Private Messenger');
    unread.set(new Set(['group'])); TestBed.flushEffects();
    expect(document.title).toBe('(1) Nivra - Private Messenger');
    chats.update(items => [...items, { id: 'new' }]);
    unread.set(new Set(['group', 'new'])); TestBed.flushEffects();
    expect(document.title).toBe('(2) Nivra - Private Messenger');
  });

  it('clears the badge after logout without exposing message or contact text', () => {
    TestBed.inject(UnreadTabService); TestBed.flushEffects();
    signedIn.set(false); TestBed.flushEffects();
    expect(document.title).toBe('Nivra - Private Messenger');
  });

  it('clears the badge when all conversations are read', () => {
    TestBed.inject(UnreadTabService); TestBed.flushEffects();
    unread.set(new Set()); TestBed.flushEffects();
    expect(document.title).toBe('Nivra - Private Messenger');
  });
});
