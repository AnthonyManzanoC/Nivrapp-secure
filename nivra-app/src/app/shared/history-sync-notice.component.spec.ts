import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HistoryDeviceSyncService, PendingHistoryApproval, PreferredHistorySource } from '../core/services/history-device-sync.service';
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
    checking: ReturnType<typeof signal<boolean>>;
    preferredSource: ReturnType<typeof signal<PreferredHistorySource | null>>;
    recoveryStatus: ReturnType<typeof signal<'approval' | 'partial' | 'retryable'>>;
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
      approvalError: signal(''), approvalEpoch: signal(1), checking: signal(false),
      preferredSource: signal<PreferredHistorySource | null>(null),
      recoveryStatus: signal<'approval' | 'partial' | 'retryable'>('approval'),
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

  it('retains the pending fingerprint notice throughout an actual retry without sharing anything', async () => {
    history.state.set('waiting');
    history.targetFingerprint.set('abcd ef01 2345 6789 abcd ef01');
    await settle();
    const notice = root().querySelector('.history-notice:not(.history-approval)');
    const retry = root().querySelector<HTMLButtonElement>('.history-retry')!;
    retry.click();
    expect(history.retry).toHaveBeenCalledTimes(1);
    history.checking.set(true);
    await settle();
    expect(root().querySelector('.history-notice:not(.history-approval)')).toBe(notice);
    expect(root().textContent).toContain('abcd ef01 2345 6789 abcd ef01');
    expect(retry.disabled).toBeTrue();
    expect(retry.textContent).toContain('Comprobando');
    retry.click();
    expect(history.retry).toHaveBeenCalledTimes(1);
    expect(history.approveRequest).not.toHaveBeenCalled();
    history.checking.set(false);
    await settle();
    expect(retry.disabled).toBeFalse();
    expect(notice?.textContent).toContain('pendiente');
  });

  it('keeps an unsuccessful recovery honest and hides the notice only after real readiness', async () => {
    history.state.set('unavailable');
    await settle();
    expect(root().querySelector('.history-unavailable')?.textContent).toContain('No pudimos completar');
    history.state.set('syncing');
    await settle();
    expect(root().querySelector('.history-syncing')).not.toBeNull();
    expect(root().querySelector('.history-retry')).toBeNull();
    history.state.set('idle');
    await settle();
    expect(root().querySelector('.history-notice:not(.history-approval)')).toBeNull();
    expect(history.approveRequest).not.toHaveBeenCalled();
  });

  it('replaces the authorization code with progress once the approved history starts recovering', async () => {
    fixture.componentInstance.showApprovals = false;
    history.state.set('waiting');
    history.targetFingerprint.set('abcd ef01 2345 6789 abcd ef01');
    await settle();
    expect(root().querySelector('.history-code')).not.toBeNull();
    history.state.set('syncing');
    await settle();
    expect(root().querySelector('.history-code')).toBeNull();
    expect(root().querySelector('.history-retry')).toBeNull();
    expect(root().querySelector('.history-syncing')?.textContent).toContain('Sincronizando');
    history.state.set('idle');
    await settle();
    expect(root().querySelector('.history-notice')).toBeNull();
  });

  it('guards the approval handler against stale or unconfirmed fingerprints', async () => {
    fixture.componentInstance.approve(request('first'));
    expect(history.approveRequest).not.toHaveBeenCalled();
    await confirmCode();
    history.pendingRequests.set([request('first', 'aaaa bbbb cccc dddd eeee ffff')]);
    fixture.componentInstance.approve(request('first'));
    expect(history.approveRequest).not.toHaveBeenCalled();
  });

  it('keeps waiting details out of a compact conversation header and exposes them through a dialog action', async () => {
    fixture.componentInstance.compact = true;
    fixture.componentInstance.showApprovals = false;
    history.state.set('waiting');
    history.targetFingerprint.set('abcd ef01 2345 6789 abcd ef01');
    await settle();
    expect(root().querySelector('.history-notice')).toBeNull();
    const trigger = root().querySelector<HTMLButtonElement>('.history-compact')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.textContent).toContain('pendiente');
    trigger.click();
    expect(fixture.componentInstance.detailsOpen).toBeTrue();
    fixture.componentInstance.detailsOpen = false;
    history.state.set('idle');
    await settle();
    expect(root().querySelector('.history-compact')).toBeNull();
  });

  it('offers explicit relinking instead of repeatedly requesting history for an unsafe identity', async () => {
    fixture.componentInstance.showApprovals = false;
    fixture.componentInstance.identityError = true;
    fixture.componentInstance.needsRelink = true;
    history.state.set('unavailable');
    history.targetFingerprint.set('abcd ef01 2345 6789 abcd ef01');
    const relink = jasmine.createSpy('relink');
    fixture.componentInstance.relinkRequested.subscribe(relink);
    await settle();
    expect(root().textContent).toContain('historial guardado se conserva');
    expect(root().querySelector('.history-code')).toBeNull();
    root().querySelector<HTMLButtonElement>('.history-retry')!.click();
    expect(relink).toHaveBeenCalledTimes(1);
    expect(history.retry).not.toHaveBeenCalled();
  });

  it('recommends the habitual APK without claiming it still owns history or disabling another source', async () => {
    history.state.set('waiting');
    history.preferredSource.set({ deviceId: 'phone', deviceName: 'Android Nivra Mobile', kind: 'android', basis: 'message-recipient' });
    await settle();
    const hint = root().querySelector('.history-source-hint');
    expect(hint?.textContent).toContain('Android Nivra Mobile');
    expect(hint?.textContent).toContain('Si conserva tus chats');
    expect(hint?.textContent).toContain('otro equipo');
    expect(share().disabled).toBeTrue();
    await confirmCode();
    expect(share().disabled).toBeFalse();
    history.state.set('syncing');
    await settle();
    expect(root().querySelector('.history-source-hint')).toBeNull();
  });

  it('keeps a partial history honest after approval and offers comparison for another key source', async () => {
    fixture.componentInstance.showApprovals = false;
    history.state.set('waiting'); history.recoveryStatus.set('partial');
    history.targetFingerprint.set('abcd ef01 2345 6789 abcd ef01');
    await settle();
    expect(root().textContent).toContain('Las llaves aprobadas ya están guardadas');
    expect(root().textContent).toContain('otras llaves');
    expect(root().querySelector('.history-code')).not.toBeNull();
    expect(root().querySelector('.history-syncing')).toBeNull();
  });

  it('offers a local retry for a failed refresh without asking to approve the same saved keys again', async () => {
    fixture.componentInstance.showApprovals = false;
    history.state.set('waiting'); history.recoveryStatus.set('retryable');
    history.targetFingerprint.set('abcd ef01 2345 6789 abcd ef01');
    await settle();
    expect(root().textContent).toContain('Reintenta con las llaves guardadas');
    expect(root().querySelector('.history-code')).toBeNull();
    root().querySelector<HTMLButtonElement>('.history-retry')!.click();
    expect(history.retry).toHaveBeenCalledTimes(1);
  });
});
