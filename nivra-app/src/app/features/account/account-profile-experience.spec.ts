import { signal } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
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
import { AccountPage } from './account.page';

describe('Account profile editing experience', () => {
  let page: AccountPage;
  let session: ReturnType<typeof signal<any>>;
  let account: { load: jasmine.Spy; updateProfile: jasmine.Spy; checkAliasAvailable: jasmine.Spy; privacy: ReturnType<typeof signal<any>>; loading: ReturnType<typeof signal<boolean>> };
  const owner = (id = 'owner-a') => ({ user: { id, alias: 'maria', displayName: 'María', bio: 'Original', isDiscoverable: true, allowStoryReposts: true, privacySettings: {} }, device: { id: `device-${id}` } });

  beforeEach(async () => {
    session = signal<any>(owner());
    account = { load: jasmine.createSpy('load').and.resolveTo(), updateProfile: jasmine.createSpy('updateProfile').and.resolveTo(), checkAliasAvailable: jasmine.createSpy('checkAliasAvailable').and.resolveTo(true), privacy: signal(null), loading: signal(false) };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } }, { provide: AccountService, useValue: account },
      { provide: AppLockService, useValue: {} }, { provide: AppSettingsService, useValue: { set: jasmine.createSpy('set') } },
      { provide: CallsService, useValue: {} }, { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
      { provide: PanicPinService, useValue: {} }, { provide: PushService, useValue: {} },
      { provide: NativeDeviceService, useValue: { copyToClipboard: jasmine.createSpy().and.resolveTo() } },
      { provide: AndroidUpdateService, useValue: {} }, { provide: Router, useValue: {} }, { provide: LoadingController, useValue: {} },
    ] });
    page = TestBed.runInInjectionContext(() => new AccountPage());
    await page.reload();
    TestBed.flushEffects();
  });
  afterEach(() => page.ngOnDestroy());

  it('does not remove the photo while a profile save or load is in progress', () => {
    page.profilePhotoDataUrl = 'data:image/jpeg;base64,b2xk';
    page.saving = true;
    page.removeProfilePhoto();
    expect(page.profilePhotoDataUrl).toBe('data:image/jpeg;base64,b2xk');
    page.saving = false;
    page.profileLoading = true;
    page.removeProfilePhoto();
    expect(page.profilePhotoDataUrl).toBe('data:image/jpeg;base64,b2xk');
  });

  it('stages a memorable alias without saving or changing the stable login ID', () => {
    session.set({ ...owner(), user: { ...owner().user, alias: 'n_010d9af5bd3143b6844e8d5d', displayName: null, nivraNumber: '619622786', isPrivateAccount: true } });
    (page as any).profileOwnerScope = 'owner-a:device-owner-a';
    page.alias = session().user.alias;
    page.displayName = '';
    expect(page.profileTitle()).toBe('Nivra 619 622 786');
    expect(page.legacyIdentityAlias()).toBeTrue();
    page.suggestAlias();
    expect(page.alias).toMatch(/^[a-z]+\.[a-z]+\d{2}$/);
    expect(page.aliasStatus).toBe('checking');
    expect(page.legacyIdentityAlias()).toBeFalse();
    expect(session().user.nivraNumber).toBe('619622786');
    expect(account.updateProfile).not.toHaveBeenCalled();
  });

  it('reports ghost mode from the discovery choice, independent of phone availability', () => {
    page.phone = '+573001234567';
    page.isDiscoverable = false;
    expect(page.identityMode()).toBe('ghost');
    page.phone = '';
    page.isDiscoverable = true;
    expect(page.identityMode()).toBe('public');
  });

  it('explains that contacts-only photos use the photo owner’s saved contacts', () => {
    account.privacy.set({ profilePhotoVisibility: 'contacts' });
    expect(page.photoVisibilityHelp()).toContain('tú guardaste');
    account.privacy.set({ profilePhotoVisibility: 'nobody' });
    expect(page.photoVisibilityHelp()).toContain('Sólo tú');
  });

  it('retains a draft while refreshing devices and privacy, and restores all fields on discard', async () => {
    page.displayName = 'Mi edición';
    page.bio = 'Nuevo texto';
    page.isDiscoverable = false;
    expect(page.hasProfileChanges()).toBeTrue();
    await page.reload();
    expect(page.displayName).toBe('Mi edición');
    page.discardProfileChanges();
    expect(page.displayName).toBe('María');
    expect(page.bio).toBe('Original');
    expect(page.isDiscoverable).toBeTrue();
    expect(page.hasProfileChanges()).toBeFalse();
  });

  it('sends an empty bio explicitly so deleting it actually removes it on the server', async () => {
    page.bio = '';
    await page.saveProfile();
    expect(account.updateProfile).toHaveBeenCalledWith(jasmine.objectContaining({ bio: '' }));
    expect(page.hasProfileChanges()).toBeFalse();
  });

  it('coalesces duplicate save clicks and freezes the submitted payload', async () => {
    let finish!: () => void;
    account.updateProfile.and.returnValue(new Promise<void>((resolve) => finish = resolve));
    page.displayName = 'Nuevo';
    const first = page.saveProfile();
    await page.saveProfile();
    expect(account.updateProfile).toHaveBeenCalledTimes(1);
    expect(page.canSaveProfile()).toBeFalse();
    finish();
    await first;
  });

  it('keeps the draft and offers an inline error when saving fails', async () => {
    account.updateProfile.and.rejectWith(new Error('Sin conexión'));
    page.bio = 'Pendiente';
    await page.saveProfile();
    expect(page.profileError).toBe('Sin conexión');
    expect(page.hasProfileChanges()).toBeTrue();
    expect(page.saving).toBeFalse();
  });

  it('clears old photos and pending edits on account change and ignores a late crop', () => {
    page.profilePhotoDataUrl = 'data:image/jpeg;base64,b2xk';
    (page as any).photoCropScope = 'owner-a:device-owner-a';
    session.set(owner('owner-b'));
    TestBed.flushEffects();
    page.applyProfilePhotoCrop('data:image/jpeg;base64,bGF0ZQ==');
    expect(page.profilePhotoDataUrl).toBe('');
    expect(page.hasProfileChanges()).toBeFalse();
    expect(page.profileCropFile).toBeNull();
  });

  it('rejects oversized photos before opening the decoder', async () => {
    const input = { value: 'picked', files: [{ type: 'image/jpeg', size: 21 * 1024 * 1024 }] };
    await page.pickProfilePhoto({ target: input } as any);
    expect(input.value).toBe('');
    expect(page.profileCropFile).toBeNull();
    expect(page.profileError).toContain('20 MB');
  });

  it('builds a public contact link usable outside a native localhost WebView', () => {
    expect(page.shareUrl()).toBe('https://nivrapp-secure.vercel.app/contact?alias=maria');
  });

  it('lets an alias check fail and retry the same value without getting stuck', fakeAsync(() => {
    (page as any).listenForAliasChecks();
    account.checkAliasAvailable.and.rejectWith(new Error('offline'));
    page.aliasChanged('nuevo');
    tick(500);
    expect(page.aliasStatus).toBe('error');
    account.checkAliasAvailable.and.resolveTo(true);
    page.retryAliasCheck();
    tick(500);
    expect(page.aliasStatus).toBe('available');
    expect(account.checkAliasAvailable).toHaveBeenCalledTimes(2);
  }));

  it('does not publish a late alias result in a different account', fakeAsync(() => {
    let resolveCheck!: (available: boolean) => void;
    account.checkAliasAvailable.and.returnValue(new Promise((resolve) => resolveCheck = resolve));
    (page as any).listenForAliasChecks();
    page.aliasChanged('nuevo');
    tick(500);
    session.set(owner('owner-b'));
    TestBed.flushEffects();
    resolveCheck(true);
    tick();
    expect(page.aliasStatus).toBe('idle');
    expect(page.alias).toBe('');
  }));

  it('releases camera capture that completes after the scanner was closed', async () => {
    const { Html5Qrcode } = await import('html5-qrcode');
    const region = document.createElement('div');
    region.id = 'contactQrScannerRegion';
    document.body.appendChild(region);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => markStarted = resolve);
    let finishCapture!: () => void;
    const capture = new Promise<null>((resolve) => finishCapture = () => resolve(null));
    spyOn(Html5Qrcode.prototype, 'start').and.callFake(() => { markStarted(); return capture; });
    const stop = spyOn(Html5Qrcode.prototype, 'stop').and.resolveTo();
    spyOn(Html5Qrcode.prototype, 'clear').and.stub();
    try {
      const pending = page.startContactScanner();
      await started;
      await page.stopContactScanner();
      finishCapture();
      await pending;
      expect(page.contactScannerOpen).toBeFalse();
      expect(stop).toHaveBeenCalledTimes(2);
      expect((page as any).contactScanner).toBeNull();
    } finally { region.remove(); }
  });
});
