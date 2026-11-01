import { signal } from '@angular/core';
import { fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
import { ChatDetailPage } from './chat-detail.page';
import { ChatService } from '../../core/services/chat.service';

describe('Nonblocking durable text composer', () => {
  function harness() {
    const page: any = Object.create(ChatDetailPage.prototype);
    const session = signal<any>({ user: { id: 'a' }, device: { id: 'phone-a' } });
    const confirmed = signal<any[]>([]), pending = signal<any[]>([]), locked = signal(false);
    const enqueue = jasmine.createSpy().and.callFake(async (conversation: any, text: string) => {
      const clientMessageId = crypto.randomUUID();
      const row = { id: 'local-' + clientMessageId, clientMessageId, conversationId: conversation.id,
        senderUserId: session().user.id, senderDeviceId: session().device.id, mine: true, status: 'sending',
        at: new Date().toISOString(), payload: { type: 'text', text: text.trim() } };
      pending.update(rows => [...rows, row]); return row;
    });
    Object.assign(page, { auth: { session }, conversation: () => ({ id: 'chat', participants: [] }),
      chat: { selectedMessages: confirmed, sendTyping: jasmine.createSpy().and.resolveTo() },
      textOutbox: { enqueue, forConversation: () => pending(), retry: jasmine.createSpy().and.resolveTo(), discard: jasmine.createSpy().and.resolveTo() },
      privateChatLocked: locked, composerGeneration: 0, destroyed: false, sending: false, textSaving: false, textQueueError: '', draft: ' Hola ', attachmentError: '',
      canSendMessages: () => true, isBlocked: () => false, currentPolicy: () => ({ ttlSeconds: null }),
      scrollBottom: jasmine.createSpy(), tr: (_key: string, fallback: string) => fallback,
    });
    return { page, session, confirmed, pending, locked, enqueue };
  }
  it('accepts a second message while the first remains pending on the network', async () => {
    const h = harness(); await h.page.send();
    expect(h.page.draft).toBe(''); expect(h.page.sending).toBeFalse();
    h.page.draft = 'Dos'; await h.page.send();
    expect(h.page.displayedMessages().map((row: any) => row.payload.text)).toEqual(['Hola', 'Dos']);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    for (const row of h.pending()) expect(h.page.deliveryState(row)).toBe('pending');
  });
  it('preserves the draft if durable storage fails', async () => {
    const h = harness(); h.enqueue.and.rejectWith(new Error('Storage unavailable'));
    await h.page.send(); expect(h.page.draft).toBe(' Hola '); expect(h.page.sending).toBeFalse();
    expect(h.page.textQueueError).toBe('Storage unavailable');
  });
  it('does not overwrite a newly typed draft when local storage finishes', async () => {
    const h = harness(); let done!: () => void;
    h.enqueue.and.returnValue(new Promise<void>(resolve => done = resolve));
    const sending = h.page.send(); h.page.draft = 'Nuevo texto'; done(); await sending;
    expect(h.page.draft).toBe('Nuevo texto');
  });
  it('allows durable text sends during an attachment upload without changing its busy or error state', async () => {
    const h = harness(); h.page.sending = true; h.page.attachmentError = 'Attachment status';
    await h.page.send();
    expect(h.enqueue).toHaveBeenCalledTimes(1); expect(h.page.sending).toBeTrue();
    expect(h.page.attachmentError).toBe('Attachment status'); expect(h.page.textSaving).toBeFalse();
  });
  it('deduplicates realtime confirmation and hides another account or locked previews', async () => {
    const h = harness(); await h.page.send(); const row = h.pending()[0];
    h.confirmed.set([{ ...row, id: 'server', status: 'enviado' }]);
    expect(h.page.displayedMessages().map((value: any) => value.id)).toEqual(['server']);
    h.confirmed.set([]); h.locked.set(true); expect(h.page.displayedMessages()).toEqual([]);
    h.locked.set(false); h.session.set({ user: { id: 'b' }, device: { id: 'phone-b' } });
    expect(h.page.displayedMessages()).toEqual([]);
  });
  it('retains failed messages for retry without preventing another durable send', async () => {
    const h = harness(); await h.page.send(); h.pending.update(rows => rows.map(row => ({ ...row, blocked: true })));
    expect(h.page.failedTextAttempt()?.text).toBe('Hola');
    h.page.draft = 'Siguiente'; await h.page.send(); expect(h.enqueue).toHaveBeenCalledTimes(2);
    await h.page.retryFailedText(); expect(h.page.textOutbox.retry).toHaveBeenCalledWith(h.pending()[0].id);
  });
  it('closes the chat view through the menu without deleting chat data or pending sends', async () => {
    const h = harness(); h.page.chatMenuOpen = true;
    h.page.router = { navigateByUrl: jasmine.createSpy().and.resolveTo(true) };
    h.page.cancelSelection = jasmine.createSpy();
    await h.page.closeConversationView();
    expect(h.page.chatMenuOpen).toBeFalse();
    expect(h.page.router.navigateByUrl).toHaveBeenCalledWith('/app/chats');
    expect(h.page.textOutbox.discard).not.toHaveBeenCalled();
  });
  it('times out identity preparation before a queued send and never posts after its late completion', fakeAsync(() => {
    const service: any = Object.create(ChatService.prototype);
    let finish!: (value: unknown) => void; let error: Error | null = null;
    service.auth = { session: () => ({ user: { id: 'a' }, device: { id: 'phone' } }),
      ensureDeviceIdentity: () => new Promise(resolve => finish = resolve) };
    service.assertPrivateChatUnlocked = () => undefined;
    service.api = { post: jasmine.createSpy() };
    void service.sendPayload({ id: 'chat' }, { type: 'text', text: 'Queued' }, 'Text', null, { queueManaged: true })
      .catch((failure: Error) => error = failure);
    tick(30001); flushMicrotasks(); expect((error as Error | null)?.name).toBe('TimeoutError');
    finish({ userId: 'a', deviceId: 'phone' }); flushMicrotasks();
    expect(service.api.post).not.toHaveBeenCalled();
  }));
});
