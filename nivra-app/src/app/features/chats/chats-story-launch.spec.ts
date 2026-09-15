import { NgZone, signal } from '@angular/core';
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
      { provide: SocialService, useValue: { stories: signal([]), load: async () => undefined } },
      { provide: LocalHistoryService, useValue: history },
      { provide: NativeDeviceService, useValue: {} },
      { provide: ActionSheetController, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    page = TestBed.runInInjectionContext(() => new ChatsPage());
  });

  afterEach(() => page.ngOnDestroy());

  it('opens the real media picker synchronously from an empty own avatar', () => {
    const input = document.createElement('input');
    input.type = 'file';
    const click = spyOn(input, 'click');
    const own = page.storyHighlights()[0];
    expect(own.isOwn).toBeTrue();
    expect(own.initials).toBe('MA');
    page.activateStoryHighlight(own, input);
    expect(click).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('passes the selected file to the existing World composer as transient data', async () => {
    const file = new File(['photo'], 'story.jpg', { type: 'image/jpeg' });
    const input = { files: [file], value: 'selected' };
    await page.storyDraftFileSelected({ target: input } as unknown as Event);
    expect(input.value).toBe('');
    expect(navigate).toHaveBeenCalledOnceWith(['/app/world'], { fragment: 'story-composer', info: { storyDraftFile: file } });
  });

  it('keeps Chats open when the media picker is cancelled', async () => {
    await page.storyDraftFileSelected({ target: { files: [], value: '' } } as unknown as Event);
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
});
