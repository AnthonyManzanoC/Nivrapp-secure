import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import {
  DAILY_APP_LAUNCH_MAX_MS, DAILY_APP_LAUNCH_MIN_MS, DAILY_APP_LAUNCH_RUNTIME,
  DailyAppLaunchRuntime, DailyAppLaunchService,
} from './daily-app-launch.service';

describe('DailyAppLaunchService', () => {
  let saved: Map<string, string>;
  let runtime: DailyAppLaunchRuntime;
  let day: Date;

  beforeEach(() => {
    saved = new Map();
    day = new Date(2026, 9, 21, 9);
    runtime = {
      storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } },
      now: () => day,
    };
    TestBed.configureTestingModule({ providers: [{ provide: DAILY_APP_LAUNCH_RUNTIME, useValue: runtime }] });
  });

  function service(): DailyAppLaunchService {
    return TestBed.inject(DailyAppLaunchService);
  }

  function update(ready = true, canShow = true, accountId: string | null = 'account-one'): void {
    service().update({ accountId, canShow, ready });
  }

  it('gives fast cached launches a readable minimum without starting any extra work', fakeAsync(() => {
    update();
    expect(service().visible()).toBeTrue();
    tick(DAILY_APP_LAUNCH_MIN_MS - 1);
    expect(service().visible()).toBeTrue();
    tick(1);
    expect(service().visible()).toBeFalse();
    expect(saved.size).toBe(1);
  }));

  it('waits for actual readiness after the minimum and releases immediately when ready', fakeAsync(() => {
    update(false);
    tick(DAILY_APP_LAUNCH_MIN_MS + 250);
    expect(service().visible()).toBeTrue();
    update(true);
    expect(service().visible()).toBeFalse();
    tick(DAILY_APP_LAUNCH_MAX_MS);
  }));

  it('always releases a failed, offline or stalled preparation at the maximum', fakeAsync(() => {
    update(false);
    tick(DAILY_APP_LAUNCH_MAX_MS - 1);
    expect(service().visible()).toBeTrue();
    tick(1);
    expect(service().visible()).toBeFalse();
    update(false);
    expect(service().visible()).toBeFalse();
  }));

  it('does not restart or extend the timers for overlapping requests', fakeAsync(() => {
    update();
    tick(500);
    service().requestPresentation();
    service().requestPresentation();
    update();
    tick(DAILY_APP_LAUNCH_MIN_MS - 500);
    expect(service().visible()).toBeFalse();
    update();
    service().requestPresentation();
    expect(service().visible()).toBeFalse();
    expect(saved.size).toBe(1);
  }));

  it('persists the daily claim before display so a reload cannot replay the intro', fakeAsync(() => {
    update(false);
    expect(service().visible()).toBeTrue();
    const second = TestBed.runInInjectionContext(() => new DailyAppLaunchService());
    second.update({ accountId: 'account-one', canShow: true, ready: false });
    expect(second.visible()).toBeFalse();
    tick(DAILY_APP_LAUNCH_MAX_MS);
  }));

  it('keeps accounts separate and ignores stale timers after an account switch', fakeAsync(() => {
    update(false);
    tick(700);
    update(true, true, 'account-two');
    tick(DAILY_APP_LAUNCH_MIN_MS - 1);
    expect(service().visible()).toBeTrue();
    tick(1);
    expect(service().visible()).toBeFalse();
    update(true, true, 'account-one');
    expect(service().visible()).toBeFalse();
    expect(saved.size).toBe(2);
    tick(DAILY_APP_LAUNCH_MAX_MS);
  }));

  it('waits for an authenticated safe route without consuming the day on auth or an invite', fakeAsync(() => {
    update(true, true, null);
    expect(service().visible()).toBeFalse();
    update(true, false);
    expect(service().visible()).toBeFalse();
    expect(saved.size).toBe(0);
    update();
    expect(service().visible()).toBeTrue();
    tick(DAILY_APP_LAUNCH_MIN_MS);
  }));

  it('dismisses immediately for a call, lock, share or recovery even before the minimum', fakeAsync(() => {
    update(false);
    tick(150);
    update(false, false);
    expect(service().visible()).toBeFalse();
    update(false, true);
    expect(service().visible()).toBeFalse();
    tick(DAILY_APP_LAUNCH_MAX_MS);
  }));

  it('dismisses immediately on logout and never shows over an unauthenticated page', fakeAsync(() => {
    update(false);
    update(false, false, null);
    expect(service().visible()).toBeFalse();
    service().requestPresentation();
    expect(service().visible()).toBeFalse();
    tick(DAILY_APP_LAUNCH_MAX_MS);
  }));

  it('starts a new local day only on the next foreground entry, never during background data updates', fakeAsync(() => {
    update();
    tick(DAILY_APP_LAUNCH_MIN_MS);
    day = new Date(2026, 9, 22, 0, 1);
    update(false);
    expect(service().visible()).toBeFalse();
    service().requestPresentation();
    expect(service().visible()).toBeTrue();
    update();
    tick(DAILY_APP_LAUNCH_MIN_MS);
    service().requestPresentation();
    expect(service().visible()).toBeFalse();
  }));

  for (const ready of [true, false]) {
    it(`does not queue duplicate foreground events past the ${ready ? 'minimum' : 'maximum'} into the next day`, fakeAsync(() => {
      update(ready);
      tick(150);
      service().requestPresentation();
      service().requestPresentation();
      tick((ready ? DAILY_APP_LAUNCH_MIN_MS : DAILY_APP_LAUNCH_MAX_MS) - 150);
      expect(service().visible()).toBeFalse();

      day = new Date(2026, 9, 22, 0, 1);
      update(false);
      expect(service().visible()).toBeFalse();
      service().requestPresentation();
      expect(service().visible()).toBeTrue();
      tick(DAILY_APP_LAUNCH_MAX_MS);
      expect(service().visible()).toBeFalse();
    }));
  }

  it('uses the local calendar day rather than a rolling 24-hour timer', fakeAsync(() => {
    day = new Date(2026, 9, 21, 23, 59);
    update();
    tick(DAILY_APP_LAUNCH_MIN_MS);
    day = new Date(2026, 9, 22, 0, 1);
    service().requestPresentation();
    expect(service().visible()).toBeTrue();
    tick(DAILY_APP_LAUNCH_MIN_MS);
  }));

  it('uses an in-memory daily claim when persistent storage is denied', fakeAsync(() => {
    runtime.storage = { getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Full'); } };
    update();
    tick(DAILY_APP_LAUNCH_MIN_MS);
    service().requestPresentation();
    update();
    expect(service().visible()).toBeFalse();
    day = new Date(2026, 9, 22, 8);
    service().requestPresentation();
    expect(service().visible()).toBeTrue();
    tick(DAILY_APP_LAUNCH_MIN_MS);
  }));

  it('supports unavailable storage and invalid clocks without trapping the app', fakeAsync(() => {
    runtime.storage = null;
    day = new Date(Number.NaN);
    update();
    expect(service().visible()).toBeFalse();
    day = new Date(2026, 9, 21, 10);
    service().requestPresentation();
    expect(service().visible()).toBeTrue();
    tick(DAILY_APP_LAUNCH_MIN_MS);
    service().requestPresentation();
    expect(service().visible()).toBeFalse();
  }));

  it('clears its bounded timers when destroyed', fakeAsync(() => {
    const launch = service();
    update(false);
    TestBed.resetTestingModule();
    expect(launch.visible()).toBeFalse();
    launch.requestPresentation();
    launch.update({ accountId: 'account-one', canShow: true, ready: true });
    expect(launch.visible()).toBeFalse();
    tick(DAILY_APP_LAUNCH_MAX_MS);
  }));
});
