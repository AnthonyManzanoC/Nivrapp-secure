import { localScheduleInput, parseLocalScheduleInput, scheduledMessageTime } from './message-schedule';

describe('message scheduling dates', () => {
  it('preserves the selected local wall time as an absolute timestamp across timezone offsets', () => {
    const timestamp = new Date(2026, 10, 16, 9, 20, 0, 0).getTime();
    const input = localScheduleInput(timestamp);
    expect(input).toBe('2026-11-16T09:20');
    expect(parseLocalScheduleInput(input)).toBe(timestamp);
    expect(new Date(scheduledMessageTime(timestamp, timestamp - 60000)).getTime()).toBe(timestamp);
  });
  it('rejects rolled calendar dates, invalid hours, past times and unbounded future schedules', () => {
    expect(() => parseLocalScheduleInput('2026-02-31T09:20')).toThrow();
    expect(() => parseLocalScheduleInput('2026-11-16T25:00')).toThrow();
    expect(() => parseLocalScheduleInput('2026-11-16T09:20Z')).toThrow();
    expect(() => scheduledMessageTime(NaN)).toThrow();
    expect(() => scheduledMessageTime(Date.now() - 10000)).toThrow();
    expect(() => scheduledMessageTime(Date.now() + 31 * 86400000)).toThrow();
  });
});
