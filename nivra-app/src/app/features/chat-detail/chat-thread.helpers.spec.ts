import { ChatMessageVm } from '../../core/models/nivra.models';
import { canQuoteMessage, insertComposerEmoji, isReplySwipe, localMessageDay, messageDeliveryState, searchThreadMessages } from './chat-thread.helpers';

describe('Chat thread interactions', () => {
  const vm = (id: string, text: string, extra: Partial<ChatMessageVm> = {}): ChatMessageVm => ({
    id, conversationId: 'chat', mine: true, senderUserId: 'me', at: '2026-10-06T12:00:00Z', payload: { type: 'text', text }, ...extra,
  });

  it('searches accents and case without exporting messages', () => {
    expect(searchThreadMessages([vm('1', '¡Qué alegría!'), vm('2', 'otro')], ' ALEGRIA ')).toEqual(['1']);
  });
  it('never includes view-once, expired or failed-to-decrypt content in search results', () => {
    const messages = [vm('once', 'secreto', { deleteAfterRead: true }), vm('old', 'secreto', { expiresAt: '2026-10-05T00:00:00Z' }),
      vm('bad', 'secreto', { decryptError: true }), vm('good', 'secreto')];
    expect(searchThreadMessages(messages, 'secreto', Date.parse('2026-10-06T00:00:00Z'))).toEqual(['good']);
  });
  it('matches document captions and names and ignores an empty query', () => {
    const file = vm('file', '', { payload: { type: 'file', text: 'Contrato', fileName: 'documento.pdf' } });
    expect(searchThreadMessages([file], 'PDF')).toEqual(['file']);
    expect(searchThreadMessages([file], '  ')).toEqual([]);
  });
  it('inserts an emoji at the caret or replaces a selected range', () => {
    expect(insertComposerEmoji('hola mundo', '👋', 4)).toEqual({ text: 'hola👋 mundo', caret: 6 });
    expect(insertComposerEmoji('hola mundo', '🌎', 5, 10)).toEqual({ text: 'hola 🌎', caret: 7 });
  });
  it('keeps local dates together and handles malformed dates', () => {
    expect(localMessageDay('2026-10-06T12:00:00')).toBe(localMessageDay('2026-10-06T23:59:00'));
    expect(localMessageDay('invalid')).toBe('');
  });
  it('does not label a group message read until each recipient has read it', () => {
    const message = vm('1', 'hola', { receipts: [{ userId: 'a', deviceId: 'phone', readAt: 'now' }, { userId: 'b', deviceId: 'phone', deliveredAt: 'now' }] });
    expect(messageDeliveryState(message, 'me', ['a', 'b', 'me'])).toBe('delivered');
    message.receipts!.push({ userId: 'b', deviceId: 'pc', readAt: 'now' });
    expect(messageDeliveryState(message, 'me', ['a', 'b'])).toBe('read');
  });
  it('ignores the sender’s receipts and requires delivery evidence', () => {
    const message = vm('1', 'hola', { receipts: [{ userId: 'me', deviceId: 'pc', readAt: 'now' }] });
    expect(messageDeliveryState(message, 'me', ['a'])).toBe('sent');
    expect(messageDeliveryState(message, 'me', [])).toBe('sent');
  });
  it('accepts a deliberate horizontal reply gesture but not vertical scrolling', () => {
    expect(isReplySwipe(70, 10)).toBeTrue();
    expect(isReplySwipe(70, 40)).toBeFalse();
    expect(isReplySwipe(20, 0)).toBeFalse();
    expect(isReplySwipe(-70, 0)).toBeFalse();
  });
  it('never quotes a view-once message or one that expired after selecting reply', () => {
    expect(canQuoteMessage(vm('once', 'secreto', { deleteAfterRead: true }))).toBeFalse();
    expect(canQuoteMessage(vm('bad', 'secreto', { decryptError: true }))).toBeFalse();
    expect(canQuoteMessage(vm('old', 'secreto', { expiresAt: '2026-10-06T00:00:00Z' }), Date.parse('2026-10-07T00:00:00Z'))).toBeFalse();
    expect(canQuoteMessage(vm('good', 'hola'))).toBeTrue();
  });
});
