import { NgZone, signal } from '@angular/core';
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
      clearSelectedConversation: () => undefined,
    };
    history = {
      storageError: signal(''),
      retryNativeStorage: jasmine.createSpy('retryNativeStorage'),
      clearStorageError: jasmine.createSpy('clearStorageError').and.callFake(() => history.storageError.set('')),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: { events: EMPTY, url: '/app/chats', navigate, parseUrl: () => ({ root: { children: {} } }) } },
      { provide: AuthService, useValue: { session: signal({ user: { id: 'me', alias: 'maria' } }) } },
      { provide: AppSettingsService, useValue: {} },
      { provide: ChatService, useValue: chat },
      { provide: SocialService, useValue: { stories: signal([]), worldStories: signal([]), load: async () => undefined } },
      { provide: LocalHistoryService, useValue: history },
      { provide: NativeDeviceService, useValue: {} },
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

  it('collapses only scrollable lists and expands when returning to their start', () => {
    const scroll = (scrollTop: number, scrollHeight: number, clientHeight: number) =>
      page.onChatListScroll({ target: { scrollTop, scrollHeight, clientHeight } } as unknown as Event);
    scroll(90, 480, 380);
    expect(page.storiesCollapsed).toBeFalse();
    scroll(90, 900, 380);
    expect(page.storiesCollapsed).toBeTrue();
    scroll(0, 900, 480);
    expect(page.storiesCollapsed).toBeFalse();
  });

  it('clears the encrypted-history warning inside Angular after a successful retry', async () => {
    history.storageError.set('No se pudo abrir el historial cifrado.');
    const zoneRun = spyOn(TestBed.inject(NgZone), 'run').and.callThrough();

    await page.refresh();

    expect(chat.bootstrap).toHaveBeenCalledTimes(1);
    expect(zoneRun).toHaveBeenCalled();
    expect(history.clearStorageError).toHaveBeenCalledTimes(1);
    expect(history.storageError()).toBe('');
  });

  it('leaves the encrypted-history warning visible when retry fails', async () => {
    history.storageError.set('No se pudo abrir el historial cifrado.');
    chat.bootstrap.and.rejectWith(new Error('offline'));

    await page.refresh();

    expect(history.clearStorageError).not.toHaveBeenCalled();
    expect(history.storageError()).toContain('historial cifrado');
  });

  it('does not flash a warning that recovers during a foreground transition', fakeAsync(() => {
    history.storageError.set('Historial temporalmente bloqueado');
    TestBed.flushEffects();
    tick(100);
    history.storageError.set('');
    TestBed.flushEffects();
    tick(1000);
    expect(page.visibleStorageError()).toBe('');
  }));

  it('shows a persistent history failure after recovery has had time to finish', fakeAsync(() => {
    history.storageError.set('No se pudo abrir el historial cifrado.');
    TestBed.flushEffects();
    tick(899);
    expect(page.visibleStorageError()).toBe('');
    tick(1);
    expect(page.visibleStorageError()).toContain('historial cifrado');
    history.storageError.set('');
    TestBed.flushEffects();
    expect(page.visibleStorageError()).toBe('');
  }));

  it('starts the warning delay after initial chat loading finishes', fakeAsync(() => {
    chat.loading.set(true);
    history.storageError.set('No se pudo abrir el historial cifrado.');
    TestBed.flushEffects();
    tick(1000);
    expect(page.visibleStorageError()).toBe('');
    chat.loading.set(false);
    TestBed.flushEffects();
    tick(900);
    expect(page.visibleStorageError()).toContain('historial cifrado');
  }));
});
