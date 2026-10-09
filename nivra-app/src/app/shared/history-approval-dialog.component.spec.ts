import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppLockService } from '../core/services/app-lock.service';
import { CallsService } from '../core/services/calls.service';
import { HistoryDeviceSyncService, PendingHistoryApproval } from '../core/services/history-device-sync.service';
import { HistoryApprovalDialogComponent } from './history-approval-dialog.component';

describe('history approval dialog interruption and queue', () => {
  let dialog: HistoryApprovalDialogComponent;
  let history: { pendingRequests: ReturnType<typeof signal<PendingHistoryApproval[]>>; dismissRequest: jasmine.Spy };
  let locked: ReturnType<typeof signal<boolean>>;
  let activeCall: ReturnType<typeof signal<{ id: string } | null>>;
  const request = (id: string): PendingHistoryApproval => ({
    id, userId: 'alice', targetDeviceId: `device-${id}`, targetIdentityKey: '{}',
    fingerprint: '1234 5678 90ab cdef 1234 5678', expiresAt: '2099-01-01T00:00:00Z',
  });
  const dismissal = (role?: string) => new CustomEvent('didDismiss', { detail: { role } });

  beforeEach(() => {
    locked = signal(false);
    activeCall = signal<{ id: string } | null>(null);
    history = { pendingRequests: signal([request('first'), request('second')]), dismissRequest: jasmine.createSpy('dismissRequest') };
    history.dismissRequest.and.callFake((id: string) => history.pendingRequests.update(items => items.filter(item => item.id !== id)));
    TestBed.configureTestingModule({ providers: [
      { provide: HistoryDeviceSyncService, useValue: history },
      { provide: AppLockService, useValue: { isLocked: locked } },
      { provide: CallsService, useValue: { activeCall } },
    ] });
    dialog = TestBed.runInInjectionContext(() => new HistoryApprovalDialogComponent());
  });

  it('hides for an app lock without declining requests and returns on unlock', async () => {
    expect(dialog.show()).toBeTrue();
    locked.set(true);
    expect(dialog.show()).toBeFalse();
    expect(await dialog.canDismiss()).toBeTrue();
    dialog.onDismiss(dismissal());
    expect(history.dismissRequest).not.toHaveBeenCalled();
    expect(history.pendingRequests().map(item => item.id)).toEqual(['first', 'second']);
    locked.set(false);
    expect(dialog.show()).toBeTrue();
  });

  it('hides for an incoming call without declining requests and returns after the call', async () => {
    activeCall.set({ id: 'incoming-call' });
    expect(dialog.show()).toBeFalse();
    expect(await dialog.canDismiss()).toBeTrue();
    dialog.onDismiss(dismissal());
    expect(history.dismissRequest).not.toHaveBeenCalled();
    activeCall.set(null);
    expect(dialog.show()).toBeTrue();
    expect(history.pendingRequests().length).toBe(2);
  });

  it('explicit close declines only the visible request and keeps the overlay open for the next request', async () => {
    dialog.dismiss();
    dialog.onDismiss(dismissal());
    expect(history.dismissRequest).toHaveBeenCalledOnceWith('first');
    expect(history.pendingRequests().map(item => item.id)).toEqual(['second']);
    expect(dialog.show()).toBeTrue();
    expect(await dialog.canDismiss()).toBeFalse();
    dialog.dismiss();
    expect(dialog.show()).toBeFalse();
    expect(await dialog.canDismiss()).toBeTrue();
  });

  it('prevents backdrop or hardware dismissal from closing a visible queue behind a one-way isOpen input', async () => {
    expect(dialog.show()).toBeTrue();
    expect(await dialog.canDismiss()).toBeFalse();
    expect(history.dismissRequest).not.toHaveBeenCalled();
    expect(history.pendingRequests().map(item => item.id)).toEqual(['first', 'second']);
  });

  it('ignores a completion dismissal rather than declining the next queued device', () => {
    history.pendingRequests.update(items => items.slice(1));
    dialog.onDismiss(dismissal('confirm'));
    expect(history.dismissRequest).not.toHaveBeenCalled();
    expect(history.pendingRequests()[0].id).toBe('second');
  });
});
