import { HISTORY_STATUS_SNOOZE_MS, HistoryStatusSnoozeService } from './history-status-snooze.service';

describe('scoped history reminder snooze', () => {
  const user = 'snooze-fixture-owner'; const other = 'snooze-fixture-other';
  const device = 'snooze-fixture-device'; const replacement = 'snooze-fixture-replacement';
  const now = 1_800_000_000_000;
  const key = (uid = user, did = device) => 'nivra.historyStatusSnooze.v1.' + encodeURIComponent(JSON.stringify([uid, did]));
  afterEach(() => {
    for (const uid of [user, other]) for (const did of [device, replacement]) localStorage.removeItem(key(uid, did));
  });

  it('remembers the choice across reload only for the exact account, device and identity fingerprint', () => {
    new HistoryStatusSnoozeService().snooze(user, device, 'fingerprint-one', now);
    const reopened = new HistoryStatusSnoozeService();
    expect(reopened.isSnoozed(user, device, 'fingerprint-one', now + 1000)).toBeTrue();
    expect(reopened.isSnoozed(other, device, 'fingerprint-one', now + 1000)).toBeFalse();
    expect(reopened.isSnoozed(user, replacement, 'fingerprint-one', now + 1000)).toBeFalse();
    expect(reopened.isSnoozed(user, device, 'new-identity', now + 1000)).toBeFalse();
  });

  it('expires after exactly twenty-four hours and fails visible after a backward clock change', () => {
    const service = new HistoryStatusSnoozeService(); service.snooze(user, device, 'identity', now);
    expect(service.isSnoozed(user, device, 'identity', now + HISTORY_STATUS_SNOOZE_MS - 1)).toBeTrue();
    expect(service.isSnoozed(user, device, 'identity', now + HISTORY_STATUS_SNOOZE_MS)).toBeFalse();
    expect(service.isSnoozed(user, device, 'identity', now - 60_000)).toBeFalse();
  });

  it('does not trust malformed, oversized, nonfinite or arbitrarily long future preferences', () => {
    for (const text of ['broken-json', 'x'.repeat(513), JSON.stringify({ v: 1, until: null, fingerprint: 'identity' }),
      JSON.stringify({ v: 1, until: now + HISTORY_STATUS_SNOOZE_MS * 100, fingerprint: 'identity' }),
      JSON.stringify({ v: 1, until: now + 1000, fingerprint: 'x'.repeat(257) })]) {
      localStorage.setItem(key(), text);
      expect(new HistoryStatusSnoozeService().isSnoozed(user, device, 'identity', now)).toBeFalse();
    }
  });

  it('keeps a session preference if browser storage is denied, without throwing or changing other data', () => {
    const service = new HistoryStatusSnoozeService();
    spyOn(Storage.prototype, 'setItem').and.throwError('fixture storage denied');
    expect(() => service.snooze(user, device, 'identity', now)).not.toThrow();
    expect(service.isSnoozed(user, device, 'identity', now)).toBeTrue();
    expect(new HistoryStatusSnoozeService().isSnoozed(user, device, 'identity', now)).toBeFalse();
  });

  it('clears one scope without changing another retained account or device', () => {
    const service = new HistoryStatusSnoozeService();
    service.snooze(user, device, 'identity', now); service.snooze(other, device, 'identity', now); service.snooze(user, replacement, 'identity', now);
    service.clear(user, device);
    expect(service.isSnoozed(user, device, 'identity', now)).toBeFalse();
    expect(service.isSnoozed(other, device, 'identity', now)).toBeTrue(); expect(service.isSnoozed(user, replacement, 'identity', now)).toBeTrue();
  });
});
