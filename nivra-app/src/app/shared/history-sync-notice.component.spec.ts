import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HistoryDeviceSyncService, PendingHistoryApproval } from '../core/services/history-device-sync.service';
import { TranslateService } from '../core/services/translate.service';
import { HistorySyncNoticeComponent } from './history-sync-notice.component';

describe('history device fingerprint comparison controls', () => {
  let fixture: ComponentFixture<HistorySyncNoticeComponent>;
  let history: {
    pendingRequests: ReturnType<typeof signal<PendingHistoryApproval[]>>;
    state: ReturnType<typeof signal<'idle' | 'waiting' | 'syncing' | 'unavailable'>>;
    targetFingerprint: ReturnType<typeof signal<string>>;
    approvingRequestId: ReturnType<typeof signal<string | null>>;
    approvalError: ReturnType<typeof signal<string>>;
    approvalEpoch: ReturnType<typeof signal<number>>;
    approveRequest: jasmine.Spy; dismissRequest: jasmine.Spy; retry: jasmine.Spy;
  };
  const request = (id: string, fingerprint = '1234 5678 90ab cdef 1234 5678'): PendingHistoryApproval => ({
    id, userId: 'alice', targetDeviceId: `device-${id}`, targetIdentityKey: '{}',
    targetDeviceName: `Browser ${id}`, fingerprint, expiresAt: '2099-01-01T00:00:00Z',
  });
  const root = () => fixture.nativeElement as HTMLElement;
  const share = () => root().querySelector<HTMLButtonElement>('.history-share')!;
  const checkbox = () => root().querySelector<HTMLInputElement>('.history-approval input')!;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const confirmCode = async () => { checkbox().click(); await settle(); };

  beforeEach(async () => {
    history = {
      pendingRequests: signal([request('first')]), state: signal<'idle' | 'waiting' | 'syncing' | 'unavailable'>('idle'),
      targetFingerprint: signal(''), approvingRequestId: signal<string | null>(null),
      approvalError: signal(''), approvalEpoch: signal(1),
      approveRequest: jasmine.createSpy('approveRequest').and.resolveTo(),
      dismissRequest: jasmine.createSpy('dismissRequest'), retry: jasmine.createSpy('retry'),
    };
    history.dismissRequest.and.callFake((id: string) => history.pendingRequests.update(items => items.filter(item => item.id !== id)));
    await TestBed.configureTestingModule({
      imports: [HistorySyncNoticeComponent], providers: [
        { provide: HistoryDeviceSyncService, useValue: history },
        { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HistorySyncNoticeComponent);
    await settle();
  });

  it('requires a deliberate comparison before a click can share private history', async () => {
    expect(checkbox().checked).toBeFalse();
    expect(share().disabled).toBeTrue();
    share().click();
    expect(history.approveRequest).not.toHaveBeenCalled();
    await confirmCode();
    expect(share().disabled).toBeFalse();
    share().click();
    expect(history.approveRequest).toHaveBeenCalledOnceWith('first');
  });

  it('requires a new comparison if the same request is replaced with a different fingerprint', async () => {
    await confirmCode();
    history.pendingRequests.set([request('first', 'aaaa bbbb cccc dddd eeee ffff')]);
    await settle();
    expect(checkbox().checked).toBeFalse();
    expect(share().disabled).toBeTrue();
    share().click();
    expect(history.approveRequest).not.toHaveBeenCalled();
    await confirmCode();
    expect(share().disabled).toBeFalse();
    share().click();
    expect(history.approveRequest).toHaveBeenCalledOnceWith('first');
  });

  it('forgets the comparison on a new session scope even if the request id and fingerprint recur', async () => {
    await confirmCode();
    expect(share().disabled).toBeFalse();
    history.approvalEpoch.update(epoch => epoch + 1);
    await settle();
    expect(checkbox().checked).toBeFalse();
    expect(share().disabled).toBeTrue();
    share().click();
    expect(history.approveRequest).not.toHaveBeenCalled();
  });

  it('blocks a second approval while any device approval is in progress', async () => {
    await confirmCode();
    history.approvingRequestId.set('another-request');
    await settle();
    expect(share().disabled).toBeTrue();
    share().click();
    expect(history.approveRequest).not.toHaveBeenCalled();
    history.approvingRequestId.set(null);
    await settle();
    expect(share().disabled).toBeFalse();
  });

  it('shows one queued device at a time and requires an independent comparison for the next device', async () => {
    fixture.componentInstance.approvalLimit = 1;
    history.pendingRequests.set([request('first'), request('second')]);
    await settle();
    expect(root().querySelectorAll('.history-approval').length).toBe(1);
    expect(root().textContent).toContain('Browser first');
    expect(root().textContent).not.toContain('Browser second');
    await confirmCode();
    root().querySelectorAll<HTMLButtonElement>('.history-approval-actions button')[1].click();
    await settle();
    expect(history.dismissRequest).toHaveBeenCalledOnceWith('first');
    expect(history.pendingRequests().map(item => item.id)).toEqual(['second']);
    expect(root().textContent).toContain('Browser second');
    expect(checkbox().checked).toBeFalse();
    expect(share().disabled).toBeTrue();
  });

  it('keeps both independently computed codes left to right in a right to left interface', async () => {
    root().dir = 'rtl';
    history.state.set('waiting');
    history.targetFingerprint.set('abcd ef01 2345 6789 abcd ef01');
    await settle();
    const codes = Array.from(root().querySelectorAll('code'));
    expect(codes.map(code => code.textContent?.trim())).toEqual([
      'abcd ef01 2345 6789 abcd ef01', '1234 5678 90ab cdef 1234 5678',
    ]);
    expect(codes.every(code => code.getAttribute('dir') === 'ltr')).toBeTrue();
  });
});
