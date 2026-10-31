/** Receipts may be repeated or arrive out of order; the first valid evidence wins. */
export function earliestReceiptTime(left: string | null | undefined, right: string | null | undefined): string | null {
  const valid = [left, right].filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  return valid.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}
import type { DeliveryReceipt } from '../models/nivra.models';


/** Keep confirmed evidence when a slower sync/HTTP response follows realtime. */
export function mergeReceiptEvidence(existing: readonly DeliveryReceipt[], incoming: readonly DeliveryReceipt[]): DeliveryReceipt[] {
  const rows = new Map<string, DeliveryReceipt>();
  for (const receipt of [...existing, ...incoming]) {
    if (!receipt.userId || !receipt.deviceId) continue;
    const key = JSON.stringify([receipt.userId, receipt.deviceId]), previous = rows.get(key);
    rows.set(key, {userId:receipt.userId,deviceId:receipt.deviceId,
      deliveredAt:earliestReceiptTime(previous?.deliveredAt,receipt.deliveredAt),
      readAt:earliestReceiptTime(previous?.readAt,receipt.readAt),
      deletedAt:earliestReceiptTime(previous?.deletedAt,receipt.deletedAt)});
  }
  return [...rows.values()];
}
