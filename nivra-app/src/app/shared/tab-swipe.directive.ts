import { Directive, ElementRef, Input, NgZone, OnChanges, OnDestroy, inject } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';

interface TabTouch {
  id: number;
  x: number;
  y: number;
  startedAt: number;
  furthestX: number;
  direction: number;
  width: number;
  url: string;
  scope: string;
  sliding: (HTMLElement & { close?: () => Promise<void> }) | null;
}

/** Observe touch intent without taking Ionic's row gestures or native vertical scrolling. */
@Directive({ selector: '[appTabSwipe]', standalone: true })
export class TabSwipeDirective implements OnChanges, OnDestroy {
  @Input({ required: true }) appTabSwipe: readonly string[] = [];
  @Input() tabSwipeEnabled = true;
  @Input() tabSwipeScope = '';

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly mobileLayout = window.matchMedia('(max-width: 768px)');
  private touch: TabTouch | null = null;
  private destroyed = false;
  private navigating = false;
  private generation = 0;
  private suppressClickUntil = 0;
  private animation?: Animation;
  private readonly routeEvents = this.router.events.subscribe(event => {
    if (event instanceof NavigationStart) this.reset();
  });

  constructor() {
    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('touchstart', this.start, { passive: true });
      this.host.addEventListener('touchmove', this.move, { passive: true });
      // Only a recognized completed swipe cancels its compatibility click.
      this.host.addEventListener('touchend', this.end, { passive: false });
      this.host.addEventListener('touchcancel', this.reset, { passive: true });
      this.host.addEventListener('click', this.preventGhostClick, true);
      window.addEventListener('blur', this.reset);
      document.addEventListener('visibilitychange', this.reset);
      this.mobileLayout.addEventListener('change', this.reset);
      window.visualViewport?.addEventListener('resize', this.reset);
    });
  }

  ngOnChanges(): void { this.reset(); }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.reset();
    this.animation?.cancel();
    this.routeEvents.unsubscribe();
    this.host.removeEventListener('touchstart', this.start);
    this.host.removeEventListener('touchmove', this.move);
    this.host.removeEventListener('touchend', this.end);
    this.host.removeEventListener('touchcancel', this.reset);
    this.host.removeEventListener('click', this.preventGhostClick, true);
    window.removeEventListener('blur', this.reset);
    document.removeEventListener('visibilitychange', this.reset);
    this.mobileLayout.removeEventListener('change', this.reset);
    window.visualViewport?.removeEventListener('resize', this.reset);
  }

  private readonly reset = (): void => { this.touch = null; ++this.generation; };

  private readonly start = (event: TouchEvent): void => {
    this.reset();
    if (this.navigating || event.touches.length !== 1 || !this.available() || this.hasOverlay()) return;
    const path = event.composedPath().filter(node => node instanceof Element) as Element[];
    if (this.protectedSurface(path) || this.editing()) return;
    const point = event.touches[0];
    const bounds = this.host.getBoundingClientRect();
    if (bounds.width <= 0 || point.clientX - bounds.left < 24 || bounds.right - point.clientX < 24) return;
    const sliding = path.find(node => node.matches('ion-item-sliding')) as TabTouch['sliding'];
    // An open row owns its closing gesture and its action buttons.
    if (this.host.querySelector('ion-item-sliding.item-sliding-active-slide')) return;
    this.touch = { id: point.identifier, x: point.clientX, y: point.clientY, startedAt: performance.now(),
      furthestX: 0, direction: 0, width: bounds.width, url: this.router.url, scope: this.tabSwipeScope, sliding: sliding ?? null };
  };

  private readonly move = (event: TouchEvent): void => {
    const touch = this.touch;
    if (!touch) return;
    const point = Array.from(event.touches).find(item => item.identifier === touch.id);
    if (event.touches.length !== 1 || !point || !this.sameContext(touch)) { this.reset(); return; }
    this.track(touch, point);
  };

  private track(touch: TabTouch, point: Touch): boolean {
    const dx = point.clientX - touch.x;
    const dy = Math.abs(point.clientY - touch.y);
    if ((dy >= 12 && dy > Math.abs(dx) * .8) || performance.now() - touch.startedAt > 1_200) {
      this.reset(); return false;
    }
    if (!touch.direction && Math.abs(dx) >= 20) touch.direction = Math.sign(dx);
    const distance = dx * touch.direction;
    if (touch.direction && touch.furthestX - distance >= 24) { this.reset(); return false; }
    touch.furthestX = Math.max(touch.furthestX, distance);
    return true;
  }

  private readonly end = (event: TouchEvent): void => {
    const touch = this.touch;
    this.touch = null;
    if (!touch || event.touches.length || !this.sameContext(touch) || this.hasOverlay() || this.editing()) return;
    const point = Array.from(event.changedTouches).find(item => item.identifier === touch.id);
    if (!point || !this.track(touch, point)) return;
    const dx = point.clientX - touch.x;
    const dy = Math.abs(point.clientY - touch.y);
    // Row action swipes remain short; a deliberate broad sweep selects a tab.
    const threshold = touch.sliding ? Math.max(128, touch.width * .4) : Math.max(64, touch.width * .2);
    if (Math.abs(dx) < threshold || Math.abs(dx) < dy * 1.7) return;
    const rtl = getComputedStyle(this.host).direction === 'rtl';
    const step = (dx < 0 ? 1 : -1) * (rtl ? -1 : 1);
    const destination = this.appTabSwipe[this.tabIndex(touch.url) + step];
    if (!destination) return;
    if (event.cancelable) event.preventDefault();
    this.suppressClickUntil = performance.now() + 350;
    this.navigating = true;
    const generation = this.generation;
    // Let the row finish its own touchend before closing it. No ionSwipe action
    // is dispatched here and normal short row gestures never enter this path.
    queueMicrotask(() => void this.navigate(touch, destination, step, generation));
  };

  private async navigate(touch: TabTouch, destination: string, step: number, generation: number): Promise<void> {
    try {
      if (!this.sameContext(touch) || generation !== this.generation) return;
      await touch.sliding?.close?.();
      if (!this.sameContext(touch) || generation !== this.generation || this.hasOverlay()) return;
      const navigated = await this.zone.run(() => this.router.navigateByUrl(destination, { replaceUrl: true }));
      if (!navigated || this.destroyed || this.tabSwipeScope !== touch.scope || this.router.url !== destination) return;
      this.animateEntry(step);
    } catch {
      // A cancelled route or detached row leaves the usual tab buttons usable.
    } finally { this.navigating = false; }
  }

  private animateEntry(step: number): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || document.documentElement.classList.contains('nivra-animations-off')
      || document.body.classList.contains('nivra-animations-off')) return;
    const page = this.host.querySelector('router-outlet')?.nextElementSibling;
    if (!(page instanceof HTMLElement) || typeof page.animate !== 'function') return;
    this.animation?.cancel();
    const direction = getComputedStyle(this.host).direction === 'rtl' ? -step : step;
    const animation = page.animate([
      { opacity: .72, transform: `translate3d(${direction * 24}px, 0, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ], { duration: 180, easing: 'cubic-bezier(.2,.65,.3,1)' });
    this.animation = animation;
    void animation.finished.catch(() => undefined).then(() => {
      if (this.animation === animation) this.animation = undefined;
    });
  }

  private sameContext(touch: TabTouch): boolean {
    return this.available() && touch.url === this.router.url && touch.scope === this.tabSwipeScope;
  }

  private available(): boolean {
    return !this.destroyed && this.tabSwipeEnabled && this.mobileLayout.matches
      && document.visibilityState !== 'hidden' && (window.visualViewport?.scale ?? 1) <= 1.01
      && this.tabIndex(this.router.url) >= 0;
  }

  private tabIndex(url: string): number { return this.appTabSwipe.indexOf(url.split(/[?#]/)[0].replace(/\/$/, '')); }

  private editing(): boolean {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active instanceof Element && this.isEditingControl(active);
  }

  private isEditingControl(element: Element): boolean {
    return element.matches('input,textarea,select,ion-input,ion-textarea,ion-select,ion-range,[contenteditable]:not([contenteditable="false"])');
  }

  private protectedSurface(path: Element[]): boolean {
    for (const node of path) {
      if (node === this.host) break;
      if (this.isEditingControl(node) || node.matches('audio,video,canvas,ion-item-option,ion-item-options,[data-tab-swipe="off"]')) return true;
      const style = getComputedStyle(node);
      if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(style.overflowX)) return true;
    }
    return false;
  }

  private hasOverlay(): boolean {
    if (document.fullscreenElement || this.host.querySelector('.vault-surface.is-fullscreen')) return true;
    return Array.from(document.querySelectorAll('ion-modal,ion-alert,ion-action-sheet,ion-popover,ion-picker,[aria-modal="true"],[role="menu"],dialog[open]'))
      .some(element => {
        const overlay = element as Element & { isOpen?: boolean; presented?: boolean };
        if (overlay.isOpen || overlay.presented) return true;
        return element.matches('[aria-modal="true"],[role="menu"],dialog[open]')
          && !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0;
      });
  }

  private readonly preventGhostClick = (event: MouseEvent): void => {
    if (event.detail > 0 && performance.now() < this.suppressClickUntil) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
}
