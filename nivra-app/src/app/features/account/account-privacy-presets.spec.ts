import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LoadingController } from '@ionic/angular/standalone';
import { EMPTY, of } from 'rxjs';
import { PrivacySettings } from '../../core/models/nivra.models';
import { AccountService } from '../../core/services/account.service';
import { AndroidUpdateService } from '../../core/services/android-update.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { CryptoService } from '../../core/services/crypto.service';
import { DesktopUpdateService } from '../../core/services/desktop-update.service';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { PanicPinService } from '../../core/services/panic-pin.service';
import { PushService } from '../../core/services/push.service';
import { SignalrService } from '../../core/services/signalr.service';
import { TranslateService } from '../../core/services/translate.service';
import { AccountPage } from './account.page';

describe('Account privacy preset persistence', () => {
  let page: AccountPage;
  let account: AccountService;
  let session: ReturnType<typeof signal<any>>;
  let api: { patch: jasmine.Spy };
  let persisted: PrivacySettings;

  beforeEach(() => {
    persisted = { defaultMessageTtlSeconds: null, privacyPreset: 'balanced', hideNotificationContent: true,
      allowForwarding: true, allowScreenshots: false, readReceipts: true, profilePhotoVisibility: 'contacts' };
    session = signal<any>({ user: { id: 'privacy-fixture', alias: 'fixture', privacySettings: { ...persisted } }, device: { id: 'phone' } });
    api = { patch: jasmine.createSpy('patch').and.callFake((_path: string, request: PrivacySettings) => {
      // PATCH /privacy uses a nullable integer: null leaves the stored value
      // untouched; an explicit zero disables the existing TTL.
      const previousTtl = persisted.defaultMessageTtlSeconds;
      const requestedTtl = request.defaultMessageTtlSeconds;
      persisted = { ...persisted, ...request, defaultMessageTtlSeconds: requestedTtl == null
        ? previousTtl : requestedTtl <= 0 ? null : requestedTtl };
      return of({ ...persisted });
    }) };
    TestBed.configureTestingModule({ providers: [AccountService,
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session(),
        updateUser: (user: any) => session.update(current => ({ ...current, user })) } },
      { provide: NivraApiService, useValue: api }, { provide: CryptoService, useValue: {} },
      { provide: SignalrService, useValue: { events$: EMPTY } },
      { provide: AppLockService, useValue: {} }, { provide: AppSettingsService, useValue: {} },
      { provide: CallsService, useValue: {} }, { provide: PanicPinService, useValue: {} },
      { provide: PushService, useValue: {} }, { provide: NativeDeviceService, useValue: {} },
      { provide: AndroidUpdateService, useValue: {} }, { provide: DesktopUpdateService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
      { provide: Router, useValue: {} }, { provide: LoadingController, useValue: {} },
    ] });
    account = TestBed.inject(AccountService);
    page = TestBed.runInInjectionContext(() => new AccountPage());
    TestBed.flushEffects();
    account.privacy.set({ ...persisted });
  });

  afterEach(() => { page.ngOnDestroy(); TestBed.resetTestingModule(); });

  for (const preset of ['balanced', 'open']) {
    it(`disables a persisted private preset TTL after saving the ${preset} preset`, async () => {
      page.applyPrivacyPreset('private');
      await page.savePrivacy();
      expect(persisted.defaultMessageTtlSeconds).toBe(86400);

      page.applyPrivacyPreset(preset);
      expect(account.privacy()?.defaultMessageTtlSeconds).toBeNull();
      await page.savePrivacy();

      expect(api.patch.calls.mostRecent().args[0]).toBe('/privacy');
      expect(api.patch.calls.mostRecent().args[1].defaultMessageTtlSeconds).toBe(0);
      expect(persisted.defaultMessageTtlSeconds).toBeNull();
      expect(account.privacy()?.defaultMessageTtlSeconds).toBeNull();
      expect(session().user.privacySettings.defaultMessageTtlSeconds).toBeNull();
      expect(persisted.privacyPreset).toBe(preset);
      expect(persisted.allowScreenshots).toBe(preset === 'open');
      expect(page.error).toBe('');
    });
  }

  it('keeps an explicit expiration and the remaining privacy choices during a full save', async () => {
    account.privacy.set({ ...persisted, defaultMessageTtlSeconds: 604800, allowForwarding: false,
      readReceipts: false, profilePhotoVisibility: 'nobody' });
    await page.savePrivacy();
    expect(persisted.defaultMessageTtlSeconds).toBe(604800);
    expect(persisted.allowForwarding).toBeFalse();
    expect(persisted.readReceipts).toBeFalse();
    expect(persisted.profilePhotoVisibility).toBe('nobody');
    expect(session().user.privacySettings).toEqual(persisted);
  });
});
