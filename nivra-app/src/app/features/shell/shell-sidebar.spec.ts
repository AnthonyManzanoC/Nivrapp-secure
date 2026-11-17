import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { ShellPage } from './shell.page';
import { DeviceAuthorityService } from '../../core/services/device-authority.service';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { SignalrService } from '../../core/services/signalr.service';
import { UnreadTabService } from '../../core/services/unread-tab.service';
import { ClientCompatibilityService } from '../../core/services/client-compatibility.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { TranslateService } from '../../core/services/translate.service';

describe('collapsible desktop navigation', () => {
  const key = 'nivra.navigation.rail-expanded';
  let previous: string | null;
  let fixture: ComponentFixture<ShellPage> | undefined;
  let native: jasmine.Spy;

  beforeEach(async () => {
    previous = localStorage.getItem(key);
    localStorage.removeItem(key);
    native = spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    await TestBed.configureTestingModule({ imports: [ShellPage], providers: [
      provideRouter([]),
      { provide: DeviceAuthorityService, useValue: { authority: signal(null) } },
      { provide: AuthService, useValue: { session: signal(null), sessionGeneration: signal(0), savedAccounts: signal([]), accountsBusy: signal(false), addingAccount: signal(false) } },
      { provide: CallsService, useValue: { activeCall: signal(null), resumableCall: signal(null), phase: signal('idle') } },
      { provide: SignalrService, useValue: { connected: signal(true) } },
      { provide: UnreadTabService, useValue: { unreadChats: signal(2) } },
      { provide: ClientCompatibilityService, useValue: { check: async () => {}, updateRequired: signal(false) } },
      { provide: AppLockService, useValue: { isContentLocked: signal(false) } },
      { provide: NivraApiService, useValue: { baseUrl: 'https://fixture.invalid' } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback, currentLanguage: signal('es') } },
    ] }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    fixture = undefined;
    TestBed.resetTestingModule();
    if (previous === null) localStorage.removeItem(key);
    else localStorage.setItem(key, previous);
  });

  function render(): ComponentFixture<ShellPage> {
    fixture = TestBed.createComponent(ShellPage);
    fixture.detectChanges();
    return fixture;
  }

  it('starts collapsed and keeps every navigation destination and unread count accessible', () => {
    const page = render().nativeElement as HTMLElement;
    expect(page.querySelector('.workspace')?.classList.contains('rail-expanded')).toBeFalse();
    expect(page.querySelector('.rail-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(page.querySelector('.rail-toggle')?.getAttribute('aria-label')).toBe('Expandir navegación');
    expect(page.querySelectorAll('a.nav-btn').length).toBe(5);
    expect(page.querySelector('a.nav-btn[href="/app/chats"]')?.getAttribute('aria-label')).toContain('2 chats sin leer');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('remembers expansion and contraction when the shell is recreated', () => {
    render();
    (fixture!.nativeElement.querySelector('.rail-toggle') as HTMLButtonElement).click();
    fixture!.detectChanges();
    expect(localStorage.getItem(key)).toBe('true');
    expect(fixture!.nativeElement.querySelector('.rail-toggle').getAttribute('aria-label')).toBe('Contraer navegación');
    fixture!.destroy();
    render();
    expect(fixture!.componentInstance.railExpanded()).toBeTrue();
    (fixture!.nativeElement.querySelector('.rail-toggle') as HTMLButtonElement).click();
    fixture!.detectChanges();
    expect(localStorage.getItem(key)).toBe('false');
    fixture!.destroy();
    render();
    expect(fixture!.componentInstance.railExpanded()).toBeFalse();
  });

  it('treats unknown stored values as collapsed', () => {
    localStorage.setItem(key, 'invalid');
    expect(render().componentInstance.railExpanded()).toBeFalse();
  });

  it('continues toggling if browser storage is denied', () => {
    spyOn(localStorage, 'getItem').and.throwError('Storage denied');
    spyOn(localStorage, 'setItem').and.throwError('Storage denied');
    const shell = render().componentInstance;
    expect(shell.railExpanded()).toBeFalse();
    expect(() => shell.toggleRail()).not.toThrow();
    expect(shell.railExpanded()).toBeTrue();
    shell.toggleRail();
    expect(shell.railExpanded()).toBeFalse();
  });

  it('leaves native navigation independent of the desktop preference', () => {
    native.and.returnValue(true);
    localStorage.setItem(key, 'true');
    const shell = render().componentInstance;
    const page = fixture!.nativeElement as HTMLElement;
    expect(shell.railExpanded()).toBeFalse();
    expect(page.querySelector('.workspace')?.classList.contains('collapsible-rail')).toBeFalse();
    expect(page.querySelector('.rail-toggle')).toBeNull();
    expect(page.querySelectorAll('a.nav-btn').length).toBe(5);
    shell.toggleRail();
    expect(localStorage.getItem(key)).toBe('true');
  });
});
