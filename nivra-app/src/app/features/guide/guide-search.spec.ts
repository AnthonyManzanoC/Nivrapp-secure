import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { GuidePage } from './guide.page';

describe('Nivra guide feature search', () => {
  let fixture: ComponentFixture<GuidePage>;
  const language = signal('es');
  const english: Record<string, string> = {
    'GUIDE.FEATURE_5_TITLE': 'Vault and rooms',
    'GUIDE.FEATURE_5_COPY': 'Local notes and private rooms.',
  };

  beforeEach(async () => {
    language.set('es');
    await TestBed.configureTestingModule({
      imports: [GuidePage],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { session: signal(null) } },
        { provide: TranslateService, useValue: {
          currentLanguage: language,
          instant: (key: string, fallback: string) => language() === 'en' ? english[key] || fallback : fallback,
        } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(GuidePage);
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); });

  it('finds accented names and keeps the original translation key after filtering', () => {
    fixture.componentInstance.featureQuery.set('  BOVEDA  ');
    fixture.detectChanges();
    const features = fixture.componentInstance.filteredFeatures();
    expect(features.length).toBe(1);
    expect(features[0].key).toBe('GUIDE.FEATURE_5');
    expect(fixture.nativeElement.querySelector('#guide-feature-results summary').textContent).toContain('Bóveda');
  });

  it('searches the text shown in the selected language and reacts to a language change', () => {
    fixture.componentInstance.featureQuery.set('vault');
    expect(fixture.componentInstance.filteredFeatures().length).toBe(0);
    language.set('en');
    fixture.detectChanges();
    expect(fixture.componentInstance.filteredFeatures().map(feature => feature.key)).toEqual(['GUIDE.FEATURE_5']);
    expect(fixture.nativeElement.querySelector('#guide-feature-results summary').textContent).toContain('Vault and rooms');
  });

  it('shows an empty result and restores all functions when the search is cleared', () => {
    fixture.componentInstance.featureQuery.set('no-such-feature');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.search-empty')?.getAttribute('role')).toBe('status');
    fixture.componentInstance.featureQuery.set('');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.search-empty')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('#guide-feature-results details').length)
      .toBe(fixture.componentInstance.features.length);
  });
});
