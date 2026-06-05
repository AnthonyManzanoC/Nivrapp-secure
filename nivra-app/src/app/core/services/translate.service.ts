import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { NivraI18nService } from './nivra-i18n.service';

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private readonly i18n = inject(NivraI18nService);
  private readonly loadedLanguage = signal('');
  private readonly loadedTerms = signal<Record<string, string>>({});

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
    const terms = this.loadedTerms();
    return terms[key] ?? this.i18n.t(key, fallback || key);
  }

  private async loadLanguage(language: string): Promise<void> {
    const normalized = language.startsWith('zh') ? 'zh-Hans' : language;
    if (normalized === this.loadedLanguage()) {
      return;
    }
    try {
      const response = await fetch(`assets/i18n/${normalized}.json`, { cache: 'no-cache' });
      if (!response.ok) {
        this.loadedTerms.set({});
        this.loadedLanguage.set(normalized);
        return;
      }
      const terms = await response.json() as Record<string, string>;
      this.loadedTerms.set(terms);
      this.loadedLanguage.set(normalized);
    } catch {
      this.loadedTerms.set({});
      this.loadedLanguage.set(normalized);
    }
  }
}
