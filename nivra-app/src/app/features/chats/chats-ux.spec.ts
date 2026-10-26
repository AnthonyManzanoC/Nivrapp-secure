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
import { HISTORY_STATUS_SNOOZE_MS } from '../../core/services/history-status-snooze.service';

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
    auth = { session: signal({ user: { id: 'ux-me', alias: 'maria' }, device: { id: 'ux-device' } }), deviceIdentityError: signal(''), deviceIdentityNeedsRelink: signal(false), relinkDevice: jasmine.createSpy('relinkDevice').and.resolveTo() };
    router = { events: EMPTY, url: '/app/chats', navigate: jasmine.createSpy().and.resolveTo(true), navigateByUrl: jasmine.createSpy().and.resolveTo(true), parseUrl: () => ({ root: { children: {} } }) };
    chat = {
      conversations: signal([{ id: 'family', title: 'Familía' }, { id: 'archived', title: 'Equipo' }]),
      loading: signal(false), bootstrap: jasmine.createSpy().and.resolveTo(),
      listUpdating: signal(false), syncError: signal(''),
      deviceHistory: { state: signal('idle'), recoveryStatus: signal('approval'), targetFingerprint: signal('ux-fixture-fingerprint') },
      messagesByConversation: signal({}),
      clearSelectedConversation: () => undefined,
      chatFolderConversations: (folder: string) => chat.conversations().filter((item: any) => folder === 'archived' ? item.id === 'archived' : item.id !== 'archived'),
      conversationTitle: (item: any) => item.title,
      searchPeople: jasmine.createSpy().and.resolveTo([]),
      createDirectConversation: jasmine.createSpy().and.resolveTo({ id: 'new-direct' }),
      isConversationPinned: () => false,
      isConversationMuted: () => false,
      isConversationArchived: () => false,
      setConversationPinned: jasmine.createSpy().and.resolveTo(),
      setConversationMuted: jasmine.createSpy().and.resolveTo(),
      setConversationArchived: jasmine.createSpy().and.resolveTo(),
      profileSummary: (item: any) => item,
    };
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: router },
      { provide: AuthService, useValue: auth },
      { provide: AppSettingsService, useValue: {} },
      { provide: ChatService, useValue: chat },
      { provide: SocialService, useValue: { stories: signal([]), worldStories: signal([]), load: async () => undefined } },
      { provide: LocalHistoryService, useValue: { storageError: signal(''), storageState: signal('ready'), storageBusy: () => false, retryNativeStorage: async () => true, clearStorageError: () => undefined } },
      { provide: NativeDeviceService, useValue: {} },
      { provide: PushService, useValue: { permission: signal('unsupported'), registering: signal(false), requestPermissionAndRegister: jasmine.createSpy().and.resolveTo(true) } },
      { provide: ActionSheetController, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    chat.refreshChats = jasmine.createSpy('refreshChats').and.callFake(async () => {
      const localReady = await TestBed.inject(LocalHistoryService).retryNativeStorage();
      await chat.bootstrap();
      return localReady;
    });
    page = TestBed.runInInjectionContext(() => new ChatsPage());
  });

  afterEach(() => {
    page.ngOnDestroy();
    localStorage.removeItem('nivra_recent_searches.ux-me');
    localStorage.removeItem('nivra_recent_searches.ux-other');
    for (const userId of ['ux-me', 'ux-other']) for (const deviceId of ['ux-device', 'other-device']) {
      localStorage.removeItem('nivra.historyStatusSnooze.v1.' + encodeURIComponent(JSON.stringify([userId, deviceId])));
    }
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

  it('replaces only unreadable last-message previews with silhouettes while approved history recovers', () => {
    const pending = chat.conversations()[0];
    const readable = chat.conversations()[1];
    chat.messagesByConversation.set({
      [pending.id]: [{ decryptError: true }],
      [readable.id]: [{ decryptError: false, payload: { text: 'Hola' } }],
    });
    chat.deviceHistory.state.set('waiting');
    expect(page.conversationPreviewLoading(pending)).toBeFalse();
    expect(page.conversationHistoryPending(pending)).toBeTrue();
    chat.deviceHistory.state.set('syncing');
    expect(page.conversationIndexLoading()).toBeTrue();
    expect(page.conversationPreviewLoading(pending)).toBeTrue();
    expect(page.conversationPreviewLoading(readable)).toBeFalse();
    chat.messagesByConversation.set({ [pending.id]: [{ decryptError: false, payload: { text: 'Recuperado' } }] });
    expect(page.conversationPreviewLoading(pending)).toBeFalse();
    expect(page.conversationHistoryPending(pending)).toBeFalse();
    chat.deviceHistory.state.set('idle');
    expect(page.conversationIndexLoading()).toBeFalse();
  });

  it('stops preview animation after a recovery attempt fails instead of spinning while waiting for approval', () => {
    const conversation = chat.conversations()[0];
    chat.messagesByConversation.set({ [conversation.id]: [{ decryptError: true }] });
    chat.deviceHistory.state.set('syncing');
    expect(page.conversationPreviewLoading(conversation)).toBeTrue();
    chat.deviceHistory.state.set('unavailable');
    expect(page.conversationIndexLoading()).toBeFalse();
    expect(page.conversationPreviewLoading(conversation)).toBeFalse();
    expect(page.conversationHistoryPending(conversation)).toBeTrue();
  });

  it('does not announce completed synchronization while the history still awaits another device', async () => {
    chat.deviceHistory.state.set('waiting');
    await page.refresh();
    expect(page.syncNotice).toBe('');
    expect(page.refreshing).toBeFalse();
  });

  it('hides only the pending reminder while keeping the actual incomplete history and manual synchronization accessible', async () => {
    chat.deviceHistory.state.set('waiting');
    expect(page.canSnoozeHistoryStatus()).toBeTrue(); page.snoozeHistoryStatus();
    expect(page.showHistoryStatus()).toBeFalse(); expect(page.hasHistoryStatus()).toBeTrue();
    expect(chat.deviceHistory.state()).toBe('waiting'); expect(chat.deviceHistory.targetFingerprint()).toBe('ux-fixture-fingerprint');
    expect(chat.refreshChats).not.toHaveBeenCalled();
    page.chooseChatMenuAction('refresh'); page.onChatMenuDismiss();
    expect(page.historyPanelOpen).toBeTrue(); await Promise.resolve(); await Promise.resolve();
    expect(chat.refreshChats).toHaveBeenCalledTimes(1); expect(page.syncNotice).toBe('');
  });

  it('re-exposes active storage, identity, network and recovery failures even during the saved snooze window', () => {
    chat.deviceHistory.state.set('waiting'); page.snoozeHistoryStatus();
    expect(page.showHistoryStatus()).toBeFalse();
    for (const status of ['partial', 'retryable']) {
      chat.deviceHistory.recoveryStatus.set(status); chat.deviceHistory.state.set('unavailable');
      expect(page.showHistoryStatus()).toBeTrue(); expect(page.canSnoozeHistoryStatus()).toBeFalse();
    }
    chat.deviceHistory.state.set('waiting'); chat.deviceHistory.recoveryStatus.set('retryable');
    expect(page.showHistoryStatus()).toBeTrue(); expect(page.canSnoozeHistoryStatus()).toBeFalse();
    chat.deviceHistory.recoveryStatus.set('partial'); expect(page.showHistoryStatus()).toBeFalse();
    auth.deviceIdentityError.set('Unreadable identity'); expect(page.showHistoryStatus()).toBeTrue(); expect(page.canSnoozeHistoryStatus()).toBeFalse();
    auth.deviceIdentityError.set(''); auth.deviceIdentityNeedsRelink.set(true); expect(page.showHistoryStatus()).toBeTrue();
    auth.deviceIdentityNeedsRelink.set(false); chat.syncError.set('offline'); expect(page.showHistoryStatus()).toBeTrue();
    chat.syncError.set(''); const storage = TestBed.inject(LocalHistoryService); storage.storageError.set('Locked storage'); expect(page.showHistoryStatus()).toBeTrue();
    storage.storageError.set(''); const busy = spyOn(storage, 'storageBusy').and.returnValue(true); expect(page.showHistoryStatus()).toBeTrue();
    busy.and.returnValue(false); chat.deviceHistory.state.set('syncing'); expect(page.showHistoryStatus()).toBeTrue();
  });

  it('does not hide a fresh device identity, another account or a device without a checked fingerprint', () => {
    chat.deviceHistory.state.set('waiting'); page.snoozeHistoryStatus(); expect(page.showHistoryStatus()).toBeFalse();
    chat.deviceHistory.targetFingerprint.set('new-device-key'); expect(page.showHistoryStatus()).toBeTrue();
    chat.deviceHistory.targetFingerprint.set(''); expect(page.canSnoozeHistoryStatus()).toBeFalse();
    chat.deviceHistory.targetFingerprint.set('ux-fixture-fingerprint');
    auth.session.set({ user: { id: 'ux-other' }, device: { id: 'other-device' } }); expect(page.showHistoryStatus()).toBeTrue();
    auth.session.set({ user: { id: 'ux-me' }, device: { id: 'other-device' } }); expect(page.showHistoryStatus()).toBeTrue();
  });

  it('reminds again after twenty-four hours using the minute clock and releases the hidden-notice timer', fakeAsync(() => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    chat.deviceHistory.state.set('waiting'); page.snoozeHistoryStatus(); TestBed.flushEffects();
    expect(page.showHistoryStatus()).toBeFalse(); expect((page as any).historySnoozeTimer).not.toBeNull();
    now += HISTORY_STATUS_SNOOZE_MS; tick(60_000); TestBed.flushEffects();
    expect(page.showHistoryStatus()).toBeTrue(); expect((page as any).historySnoozeTimer).toBeNull();
  }));

  it('does not label an empty new account as pending solely because its local store is opening', () => {
    chat.deviceHistory.state.set('idle'); spyOn(TestBed.inject(LocalHistoryService), 'storageBusy').and.returnValue(true);
    expect(page.hasHistoryStatus()).toBeFalse(); expect(page.showHistoryStatus()).toBeFalse(); expect(page.canSnoozeHistoryStatus()).toBeFalse();
  });

  it('clears transient refresh notices after they have been announced', fakeAsync(() => {
    void page.refresh();
    tick();
    expect(page.syncNotice).toContain('al día');
    tick(5_000);
    expect(page.syncNotice).toBe('');
  }));

  it('shows full-row loading during a list refresh while retaining cached conversations and previews', () => {
    const conversations = chat.conversations();
    const previews = { family: [{ decryptError: false, payload: { text: 'Hola' } }] };
    chat.messagesByConversation.set(previews);
    expect(page.showConversationSkeleton()).toBeFalse();
    chat.listUpdating.set(true);
    expect(page.showConversationSkeleton()).toBeTrue();
    expect(chat.conversations()).toBe(conversations);
    expect(chat.messagesByConversation()).toBe(previews);
    chat.listUpdating.set(false);
    expect(page.showConversationSkeleton()).toBeFalse();
    chat.deviceHistory.state.set('waiting');
    expect(page.showConversationSkeleton()).toBeFalse();
    expect(page.showHistoryStatus()).toBeTrue();
  });

  it('keeps existing conversations visible while local storage or initial bootstrap recovers', () => {
    spyOn(TestBed.inject(LocalHistoryService), 'storageBusy').and.returnValue(true);
    chat.loading.set(true);
    expect(page.conversationIndexLoading()).toBeTrue();
    expect(page.showConversationSkeleton()).toBeFalse();
    chat.conversations.set([]);
    expect(page.showConversationSkeleton()).toBeTrue();
  });

  it('completes pull-to-refresh only after the real refresh operation settles', async () => {
    const pending = deferred<boolean>();
    chat.refreshChats.and.returnValue(pending.promise);
    const complete = jasmine.createSpy('complete').and.resolveTo();
    const task = page.onPullRefresh({ detail: { complete } } as unknown as CustomEvent<{ complete: () => Promise<void> }>);
    expect(page.showConversationSkeleton()).toBeTrue();
    expect(complete).not.toHaveBeenCalled();
    pending.resolve(true);
    await task;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(page.showConversationSkeleton()).toBeFalse();
  });

  describe('Android list gesture for stories', () => {
    let list: { scrollTop: number; scrollHeight: number; clientHeight: number };
    const touch = (x: number, y: number, count = 1, target: EventTarget | null = null): TouchEvent => ({
      currentTarget: list, target: target ?? list,
      touches: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x + identifier, clientY: y })),
    } as unknown as TouchEvent);
    const scroll = (top: number) => {
      list.scrollTop = top;
      page.onChatListScroll({ target: list } as unknown as Event);
    };

    beforeEach(() => {
      list = { scrollTop: 0, scrollHeight: 1_400, clientHeight: 500 };
      spyOn(page, 'androidStoryGesturesEnabled').and.returnValue(true);
    });

    it('reveals stories after a downward pull that starts at the top, without refreshing chats', () => {
      page.onNativeStoryTouchStart(touch(120, 120));
      page.onNativeStoryTouchMove(touch(125, 190));
      expect(page.storiesCollapsed).toBeTrue();
      page.onNativeStoryTouchEnd(touch(125, 190, 0));
      expect(page.storiesCollapsed).toBeFalse();
      expect(chat.refreshChats).not.toHaveBeenCalled();
      expect(page.showConversationSkeleton()).toBeFalse();
    });

    it('does not reveal stories while scrolling in the middle and reveals them on a real return to the top', () => {
      list.scrollTop = 250;
      page.onNativeStoryTouchStart(touch(120, 120));
      page.onNativeStoryTouchMove(touch(123, 190));
      scroll(120);
      expect(page.storiesCollapsed).toBeTrue();
      page.onNativeStoryTouchEnd(touch(123, 190, 0));
      scroll(0);
      expect(page.storiesCollapsed).toBeFalse();
      expect(chat.refreshChats).not.toHaveBeenCalled();
    });

    it('ignores programmatic returns to the top without an active user scroll gesture', () => {
      scroll(250);
      scroll(0);
      expect(page.storiesCollapsed).toBeTrue();
    });

    it('folds expanded stories with an upward swipe even when the list cannot scroll', () => {
      for (const height of [0, 100, 500]) {
        list.scrollHeight = height;
        page.storiesCollapsed = false;
        page.onNativeStoryTouchStart(touch(120, 190));
        page.onNativeStoryTouchMove(touch(124, 138));
        page.onNativeStoryTouchEnd(touch(124, 138, 0));
        expect(page.storiesCollapsed).toBeTrue();
      }
      expect(chat.refreshChats).not.toHaveBeenCalled();
    });

    it('keeps the accordion open for a tap, cancelled swipe or horizontal story navigation', () => {
      page.storiesCollapsed = false;
      page.onNativeStoryTouchStart(touch(120, 190));
      page.onNativeStoryTouchMove(touch(124, 175));
      page.onNativeStoryTouchEnd(touch(124, 175, 0));
      expect(page.storiesCollapsed).toBeFalse();
      page.onNativeStoryTouchStart(touch(120, 190));
      page.onNativeStoryTouchMove(touch(190, 135));
      page.onNativeStoryTouchEnd(touch(190, 135, 0));
      expect(page.storiesCollapsed).toBeFalse();
      page.onNativeStoryTouchStart(touch(120, 190));
      page.onNativeStoryTouchMove(touch(120, 130));
      page.onNativeStoryTouchCancel();
      page.onNativeStoryTouchEnd(touch(120, 130, 0));
      expect(page.storiesCollapsed).toBeFalse();
    });

    it('does not turn a horizontal chat swipe into a story pull', () => {
      page.onNativeStoryTouchStart(touch(120, 120));
      page.onNativeStoryTouchMove(touch(190, 133));
      page.onNativeStoryTouchMove(touch(190, 210));
      page.onNativeStoryTouchEnd(touch(190, 210, 0));
      expect(page.storiesCollapsed).toBeTrue();
      expect(chat.refreshChats).not.toHaveBeenCalled();
    });

    it('yields to an Ionic swipe claimed after a small initial horizontal movement', () => {
      const sliding = document.createElement('ion-item-sliding');
      page.onNativeStoryTouchStart(touch(120, 120, 1, sliding));
      page.onNativeStoryTouchMove(touch(130, 123, 1, sliding));
      sliding.classList.add('item-sliding-active-slide');
      page.onNativeStoryTouchMove(touch(130, 200, 1, sliding));
      page.onNativeStoryTouchEnd(touch(130, 200, 0, sliding));
      expect(page.storiesCollapsed).toBeTrue();
      expect(chat.refreshChats).not.toHaveBeenCalled();
    });

    it('ignores an open sliding row, multi-touch and cancelled pulls', () => {
      const sliding = document.createElement('ion-item-sliding');
      sliding.classList.add('item-sliding-active-slide');
      page.onNativeStoryTouchStart(touch(120, 120, 1, sliding));
      page.onNativeStoryTouchMove(touch(120, 200));
      page.onNativeStoryTouchEnd(touch(120, 200, 0));
      expect(page.storiesCollapsed).toBeTrue();
      page.onNativeStoryTouchStart(touch(120, 120, 2));
      page.onNativeStoryTouchMove(touch(120, 200));
      page.onNativeStoryTouchEnd(touch(120, 200, 0));
      expect(page.storiesCollapsed).toBeTrue();
      page.onNativeStoryTouchStart(touch(120, 120));
      page.onNativeStoryTouchMove(touch(120, 200));
      page.onNativeStoryTouchCancel();
      page.onNativeStoryTouchEnd(touch(120, 200, 0));
      expect(page.storiesCollapsed).toBeTrue();
    });

    it('expires a completed touch gesture instead of expanding after an unrelated later scroll', fakeAsync(() => {
      list.scrollTop = 250;
      page.onNativeStoryTouchStart(touch(120, 120));
      page.onNativeStoryTouchMove(touch(120, 190));
      scroll(120);
      page.onNativeStoryTouchEnd(touch(120, 190, 0));
      tick(1_700);
      scroll(0);
      expect(page.storiesCollapsed).toBeTrue();
    }));

    it('never calls refresh from a stray Android refresher event', async () => {
      const complete = jasmine.createSpy('complete').and.resolveTo();
      await page.onPullRefresh({ detail: { complete } } as unknown as CustomEvent<{ complete: () => Promise<void> }>);
      expect(page.storiesCollapsed).toBeFalse();
      expect(chat.refreshChats).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });

  it('offers explicit relinking for an unsafe device identity without attempting another history transfer', async () => {
    auth.deviceIdentityError.set('Identity mismatch');
    auth.deviceIdentityNeedsRelink.set(true);
    expect(page.showHistoryStatus()).toBeTrue();
    expect(page.historyStatusTitle()).toContain('vincular');
    expect(auth.relinkDevice).not.toHaveBeenCalled();
    await page.relinkDevice();
    expect(auth.relinkDevice).toHaveBeenCalledTimes(1);
    expect(chat.refreshChats).not.toHaveBeenCalled();
  });

  it('restores a keyboard-focused conversation after the loading overlay without changing the list scroll', async () => {
    const list = document.createElement('div');
    const row = document.createElement('button');
    list.append(row);
    document.body.append(list);
    (page as any).conversationList = { nativeElement: list };
    try {
      row.focus();
      chat.listUpdating.set(true);
      list.setAttribute('inert', '');
      row.blur();
      TestBed.flushEffects();
      chat.listUpdating.set(false);
      list.removeAttribute('inert');
      TestBed.flushEffects();
      await Promise.resolve();
      expect(document.activeElement).toBe(row);
    } finally { list.remove(); }
  });

  it('does not steal focus back from search when the user changes focus during a list refresh', async () => {
    const list = document.createElement('div');
    const row = document.createElement('button');
    const search = document.createElement('input');
    list.append(row);
    document.body.append(list, search);
    (page as any).conversationList = { nativeElement: list };
    try {
      row.focus();
      chat.listUpdating.set(true);
      list.setAttribute('inert', '');
      row.blur();
      TestBed.flushEffects();
      search.focus();
      chat.listUpdating.set(false);
      list.removeAttribute('inert');
      TestBed.flushEffects();
      await Promise.resolve();
      expect(document.activeElement).toBe(search);
    } finally { list.remove(); search.remove(); }
  });

  it('requests call notification permission only through the explicit action', async () => {
    const push = TestBed.inject(PushService) as any;
    spyOn(page, 'showCallAlertsSetup').and.returnValue(true);
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
    await page.enableCallAlerts();
    expect(push.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    expect(page.callAlertsNotice).toContain('activados');
  });

  it('offers the same conversation preferences through the explicit menu without opening a chat', async () => {
    const conversation = chat.conversations()[0];
    const event = { preventDefault: jasmine.createSpy(), stopPropagation: jasmine.createSpy() } as unknown as Event;
    page.openConversationMenu(conversation, event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(page.conversationMenuOpen).toBeTrue();
    await page.chooseConversationAction('pin');
    expect(chat.setConversationPinned).toHaveBeenCalledOnceWith(conversation, true);
    expect(page.conversationMenuOpen).toBeFalse();
    expect(page.conversationActionNotice).toContain('guardada');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('coalesces repeated preference actions while persistence is pending', async () => {
    const pending = deferred<void>();
    chat.setConversationMuted.and.returnValue(pending.promise);
    const conversation = chat.conversations()[0];
    const task = page.toggleMuted(conversation);
    await page.toggleMuted(conversation);
    await page.toggleArchived(conversation);
    expect(chat.setConversationMuted).toHaveBeenCalledTimes(1);
    expect(chat.setConversationArchived).not.toHaveBeenCalled();
    expect(page.conversationActionBusy).toBe(conversation.id);
    pending.resolve();
    await task;
    expect(page.conversationActionBusy).toBe('');
  });

  it('recovers from a preference save failure and lets the user try again', async () => {
    const conversation = chat.conversations()[0];
    chat.setConversationArchived.and.rejectWith(new Error('storage unavailable'));
    await page.toggleArchived(conversation);
    expect(page.conversationActionError).toContain('No se pudo');
    expect(page.conversationActionBusy).toBe('');
    chat.setConversationArchived.and.resolveTo();
    await page.toggleArchived(conversation);
    expect(page.conversationActionError).toBe('');
    expect(page.conversationActionNotice).toContain('guardada');
  });

  it('drops an open conversation menu and a pending preference notice when the account changes', async () => {
    const pending = deferred<void>();
    chat.setConversationPinned.and.returnValue(pending.promise);
    const conversation = chat.conversations()[0];
    page.openConversationMenu(conversation, new Event('click'));
    const task = page.chooseConversationAction('pin');
    auth.session.set({ user: { id: 'ux-other', alias: 'other' }, device: { id: 'other-device' } });
    TestBed.flushEffects();
    pending.resolve();
    await task;
    expect(page.conversationMenuTarget).toBeNull();
    expect(page.conversationActionNotice).toBe('');
    expect(page.conversationActionBusy).toBe('');
    await page.chooseConversationAction('archive');
    expect(chat.setConversationArchived).not.toHaveBeenCalled();
  });
});
