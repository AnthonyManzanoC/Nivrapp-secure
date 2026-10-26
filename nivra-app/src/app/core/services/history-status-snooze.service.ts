import { Injectable, signal } from '@angular/core';

export const HISTORY_STATUS_SNOOZE_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'nivra.historyStatusSnooze.v1.';
interface SnoozedHistoryStatus { v: 1; until: number; fingerprint: string; }

/** Presentation preference only: never changes history, keys or recovery state. */
@Injectable({ providedIn: 'root' })
export class HistoryStatusSnoozeService {
  private readonly records = new Map<string, SnoozedHistoryStatus | null>();
  private readonly revision = signal(0);

  isSnoozed(userId: string, deviceId: string, fingerprint: string, now = Date.now()): boolean {
    this.revision();
    const key = this.key(userId, deviceId);
    if (!key || !fingerprint || !Number.isSafeInteger(now)) return false;
    const record = this.read(key);
    return Boolean(record && record.fingerprint === fingerprint && record.until > now && record.until <= now + HISTORY_STATUS_SNOOZE_MS);
  }

  snooze(userId: string, deviceId: string, fingerprint: string, now = Date.now()): void {
    const key = this.key(userId, deviceId);
    if (!key || !fingerprint || fingerprint.length > 256 || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + HISTORY_STATUS_SNOOZE_MS)) return;
    const record: SnoozedHistoryStatus = { v: 1, until: now + HISTORY_STATUS_SNOOZE_MS, fingerprint };
    this.records.set(key, record);
    try { localStorage.setItem(key, JSON.stringify(record)); } catch { /* Keep this session's preference if storage is unavailable. */ }
    this.revision.update(value => value + 1);
  }

  clear(userId: string, deviceId: string): void {
    const key = this.key(userId, deviceId);
    if (!key) return;
    this.records.set(key, null);
    try { localStorage.removeItem(key); } catch { /* No effect on history storage. */ }
    this.revision.update(value => value + 1);
  }

  private key(userId: string, deviceId: string): string | null {
    return userId && deviceId && userId.length <= 128 && deviceId.length <= 128 ? PREFIX + encodeURIComponent(JSON.stringify([userId, deviceId])) : null;
  }

  private read(key: string): SnoozedHistoryStatus | null {
    if (this.records.has(key)) return this.records.get(key) ?? null;
    let value: SnoozedHistoryStatus | null = null;
    try {
      const text = localStorage.getItem(key);
      if (text && text.length <= 512) {
        const candidate = JSON.parse(text) as SnoozedHistoryStatus;
        if (candidate?.v === 1 && Number.isSafeInteger(candidate.until) && candidate.until > 0
          && typeof candidate.fingerprint === 'string' && candidate.fingerprint.length > 0 && candidate.fingerprint.length <= 256) value = candidate;
      }
    } catch { /* A malformed preference makes the real status visible. */ }
    this.records.set(key, value);
    return value;
  }
}
