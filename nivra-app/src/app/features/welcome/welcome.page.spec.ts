import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NativeOnboardingService } from '../../core/services/native-onboarding.service';
import { TranslateService } from '../../core/services/translate.service';
import { WelcomePage } from './welcome.page';

describe('WelcomePage', () => {
  const setup = (navigate: jasmine.Spy) => {
    const use = jasmine.createSpy('use');
    const complete = jasmine.createSpy('complete');
    TestBed.configureTestingModule({ providers: [
      { provide: TranslateService, useValue: {
        currentLanguage: signal('es'), use,
        instant: (_key: string, fallback: string) => fallback,
      } },
      { provide: NativeOnboardingService, useValue: { complete } },
      { provide: Router, useValue: { navigateByUrl: navigate } },
    ] });
    return { page: TestBed.runInInjectionContext(() => new WelcomePage()), use, complete };
  };

  it('uses the saved language setting and continues to the existing auth flow', async () => {
    const navigate = jasmine.createSpy('navigateByUrl').and.resolveTo(true);
    const { page, use, complete } = setup(navigate);
    expect(page.languageOptions.length).toBe(10);
    page.setLanguage('ar');
    expect(use).toHaveBeenCalledOnceWith('ar');
    await page.next();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledOnceWith('/auth', { replaceUrl: true });
  });

  it('prevents repeated navigation while the first transition is pending', async () => {
    let finish!: (result: boolean) => void;
    const navigate = jasmine.createSpy('navigateByUrl').and.returnValue(new Promise<boolean>(resolve => { finish = resolve; }));
    const { page, complete } = setup(navigate);
    const pending = page.next();
    await page.next();
    expect(page.continuing).toBeTrue();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    finish(true);
    await pending;
    expect(page.continuing).toBeFalse();
  });

  it('offers a retry when navigation is cancelled', async () => {
    const navigate = jasmine.createSpy('navigateByUrl').and.resolveTo(false);
    const { page } = setup(navigate);
    await page.next();
    expect(page.error).toContain('Vuelve a intentarlo');
    expect(page.continuing).toBeFalse();
    navigate.and.resolveTo(true);
    await page.next();
    expect(page.error).toBe('');
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('handles rejected navigation without leaving the continue button locked', async () => {
    const navigate = jasmine.createSpy('navigateByUrl').and.rejectWith(new Error('navigation failed'));
    const { page } = setup(navigate);
    await page.next();
    expect(page.error).toContain('Vuelve a intentarlo');
    expect(page.continuing).toBeFalse();
  });
});
