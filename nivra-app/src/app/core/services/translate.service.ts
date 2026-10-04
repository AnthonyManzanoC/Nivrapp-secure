import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { NivraI18nService } from './nivra-i18n.service';

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private readonly i18n = inject(NivraI18nService);
  private requestVersion = 0;
  private pendingLanguage = '';
  private readonly loadedLanguage = signal('');
  private readonly loadedTerms = signal<Record<string, string>>({});
  private readonly fallbackTerms = signal<Record<string, string>>({});

  readonly currentLanguage = this.i18n.currentLanguage;

  constructor() {
    effect(() => {
      const language = this.currentLanguage();
      untracked(() => void this.loadLanguage(language));
    });
  }

  use(language: string): void {
    this.i18n.use(language);
    void this.loadLanguage(language);
  }

  instant(key: string, fallback = ''): string {
    const terms = this.loadedLanguage() === this.normalizeLanguage(this.currentLanguage()) ? this.loadedTerms() : {};
    const localTerm = this.i18n.currentTerm(key);
    return terms[key] || localTerm || this.i18n.t(key, this.fallbackTerms()[key] || fallback || key);
  }

  private async loadLanguage(language: string): Promise<void> {
    const normalized = this.normalizeLanguage(language);
    if (normalized === this.loadedLanguage() || normalized === this.pendingLanguage) {
      return;
    }
    const version = ++this.requestVersion;
    this.pendingLanguage = normalized;
    try {
      const [fallbackTerms, terms] = await Promise.all([
        this.loadTerms('es'),
        this.loadTerms(normalized),
      ]);
      if (version !== this.requestVersion || normalized !== this.normalizeLanguage(this.currentLanguage())) return;
      this.fallbackTerms.set(fallbackTerms);
      this.loadedTerms.set(terms);
      this.loadedLanguage.set(normalized);
    } catch {
      if (version === this.requestVersion) {
        this.loadedTerms.set({});
        this.loadedLanguage.set('');
      }
    } finally {
      if (version === this.requestVersion) this.pendingLanguage = '';
    }
  }

  private async loadTerms(language: string): Promise<Record<string, string>> {
    const response = await fetch(`assets/i18n/${language}.json`, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Translation load failed: ${response.status}`);
    }
    return await response.json() as Record<string, string>;
  }

  private normalizeLanguage(language: string): string {
    if (language.startsWith('zh')) {
      return 'zh-Hans';
    }
    const base = language.split('-')[0];
    return ['es', 'en', 'hi', 'ar', 'pt', 'ru', 'ja', 'fr', 'de'].includes(base) ? base : 'en';
  }
}
