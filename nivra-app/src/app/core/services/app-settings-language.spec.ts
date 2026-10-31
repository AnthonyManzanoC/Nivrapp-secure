import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppSettingsService } from './app-settings.service';
import { AuthService } from './auth.service';

describe('welcome language and account preferences', () => {
  const guestKey = 'nivra.settings.v2';
  const accountKey = 'nivra.settings.v2.welcome-language-test';
  const legacyKey = 'nivra.theme';
  const session = signal<{ user: { id: string } } | null>(null);
  let originalStorage: Array<[string, string | null]>;
  let originalDocument: Array<[HTMLElement, string | null, string | null, Record<string, string | undefined>]>;
  let originalLanguage: string | null;
  let originalDirection: string | null;

  beforeEach(() => {
    originalStorage = [guestKey, accountKey, legacyKey].map(key => [key, localStorage.getItem(key)]);
    [guestKey, accountKey, legacyKey].forEach(key => localStorage.removeItem(key));
    const targets = [document.documentElement, document.body, document.querySelector('ion-app') as HTMLElement | null]
      .filter((element): element is HTMLElement => !!element);
    originalDocument = targets.map(element => [
      element, element.getAttribute('style'), element.getAttribute('class'), { ...element.dataset },
    ]);
    originalLanguage = document.documentElement.getAttribute('lang');
    originalDirection = document.documentElement.getAttribute('dir');
    session.set(null);
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session() } },
    ] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    originalStorage.forEach(([key, value]) => value === null
      ? localStorage.removeItem(key) : localStorage.setItem(key, value));
    originalDocument.forEach(([element, style, classes, dataset]) => {
      style === null ? element.removeAttribute('style') : element.setAttribute('style', style);
      classes === null ? element.removeAttribute('class') : element.setAttribute('class', classes);
      Object.keys(element.dataset).forEach(key => delete element.dataset[key]);
      Object.assign(element.dataset, dataset);
    });
    originalLanguage === null ? document.documentElement.removeAttribute('lang')
      : document.documentElement.setAttribute('lang', originalLanguage);
    originalDirection === null ? document.documentElement.removeAttribute('dir')
      : document.documentElement.setAttribute('dir', originalDirection);
  });

  it('carries only the chosen guest language into a new account and keeps it after relaunch', () => {
    const settings = TestBed.inject(AppSettingsService);
    settings.update({ language: 'ar', chatWallpaper: 'paper', accentColor: 'blue', messageTextSize: 22 });
    TestBed.flushEffects();
    expect(JSON.parse(localStorage.getItem(guestKey)!).language).toBe('ar');

    session.set({ user: { id: 'welcome-language-test' } });
    TestBed.flushEffects();
    expect(settings.settings().language).toBe('ar');
    expect(settings.settings().chatWallpaper).toBe('nivra');
    expect(settings.settings().accentColor).toBe('nivra');
    expect(settings.settings().messageTextSize).toBe(15);
    expect(document.documentElement.dir).toBe('rtl');
    expect(JSON.parse(localStorage.getItem(accountKey)!).language).toBe('ar');

    const reopened = TestBed.runInInjectionContext(() => new AppSettingsService());
    expect(reopened.settings().language).toBe('ar');
  });

  it('applies the selected login language to an existing account while preserving other preferences', () => {
    localStorage.setItem(guestKey, JSON.stringify({ language: 'ar' }));
    localStorage.setItem(accountKey, JSON.stringify({ language: 'fr', chatWallpaper: 'silk' }));
    const settings = TestBed.inject(AppSettingsService);
    TestBed.flushEffects();
    expect(settings.settings().language).toBe('ar');

    session.set({ user: { id: 'welcome-language-test' } });
    TestBed.flushEffects();
    expect(settings.settings().language).toBe('ar');
    expect(settings.settings().chatWallpaper).toBe('silk');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('uses the system theme on a public recovery screen without changing the account theme', () => {
    const settings = TestBed.inject(AppSettingsService);
    session.set({ user: { id: 'welcome-language-test' } }); TestBed.flushEffects();
    settings.set('themeMode', 'dark');
    (settings as any).systemLightTheme.set(true);
    expect(settings.resolvedLightTheme()).toBeFalse();
    settings.publicSurface.set(true); TestBed.flushEffects();
    expect(settings.resolvedLightTheme()).toBeTrue();
    expect(settings.settings().themeMode).toBe('dark');
    settings.publicSurface.set(false); TestBed.flushEffects();
    expect(settings.resolvedLightTheme()).toBeFalse();
  });

  it('keeps the last visible language when returning to welcome and preserves it on the next login', () => {
    const settings = TestBed.inject(AppSettingsService); TestBed.flushEffects();
    session.set({ user: { id: 'welcome-language-test' } }); TestBed.flushEffects();
    settings.set('language', 'de'); TestBed.flushEffects();
    session.set(null); TestBed.flushEffects();
    expect(settings.settings().language).toBe('de');
    expect(JSON.parse(localStorage.getItem(guestKey)!).language).toBe('de');
    settings.set('language', 'ja'); TestBed.flushEffects();
    session.set({ user: { id: 'welcome-language-test' } }); TestBed.flushEffects();
    expect(settings.settings().language).toBe('ja');
  });
});
