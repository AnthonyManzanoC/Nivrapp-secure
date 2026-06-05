import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Keyboard, KeyboardStyle } from '@capacitor/keyboard';
import { Config } from '@ionic/angular/standalone';
import { AuthService } from './auth.service';

export type NivraThemeMode = 'system' | 'dark' | 'light';
export type NivraChatListDensity = 'two-line' | 'three-line';
export type NivraChatWallpaper = 'nivra' | 'clean' | 'botanic' | 'midnight' | 'paper';
export type NivraLowDataMode = 'never' | 'mobile' | 'roaming' | 'always';
export type NivraVisibility = 'everyone' | 'contacts' | 'nobody';

export interface NivraAppSettings {
  themeMode: NivraThemeMode;
  accentColor: string;
  messageTextSize: number;
  messageCornerRadius: number;
  chatWallpaper: NivraChatWallpaper;
  chatListDensity: NivraChatListDensity;
  enterToSend: boolean;
  animationsEnabled: boolean;
  directShare: boolean;
  appBrowser: boolean;
  showNextMediaOnTap: boolean;
  raiseToListen: boolean;
  raiseToTalk: boolean;
  pauseMediaOnRecord: boolean;
  pauseMediaOnPlayback: boolean;
  showAdultContent: boolean;
  savePrivateMedia: boolean;
  saveGroupMedia: boolean;
  saveChannelMedia: boolean;
  mediaStreaming: boolean;
  lowDataCalls: NivraLowDataMode;
  proxyEnabled: boolean;
  proxyHost: string;
  language: string;
  showTranslateButton: boolean;
  translateEntireChats: boolean;
  phoneVisibility: NivraVisibility;
  lastSeenVisibility: NivraVisibility;
  profilePhotoVisibility: NivraVisibility;
  forwardedMessagesVisibility: NivraVisibility;
  callsVisibility: NivraVisibility;
  voiceMessagesVisibility: NivraVisibility;
  messagesVisibility: NivraVisibility;
  birthdayVisibility: NivraVisibility;
  giftsVisibility: NivraVisibility;
  bioVisibility: NivraVisibility;
  savedMusicVisibility: NivraVisibility;
  invitesVisibility: NivraVisibility;
  deleteAccountIfAwayMonths: number;
  diagnosticsSendLogs: boolean;
  diagnosticsIncludeRecent: boolean;
}

interface AccentTheme {
  primary: string;
  secondary: string;
  contrast: string;
  rgb: string;
}

const SETTINGS_STORAGE_PREFIX = 'nivra.settings.v2';
const LEGACY_THEME_STORAGE_KEY = 'nivra.theme';
const DEFAULT_SETTINGS: NivraAppSettings = {
  themeMode: 'system',
  accentColor: 'nivra',
  messageTextSize: 15,
  messageCornerRadius: 16,
  chatWallpaper: 'nivra',
  chatListDensity: 'two-line',
  enterToSend: false,
  animationsEnabled: true,
  directShare: true,
  appBrowser: false,
  showNextMediaOnTap: true,
  raiseToListen: true,
  raiseToTalk: false,
  pauseMediaOnRecord: true,
  pauseMediaOnPlayback: true,
  showAdultContent: false,
  savePrivateMedia: false,
  saveGroupMedia: false,
  saveChannelMedia: false,
  mediaStreaming: true,
  lowDataCalls: 'roaming',
  proxyEnabled: false,
  proxyHost: '',
  language: 'es',
  showTranslateButton: false,
  translateEntireChats: false,
  phoneVisibility: 'contacts',
  lastSeenVisibility: 'everyone',
  profilePhotoVisibility: 'everyone',
  forwardedMessagesVisibility: 'everyone',
  callsVisibility: 'everyone',
  voiceMessagesVisibility: 'everyone',
  messagesVisibility: 'everyone',
  birthdayVisibility: 'contacts',
  giftsVisibility: 'everyone',
  bioVisibility: 'everyone',
  savedMusicVisibility: 'nobody',
  invitesVisibility: 'everyone',
  deleteAccountIfAwayMonths: 18,
  diagnosticsSendLogs: false,
  diagnosticsIncludeRecent: false,
};

const ACCENTS: Record<string, AccentTheme> = {
  nivra: { primary: '#18d6a2', secondary: '#72f0ca', contrast: '#087f62', rgb: '24, 214, 162' },
  blue: { primary: '#2f8cff', secondary: '#7cc7ff', contrast: '#1d4ed8', rgb: '47, 140, 255' },
  green: { primary: '#34c759', secondary: '#8ee99f', contrast: '#15803d', rgb: '52, 199, 89' },
  amber: { primary: '#f59f00', secondary: '#ffd166', contrast: '#b7791f', rgb: '245, 159, 0' },
  rose: { primary: '#e04f85', secondary: '#ff9fbd', contrast: '#be185d', rgb: '224, 79, 133' },
  violet: { primary: '#8b5cf6', secondary: '#c4a5ff', contrast: '#6d28d9', rgb: '139, 92, 246' },
  cyan: { primary: '#12b5cb', secondary: '#75e6f2', contrast: '#0e7490', rgb: '18, 181, 203' },
  slate: { primary: '#64748b', secondary: '#b6c2d1', contrast: '#475569', rgb: '100, 116, 139' },
};

@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ionicConfig = inject(Config, { optional: true });
  private readonly systemThemeQuery = typeof window !== 'undefined' && 'matchMedia' in window
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;
  private currentStorageKey = this.storageKey();

  readonly settings = signal<NivraAppSettings>(this.loadSettings(this.currentStorageKey));
  readonly accent = computed(() => ACCENTS[this.settings().accentColor] ?? ACCENTS['nivra']);

  constructor() {
    const systemThemeListener = () => this.applyToDocument(this.settings());
    this.systemThemeQuery?.addEventListener('change', systemThemeListener);
    this.destroyRef.onDestroy(() => this.systemThemeQuery?.removeEventListener('change', systemThemeListener));

    effect(() => {
      const userId = this.auth.session()?.user.id || '';
      untracked(() => this.reloadForAccount(userId));
    });

    effect(() => {
      const settings = this.settings();
      this.persist(settings);
      this.applyToDocument(settings);
    });
  }

  set<K extends keyof NivraAppSettings>(key: K, value: NivraAppSettings[K]): void {
    this.settings.update((settings) => this.normalizeSettings({ ...settings, [key]: value }));
  }

  update(patch: Partial<NivraAppSettings>): void {
    this.settings.update((settings) => this.normalizeSettings({ ...settings, ...patch }));
  }

  reset(): void {
    const next = this.normalizeSettings({
      ...DEFAULT_SETTINGS,
      themeMode: this.readLegacyThemeMode() ?? DEFAULT_SETTINGS.themeMode,
    });
    this.settings.set(next);
  }

  resolvedLightTheme(settings = this.settings()): boolean {
    if (settings.themeMode === 'light') {
      return true;
    }
    if (settings.themeMode === 'dark') {
      return false;
    }
    return this.systemThemeQuery?.matches ?? false;
  }

  formatSettingValue(key: keyof NivraAppSettings): string {
    const value = this.settings()[key];
    return typeof value === 'boolean' ? (value ? 'Si' : 'No') : String(value || '');
  }

  chatBackgroundCss(settings = this.settings()): string {
    const light = this.resolvedLightTheme(settings);
    switch (settings.chatWallpaper) {
      case 'clean':
        return light
          ? 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)'
          : 'linear-gradient(180deg, rgba(255, 255, 255, .022), transparent 24%), var(--nivra-bg)';
      case 'botanic':
        return light
          ? 'radial-gradient(circle at 24px 18px, rgba(10, 159, 120, .13) 3px, transparent 4px), radial-gradient(circle at 68px 72px, rgba(52, 120, 246, .08) 2px, transparent 3px), linear-gradient(135deg, rgba(24, 214, 162, .08), rgba(52, 120, 246, .045)), #eef6ee'
          : 'radial-gradient(circle at 24px 18px, rgba(114, 240, 202, .08) 3px, transparent 4px), radial-gradient(circle at 68px 72px, rgba(107, 168, 255, .075) 2px, transparent 3px), linear-gradient(135deg, rgba(24, 214, 162, .09), rgba(107, 168, 255, .045)), var(--nivra-bg)';
      case 'midnight':
        return 'radial-gradient(circle at 24% 18%, rgba(107, 168, 255, .12), transparent 30%), radial-gradient(circle at 76% 72%, rgba(114, 240, 202, .08), transparent 26%), linear-gradient(180deg, #030812, #07111b)';
      case 'paper':
        return light
          ? 'linear-gradient(90deg, rgba(17, 24, 39, .055) 1px, transparent 1px), linear-gradient(180deg, #f8f1e4, #eadcc3)'
          : 'linear-gradient(90deg, rgba(255, 255, 255, .035) 1px, transparent 1px), linear-gradient(180deg, rgba(239, 196, 107, .08), rgba(107, 168, 255, .03)), #15120d';
      case 'nivra':
      default:
        return light
          ? 'radial-gradient(circle at 20px 20px, rgba(24, 214, 162, .10) 1px, transparent 2px), linear-gradient(135deg, rgba(24, 214, 162, .08), rgba(47, 140, 255, .06)), #f3fbf8'
          : 'linear-gradient(180deg, rgba(255, 255, 255, .024), transparent 20%), radial-gradient(circle at 20px 20px, rgba(255, 255, 255, .026) 1px, transparent 1px), linear-gradient(135deg, rgba(107, 168, 255, .026), transparent 34%), var(--nivra-bg)';
    }
  }

  chatBackgroundTone(settings = this.settings()): 'light' | 'dark' {
    if (settings.chatWallpaper === 'midnight') {
      return 'dark';
    }
    return this.resolvedLightTheme(settings) ? 'light' : 'dark';
  }

  chatPreviewBackgroundCss(settings = this.settings()): string {
    switch (settings.chatWallpaper) {
      case 'clean':
        return 'linear-gradient(180deg, #ffffff 0%, #e8edf5 100%)';
      case 'botanic':
        return 'radial-gradient(circle at 24px 18px, rgba(80, 190, 118, .35) 4px, transparent 5px), linear-gradient(135deg, #bfe6b8, #6bae8c)';
      case 'midnight':
        return 'radial-gradient(circle at 28px 20px, rgba(124, 199, 255, .35) 2px, transparent 3px), linear-gradient(135deg, #06101a, #111b2d)';
      case 'paper':
        return 'linear-gradient(90deg, rgba(17, 24, 39, .1) 1px, transparent 1px), linear-gradient(180deg, #fbf3df, #dfcfae)';
      case 'nivra':
      default:
        return 'radial-gradient(circle at 20px 20px, rgba(114, 240, 202, .16) 2px, transparent 3px), linear-gradient(135deg, rgba(var(--ion-color-primary-rgb), .22), rgba(47, 140, 255, .12)), #10272c';
    }
  }

  private reloadForAccount(_userId: string): void {
    const nextKey = this.storageKey();
    if (nextKey === this.currentStorageKey) {
      return;
    }
    this.currentStorageKey = nextKey;
    this.settings.set(this.loadSettings(nextKey));
  }

  private persist(settings: NivraAppSettings): void {
    try {
      localStorage.setItem(this.currentStorageKey, JSON.stringify(settings));
      localStorage.setItem(LEGACY_THEME_STORAGE_KEY, settings.themeMode);
    } catch {
      // Some locked-down browsers deny storage; the in-memory settings still apply.
    }
  }

  private loadSettings(key: string): NivraAppSettings {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || 'null') as Partial<NivraAppSettings> | null;
      return this.normalizeSettings({
        ...DEFAULT_SETTINGS,
        themeMode: this.readLegacyThemeMode() ?? DEFAULT_SETTINGS.themeMode,
        ...(stored ?? {}),
      });
    } catch {
      return this.normalizeSettings({
        ...DEFAULT_SETTINGS,
        themeMode: this.readLegacyThemeMode() ?? DEFAULT_SETTINGS.themeMode,
      });
    }
  }

  private storageKey(): string {
    const userId = this.auth.session()?.user.id;
    return userId ? `${SETTINGS_STORAGE_PREFIX}.${userId}` : SETTINGS_STORAGE_PREFIX;
  }

  private readLegacyThemeMode(): NivraThemeMode | null {
    try {
      const value = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      return value === 'light' || value === 'dark' || value === 'system' ? value : null;
    } catch {
      return null;
    }
  }

  private normalizeSettings(settings: Partial<NivraAppSettings>): NivraAppSettings {
    const next = { ...DEFAULT_SETTINGS, ...settings };
    next.themeMode = this.oneOf(next.themeMode, ['system', 'dark', 'light'], DEFAULT_SETTINGS.themeMode);
    next.accentColor = ACCENTS[next.accentColor] ? next.accentColor : DEFAULT_SETTINGS.accentColor;
    next.messageTextSize = this.clampNumber(next.messageTextSize, 12, 22, DEFAULT_SETTINGS.messageTextSize);
    next.messageCornerRadius = this.clampNumber(next.messageCornerRadius, 4, 24, DEFAULT_SETTINGS.messageCornerRadius);
    next.chatWallpaper = this.oneOf(next.chatWallpaper, ['nivra', 'clean', 'botanic', 'midnight', 'paper'], DEFAULT_SETTINGS.chatWallpaper);
    next.chatListDensity = this.oneOf(next.chatListDensity, ['two-line', 'three-line'], DEFAULT_SETTINGS.chatListDensity);
    next.lowDataCalls = this.oneOf(next.lowDataCalls, ['never', 'mobile', 'roaming', 'always'], DEFAULT_SETTINGS.lowDataCalls);
    next.language = this.oneOf(next.language, ['es', 'en', 'zh-Hans', 'hi', 'ar', 'pt', 'ru', 'ja', 'fr', 'de'], DEFAULT_SETTINGS.language);
    next.phoneVisibility = this.visibility(next.phoneVisibility, DEFAULT_SETTINGS.phoneVisibility);
    next.lastSeenVisibility = this.visibility(next.lastSeenVisibility, DEFAULT_SETTINGS.lastSeenVisibility);
    next.profilePhotoVisibility = this.visibility(next.profilePhotoVisibility, DEFAULT_SETTINGS.profilePhotoVisibility);
    next.forwardedMessagesVisibility = this.visibility(next.forwardedMessagesVisibility, DEFAULT_SETTINGS.forwardedMessagesVisibility);
    next.callsVisibility = this.visibility(next.callsVisibility, DEFAULT_SETTINGS.callsVisibility);
    next.voiceMessagesVisibility = this.visibility(next.voiceMessagesVisibility, DEFAULT_SETTINGS.voiceMessagesVisibility);
    next.messagesVisibility = this.visibility(next.messagesVisibility, DEFAULT_SETTINGS.messagesVisibility);
    next.birthdayVisibility = this.visibility(next.birthdayVisibility, DEFAULT_SETTINGS.birthdayVisibility);
    next.giftsVisibility = this.visibility(next.giftsVisibility, DEFAULT_SETTINGS.giftsVisibility);
    next.bioVisibility = this.visibility(next.bioVisibility, DEFAULT_SETTINGS.bioVisibility);
    next.savedMusicVisibility = this.visibility(next.savedMusicVisibility, DEFAULT_SETTINGS.savedMusicVisibility);
    next.invitesVisibility = this.visibility(next.invitesVisibility, DEFAULT_SETTINGS.invitesVisibility);
    next.deleteAccountIfAwayMonths = this.clampNumber(next.deleteAccountIfAwayMonths, 1, 24, DEFAULT_SETTINGS.deleteAccountIfAwayMonths);
    next.proxyHost = String(next.proxyHost || '').trim().slice(0, 160);
    return next;
  }

  private oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? value as T : fallback;
  }

  private visibility(value: unknown, fallback: NivraVisibility): NivraVisibility {
    return this.oneOf(value, ['everyone', 'contacts', 'nobody'], fallback);
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  private applyToDocument(settings: NivraAppSettings): void {
    if (typeof document === 'undefined') {
      return;
    }
    const light = this.resolvedLightTheme(settings);
    const accent = ACCENTS[settings.accentColor] ?? ACCENTS['nivra'];
    const root = document.documentElement;
    document.body.classList.toggle('nivra-light-theme', light);
    root.classList.toggle('nivra-light-theme', light);
    document.body.classList.toggle('nivra-animations-off', !settings.animationsEnabled);
    root.classList.toggle('nivra-animations-off', !settings.animationsEnabled);
    this.syncIonicAnimations(settings.animationsEnabled);
    document.body.dataset['nivraWallpaper'] = settings.chatWallpaper;
    document.body.dataset['nivraListDensity'] = settings.chatListDensity;
    document.body.dataset['nivraChatTone'] = this.chatBackgroundTone(settings);
    root.dataset['nivraWallpaper'] = settings.chatWallpaper;
    root.dataset['nivraListDensity'] = settings.chatListDensity;
    root.dataset['nivraChatTone'] = this.chatBackgroundTone(settings);
    root.lang = settings.language;
    root.dir = settings.language === 'ar' ? 'rtl' : 'ltr';
    const shade = this.mixColor(accent.primary, '#000000', light ? .18 : .28);
    const tint = this.mixColor(accent.primary, '#ffffff', light ? .18 : .30);
    const contrast = this.readableTextColor(accent.primary);
    const primaryRgb = this.rgbString(accent.primary);
    const styleTargets = [root, document.body, document.querySelector('ion-app') as HTMLElement | null]
      .filter((target): target is HTMLElement => !!target);
    const setGlobalVar = (name: string, value: string) => {
      styleTargets.forEach((target) => target.style.setProperty(name, value, 'important'));
    };
    setGlobalVar('--nivra-message-font-size', `${settings.messageTextSize}px`);
    setGlobalVar('--nivra-message-radius', `${settings.messageCornerRadius}px`);
    setGlobalVar('--nivra-brand', accent.primary);
    setGlobalVar('--nivra-brand-2', light ? accent.contrast : accent.secondary);
    setGlobalVar('--nivra-brand-rgb', primaryRgb);
    setGlobalVar('--nivra-brand-shade', shade);
    setGlobalVar('--nivra-brand-tint', tint);
    setGlobalVar('--nivra-brand-contrast', contrast);
    setGlobalVar('--nivra-chat-background', this.chatBackgroundCss(settings));
    setGlobalVar('--nivra-chat-on-background', this.chatBackgroundTone(settings) === 'light' ? '#111827' : '#f8fafc');
    setGlobalVar('--ion-color-primary', accent.primary);
    setGlobalVar('--ion-color-primary-rgb', primaryRgb);
    setGlobalVar('--ion-color-primary-contrast', contrast);
    setGlobalVar('--ion-color-primary-contrast-rgb', this.rgbString(contrast));
    setGlobalVar('--ion-color-primary-shade', shade);
    setGlobalVar('--ion-color-primary-tint', tint);
    void this.syncNativeKeyboard(light);
  }

  private syncIonicAnimations(enabled: boolean): void {
    const runtimeConfig = this.ionicConfig as unknown as { set?: (key: string, value: unknown) => void } | null;
    runtimeConfig?.set?.('animated', enabled);
    const ionicGlobal = (globalThis as { Ionic?: { config?: { set?: (key: string, value: unknown) => void } } }).Ionic;
    ionicGlobal?.config?.set?.('animated', enabled);
  }

  private readableTextColor(hex: string): '#04100d' | '#ffffff' {
    const [red, green, blue] = this.hexToRgb(hex);
    const luminance = ((red * .299) + (green * .587) + (blue * .114)) / 255;
    return luminance > .58 ? '#04100d' : '#ffffff';
  }

  private rgbString(hex: string): string {
    return this.hexToRgb(hex).join(', ');
  }

  private mixColor(hex: string, targetHex: string, amount: number): string {
    const source = this.hexToRgb(hex);
    const target = this.hexToRgb(targetHex);
    const mixed = source.map((channel, index) => {
      const targetChannel = target[index] ?? channel;
      return Math.round(channel + ((targetChannel - channel) * amount));
    });
    return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  private hexToRgb(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '').trim();
    const full = normalized.length === 3
      ? normalized.split('').map((part) => `${part}${part}`).join('')
      : normalized.padEnd(6, '0').slice(0, 6);
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }

  private async syncNativeKeyboard(light: boolean): Promise<void> {
    try {
      await Keyboard.setStyle({ style: light ? KeyboardStyle.Light : KeyboardStyle.Dark });
    } catch {
      // Web and desktop do not expose the native keyboard bridge.
    }
  }
}
