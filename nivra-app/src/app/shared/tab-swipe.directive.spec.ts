import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { IonItem, IonItemOption, IonItemOptions, IonItemSliding } from '@ionic/angular/standalone';
import { TabSwipeDirective } from './tab-swipe.directive';

@Component({ standalone: true, template: '<p>Fixture tab</p>' })
class TabPage { }

@Component({
  standalone: true, imports: [RouterOutlet, TabSwipeDirective], schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `<section [appTabSwipe]="tabs" [tabSwipeEnabled]="enabled" [tabSwipeScope]="scope" style="width:390px;height:640px">
    <div class="surface">Swipe surface</div>
    <ion-item-sliding><ion-item><span class="row-target">Conversation</span></ion-item></ion-item-sliding>
    <input><textarea></textarea><select><option>One</option></select><input type="range"><ion-range></ion-range>
    <video></video><audio></audio><canvas></canvas><div contenteditable="true"><span>Editable</span></div>
    <div data-tab-swipe="off"><span class="opt-out">Separate gesture</span></div>
    <div class="horizontal" style="width:180px;overflow-x:auto"><div style="width:1000px"><span>Horizontal scroller</span></div></div>
    <router-outlet></router-outlet>
  </section>`,
})
class SwipeHost {
  readonly tabs = ['/app/chats', '/app/world', '/app/vault', '/app/calls', '/app/account'];
  enabled = true;
  scope = 'fixture-user:fixture-device';
}

@Component({
  standalone: true, imports: [TabSwipeDirective, IonItem, IonItemSliding, IonItemOptions, IonItemOption],
  template: `<section [appTabSwipe]="tabs" [tabSwipeScope]="scope" style="width:390px;height:640px">
    <ion-item-sliding><ion-item><span class="real-row-target">Fixture chat</span></ion-item>
      <ion-item-options side="end"><ion-item-option (click)="actionCalls = actionCalls + 1">Archive fixture</ion-item-option></ion-item-options>
    </ion-item-sliding>
  </section>`,
})
class IonicSwipeHost extends SwipeHost { actionCalls = 0; }

describe('mobile tab swipe navigation', () => {
  let fixture: ComponentFixture<SwipeHost>;
  let router: Router;
  let navigation: jasmine.Spy;
  let host: HTMLElement;
  let target: HTMLElement;
  let mobile: boolean;
  let reducedMotion: boolean;
  let scale: number;
  let visibility: jasmine.Spy;
  let fullscreen: jasmine.Spy;
  let originalWidth: PropertyDescriptor | undefined;
  let originalViewport: PropertyDescriptor | undefined;
  let originalHtmlAnimationOff: boolean;
  let originalBodyAnimationOff: boolean;
  const overlays: Element[] = [];

  beforeEach(async () => {
    mobile = true; reducedMotion = true; scale = 1;
    originalHtmlAnimationOff = document.documentElement.classList.contains('nivra-animations-off');
    originalBodyAnimationOff = document.body.classList.contains('nivra-animations-off');
    originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => ({ scale, addEventListener: () => undefined, removeEventListener: () => undefined }) });
    spyOn(window, 'matchMedia').and.callFake(query => ({
      get matches() { return query === '(max-width: 768px)' ? mobile : query === '(prefers-reduced-motion: reduce)' ? reducedMotion : false; }, media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => true,
    } as MediaQueryList));
    visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    fullscreen = spyOnProperty(document, 'fullscreenElement', 'get').and.returnValue(null);
    TestBed.configureTestingModule({ imports: [SwipeHost, IonicSwipeHost], providers: [provideRouter([
      ...['chats', 'world', 'vault', 'calls', 'account'].map(tab => ({ path: `app/${tab}`, pathMatch: 'full' as const, component: TabPage })),
      { path: 'app/chats/:id', component: TabPage }, { path: 'app/account/privacy', component: TabPage },
      { path: 'auth', component: TabPage },
    ])] });
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(SwipeHost); fixture.detectChanges();
    host = fixture.nativeElement.querySelector('section'); target = host.querySelector('.surface')!;
    spyOn(host, 'getBoundingClientRect').and.returnValue({ x: 0, y: 0, left: 0, top: 0, right: 390, bottom: 640, width: 390, height: 640, toJSON: () => ({}) });
    await router.navigateByUrl('/app/chats'); fixture.detectChanges();
    navigation = spyOn(router, 'navigateByUrl').and.callThrough();
  });

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    overlays.splice(0).forEach(overlay => overlay.remove());
    fixture.destroy();
    document.documentElement.classList.toggle('nivra-animations-off', originalHtmlAnimationOff);
    document.body.classList.toggle('nivra-animations-off', originalBodyAnimationOff);
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
    if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
    else delete (window as unknown as { visualViewport?: unknown }).visualViewport;
  });

  function touch(type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x: number, y = 200, element = target, fingers = 1): TouchEvent {
    const changed = Array.from({ length: fingers }, (_, identifier) => new Touch({ identifier, target: element,
      clientX: x + identifier * 10, clientY: y, pageX: x + identifier * 10, pageY: y, screenX: x + identifier * 10, screenY: y }));
    const touches = type === 'touchend' || type === 'touchcancel' ? [] : changed;
    const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: changed });
    element.dispatchEvent(event); return event;
  }
  async function settle(): Promise<void> { await fixture.whenStable(); await Promise.resolve(); fixture.detectChanges(); await fixture.whenStable(); }
  async function go(url: string): Promise<void> { await router.navigateByUrl(url); fixture.detectChanges(); navigation.calls.reset(); }
  async function swipe(start: number, end: number, element = target, dy = 0): Promise<TouchEvent> {
    touch('touchstart', start, 200, element); touch('touchmove', end, 200 + dy, element);
    const result = touch('touchend', end, 200 + dy, element); await settle(); return result;
  }
  function overlay(tag: string, attributes: Record<string, string> = {}, openedBy: 'isOpen' | 'presented' = 'isOpen'): Element {
    // A distinct namespace preserves the selector/state contract without
    // hydrating registered Ionic HTML custom elements and presenting a modal.
    const element = tag.startsWith('ion-') ? document.createElementNS('urn:nivra-test:overlay', tag) : document.createElement(tag);
    element.textContent = 'Open fixture overlay';
    if (tag.startsWith('ion-')) {
      // Model the public state consumed by the directive, independently of
      // Stencil's HTML-element lifecycle and its framework delegate.
      Object.defineProperties(element, {
        isOpen: { configurable: true, value: openedBy === 'isOpen' },
        presented: { configurable: true, value: openedBy === 'presented' },
      });
    }
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    element.setAttribute('style', 'display:block;position:fixed;width:100px;height:100px;top:0;left:0');
    spyOn(element, 'getBoundingClientRect').and.returnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
    document.body.append(element); overlays.push(element); return element;
  }

  it('moves one adjacent tab in either direction and replaces history even from a root with query/hash', async () => {
    await go('/app/chats?filter=unread#top');
    await swipe(320, 50);
    expect(router.url).toBe('/app/world');
    expect(navigation).toHaveBeenCalledOnceWith('/app/world', { replaceUrl: true });
    navigation.calls.reset(); await swipe(70, 320);
    expect(router.url).toBe('/app/chats');
    expect(navigation).toHaveBeenCalledOnceWith('/app/chats', { replaceUrl: true });
  });

  it('does not wrap at the first or last tab, or jump across several tabs on a long swipe', async () => {
    await swipe(70, 320); expect(router.url).toBe('/app/chats'); expect(navigation).not.toHaveBeenCalled();
    await go('/app/account'); await swipe(320, 50); expect(router.url).toBe('/app/account'); expect(navigation).not.toHaveBeenCalled();
    await go('/app/world'); await swipe(350, 30); expect(router.url).toBe('/app/vault');
  });

  it('leaves desktop and pinch-zoomed views alone', async () => {
    mobile = false; await swipe(320, 50); expect(navigation).not.toHaveBeenCalled();
    mobile = true; scale = 1.02; await swipe(320, 50); expect(navigation).not.toHaveBeenCalled();
    expect(router.url).toBe('/app/chats');
  });

  it('keeps swipe navigation functional when app animations are disabled on either document surface', async () => {
    reducedMotion = false;
    const animate = spyOn(HTMLElement.prototype, 'animate').and.returnValue({ finished: Promise.resolve(), cancel: jasmine.createSpy('cancel') } as unknown as Animation);
    document.body.classList.remove('nivra-animations-off'); document.documentElement.classList.add('nivra-animations-off');
    await swipe(320, 50);
    expect(router.url).toBe('/app/world'); expect(animate).not.toHaveBeenCalled();
    document.documentElement.classList.remove('nivra-animations-off'); document.body.classList.add('nivra-animations-off');
    await swipe(320, 50);
    expect(router.url).toBe('/app/vault'); expect(animate).not.toHaveBeenCalled();
    expect(navigation.calls.allArgs()).toEqual([['/app/world', { replaceUrl: true }], ['/app/vault', { replaceUrl: true }]]);
  });

  it('honors OS reduced motion and animates only an otherwise enabled transition, releasing the finished animation', async () => {
    document.documentElement.classList.remove('nivra-animations-off'); document.body.classList.remove('nivra-animations-off');
    let finish!: (animation: Animation) => void;
    const finished = new Promise<Animation>(resolve => finish = resolve);
    const cancel = jasmine.createSpy('cancel');
    const animation = { finished, cancel } as unknown as Animation;
    const animate = spyOn(HTMLElement.prototype, 'animate').and.returnValue(animation);
    reducedMotion = true; await swipe(320, 50);
    expect(router.url).toBe('/app/world'); expect(animate).not.toHaveBeenCalled();
    reducedMotion = false; await swipe(320, 50);
    expect(router.url).toBe('/app/vault'); expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.calls.mostRecent().object as unknown).toBe(host.querySelector('router-outlet')!.nextElementSibling);
    finish(animation); await Promise.resolve(); await Promise.resolve();
    fixture.destroy();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('never changes tabs from a chat detail, a nested settings route, or login', async () => {
    for (const url of ['/app/chats/fixture-chat', '/app/account/privacy', '/auth']) {
      await go(url); await swipe(320, 50); expect(router.url).withContext(url).toBe(url); expect(navigation).not.toHaveBeenCalled();
    }
  });

  it('reserves both screen edges for operating-system back gestures', async () => {
    for (const [start, end] of [[12, 300], [380, 70]]) { await swipe(start, end); expect(navigation).not.toHaveBeenCalled(); }
  });

  it('keeps short, diagonal, and initially vertical gestures with their original controls', async () => {
    await swipe(280, 210); expect(navigation).not.toHaveBeenCalled(); // 70 < 20% of 390
    await swipe(300, 190, target, 80); expect(navigation).not.toHaveBeenCalled(); // horizontal ratio < 1.7
    touch('touchstart', 300); touch('touchmove', 298, 220); touch('touchmove', 80, 220); touch('touchend', 80, 220);
    await settle(); expect(navigation).not.toHaveBeenCalled();
  });

  it('cancels a horizontal gesture that reverses direction by at least 24 pixels', async () => {
    touch('touchstart', 300); touch('touchmove', 160); touch('touchmove', 190); touch('touchmove', 80); touch('touchend', 80);
    await settle(); expect(router.url).toBe('/app/chats'); expect(navigation).not.toHaveBeenCalled();
  });

  it('cancels multi-touch, touchcancel, window blur, and backgrounding before a late end event', async () => {
    for (const cancel of [
      () => touch('touchmove', 180, 200, target, 2), () => touch('touchcancel', 180),
      () => window.dispatchEvent(new Event('blur')),
      () => { visibility.and.returnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); },
    ]) {
      visibility.and.returnValue('visible'); touch('touchstart', 300); touch('touchmove', 180); cancel();
      touch('touchend', 70); await settle(); expect(navigation).not.toHaveBeenCalled();
    }
    visibility.and.returnValue('visible');
  });

  it('does not revive a gesture after a scope change, disable/enable cycle, or route round-trip', async () => {
    touch('touchstart', 300); touch('touchmove', 180);
    fixture.componentInstance.scope = 'another-account:another-device'; fixture.detectChanges();
    touch('touchend', 70); await settle(); expect(navigation).not.toHaveBeenCalled();
    touch('touchstart', 300); fixture.componentInstance.enabled = false; fixture.detectChanges();
    fixture.componentInstance.enabled = true; fixture.detectChanges(); touch('touchend', 70); await settle();
    expect(navigation).not.toHaveBeenCalled();
    touch('touchstart', 300); touch('touchmove', 180); await go('/app/world'); await go('/app/chats');
    touch('touchend', 70); await settle(); expect(navigation).not.toHaveBeenCalled();
  });

  it('excludes editable controls, media, canvas, and explicit opt-out descendants', async () => {
    for (const selector of ['input', 'textarea', 'select', 'input[type=range]', 'ion-range', 'video', 'audio', 'canvas', '[contenteditable] span', '.opt-out']) {
      const element = host.querySelector<HTMLElement>(selector)!;
      await swipe(320, 50, element); expect(navigation).withContext(selector).not.toHaveBeenCalled();
    }
  });

  it('does not steal a horizontal story strip or any nested overflow-x scroller', async () => {
    const horizontal = host.querySelector<HTMLElement>('.horizontal')!;
    expect(horizontal.scrollWidth).toBeGreaterThan(horizontal.clientWidth);
    for (const overflow of ['auto', 'scroll']) {
      horizontal.style.overflowX = overflow; await swipe(320, 50, horizontal.querySelector('span')!);
      expect(navigation).not.toHaveBeenCalled();
    }
    horizontal.classList.add('story-strip'); await swipe(320, 50, horizontal.querySelector('span')!);
    expect(navigation).not.toHaveBeenCalled();
  });

  it('does not leave a focused editor or a fullscreen surface', async () => {
    host.querySelector('input')!.focus(); await swipe(320, 50); expect(navigation).not.toHaveBeenCalled();
    host.querySelector('input')!.blur(); fullscreen.and.returnValue(host); await swipe(320, 50); expect(navigation).not.toHaveBeenCalled();
    fullscreen.and.returnValue(null); target.classList.add('vault-surface', 'is-fullscreen'); await swipe(320, 50); expect(navigation).not.toHaveBeenCalled();
  });

  it('blocks open Ionic overlays and visible modal/menu/dialog content without relying on Ionic gesture internals', async () => {
    for (const tag of ['ion-modal', 'ion-alert', 'ion-action-sheet', 'ion-popover']) {
      const element = overlay(tag, {}, tag === 'ion-alert' ? 'presented' : 'isOpen');
      await swipe(320, 50); expect(navigation).withContext(tag).not.toHaveBeenCalled(); element.remove();
    }
    for (const [tag, attributes] of [['div', { 'aria-modal': 'true' }], ['div', { role: 'menu' }], ['dialog', { open: '' }]] as const) {
      const element = overlay(tag, attributes); await swipe(320, 50); expect(navigation).not.toHaveBeenCalled(); element.remove();
    }
  });

  it('preserves row actions for a short swipe and awaits closing them before a deliberate tab gesture', async () => {
    const row = host.querySelector<HTMLElement>('ion-item-sliding')!;
    const rowTarget = row.querySelector<HTMLElement>('.row-target')!;
    let finishClose!: () => void;
    const close = jasmine.createSpy('close').and.returnValue(new Promise<void>(done => finishClose = done));
    (row as HTMLElement & { close: () => Promise<void> }).close = close;
    await swipe(300, 205, rowTarget); expect(navigation).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    touch('touchstart', 320, 200, rowTarget); touch('touchmove', 100, 200, rowTarget); touch('touchend', 100, 200, rowTarget);
    await Promise.resolve(); expect(close).toHaveBeenCalledTimes(1); expect(navigation).not.toHaveBeenCalled();
    finishClose(); await settle(); expect(router.url).toBe('/app/world');
    expect(navigation).toHaveBeenCalledOnceWith('/app/world', { replaceUrl: true });
  });

  it('coexists with real Ionic row options without activating an action or closing a short row gesture', async () => {
    fixture.destroy();
    const ionic = TestBed.createComponent(IonicSwipeHost); ionic.detectChanges(); await ionic.whenStable();
    const surface = ionic.nativeElement.querySelector('section') as HTMLElement;
    const row = surface.querySelector('ion-item-sliding') as HTMLIonItemSlidingElement;
    const item = surface.querySelector('.real-row-target') as HTMLElement;
    spyOn(surface, 'getBoundingClientRect').and.returnValue({ x: 0, y: 0, left: 0, top: 0, right: 390, bottom: 640, width: 390, height: 640, toJSON: () => ({}) });
    const close = spyOn(row, 'close').and.callThrough();
    try {
      touch('touchstart', 300, 200, item); touch('touchmove', 205, 200, item); touch('touchend', 205, 200, item);
      await ionic.whenStable(); expect(navigation).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
      expect(ionic.componentInstance.actionCalls).toBe(0);
      // Return the real row to rest before the deliberate tab gesture. An
      // already-open action tray must keep its own closing gesture.
      await row.close(); expect(await row.getOpenAmount()).toBe(0); close.calls.reset();
      touch('touchstart', 320, 200, item); touch('touchmove', 100, 200, item); touch('touchend', 100, 200, item);
      await ionic.whenStable(); await Promise.resolve(); await ionic.whenStable();
      expect(close).toHaveBeenCalledTimes(1); expect(ionic.componentInstance.actionCalls).toBe(0);
      expect(await row.getOpenAmount()).toBe(0);
      expect(router.url).toBe('/app/world'); expect(navigation).toHaveBeenCalledOnceWith('/app/world', { replaceUrl: true });
    } finally { ionic.destroy(); }
  });

  it('prevents the successful touch end without stopping propagation and suppresses only its brief pointer ghost click', fakeAsync(() => {
    const now = spyOn(performance, 'now').and.returnValue(1000);
    const endSeen = jasmine.createSpy('document.touchend'); document.addEventListener('touchend', endSeen);
    try {
      touch('touchstart', 320); touch('touchmove', 50); const end = touch('touchend', 50); flushMicrotasks();
      expect(end.defaultPrevented).toBeTrue(); expect(endSeen).toHaveBeenCalledTimes(1);
      const pointerClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }); target.dispatchEvent(pointerClick);
      expect(pointerClick.defaultPrevented).toBeTrue();
      const keyboardClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }); target.dispatchEvent(keyboardClick);
      expect(keyboardClick.defaultPrevented).toBeFalse();
      tick(351);
      now.and.returnValue(1351);
      const laterClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }); target.dispatchEvent(laterClick);
      expect(laterClick.defaultPrevented).toBeFalse();
    } finally { document.removeEventListener('touchend', endSeen); }
  }));

  it('does not navigate after its host was destroyed while a gesture was pending', async () => {
    touch('touchstart', 320); touch('touchmove', 100); fixture.destroy();
    touch('touchend', 50); await Promise.resolve(); expect(navigation).not.toHaveBeenCalled();
  });
});
