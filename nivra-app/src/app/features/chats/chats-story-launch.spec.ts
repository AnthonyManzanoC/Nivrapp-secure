import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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

describe('Chats story creation entry', () => {
  let page: ChatsPage;
  let navigate: jasmine.Spy;
  let chat: any;
  let history: any;

  beforeEach(() => {
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    chat = {
      bootstrap: jasmine.createSpy('bootstrap').and.resolveTo(),
      conversations: signal([]),
      loading: signal(false),
      listUpdating: signal(false), syncError: signal(''),
      deviceHistory: { state: signal('idle') },
      messagesByConversation: signal({}),
      clearSelectedConversation: () => undefined,
    };
    history = {
      storageError: signal(''),
      storageState: signal('ready'),
      storageBusy: () => ['opening', 'retrying'].includes(history.storageState()),
      retryNativeStorage: jasmine.createSpy('retryNativeStorage').and.resolveTo(true),
      clearStorageError: jasmine.createSpy('clearStorageError').and.callFake(() => history.storageError.set('')),
    };
    chat.refreshChats = jasmine.createSpy('refreshChats').and.callFake(async () => {
      const localReady = await history.retryNativeStorage();
      await chat.bootstrap();
      return localReady;
    });
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: { events: EMPTY, url: '/app/chats', navigate, parseUrl: () => ({ root: { children: {} } }) } },
      { provide: AuthService, useValue: { session: signal({ user: { id: 'me', alias: 'maria' } }), deviceIdentityError: signal(''), deviceIdentityNeedsRelink: signal(false) } },
      { provide: AppSettingsService, useValue: {} },
      { provide: ChatService, useValue: chat },
      { provide: SocialService, useValue: { stories: signal([]), worldStories: signal([]), load: async () => undefined } },
      { provide: LocalHistoryService, useValue: history },
      { provide: NativeDeviceService, useValue: {} },
      { provide: PushService, useValue: { permission: signal('unsupported'), registering: signal(false) } },
      { provide: ActionSheetController, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    page = TestBed.runInInjectionContext(() => new ChatsPage());
  });

  afterEach(() => page.ngOnDestroy());

  it('opens the shared composer from an empty own avatar without leaving Chats', () => {
    const own = page.storyHighlights()[0];
    expect(own.isOwn).toBeTrue();
    expect(own.initials).toBe('MA');
    page.activateStoryHighlight(own);
    expect(page.storyComposerOpen).toBeTrue();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps existing own stories playable while the separate add button creates another', () => {
    const own = { ...page.storyHighlights()[0], stories: [{ id: 'story-1' } as any] };
    const openViewer = spyOn(page, 'openStoryHighlight').and.resolveTo();
    page.activateStoryHighlight(own);
    expect(openViewer).toHaveBeenCalledOnceWith(own);
    expect(page.storyComposerOpen).toBeFalse();
    const event = { stopPropagation: jasmine.createSpy('stopPropagation') } as unknown as Event;
    page.openStoryComposer(event);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(page.storyComposerOpen).toBeTrue();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps Chats open after a publication and updates the inline confirmation', () => {
    page.storyPublished('Historia publicada.');
    expect(page.storyPublishNotice).toBe('Historia publicada.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps stories compact until explicitly opened and does not expand them when returning to the list start', () => {
    const scroll = (scrollTop: number, scrollHeight: number, clientHeight: number) =>
      page.onChatListScroll({ target: { scrollTop, scrollHeight, clientHeight } } as unknown as Event);
    expect(page.storiesCollapsed).toBeTrue();
    page.expandStories();
    scroll(90, 480, 380);
    expect(page.storiesCollapsed).toBeFalse();
    scroll(90, 900, 380);
    expect(page.storiesCollapsed).toBeTrue();
    scroll(0, 900, 480);
    expect(page.storiesCollapsed).toBeTrue();
    page.expandStories();
    expect(page.storiesCollapsed).toBeFalse();
  });

  it('waits for a proven local recovery before refreshing the remote index', async () => {
    history.storageError.set('No se pudo abrir el historial cifrado.');
    const order: string[] = [];
    history.retryNativeStorage.and.callFake(async () => { order.push('sqlite'); history.storageError.set(''); return true; });
    chat.bootstrap.and.callFake(async () => { order.push('remote'); });
    await page.refresh();
    expect(chat.bootstrap).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['sqlite', 'remote']);
    expect(history.clearStorageError).not.toHaveBeenCalled();
    expect(history.storageError()).toBe('');
  });

  it('leaves the encrypted-history warning visible when retry fails', async () => {
    history.storageError.set('No se pudo abrir el historial cifrado.');
    chat.bootstrap.and.rejectWith(new Error('offline'));

    await page.refresh();

    expect(history.clearStorageError).not.toHaveBeenCalled();
    expect(history.storageError()).toContain('historial cifrado');
  });

  it('shows loading without inventing an error while encrypted storage is opening', () => {
    history.storageState.set('opening');
    expect(page.conversationIndexLoading()).toBeTrue();
    expect(page.visibleStorageError()).toBe('');
    history.storageState.set('ready');
    expect(page.conversationIndexLoading()).toBeFalse();
  });

  it('does not erase a local failure when only the cloud refresh succeeded', async () => {
    history.storageError.set('No se pudo abrir el historial cifrado.');
    history.storageState.set('error');
    history.retryNativeStorage.and.resolveTo(false);
    await page.refresh();
    expect(chat.bootstrap).toHaveBeenCalledTimes(1);
    expect(history.clearStorageError).not.toHaveBeenCalled();
    expect(page.visibleStorageError()).toContain('historial cifrado');
    expect(page.syncNotice).toContain('historial local sigue pendiente');
  });

  it('keeps a known failure visible during retry until the local service confirms recovery', () => {
    history.storageError.set('No se pudo abrir el historial cifrado.');
    history.storageState.set('retrying');
    chat.loading.set(true);
    expect(page.conversationIndexLoading()).toBeTrue();
    expect(page.visibleStorageError()).toContain('historial cifrado');
    history.storageError.set('');
    history.storageState.set('ready');
    chat.loading.set(false);
    expect(page.visibleStorageError()).toBe('');
    expect(page.conversationIndexLoading()).toBeFalse();
  });

  it('keeps an explicit refresh busy until its real work settles and coalesces repeated clicks', async () => {
    let finish!: (ready: boolean) => void;
    history.retryNativeStorage.and.returnValue(new Promise<boolean>(resolve => { finish = resolve; }));
    const first = page.refresh();
    expect(page.refreshing).toBeTrue();
    expect(page.conversationIndexLoading()).toBeTrue();
    await page.refresh();
    expect(history.retryNativeStorage).toHaveBeenCalledTimes(1);
    expect(chat.bootstrap).not.toHaveBeenCalled();
    finish(true); await first;
    expect(page.refreshing).toBeFalse();
    expect(chat.bootstrap).toHaveBeenCalledTimes(1);
  });
});
