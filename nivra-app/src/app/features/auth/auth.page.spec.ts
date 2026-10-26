import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { AuthPage } from './auth.page';

describe('AuthPage access safeguards', () => {
  let page: AuthPage;
  let auth: {
    busy: ReturnType<typeof signal<boolean>>;
    stopQrLogin: jasmine.Spy;
    loginWithAlias: jasmine.Spy;
    createPrivateAccount: jasmine.Spy;
    accountsBusy: ReturnType<typeof signal<boolean>>;
    cancelAddAccount: jasmine.Spy;
  };

  beforeEach(() => {
    auth = {
      busy: signal(false),
      accountsBusy: signal(false),
      cancelAddAccount: jasmine.createSpy('cancelAddAccount').and.resolveTo(),
      stopQrLogin: jasmine.createSpy('stopQrLogin').and.resolveTo(),
      loginWithAlias: jasmine.createSpy('loginWithAlias').and.resolveTo(),
      createPrivateAccount: jasmine.createSpy('createPrivateAccount').and.resolveTo(),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: TranslateService, useValue: {
        currentLanguage: signal('es'),
        instant: (_key: string, fallback: string) => fallback,
      } },
    ] });
    page = TestBed.runInInjectionContext(() => new AuthPage());
  });

  afterEach(() => page.ngOnDestroy());

  it('hides a revealed password when another access method is selected', () => {
    page.password = 'a password kept for editing';
    page.passwordVisible = true;
    page.capsLockOn = true;
    page.setMode('qr');
    expect(page.passwordVisible).toBeFalse();
    expect(page.capsLockOn).toBeFalse();
    expect(page.password).toBe('a password kept for editing');
    page.passwordVisible = true;
    page.setAliasMode('private');
    expect(page.passwordVisible).toBeFalse();
  });

  it('clears unsent credentials before returning to the saved account', async () => {
    page.password = 'unsent private password'; page.code = '123456'; page.passwordVisible = true;
    await page.cancelAddingAccount();
    expect(auth.cancelAddAccount).toHaveBeenCalledTimes(1);
    expect(page.password).toBe(''); expect(page.code).toBe(''); expect(page.passwordVisible).toBeFalse();
  });

  it('conceals passwords when the app is hidden and clears the value on leaving access', () => {
    spyOnProperty(document, 'hidden', 'get').and.returnValue(true);
    page.password = 'private value';
    page.passwordVisible = true;
    page.onVisibilityChange();
    expect(page.passwordVisible).toBeFalse();
    expect(page.password).toBe('private value');
    page.ngOnDestroy();
    expect(page.password).toBe('');
  });

  it('reads Caps Lock state without changing the entered password', () => {
    page.password = 'Unchanged';
    page.updateCapsLock({ getModifierState: (key: string) => key === 'CapsLock' } as unknown as KeyboardEvent);
    expect(page.capsLockOn).toBeTrue();
    page.updateCapsLock({ getModifierState: () => false } as unknown as KeyboardEvent);
    expect(page.capsLockOn).toBeFalse();
    expect(page.password).toBe('Unchanged');
  });

  it('keeps one request and its access mode stable while authentication is pending', async () => {
    let finish!: () => void;
    auth.loginWithAlias.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));
    page.alias = 'private.alias';
    page.password = 'my password';
    const pending = page.submitAlias();
    await page.submitAlias();
    page.setMode('qr');
    page.setAliasMode('private');
    expect(auth.loginWithAlias).toHaveBeenCalledTimes(1);
    expect(page.mode).toBe('alias');
    expect(page.aliasMode).toBe('login');
    finish();
    await pending;
    page.setMode('qr');
    expect(page.mode).toBe('qr');
  });

  it('requires ten characters for a new account while preserving existing login compatibility', async () => {
    page.setAliasMode('private');
    page.password = 'short';
    await page.submitAlias();
    expect(auth.createPrivateAccount).not.toHaveBeenCalled();
    expect(page.error).toContain('10');
    page.password = 'long enough password';
    await page.submitAlias();
    expect(auth.createPrivateAccount).toHaveBeenCalledOnceWith('long enough password');
    page.setAliasMode('login');
    page.alias = '123 456 789';
    page.password = 'older';
    await page.submitAlias();
    expect(auth.loginWithAlias).toHaveBeenCalledOnceWith('123 456 789', 'older', 'login', '');
  });
});
