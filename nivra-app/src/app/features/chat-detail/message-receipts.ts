import { ChatMessageVm, Participant } from '../../core/models/nivra.models';
import { earliestReceiptTime } from '../../core/utils/receipt-time';

export type ReceiptState = 'read' | 'delivered' | 'pending';
export interface RecipientReceipt { userId: string; deliveredAt: string | null; readAt: string | null; state: ReceiptState; }

/** One person, regardless of device count. Only receipt evidence establishes a state. */
export function recipientReceipts(message: ChatMessageVm, ownUserId: string, participants: readonly Participant[]): RecipientReceipt[] {
  if (!message.mine || message.senderUserId !== ownUserId) return [];
  const rows = new Map<string, RecipientReceipt>();
  const include = (userId: string) => {
    if (userId && userId !== ownUserId && !rows.has(userId)) rows.set(userId, { userId, deliveredAt: null, readAt: null, state: 'pending' });
  };
  const sentAt = Date.parse(message.at);
  for (const person of participants) {
    if ((!person.joinedAt || Date.parse(person.joinedAt) <= sentAt) && (!person.removedAt || Date.parse(person.removedAt) > sentAt)) include(person.userId);
  }
  for (const receipt of message.receipts ?? []) {
    include(receipt.userId);
    const row = rows.get(receipt.userId);
    if (!row) continue;
    row.deliveredAt = earliestReceiptTime(row.deliveredAt, receipt.deliveredAt);
    row.readAt = earliestReceiptTime(row.readAt, receipt.readAt);
    row.state = row.readAt ? 'read' : row.deliveredAt ? 'delivered' : 'pending';
    // Deleting a local copy is neither a delivery nor a read confirmation.
  }
  return [...rows.values()];
}
