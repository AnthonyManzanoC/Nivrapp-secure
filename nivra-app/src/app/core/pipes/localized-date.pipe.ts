import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '../services/translate.service';

const LOCALES: Record<string, string> = {
  es: 'es-CO', en: 'en-US', 'zh-Hans': 'zh-CN', hi: 'hi-IN',
  ar: 'ar', pt: 'pt-BR', ru: 'ru', ja: 'ja', fr: 'fr', de: 'de',
};

@Pipe({ name: 'localizedDate', standalone: true, pure: false })
export class LocalizedDatePipe implements PipeTransform {
  private static readonly formatters = new Map<string, Intl.DateTimeFormat>();
  private readonly translate = inject(TranslateService);

  transform(value: string | number | Date | null | undefined, format: 'short' | 'shortTime' | 'medium' = 'short'): string {
    if (value === null || value === undefined || value === '') return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const locale = LOCALES[this.translate.currentLanguage()] ?? 'en-US';
    const cacheKey = `${locale}:${format}`;
    let formatter = LocalizedDatePipe.formatters.get(cacheKey);
    if (!formatter) {
      const options: Intl.DateTimeFormatOptions = format === 'shortTime'
        ? { hour: 'numeric', minute: '2-digit' }
        : format === 'medium'
          ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
          : { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      formatter = new Intl.DateTimeFormat(locale, options);
      LocalizedDatePipe.formatters.set(cacheKey, formatter);
    }
    return formatter.format(date);
  }
}
