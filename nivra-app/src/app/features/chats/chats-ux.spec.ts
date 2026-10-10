import { signal } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ActionSheetController } from '@ionic/angular/standalone';
import { EMPTY } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ChatService } from '../../core/services/chat.service';
import { SocialService } from '../../core/services/social.service';
import { LocalHistoryService } from '../../core/services/local-history.service';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { TranslateService } from '../../core/services/translate.service';
import { PushService } from '../../core/services/push.service';
import { ChatsPage } from './chats.page';

describe('Chats actions and scoped search', () => {
  let page: ChatsPage;
  let auth: any;
  let chat: any;
  let router: any;
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };

  beforeEach(() => {
    auth = { session: signal({ user: { id: 'ux-me', alias: 'maria' }, device: { id: 'ux-device' } }) };
    router = { events: EMPTY, url: '/app/chats', navigate: jasmine.createSpy().and.resolveTo(true), navigateByUrl: jasmine.createSpy().and.resolveTo(true), parseUrl: () => ({ root: { children: {} } }) };
    chat = {
      conversations: signal([{ id: 'family', title: 'Familía' }, { id: 'archived', title: 'Equipo' }]),
      loading: signal(false), bootstrap: jasmine.createSpy().and.resolveTo(),
      clearSelectedConversation: () => undefined,
      chatFolderConversations: (folder: string) => chat.conversations().filter((item: any) => folder === 'archived' ? item.id === 'archived' : item.id !== 'archived'),
      conversationTitle: (item: any) => item.title,
      searchPeople: jasmine.createSpy().and.resolveTo([]),
      createDirectConversation: jasmine.createSpy().and.resolveTo({ id: 'new-direct' }),
      profileSummary: (item: any) => item,
    };
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: router },
      { provide: AuthService, useValue: auth },
      { provide: AppSettingsService, useValue: {} },
      { provide: ChatService, useValue: chat },
      { provide: SocialService, useValue: { stories: signal([]), worldStories: signal([]), load: async () => undefined } },
      { provide: LocalHistoryService, useValue: { storageError: signal(''), retryNativeStorage: () => undefined, clearStorageError: () => undefined } },
      { provide: NativeDeviceService, useValue: {} },
      { provide: PushService, useValue: { permission: signal('unsupported'), registering: signal(false), requestPermissionAndRegister: jasmine.createSpy().and.resolveTo(true) } },
      { provide: ActionSheetController, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    page = TestBed.runInInjectionContext(() => new ChatsPage());
  });

  afterEach(() => {
    page.ngOnDestroy();
    localStorage.removeItem('nivra_recent_searches.ux-me');
    localStorage.removeItem('nivra_recent_searches.ux-other');
  });

  it('searches existing and archived chats locally with accent-insensitive matching', fakeAsync(() => {
    page.query = 'familia';
    page.setSearchScope('chats');
    tick(500);
    expect(page.matchingConversations().map((item) => item.id)).toEqual(['family']);
    page.query = 'equipo';
    page.onSearchChange();
    tick(500);
    expect(page.matchingConversations().map((item) => item.id)).toEqual(['archived']);
    expect(chat.searchPeople).not.toHaveBeenCalled();
  }));

  it('invalidates the previous response immediately before the input debounce elapses', async () => {
    const first = deferred<any[]>();
    chat.searchPeople.and.returnValue(first.promise);
    page.query = 'maria';
    const task = page.search();
    page.query = 'jo';
    page.onSearchChange();
    first.resolve([{ id: 'old-result' }]);
    await task;
    expect(page.searchResults).toEqual([]);
    expect(page.searching).toBeTrue();
    page.clearSearch();
  });

  it('keeps local search usable after the people directory fails and allows a retry', async () => {
    page.query = 'familia';
    chat.searchPeople.and.rejectWith(new Error('offline'));
    await page.search();
    expect(page.searchError).toContain('Tus chats siguen disponibles');
    expect(page.matchingConversations().map((item) => item.id)).toEqual(['family']);
    chat.searchPeople.and.resolveTo([{ id: 'person' }]);
    await page.search();
    expect(page.searchError).toBe('');
    expect(page.searchResults.map((item) => item.id)).toEqual(['person']);
  });

  it('does not reveal a pending directory response after switching accounts', async () => {
    const pending = deferred<any[]>();
    chat.searchPeople.and.returnValue(pending.promise);
    page.query = 'maria';
    const task = page.search();
    auth.session.set({ user: { id: 'ux-other', alias: 'other' }, device: { id: 'other-device' } });
    TestBed.flushEffects();
    pending.resolve([{ id: 'old-private-profile' }]);
    await task;
    expect(page.query).toBe('');
    expect(page.searchResults).toEqual([]);
    expect(page.searching).toBeFalse();
  });

  it('waits for the menu to dismiss before opening a group, and outside dismissal runs nothing', () => {
    page.openChatMenu(new Event('click'));
    page.chooseChatMenuAction('new-group');
    expect(page.groupModalOpen).toBeFalse();
    page.onChatMenuDismiss();
    expect(page.groupModalOpen).toBeTrue();
    page.closeGroupModal();
    page.openChatMenu(new Event('click'));
    page.onChatMenuDismiss();
    expect(page.groupModalOpen).toBeFalse();
  });

  it('drops a selected menu action if the account changes while its popover closes', () => {
    page.openChatMenu(new Event('click'));
    page.chooseChatMenuAction('share-pass');
    auth.session.set({ user: { id: 'ux-other', alias: 'other' }, device: { id: 'other-device' } });
    page.onChatMenuDismiss();
    expect(page.sharePassOpen).toBeFalse();
  });

  it('opens contact search from onboarding, and opens the pass directly without navigation', async () => {
    page.startNewChat();
    expect(page.searchScope).toBe('people');
    expect(page.showRecentSearches).toBeTrue();
    await page.openShareAccount();
    expect(page.sharePassOpen).toBeTrue();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('deduplicates double taps when starting a chat and never navigates an old account response', async () => {
    const pending = deferred<any>();
    chat.createDirectConversation.and.returnValue(pending.promise);
    const first = page.startConversation({ id: 'person' } as any);
    await page.startConversation({ id: 'person' } as any);
    expect(chat.createDirectConversation).toHaveBeenCalledTimes(1);
    auth.session.set({ user: { id: 'ux-other', alias: 'other' }, device: { id: 'other-device' } });
    TestBed.flushEffects();
    pending.resolve({ id: 'old-account-chat' });
    await first;
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not adopt unscoped recent profiles from a previous account', () => {
    localStorage.setItem('nivra_recent_searches', JSON.stringify([{ id: 'legacy-private-contact' }]));
    localStorage.removeItem('nivra_recent_searches.ux-other');
    auth.session.set({ user: { id: 'ux-other', alias: 'other' }, device: { id: 'other-device' } });
    TestBed.flushEffects();
    expect(page.recentSearches).toEqual([]);
    localStorage.removeItem('nivra_recent_searches');
  });

  it('coalesces repeated refresh taps into one bootstrap', async () => {
    const pending = deferred<void>();
    chat.bootstrap.and.returnValue(pending.promise);
    const task = page.refresh();
    await page.refresh();
    expect(chat.bootstrap).toHaveBeenCalledTimes(1);
    pending.resolve();
    await task;
    expect(page.syncNotice).toContain('al día');
    expect(page.refreshing).toBeFalse();
  });

  it('requests call notification permission only through the explicit action', async () => {
    const push = TestBed.inject(PushService) as any;
    spyOn(page, 'showCallAlertsSetup').and.returnValue(true);
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
    await page.enableCallAlerts();
    expect(push.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    expect(page.callAlertsNotice).toContain('activados');
  });
});
