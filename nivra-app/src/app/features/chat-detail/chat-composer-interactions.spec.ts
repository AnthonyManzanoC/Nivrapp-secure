import { ChatDetailPage } from './chat-detail.page';
import { ChatMessageVm } from '../../core/models/nivra.models';

describe('Chat composer boundaries', () => {
  let page: ChatDetailPage;
  let scope: { user: { id: string }; device: { id: string } };
  let sendFile: jasmine.Spy;
  const message = (extra: Partial<ChatMessageVm> = {}): ChatMessageVm => ({ id: 'm', conversationId: 'chat', mine: false, senderUserId: 'other', at: '2026-10-06T12:00:00Z', payload: { type: 'text', text: 'secreto' }, ...extra });

  beforeEach(() => {
    page = Object.create(ChatDetailPage.prototype);
    scope = { user: { id: 'me' }, device: { id: 'phone' } };
    sendFile = jasmine.createSpy('sendFile').and.resolveTo({ id: 'sent' });
    Object.assign(page, {
      auth: { session: () => scope }, chat: { sendFile, uploading: () => false, preview: (payload: { text: string }) => payload.text },
      conversation: () => ({ id: 'chat', participants: [] }), canSendMessages: () => true, isBlocked: () => false,
      currentPolicy: () => ({ ttlSeconds: null }), scrollBottom: jasmine.createSpy('scrollBottom'),
      draft: 'texto que todavía no envío', sending: false, destroyed: false, composerGeneration: 0,
      attachmentError: '', emojiPanelOpen: true, replyingMessage: message(), editingMessage: null,
      tr: (_key: string, fallback: string) => fallback,
    });
  });

  it('sends a sticker independently without sending or changing the text draft', async () => {
    const file = new File(['png'], 'sticker.png', { type: 'image/png' });
    await page.sendSticker(file);
    expect(sendFile).toHaveBeenCalledWith(jasmine.objectContaining({ id: 'chat' }), file, jasmine.objectContaining({ sticker: true, mode: 'document' }));
    expect(page.draft).toBe('texto que todavía no envío');
    expect(page.replyingMessage).toBeNull();
  });
  it('does not upload during edit, blocked chat, or with an unsupported file', async () => {
    page.editingMessage = message();
    await page.sendSticker(new File(['png'], 's.png', { type: 'image/png' }));
    page.editingMessage = null;
    await page.sendSticker(new File(['text'], 's.txt', { type: 'text/plain' }));
    Object.assign(page, { isBlocked: () => true });
    await page.sendSticker(new File(['png'], 's.png', { type: 'image/png' }));
    expect(sendFile).not.toHaveBeenCalled();
  });
  it('keeps the picker and draft on a failed upload so it can be retried', async () => {
    sendFile.and.rejectWith(new Error('sin conexión'));
    await page.sendSticker(new File(['png'], 's.png', { type: 'image/png' }));
    expect(page.emojiPanelOpen).toBeTrue();
    expect(page.draft).toBe('texto que todavía no envío');
    expect(page.attachmentError).toBe('sin conexión');
    expect(page.sending).toBeFalse();
  });
  it('does not modify a new account screen when an older upload finishes', async () => {
    let resolve!: (value: unknown) => void;
    sendFile.and.returnValue(new Promise(done => resolve = done));
    const pending = page.sendSticker(new File(['png'], 's.png', { type: 'image/png' }));
    scope = { user: { id: 'new' }, device: { id: 'new-phone' } };
    page.attachmentError = 'nuevo estado';
    const reply = page.replyingMessage;
    resolve({ id: 'sent' });
    await pending;
    expect(page.attachmentError).toBe('nuevo estado');
    expect(page.replyingMessage).toBe(reply);
    expect(page.emojiPanelOpen).toBeTrue();
    expect((page as unknown as { scrollBottom: jasmine.Spy }).scrollBottom).not.toHaveBeenCalled();
  });
  it('does not expose view-once text through preview, references or the reply action', () => {
    const once = message({ deleteAfterRead: true });
    page.replyingMessage = null;
    page.beginReply(once);
    expect(page.replyingMessage).toBeNull();
    expect(page.replyPreview(once)).toBe('');
    expect(page.replyReference(once)).toBeNull();
  });
  it('keeps historical read receipts when a new participant joins later', () => {
    Object.assign(page, { conversation: () => ({ id: 'chat', participants: [
      { userId: 'me', joinedAt: '2026-10-01T00:00:00Z' }, { userId: 'other', joinedAt: '2026-10-01T00:00:00Z' },
      { userId: 'new', joinedAt: '2026-10-07T00:00:00Z' },
    ] }) });
    expect(page.deliveryState(message({ mine: true, receipts: [{ userId: 'other', deviceId: 'phone', readAt: '2026-10-06T13:00:00Z' }] }))).toBe('read');
  });
});
