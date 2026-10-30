import { ElementRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateService } from '../../core/services/translate.service';
import { AccountNavigationComponent } from './account-navigation.component';
import { AccountPage } from './account.page';

describe('Account section navigation', () => {
  let fixture: ComponentFixture<AccountNavigationComponent>;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AccountNavigationComponent], providers: [
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    fixture = TestBed.createComponent(AccountNavigationComponent);
    fixture.detectChanges();
  });

  it('labels the navigation and opens the exact section chosen through a real button', () => {
    const chosen = jasmine.createSpy('openSection');
    fixture.componentInstance.openSection.subscribe(chosen);
    const nav = fixture.nativeElement.querySelector('nav') as HTMLElement;
    expect(nav.getAttribute('aria-label')).toBe('Secciones de cuenta');
    const buttons = Array.from(nav.querySelectorAll('button'));
    expect(buttons.map(button => button.getAttribute('aria-controls'))).toEqual([
      'account-profile', 'account-appearance', 'account-chats', 'account-lock', 'account-privacy', 'account-devices',
    ]);
    buttons[4].click();
    expect(chosen).toHaveBeenCalledOnceWith('account-privacy');
    expect(buttons[4].textContent).toContain('Privacidad');
  });

  it('keeps all six navigation targets usable at 320 and 390 pixels without horizontal overflow', async () => {
    const host = fixture.nativeElement as HTMLElement;
    const nav = host.querySelector('nav')!;
    for (const width of [320, 390]) {
      host.style.width = `${width}px`;
      host.style.maxWidth = `${width}px`;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      expect(nav.scrollWidth).withContext(`${width}px overflow`).toBeLessThanOrEqual(nav.clientWidth + 1);
      for (const button of Array.from(nav.querySelectorAll('button'))) {
        const bounds = button.getBoundingClientRect();
        expect(bounds.width).withContext(`${width}px target width`).toBeGreaterThanOrEqual(44);
        expect(bounds.height).withContext(`${width}px target height`).toBeGreaterThanOrEqual(44);
        expect(button.scrollWidth).withContext(`${width}px clipped label`).toBeLessThanOrEqual(button.clientWidth + 1);
      }
    }
  });

  it('finds settings by accent-insensitive terms and opens the first result with Enter', () => {
    const chosen = jasmine.createSpy('openSection'); fixture.componentInstance.openSection.subscribe(chosen);
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.value = '  TRADUCCIÓN '; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.search-result').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.search-result').getAttribute('aria-controls')).toBe('account-language');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(chosen).toHaveBeenCalledOnceWith('account-language');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); fixture.detectChanges();
    expect(input.value).toBe(''); expect(fixture.nativeElement.querySelectorAll('nav button').length).toBe(6);
  });

  it('supports actual translated labels, multiple words, clearing and empty search feedback', () => {
    const translator = TestBed.inject(TranslateService);
    spyOn(translator, 'instant').and.callFake((key, fallback) => key === 'ACCOUNT.NOTIFICATIONS' ? 'Benachrichtigungen' : fallback || key);
    fixture.componentInstance.query.set('Benachrichtigungen'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.search-result').getAttribute('aria-controls')).toBe('account-notifications');
    fixture.componentInstance.query.set('foto avatar'); fixture.detectChanges();
    expect(fixture.componentInstance.results().map(section => section.id)).toEqual(['account-profile']);
    fixture.componentInstance.query.set('no existe este ajuste'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain('0');
    expect(fixture.nativeElement.querySelector('.search-empty')).not.toBeNull();
    fixture.nativeElement.querySelector('.clear-search').click(); fixture.detectChanges();
    expect(fixture.componentInstance.query()).toBe('');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('input'));
  });

  it('opens and focuses only this page’s accordion while preserving a draft and honoring reduced motion', () => {
    const foreign = document.createElement('details');
    foreign.id = 'account-privacy'; foreign.innerHTML = '<summary>Otra instancia</summary>';
    const surface = document.createElement('main');
    surface.innerHTML = '<details id="account-profile" open><summary>Perfil</summary><input value="Mi borrador"></details><details id="account-privacy"><summary>Privacidad</summary><p>Ajustes</p></details>';
    document.body.append(foreign, surface);
    const section = surface.querySelector<HTMLDetailsElement>('#account-privacy')!;
    const profile = surface.querySelector<HTMLDetailsElement>('#account-profile')!;
    const summary = section.querySelector('summary')!;
    const scroll = spyOn(section, 'scrollIntoView');
    let reducedMotion = false;
    const matchMedia = window.matchMedia.bind(window);
    spyOn(window, 'matchMedia').and.callFake(query => query === '(prefers-reduced-motion: reduce)'
      ? { matches: reducedMotion } as MediaQueryList : matchMedia(query));
    // The actual AccountPage navigation methods need no account mutation or
    // service request. Retain a saving draft to catch accidental resets.
    const page = Object.assign(Object.create(AccountPage.prototype), {
      accountSurface: new ElementRef(surface), displayName: 'Mi borrador', bio: 'Sin guardar', saving: true,
      saveProfile: jasmine.createSpy('saveProfile'), reload: jasmine.createSpy('reload'),
    });
    const subscription = fixture.componentInstance.openSection.subscribe(id => page.openAccountSectionById(id));
    try {
      fixture.nativeElement.querySelector('[aria-controls="account-privacy"]').click();
      expect(section.open).toBeTrue();
      expect(foreign.open).toBeFalse();
      expect(document.activeElement).toBe(summary);
      expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
      expect(profile.open).toBeTrue();
      expect(profile.querySelector('input')?.value).toBe('Mi borrador');
      expect(page.displayName).toBe('Mi borrador');
      expect(page.bio).toBe('Sin guardar');
      expect(page.saving).toBeTrue();
      expect(page.saveProfile).not.toHaveBeenCalled(); expect(page.reload).not.toHaveBeenCalled();
      reducedMotion = true;
      page.openAccountSectionById('account-privacy');
      expect(scroll.calls.mostRecent().args[0]).toEqual({ block: 'start', behavior: 'instant' });
    } finally { subscription.unsubscribe(); foreign.remove(); surface.remove(); }
  });
});
