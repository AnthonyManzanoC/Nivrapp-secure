import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { ChatsPage } from './chats.page';

describe('Chat detail outlet layout transitions', () => {
  let page: any;
  beforeEach(() => {
    page = Object.assign(Object.create(ChatsPage.prototype), {
      alive: true, detailActive: false, detailTransition: 0,
      router: { url: '/app/chats' }, syncSelectedConversationFromUrl: jasmine.createSpy('syncSelectedConversation'),
    });
  });
  it('does not mutate an earlier parent binding during outlet activation or deactivation', fakeAsync(() => {
    page.onDetailActivate(); expect(page.detailActive).toBeFalse();
    flushMicrotasks(); expect(page.detailActive).toBeTrue();
    page.onDetailDeactivate(); expect(page.detailActive).toBeTrue();
    flushMicrotasks(); expect(page.detailActive).toBeFalse();
    expect(page.syncSelectedConversationFromUrl).toHaveBeenCalledWith('/app/chats');
  }));
  it('keeps the latest navigation when outlet callbacks race in the same frame', fakeAsync(() => {
    page.onDetailActivate(); page.onDetailDeactivate(); page.onDetailActivate();
    flushMicrotasks(); expect(page.detailActive).toBeTrue();
    expect(page.syncSelectedConversationFromUrl).not.toHaveBeenCalled();
  }));
  it('does not update a destroyed chat page after a queued callback', fakeAsync(() => {
    page.onDetailActivate(); page.alive = false;
    flushMicrotasks(); expect(page.detailActive).toBeFalse();
    expect(page.syncSelectedConversationFromUrl).not.toHaveBeenCalled();
  }));
});
