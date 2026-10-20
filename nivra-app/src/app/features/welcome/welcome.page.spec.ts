import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NativeOnboardingService } from '../../core/services/native-onboarding.service';
import { TranslateService } from '../../core/services/translate.service';
import { WelcomePage } from './welcome.page';

describe('WelcomePage', () => {
  it('uses the saved language setting and continues to the existing auth flow', async () => {
    const use = jasmine.createSpy('use');
    const complete = jasmine.createSpy('complete');
    const navigate = jasmine.createSpy('navigateByUrl').and.resolveTo(true);
    TestBed.configureTestingModule({ providers: [
      { provide: TranslateService, useValue: { currentLanguage: signal('es'), use } },
      { provide: NativeOnboardingService, useValue: { complete } },
      { provide: Router, useValue: { navigateByUrl: navigate } },
    ] });
    const page = TestBed.runInInjectionContext(() => new WelcomePage());
    expect(page.languageOptions.length).toBe(10);
    page.setLanguage('ar');
    expect(use).toHaveBeenCalledOnceWith('ar');
    await page.next();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledOnceWith('/auth', { replaceUrl: true });
  });
});
