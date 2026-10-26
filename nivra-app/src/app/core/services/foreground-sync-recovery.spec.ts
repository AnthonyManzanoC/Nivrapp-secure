import { HttpErrorResponse } from '@angular/common/http';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { TimeoutError } from 'rxjs';
import { ForegroundSyncRecovery } from './foreground-sync-recovery';

describe('foreground connection recovery', () => {
  function harness() {
    const state = { scope: '0:alice:phone', online: true, visible: true };
    const sync = jasmine.createSpy('sync').and.resolveTo();
    const delay = jasmine.createSpy('delay').and.callFake((attempt: number) => Math.min(30_000, 2500 * 2 ** attempt));
    const recovery = new ForegroundSyncRecovery({
      scope: () => state.scope, canRun: () => state.online && state.visible,
      sync, retryDelay: delay,
    });
    return { recovery, state, sync, delay };
  }

  it('coalesces connectivity and foreground hints into one actual sync', fakeAsync(() => {
    const { recovery, sync } = harness();
    for (let count = 0; count < 30; count++) recovery.wake();
    tick(399); expect(sync).not.toHaveBeenCalled();
    tick(1); flushMicrotasks();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(recovery.pending).toBeFalse();
    tick(120_000); expect(sync).toHaveBeenCalledTimes(1);
  }));

  it('keeps retrying a premature online hint with spaced reads until the server responds', fakeAsync(() => {
    const { recovery, sync } = harness();
    let failures = 2;
    sync.and.callFake(async () => { if (failures-- > 0) throw new HttpErrorResponse({ status: 0 }); });
    recovery.wake(); tick(400); flushMicrotasks();
    expect(sync).toHaveBeenCalledTimes(1);
    tick(2499); expect(sync).toHaveBeenCalledTimes(1);
    tick(1); flushMicrotasks(); expect(sync).toHaveBeenCalledTimes(2);
    tick(4999); expect(sync).toHaveBeenCalledTimes(2);
    tick(1); flushMicrotasks(); expect(sync).toHaveBeenCalledTimes(3);
    expect(recovery.pending).toBeFalse();
    tick(180_000); expect(sync).toHaveBeenCalledTimes(3);
  }));

  it('lets a new connectivity hint advance the backoff only once', fakeAsync(() => {
    const { recovery, sync } = harness();
    recovery.failed(new TimeoutError());
    tick(500);
    for (let count = 0; count < 20; count++) recovery.wake();
    tick(400); flushMicrotasks();
    expect(sync).toHaveBeenCalledTimes(1);
    tick(30_000); expect(sync).toHaveBeenCalledTimes(1);
  }));

  it('pauses while offline or backgrounded and resumes without discarding the session', fakeAsync(() => {
    const { recovery, sync, state } = harness();
    state.online = false; recovery.wake(); tick(30_000);
    expect(sync).not.toHaveBeenCalled();
    state.online = true; recovery.wake(); state.visible = false;
    tick(400); flushMicrotasks(); expect(sync).not.toHaveBeenCalled();
    state.visible = true; recovery.wake(); tick(400); flushMicrotasks();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(state.scope).toBe('0:alice:phone');
  }));

  it('does not let a queued read cross logout or an account transition', fakeAsync(() => {
    const { recovery, sync, state } = harness();
    recovery.wake(); state.scope = ''; tick(400); flushMicrotasks();
    expect(sync).not.toHaveBeenCalled();
    state.scope = '1:bob:phone'; recovery.wake(); state.scope = '2:alice:phone';
    tick(400); flushMicrotasks(); expect(sync).not.toHaveBeenCalled();
  }));

  it('invalidates a failed old operation even when the same account opens again', fakeAsync(() => {
    const { recovery, sync } = harness();
    let reject!: (reason: unknown) => void;
    sync.and.returnValue(new Promise<void>((_resolve, fail) => reject = fail));
    recovery.wake(); tick(400); flushMicrotasks();
    recovery.reset();
    reject(new HttpErrorResponse({ status: 503 })); flushMicrotasks();
    tick(120_000); expect(sync).toHaveBeenCalledTimes(1);
    expect(recovery.pending).toBeFalse();
  }));

  it('does not spawn parallel reads while reconciliation is running', fakeAsync(() => {
    const { recovery, sync } = harness();
    let finish!: () => void;
    sync.and.returnValue(new Promise<void>(resolve => finish = resolve));
    recovery.wake(); tick(400); flushMicrotasks();
    for (let count = 0; count < 20; count++) {
      recovery.wake(); recovery.failed(new HttpErrorResponse({ status: 0 }));
    }
    tick(60_000); expect(sync).toHaveBeenCalledTimes(1);
    finish(); flushMicrotasks(); expect(recovery.pending).toBeFalse();
  }));

  it('cancels a retry after another real refresh has already recovered', fakeAsync(() => {
    const { recovery, sync } = harness();
    recovery.failed(new HttpErrorResponse({ status: 503 }));
    recovery.recovered(); tick(120_000); flushMicrotasks();
    expect(sync).not.toHaveBeenCalled();
    expect(recovery.pending).toBeFalse();
  }));

  it('does not automatically loop on denied credentials, forbidden access or malformed responses', fakeAsync(() => {
    const { recovery, sync } = harness();
    for (const error of [new HttpErrorResponse({ status: 401 }), new HttpErrorResponse({ status: 403 }),
      new HttpErrorResponse({ status: 426 }), new Error('Invalid sync cursor')]) {
      sync.and.rejectWith(error);
      recovery.wake(); tick(400); flushMicrotasks();
      expect(recovery.pending).toBeFalse();
      tick(120_000);
    }
    expect(sync).toHaveBeenCalledTimes(4);
  }));

  it('bounds continuing server failures to one read per capped retry interval', fakeAsync(() => {
    const { recovery, sync, delay } = harness();
    sync.and.rejectWith(new HttpErrorResponse({ status: 503 }));
    recovery.wake(); tick(400); flushMicrotasks();
    for (const wait of [2500, 5000, 10_000, 20_000, 30_000, 30_000]) { tick(wait); flushMicrotasks(); }
    expect(sync).toHaveBeenCalledTimes(7);
    expect(delay.calls.allArgs()).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    recovery.reset(); tick(120_000); expect(sync).toHaveBeenCalledTimes(7);
  }));
});
