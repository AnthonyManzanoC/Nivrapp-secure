import { TestBed } from '@angular/core/testing';
import { NOTIFICATION_PROMPT_RUNTIME, NotificationPermissionPromptService } from './notification-permission-prompt.service';

describe('notification permission reminder policy', () => {
  let now: number;
  let saved: string | null;
  function open(): NotificationPermissionPromptService {
    TestBed.configureTestingModule({ providers: [{ provide: NOTIFICATION_PROMPT_RUNTIME, useValue: {
      now: () => now, read: () => saved, write: (value: string) => { saved = value; },
    } }] });
    return TestBed.inject(NotificationPermissionPromptService);
  }
  beforeEach(() => { now = 1_800_000_000_000; saved = null; });
  afterEach(() => TestBed.resetTestingModule());

  it('permits one automatic native prompt and remembers it across app restarts', () => {
    const first = open();
    expect(first.claimAutomaticPrompt()).toBeTrue();
    expect(first.claimAutomaticPrompt()).toBeFalse();
    TestBed.resetTestingModule();
    now += 10 * 86_400_000;
    expect(open().claimAutomaticPrompt()).toBeFalse();
  });
  it('respects a full day of quiet after Now not, without losing the manual reminder forever', () => {
    const policy = open();
    policy.remindTomorrow();
    expect(policy.showReminder()).toBeFalse();
    expect(policy.claimAutomaticPrompt()).toBeFalse();
    now += 86_399_999;
    expect(policy.showReminder()).toBeFalse();
    now++;
    expect(policy.showReminder()).toBeTrue();
  });
  it('does not ask automatically again after an explicit permission action', () => {
    const policy = open(); policy.markAttempted();
    expect(policy.showReminder()).toBeTrue();
    expect(policy.claimAutomaticPrompt()).toBeFalse();
  });
  it('keeps in-memory suppression when storage is unavailable', () => {
    TestBed.configureTestingModule({ providers: [{ provide: NOTIFICATION_PROMPT_RUNTIME, useValue: {
      now: () => now, read: () => { throw Error('Storage denied'); }, write: () => { throw Error('Storage denied'); },
    } }] });
    const policy = TestBed.inject(NotificationPermissionPromptService);
    expect(policy.claimAutomaticPrompt()).toBeTrue();
    expect(policy.claimAutomaticPrompt()).toBeFalse();
    expect(() => policy.remindTomorrow()).not.toThrow();
    expect(policy.showReminder()).toBeFalse();
  });
});
