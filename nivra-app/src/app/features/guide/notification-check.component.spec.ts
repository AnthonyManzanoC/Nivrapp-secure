import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotificationCheckComponent } from './notification-check.component';
import { AuthService } from '../../core/services/auth.service';
import { PushService } from '../../core/services/push.service';
import { NativeDeviceService } from '../../core/services/native-device.service';

describe('notification diagnosis lifecycle', () => {
  const session = signal<any>({ user: { id: 'alice' }, device: { id: 'a' } });
  let push: any;
  beforeEach(() => {
    session.set({ user: { id: 'alice' }, device: { id: 'a' } });
    push = { refreshStatus: jasmine.createSpy().and.resolveTo(true), requestPermissionAndRegister: jasmine.createSpy().and.resolveTo(true), registeredOnServer: signal(false), error: signal(''), tokenId: signal(null) };
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: { session } }, { provide: PushService, useValue: push }, { provide: NativeDeviceService, useValue: { openNotificationSettings: jasmine.createSpy().and.resolveTo() } }] });
  });
  const create = () => TestBed.runInInjectionContext(() => new NotificationCheckComponent());
  it('checks automatically without prompting for permission', async () => {
    const panel = create(); TestBed.flushEffects(); await Promise.resolve();
    expect(push.refreshStatus).toHaveBeenCalledTimes(1);
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
    expect(panel.checked()).toBeTrue(); expect(panel.reachable()).toBeTrue();
  });
  it('ignores late results from another account', async () => {
    let finish!: (ok: boolean) => void;
    push.refreshStatus.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const panel = create(); TestBed.flushEffects();
    session.set({ user: { id: 'bob' }, device: { id: 'b' } });
    push.refreshStatus.and.resolveTo(false); TestBed.flushEffects(); await Promise.resolve();
    finish(true); await Promise.resolve(); await Promise.resolve();
    expect(panel.reachable()).toBeFalse(); expect(panel.registered()).toBeNull();
  });
  it('offers retry after failure and registers only on explicit action', async () => {
    const panel = create(); TestBed.flushEffects(); await Promise.resolve();
    push.refreshStatus.and.rejectWith(new Error('offline'));
    await panel.check(); expect(panel.checked()).toBeTrue(); expect(panel.busy()).toBeFalse(); expect(panel.reachable()).toBeFalse();
    await panel.check(true); expect(push.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
  });
});
