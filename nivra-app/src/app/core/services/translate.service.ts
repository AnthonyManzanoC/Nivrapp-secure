import { Injectable, inject } from '@angular/core';
import { NivraI18nService } from './nivra-i18n.service';

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private readonly i18n = inject(NivraI18nService);

  readonly currentLanguage = this.i18n.currentLanguage;

  use(language: string): void {
    this.i18n.use(language);
  }

  instant(key: string, fallback = ''): string {
    return this.i18n.t(key, fallback || key);
  }
}
