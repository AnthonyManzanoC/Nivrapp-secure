import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppSettingsService, NivraChatWallpaper } from './app-settings.service';
import { AuthService } from './auth.service';

describe('chat wallpaper preferences and preview', () => {
  const firstKey = 'nivra.settings.v2.wallpaper-test-a';
  const secondKey = 'nivra.settings.v2.wallpaper-test-b';
  const legacyKey = 'nivra.theme';
  const wallpapers: NivraChatWallpaper[] = ['nivra', 'silk', 'clean', 'botanic', 'midnight', 'paper'];
  const session = signal<{ user: { id: string } } | null>(null);
  let originalStorage: Array<[string, string | null]>;
  let originalDocument: Array<[HTMLElement, string | null, string | null, Record<string, string | undefined>]>;
  let originalLanguage: string | null;
  let originalDirection: string | null;

  beforeEach(() => {
    originalStorage = [firstKey, secondKey, legacyKey].map(key => [key, localStorage.getItem(key)]);
    [firstKey, secondKey, legacyKey].forEach(key => localStorage.removeItem(key));
    const styleTargets = [document.documentElement, document.body, document.querySelector('ion-app') as HTMLElement | null]
      .filter((element): element is HTMLElement => !!element);
    originalDocument = styleTargets.map(element => [
      element, element.getAttribute('style'), element.getAttribute('class'), { ...element.dataset },
    ]);
    originalLanguage = document.documentElement.getAttribute('lang');
    originalDirection = document.documentElement.getAttribute('dir');
    session.set({ user: { id: 'wallpaper-test-a' } });
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

  it('opens the default as warm original line art in light mode and a readable dark variant', () => {
    const settings = TestBed.inject(AppSettingsService);
    expect(settings.settings().chatWallpaper).toBe('nivra');
    settings.set('themeMode', 'light');
    expect(settings.chatBackgroundCss()).toContain('nivra-doodles-light.svg');
    expect(settings.chatBackgroundCss()).toContain('#faf7f1');
    expect(settings.chatBackgroundTone()).toBe('light');
    settings.set('themeMode', 'dark');
    expect(settings.chatBackgroundCss()).toContain('nivra-doodles-dark.svg');
    expect(settings.chatBackgroundTone()).toBe('dark');
  });

  it('uses the same background for the account preview and the live chat in both themes', () => {
    const settings = TestBed.inject(AppSettingsService);
    for (const themeMode of ['light', 'dark'] as const) {
      for (const chatWallpaper of wallpapers) {
        settings.update({ themeMode, chatWallpaper });
        expect(settings.chatPreviewBackgroundCss()).withContext(`${themeMode}/${chatWallpaper}`)
          .toBe(settings.chatBackgroundCss());
      }
    }
  });

  it('preserves saved wallpaper choices when switching between accounts', () => {
    localStorage.setItem(firstKey, JSON.stringify({ chatWallpaper: 'paper', themeMode: 'light' }));
    localStorage.setItem(secondKey, JSON.stringify({ chatWallpaper: 'silk', themeMode: 'dark' }));
    const settings = TestBed.inject(AppSettingsService);
    TestBed.flushEffects();
    expect(settings.settings().chatWallpaper).toBe('paper');
    session.set({ user: { id: 'wallpaper-test-b' } });
    TestBed.flushEffects();
    expect(settings.settings().chatWallpaper).toBe('silk');
    expect(settings.settings().themeMode).toBe('dark');
    session.set({ user: { id: 'wallpaper-test-a' } });
    TestBed.flushEffects();
    expect(settings.settings().chatWallpaper).toBe('paper');
    expect(settings.settings().themeMode).toBe('light');
  });

  it('persists the new silk selection and restores it on the next launch', () => {
    const settings = TestBed.inject(AppSettingsService);
    settings.update({ chatWallpaper: 'silk', themeMode: 'light' });
    TestBed.flushEffects();
    expect(JSON.parse(localStorage.getItem(firstKey)!).chatWallpaper).toBe('silk');
    const reopened = TestBed.runInInjectionContext(() => new AppSettingsService());
    expect(reopened.settings().chatWallpaper).toBe('silk');
    expect(reopened.chatBackgroundCss()).toContain('silk-light.svg');
  });

  it('keeps previous explicit backgrounds valid and falls back safely for unknown saved values', () => {
    const settings = TestBed.inject(AppSettingsService);
    for (const chatWallpaper of ['clean', 'botanic', 'midnight', 'paper'] as const) {
      settings.set('chatWallpaper', chatWallpaper);
      expect(settings.settings().chatWallpaper).toBe(chatWallpaper);
    }
    settings.update({ chatWallpaper: 'unknown' as NivraChatWallpaper });
    expect(settings.settings().chatWallpaper).toBe('nivra');
  });

  it('applies a complete live pattern and updates it without leaving old layer sizes behind', () => {
    const settings = TestBed.inject(AppSettingsService);
    settings.update({ themeMode: 'light', chatWallpaper: 'nivra' });
    TestBed.flushEffects();
    expect(document.body.style.getPropertyValue('--nivra-chat-background')).toContain('nivra-doodles-light.svg');
    expect(document.body.style.getPropertyValue('--nivra-chat-background-size')).toBe('360px 360px, cover');
    settings.set('chatWallpaper', 'clean');
    TestBed.flushEffects();
    expect(document.body.style.getPropertyValue('--nivra-chat-background-size')).toBe('cover');
    expect(document.body.style.getPropertyValue('--nivra-chat-background-repeat')).toBe('no-repeat');
    expect(document.body.style.getPropertyValue('--nivra-chat-background')).not.toContain('.svg');
  });

  it('scales only thumbnail patterns while the real pattern keeps its natural size', () => {
    const settings = TestBed.inject(AppSettingsService);
    expect(settings.chatBackgroundSizeCss(settings.settings(), .3)).toBe('108px 108px, cover');
    expect(settings.chatBackgroundSizeCss()).toBe('360px 360px, cover');
    expect(settings.chatBackgroundSizeCss(settings.settings(), Number.NaN)).toBe(settings.chatBackgroundSizeCss());
  });

  it('retains the midnight choice as a dark canvas even when the surrounding app is light', () => {
    const settings = TestBed.inject(AppSettingsService);
    settings.update({ themeMode: 'light', chatWallpaper: 'midnight' });
    expect(settings.chatBackgroundTone()).toBe('dark');
    expect(settings.chatPreviewBackgroundCss()).toContain('#030812');
  });
});
