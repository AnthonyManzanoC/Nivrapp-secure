import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppSettingsService } from './app-settings.service';
import { NivraI18nService } from './nivra-i18n.service';

describe('release language initialization', () => {
  const settings = signal({ language: 'es' });
  let originalLanguage: string | null;
  let originalDirection: string | null;

  beforeEach(() => {
    originalLanguage = document.documentElement.getAttribute('lang');
    originalDirection = document.documentElement.getAttribute('dir');
    settings.set({ language: 'es' });
    TestBed.configureTestingModule({ providers: [
      { provide: AppSettingsService, useValue: {
        settings,
        set: (_key: string, language: string) => settings.set({ language }),
      } },
    ] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    originalLanguage === null ? document.documentElement.removeAttribute('lang')
      : document.documentElement.setAttribute('lang', originalLanguage);
    originalDirection === null ? document.documentElement.removeAttribute('dir')
      : document.documentElement.setAttribute('dir', originalDirection);
  });

  it('starts in every supported language with translated release actions', () => {
    const i18n = TestBed.inject(NivraI18nService);
    for (const language of ['es', 'en', 'ar', 'de', 'fr', 'hi', 'ja', 'pt', 'ru', 'zh-Hans']) {
      i18n.use(language);
      for (const key of [
        'LAUNCH.CHECKING', 'LAUNCH.ENCRYPTED', 'CALLS.CAMERA_PERMISSION_ERROR',
        'HISTORY_DEVICE.HINT', 'settings.wallpaper.silk', 'CHAT.IDENTITY_VERIFY_ACTION',
      ]) {
        expect(i18n.currentTerm(key)).withContext(`${language}: ${key}`).toBeTruthy();
      }
    }
  });
});
