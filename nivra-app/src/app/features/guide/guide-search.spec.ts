import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { GuidePage } from './guide.page';

describe('Nivra guide feature search', () => {
  let fixture: ComponentFixture<GuidePage>;
  const owner = 'guide-search-fixture';
  const language = signal('es');
  const english: Record<string, string> = {
    'GUIDE.FEATURE_5_TITLE': 'Vault and rooms',
    'GUIDE.FEATURE_5_COPY': 'Local notes and private rooms.',
  };

  beforeEach(async () => {
    localStorage.removeItem(`nivra.guide.v1.${owner}`);
    language.set('es');
    await TestBed.configureTestingModule({
      imports: [GuidePage],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { session: signal({ user: { id: owner } }) } },
        { provide: TranslateService, useValue: {
          currentLanguage: language,
          instant: (key: string, fallback: string) => language() === 'en' ? english[key] || fallback : fallback,
        } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(GuidePage);
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); localStorage.removeItem(`nivra.guide.v1.${owner}`); });

  it('shows one useful step and dismisses the introduction without claiming any task was completed', () => {
    expect(fixture.componentInstance.guide.progress(owner)).toEqual({ introduced: true, completed: [] });
    expect(fixture.nativeElement.querySelectorAll('.tasks article:not([hidden])').length).toBe(1);
    fixture.nativeElement.querySelector('.next-step').click();
    fixture.detectChanges();
    expect(fixture.componentInstance.activeStep()).toBe(1);
    expect(fixture.nativeElement.querySelector('.tasks article:not([hidden]) h3').textContent).toContain('primera persona');
    expect(fixture.componentInstance.guide.progress(owner).completed).toEqual([]);
  });

  it('keeps reference and troubleshooting out of the first view and makes both easy to open', () => {
    expect(fixture.nativeElement.querySelector('#guide-features').hidden).toBeTrue();
    fixture.nativeElement.querySelector('.guide-tabs button:nth-child(2)').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#guide-features').hidden).toBeFalse();
    expect(fixture.nativeElement.querySelector('#guide-start').hidden).toBeTrue();
    fixture.nativeElement.querySelector('.guide-tabs button:nth-child(3)').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#guide-delivery').hidden).toBeFalse();
    expect(fixture.nativeElement.querySelector('.pending-help')).not.toBeNull();
  });

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
