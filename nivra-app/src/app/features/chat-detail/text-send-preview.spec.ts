import { signal } from '@angular/core';
import { ChatDetailPage } from './chat-detail.page';
import { ChatService } from '../../core/services/chat.service';

describe('Immediate text send feedback', () => {
  function harness() {
    const page: any = Object.create(ChatDetailPage.prototype);
    const session = signal<any>({ user: { id: 'a' }, device: { id: 'phone-a' } });
    const confirmed = signal<any[]>([]);
    const locked = signal(false);
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    const send = new Promise((done, fail) => { resolve = done; reject = fail; });
    Object.assign(page, {
      auth: { session }, conversation: () => ({ id: 'chat', participants: [] }),
      chat: { selectedMessages: confirmed, sendText: jasmine.createSpy().and.returnValue(send),
        sendTyping: jasmine.createSpy().and.returnValue(new Promise(() => undefined)) },
      privateChatLocked: locked, pendingTextPreview: signal(null),
      composerGeneration: 0, destroyed: false, sending: false, draft: ' Hola ', attachmentError: '',
      canSendMessages: () => true, isBlocked: () => false, currentPolicy: () => ({ ttlSeconds: null }),
      scrollBottom: jasmine.createSpy(), tr: (_key: string, fallback: string) => fallback,
    });
    return { page, session, confirmed, locked, resolve, reject };
  }

  it('shows a pending bubble before typing or HTTP completes and uses one stable send identity', async () => {
    const h = harness(); const sending = h.page.send();
    expect(h.page.draft).toBe('');
    expect(h.page.chat.sendText).toHaveBeenCalledTimes(1);
    const bubble = h.page.displayedMessages()[0];
    expect(bubble.payload.text).toBe('Hola');
    expect(h.page.deliveryState(bubble)).toBe('pending');
    expect(h.page.deliveryLabel(bubble)).toBe('Enviando…');
    expect(h.page.chat.sendText.calls.mostRecent().args[3]).toBe(bubble.clientMessageId);
    await h.page.send(); expect(h.page.chat.sendText).toHaveBeenCalledTimes(1);
    h.confirmed.set([{ ...bubble, id: 'server-id', status: 'enviado' }]);
    expect(h.page.displayedMessages().map((message: any) => message.id)).toEqual(['server-id']);
    h.resolve({ id: 'server-id' }); await sending;
    expect(h.page.pendingTextPreview()).toBeNull(); expect(h.page.sending).toBeFalse();
  });

  it('restores the draft on failure without leaving a sent checkmark or phantom bubble', async () => {
    const h = harness(); const sending = h.page.send();
    h.reject(new Error('offline')); await sending;
    expect(h.page.draft).toBe(' Hola '); expect(h.page.attachmentError).toBe('offline');
    expect(h.page.displayedMessages()).toEqual([]); expect(h.page.sending).toBeFalse();
  });

  it('does not recreate a draft when realtime already confirmed that exact send', async () => {
    const h = harness(); const sending = h.page.send();
    h.confirmed.set([{ ...h.page.displayedMessages()[0], id: 'accepted', status: 'enviado' }]);
    h.reject(new Error('HTTP response lost')); await sending;
    expect(h.page.draft).toBe(''); expect(h.page.attachmentError).toBe('');
    expect(h.page.displayedMessages().length).toBe(1);
  });

  it('hides the previous account preview and rejects stale completion changes after switching accounts', async () => {
    const h = harness(); const sending = h.page.send();
    h.session.set({ user: { id: 'b' }, device: { id: 'phone-b' } });
    h.page.draft = 'Draft for B'; h.page.attachmentError = 'B status'; h.page.sending = false;
    expect(h.page.displayedMessages()).toEqual([]);
    h.reject(new Error('old account failed')); await sending;
    expect(h.page.draft).toBe('Draft for B'); expect(h.page.attachmentError).toBe('B status');
  });

  it('keeps pending content out of locked chats and prevents actions against temporary IDs', async () => {
    const h = harness(); const sending = h.page.send(); const bubble = h.page.displayedMessages()[0];
    h.locked.set(true); expect(h.page.displayedMessages()).toEqual([]);
    expect(h.page.canReply(bubble)).toBeFalse(); expect(h.page.canEdit(bubble)).toBeFalse();
    h.page.openMessageActions(bubble); expect(h.page.messageActionsOpen).toBeUndefined();
    h.resolve({ id: 'done' }); await sending;
  });

  it('passes the preview identity through the encrypted send and keeps it on the confirmed local row', async () => {
    const service: any = Object.create(ChatService.prototype);
    service.currentUserAllowsForwarding = () => true;
    service.sendPayload = jasmine.createSpy().and.resolveTo({ id: 'accepted' });
    const conversation: any = { id: 'chat' };
    await service.sendText(conversation, 'hello', {}, 'web-preview');
    expect(service.sendPayload.calls.mostRecent().args[4].clientMessageId).toBe('web-preview');
    service.auth = { session: () => ({ user: { id: 'a' }, device: { id: 'phone-a' } }) };
    service.upsertMessage = jasmine.createSpy(); service.withLocalReadReceipt = (value: any) => value;
    await service.ingestLocalSent({ id: 'accepted', clientMessageId: 'web-preview' }, { type: 'text', text: 'hello' });
    expect(service.upsertMessage).toHaveBeenCalledWith(jasmine.objectContaining({ id: 'accepted', clientMessageId: 'web-preview' }));
  });
});
