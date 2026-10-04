import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '../services/translate.service';
import { LocalizedDatePipe } from './localized-date.pipe';

describe('LocalizedDatePipe', () => {
  it('formats dates with the selected language without changing the instant', () => {
    const language = signal('en');
    TestBed.configureTestingModule({ providers: [{ provide: TranslateService, useValue: { currentLanguage: language } }] });
    const pipe = TestBed.runInInjectionContext(() => new LocalizedDatePipe());
    const instant = new Date(2026, 9, 3, 14, 5);
    const english = pipe.transform(instant, 'medium');
    language.set('es');
    const spanish = pipe.transform(instant, 'medium');
    expect(english).not.toBe(spanish);
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform('not-a-date')).toBe('');
  });
});
