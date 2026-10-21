import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LoadingController } from '@ionic/angular/standalone';
import { AccountService } from '../../core/services/account.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { AndroidUpdateService } from '../../core/services/android-update.service';
import { PanicPinService } from '../../core/services/panic-pin.service';
import { PushService } from '../../core/services/push.service';
import { TranslateService } from '../../core/services/translate.service';
import { NivraDevice } from '../../core/models/nivra.models';
import { AccountPage } from './account.page';

describe('Account device access controls', () => {
  let page: AccountPage;
  let session: ReturnType<typeof signal<any>>;
  let devices: ReturnType<typeof signal<NivraDevice[]>>;
  let revokeDevice: jasmine.Spy;
  const device = (id: string, extra: Partial<NivraDevice> = {}): NivraDevice => ({
    id, userId: 'owner', name: id, isTrusted: true, createdAt: '2026-10-21T00:00:00Z', ...extra,
  });

  beforeEach(() => {
    session = signal<any>({ user: { id: 'owner' }, device: device('current', { hardwareId: 'local' }) });
    devices = signal([device('other'), device('current', { hardwareId: 'local' })]);
    revokeDevice = jasmine.createSpy().and.resolveTo();
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } },
      { provide: AccountService, useValue: { devices, revokeDevice } },
      { provide: AppLockService, useValue: {} }, { provide: AppSettingsService, useValue: {} },
      { provide: CallsService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
      { provide: PanicPinService, useValue: {} }, { provide: PushService, useValue: {} },
      { provide: NativeDeviceService, useValue: {} }, { provide: AndroidUpdateService, useValue: {} },
      { provide: Router, useValue: {} }, { provide: LoadingController, useValue: {} },
    ] });
    page = TestBed.runInInjectionContext(() => new AccountPage());
  });
  afterEach(() => page.ngOnDestroy());

  it('shows only active devices belonging to the current account and keeps the source order intact', () => {
    devices.update((items) => [...items, device('foreign', { userId: 'someone-else' }), device('old', { revokedAt: '2026-10-21T01:00:00Z' })]);
    expect(page.accountDevices().map((entry) => entry.id)).toEqual(['current', 'other']);
    expect(devices()[0].id).toBe('other');
  });

  it('requires an explicit confirmation and sends the exact device ID', async () => {
    page.requestDeviceRevocation(devices()[0]);
    expect(revokeDevice).not.toHaveBeenCalled();
    expect(page.pendingDeviceName()).toBe('other');
    await page.confirmDeviceRevocation();
    expect(revokeDevice).toHaveBeenCalledOnceWith('other');
    expect(page.pendingDeviceRevocation).toBeNull();
  });

  it('never offers to revoke this device or another entry with its hardware identity', () => {
    const sameHardware = device('duplicate', { hardwareId: 'local' });
    devices.update((items) => [...items, sameHardware]);
    page.requestDeviceRevocation(devices()[1]);
    expect(page.pendingDeviceRevocation).toBeNull();
    page.requestDeviceRevocation(sameHardware);
    expect(page.pendingDeviceRevocation).toBeNull();
  });

  it('discards confirmation if the account changes while the sheet is open', async () => {
    page.requestDeviceRevocation(devices()[0]);
    session.set({ user: { id: 'new-owner' }, device: device('new-current', { userId: 'new-owner' }) });
    await page.confirmDeviceRevocation();
    expect(revokeDevice).not.toHaveBeenCalled();
    expect(page.pendingDeviceRevocation).toBeNull();
  });

  it('does not act on a device already removed by a live update', async () => {
    page.requestDeviceRevocation(devices()[0]);
    devices.set([devices()[1]]);
    await page.confirmDeviceRevocation();
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it('coalesces duplicate confirmation clicks', async () => {
    let finish!: () => void;
    revokeDevice.and.returnValue(new Promise<void>((resolve) => finish = resolve));
    page.requestDeviceRevocation(devices()[0]);
    const first = page.confirmDeviceRevocation();
    await page.confirmDeviceRevocation();
    expect(revokeDevice).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(page.saving).toBeFalse();
  });

  it('shows revocation failure without claiming success', async () => {
    revokeDevice.and.rejectWith(new Error('Sin conexión'));
    page.requestDeviceRevocation(devices()[0]);
    await page.confirmDeviceRevocation();
    expect(page.error).toBe('Sin conexión');
    expect(page.notice).toBe('');
  });
});
