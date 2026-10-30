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
      privateChatLocked: locked, pendingTextPreview: signal(null), failedTextSend: signal(null),
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

  it('retains failed text separately without a sent checkmark or replacing the next draft', async () => {
    const h = harness(); const sending = h.page.send();
    h.page.draft = 'Siguiente mensaje';
    h.reject(new Error('offline')); await sending;
    expect(h.page.draft).toBe('Siguiente mensaje');
    expect(h.page.failedTextAttempt().text).toBe(' Hola ');
    expect(h.page.displayedMessages()).toEqual([]); expect(h.page.sending).toBeFalse();
    await h.page.send(); expect(h.page.chat.sendText).toHaveBeenCalledTimes(1);
  });

  it('retries with the same identity and policy, preserving new text and reply choice', async () => {
    const h = harness(); h.page.currentPolicy = () => ({ ttlSeconds: 3600, replyTo: { messageId: 'original' } });
    const sending = h.page.send(); const original = h.page.chat.sendText.calls.mostRecent().args;
    h.reject(new Error('offline')); await sending;
    h.page.draft = 'Otro texto'; h.page.replyingMessage = { id: 'next-reply' };
    h.page.currentPolicy = () => ({ ttlSeconds: null });
    h.page.chat.sendText.and.resolveTo({ id: 'accepted' });
    await h.page.retryFailedText();
    const retried = h.page.chat.sendText.calls.mostRecent().args;
    expect(retried[1]).toBe(original[1]); expect(retried[2]).toEqual(original[2]); expect(retried[3]).toBe(original[3]);
    expect(h.page.draft).toBe('Otro texto'); expect(h.page.replyingMessage.id).toBe('next-reply');
    expect(h.page.failedTextAttempt()).toBeNull();
  });

  it('dismisses a late-confirmed failure and never retries an already confirmed message', async () => {
    const h = harness(); const sending = h.page.send(); const bubble = h.page.displayedMessages()[0];
    h.reject(new Error('response lost')); await sending;
    expect(h.page.failedTextAttempt()).not.toBeNull();
    h.confirmed.set([{ ...bubble, id: 'accepted', status: 'enviado' }]);
    expect(h.page.failedTextAttempt()).toBeNull();
    await h.page.retryFailedText(); expect(h.page.chat.sendText).toHaveBeenCalledTimes(1);
  });

  it('prevents retries across accounts, locked chats and stale composer generations', async () => {
    const h = harness(); const sending = h.page.send(); h.reject(new Error('offline')); await sending;
    h.locked.set(true); expect(h.page.failedTextAttempt()).toBeNull(); await h.page.retryFailedText();
    h.locked.set(false); h.session.set({ user: { id: 'b' }, device: { id: 'phone-b' } });
    expect(h.page.failedTextAttempt()).toBeNull(); await h.page.retryFailedText();
    h.session.set({ user: { id: 'a' }, device: { id: 'phone-a' } }); h.page.composerGeneration++;
    expect(h.page.failedTextAttempt()).toBeNull(); await h.page.retryFailedText();
    expect(h.page.chat.sendText).toHaveBeenCalledTimes(1);
  });

  it('discards only the failed attempt, leaving the next draft intact', async () => {
    const h = harness(); const sending = h.page.send(); h.reject(new Error('offline')); await sending;
    h.page.draft = 'Siguiente'; h.page.discardFailedText();
    expect(h.page.failedTextAttempt()).toBeNull(); expect(h.page.draft).toBe('Siguiente');
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
