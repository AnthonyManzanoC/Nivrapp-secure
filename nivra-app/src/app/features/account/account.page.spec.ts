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
import { PanicPinService } from '../../core/services/panic-pin.service';
import { PushService } from '../../core/services/push.service';
import { TranslateService } from '../../core/services/translate.service';
import { AccountPage } from './account.page';

describe('Account recovery email profile binding', () => {
  let page: AccountPage;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session: signal({ user: { email: 'perfil@nivra.test' } }) } },
      { provide: AccountService, useValue: { loading: signal(false), privacy: signal(null) } },
      { provide: AppLockService, useValue: {} },
      { provide: AppSettingsService, useValue: {} },
      { provide: CallsService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
      { provide: PanicPinService, useValue: {} },
      { provide: PushService, useValue: {} },
      { provide: NativeDeviceService, useValue: {} },
      { provide: Router, useValue: {} },
      { provide: LoadingController, useValue: {} },
    ] });
    page = TestBed.runInInjectionContext(() => new AccountPage());
  });

  it('shows a verified recovery email in the readonly profile value', () => {
    page.onRecoveryEmailState({ email: 'recuperacion@nivra.test', verified: true });

    expect(page.recoveryEmailVerified).toBeTrue();
    expect(page.email).toBe('recuperacion@nivra.test');
  });

  it('does not retain a stale recovery email when verification is absent', () => {
    page.email = 'recuperacion@nivra.test';
    page.onRecoveryEmailState({ email: null, verified: false });

    expect(page.recoveryEmailVerified).toBeFalse();
    expect(page.email).toBe('perfil@nivra.test');
  });
});
