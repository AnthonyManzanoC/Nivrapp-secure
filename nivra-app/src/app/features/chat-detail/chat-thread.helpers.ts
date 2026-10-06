import { ChatMessageVm } from '../../core/models/nivra.models';

export function canQuoteMessage(message: ChatMessageVm | null, now = Date.now()): boolean {
  return Boolean(message && !message.decryptError && !message.deleteAfterRead && !message.payload['viewOnceOpened']
    && (!message.expiresAt || Date.parse(message.expiresAt) > now));
}

export function normalizeChatSearch(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
}

export function searchThreadMessages(messages: ChatMessageVm[], query: string, now = Date.now()): string[] {
  const term = normalizeChatSearch(query);
  if (!term) return [];
  return messages.filter(message => {
    if (message.decryptError || message.deleteAfterRead || message.payload['viewOnceOpened']
      || (message.expiresAt && Date.parse(message.expiresAt) <= now)) return false;
    const text = [message.payload.text, message.payload.title, message.payload['fileName']]
      .filter(value => typeof value === 'string').join(' ');
    return normalizeChatSearch(text).includes(term);
  }).map(message => message.id);
}

export function localMessageDay(at: string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function insertComposerEmoji(text: string, emoji: string, start = text.length, end = start): { text: string; caret: number } {
  const from = Math.max(0, Math.min(text.length, start));
  const to = Math.max(from, Math.min(text.length, end));
  return { text: text.slice(0, from) + emoji + text.slice(to), caret: from + emoji.length };
}

export type MessageDeliveryState = 'sent' | 'delivered' | 'read';

export function messageDeliveryState(message: ChatMessageVm, ownUserId: string, recipientIds: string[]): MessageDeliveryState {
  const expected = [...new Set(recipientIds.filter(id => id && id !== ownUserId))];
  if (!expected.length) return 'sent';
  const receipts = message.receipts ?? [];
  if (expected.every(userId => receipts.some(r => r.userId === userId && r.readAt))) return 'read';
  if (expected.every(userId => receipts.some(r => r.userId === userId && (r.deliveredAt || r.readAt)))) return 'delivered';
  return 'sent';
}

export function isReplySwipe(dx: number, dy: number): boolean {
  return dx >= 64 && Math.abs(dy) <= 24 && dx > Math.abs(dy) * 2;
}
