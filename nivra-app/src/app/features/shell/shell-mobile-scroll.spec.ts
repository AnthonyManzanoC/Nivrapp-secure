import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { ShellPage } from './shell.page';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { SignalrService } from '../../core/services/signalr.service';
import { UnreadTabService } from '../../core/services/unread-tab.service';
import { ClientCompatibilityService } from '../../core/services/client-compatibility.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { TranslateService } from '../../core/services/translate.service';
import { DeviceAuthorityService } from '../../core/services/device-authority.service';
import { ChatsPage } from '../chats/chats.page';

@Component({ standalone: true, imports: [IonContent], template: '<ion-content><div style="height:2000px">Scrollable tab</div></ion-content>' })
class ScrollingTab {}
@Component({ standalone: true, imports: [IonContent], template: '<ion-content><div class="ion-content-scroll-host" style="height:200px;overflow:auto"><div style="height:2000px">Nested chat list</div></div></ion-content>' })
class NestedScrollingTab {}

describe('mobile navigation double tap returns the active tab to its beginning', () => {
  let fixture: ComponentFixture<ShellPage>, router: Router, auth: any, locked: any, mobile: boolean, reduced: boolean, now: number;
  beforeEach(async () => {
    mobile = true; reduced = false; now = 1000;
    spyOn(performance, 'now').and.callFake(() => now);
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    spyOn(window, 'matchMedia').and.callFake(query => ({ matches: query.includes('max-width') ? mobile : query.includes('reduced-motion') ? reduced : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }));
    auth = { session: signal({ user: { id: 'alice' }, device: { id: 'apk' } }), sessionGeneration: signal(1), savedAccounts: signal([]), accountsBusy: signal(false), addingAccount: signal(false) };
    locked = signal(false);
    await TestBed.configureTestingModule({ imports: [ShellPage], providers: [
      provideRouter(['chats', 'world', 'vault', 'calls', 'account'].map(tab => ({ path: `app/${tab}`, component: tab === 'chats' ? NestedScrollingTab : ScrollingTab }))),
      { provide: AuthService, useValue: auth }, { provide: CallsService, useValue: { activeCall: signal(null), resumableCall: signal(null), phase: signal('idle') } },
      { provide: SignalrService, useValue: { connected: signal(true) } }, { provide: UnreadTabService, useValue: { unreadChats: signal(0) } },
      { provide: ClientCompatibilityService, useValue: { check: async () => {}, updateRequired: signal(false) } },
      { provide: AppLockService, useValue: { isContentLocked: locked } }, { provide: NivraApiService, useValue: { baseUrl: 'https://fixture.invalid' } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback, currentLanguage: signal('es') } },
      { provide: DeviceAuthorityService, useValue: { authority: signal(null) } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(ShellPage); fixture.detectChanges(); router = TestBed.inject(Router);
  });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); });
  async function open(tab: string) { await router.navigateByUrl('/app/' + tab); fixture.detectChanges(); await fixture.whenStable(); now += 500; }
  function tap(tab: string, options: MouseEventInit = {}) {
    const link = fixture.nativeElement.querySelector(`a.nav-btn[href="/app/${tab}"]`) as HTMLElement;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, ...options }));
  }
  it('scrolls the nested Chats list and reveals its accordion only after the second active-tab tap', async () => {
    await open('chats');
    const content = fixture.nativeElement.querySelector('.route-stage ion-content') as HTMLElement;
    const list = content.querySelector('.ion-content-scroll-host') as HTMLElement;
    const scroll = spyOn(list, 'scrollTo'); const reset = jasmine.createSpy('accordionReset'); content.addEventListener('nivra-tab-scroll-top', reset);
    tap('chats'); expect(scroll).not.toHaveBeenCalled(); now += 120; tap('chats');
    expect(scroll.calls.count()).toBe(1); expect(scroll.calls.mostRecent().args as unknown).toEqual([{ top: 0, behavior: 'smooth' }]); expect(reset).toHaveBeenCalledTimes(1);
  });
  it('returns Mundo, Bóveda and Llamadas through Ionic and honors reduced motion', async () => {
    for (const tab of ['world', 'vault', 'calls']) {
      await open(tab); reduced = tab === 'vault';
      const content = fixture.nativeElement.querySelector('.route-stage ion-content') as any;
      const scroll = spyOn(content, 'scrollToTop').and.resolveTo();
      tap(tab); now += 120; tap(tab);
      expect(scroll).toHaveBeenCalledOnceWith(reduced ? 0 : 240);
    }
  });
  it('leaves desktop clicks, keyboard activation, late taps, locked accounts and Cuenta unchanged', async () => {
    await open('world'); const content = fixture.nativeElement.querySelector('.route-stage ion-content') as any;
    const scroll = spyOn(content, 'scrollToTop').and.resolveTo();
    mobile = false; tap('world'); now += 100; tap('world'); expect(scroll).not.toHaveBeenCalled();
    mobile = true; tap('world', { detail: 0 }); now += 100; tap('world', { detail: 0 }); expect(scroll).not.toHaveBeenCalled();
    tap('world'); now += 400; tap('world'); expect(scroll).not.toHaveBeenCalled();
    locked.set(true); tap('world'); now += 100; tap('world'); expect(scroll).not.toHaveBeenCalled();
    await open('account'); const accountContent = fixture.nativeElement.querySelector('.route-stage ion-content') as any;
    const accountScroll = spyOn(accountContent, 'scrollToTop').and.resolveTo(); locked.set(false);
    tap('account'); now += 100; tap('account'); expect(accountScroll).not.toHaveBeenCalled();
  });
  it('discards the first tap when the account session changes', async () => {
    await open('world'); const content = fixture.nativeElement.querySelector('.route-stage ion-content') as any;
    const scroll = spyOn(content, 'scrollToTop').and.resolveTo();
    tap('world'); auth.sessionGeneration.update((value: number) => value + 1); now += 100; tap('world'); expect(scroll).not.toHaveBeenCalled();
  });
  it('uses the existing Chats accordion methods without changing row gestures', () => {
    const state = { mobileChatHeaderEnabled: () => true, detailActive: false, resetNativeStoryGesture: jasmine.createSpy(), setMobileChatHeaderCollapsed: jasmine.createSpy(), expandStories: jasmine.createSpy() };
    ChatsPage.prototype.onTabScrollTop.call(state as any);
    expect(state.setMobileChatHeaderCollapsed).toHaveBeenCalledOnceWith(false); expect(state.expandStories).toHaveBeenCalledTimes(1);
  });
});
