import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NivraI18nService } from './nivra-i18n.service';
import { TranslateService } from './translate.service';

describe('TranslateService language loading', () => {
  let language: ReturnType<typeof signal<string>>;
  let service: TranslateService;
  let requests: Array<{ url: string; resolve: (response: Response) => void }>;
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const respond = (request: typeof requests[number], value: string, ok = true) =>
    request.resolve({ ok, status: ok ? 200 : 503, json: async () => ({ TEST: value }) } as Response);

  beforeEach(() => {
    language = signal('es');
    requests = [];
    spyOn(window, 'fetch').and.callFake((url) => new Promise<Response>(resolve => requests.push({ url: String(url), resolve })));
    TestBed.configureTestingModule({ providers: [{ provide: NivraI18nService, useValue: {
      currentLanguage: language, use: (value: string) => language.set(value),
      currentTerm: () => undefined, t: (_key: string, fallback: string) => fallback,
    } }] });
    service = TestBed.inject(TranslateService);
  });

  it('ignores a slower response for a previously selected language', async () => {
    service.use('en');
    const old = requests.splice(0);
    service.use('fr');
    requests.forEach(r => respond(r, r.url.includes('/fr.') ? 'Français' : 'Español'));
    await settle();
    old.forEach(r => respond(r, 'English'));
    await settle();
    expect(service.instant('TEST')).toBe('Français');
  });

  it('does not display a previous language while the next dictionary loads', async () => {
    service.use('en');
    requests.forEach(r => respond(r, r.url.includes('/en.') ? 'English' : 'Español'));
    await settle();
    expect(service.instant('TEST')).toBe('English');
    service.use('fr');
    expect(service.instant('TEST')).not.toBe('English');
  });

  it('can retry after a failed download and deduplicates pending requests', async () => {
    service.use('en');
    service.use('en');
    expect(requests.length).toBe(2);
    requests.forEach(r => respond(r, '', false));
    await settle();
    requests = [];
    service.use('en');
    expect(requests.length).toBe(2);
    requests.forEach(r => respond(r, 'English'));
    await settle();
    expect(service.instant('TEST')).toBe('English');
  });
});
