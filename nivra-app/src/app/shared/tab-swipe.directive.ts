import { Directive, ElementRef, Input, NgZone, OnChanges, OnDestroy, inject } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { restoreTabSnapshotScroll, tabSwipeSnapshot } from './tab-swipe-snapshot';

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
  lastX: number;
  lastAt: number;
  velocity: number;
}

interface TabPreview {
  source: HTMLElement;
  frame: HTMLElement;
  viewport: HTMLElement;
  width: number;
  dx: number;
  side: number;
  destination: string;
  sourceStyle: { transform: string; transition: string; willChange: string };
  viewportStyle: { position: string; overflow: string };
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
  private preview: TabPreview | null = null;
  private readonly snapshots = new Map<string, { node: HTMLElement; width: number; height: number; appearance: string }>();
  private ownDestination = '';
  private readonly routeEvents = this.router.events.subscribe(event => {
    if (!(event instanceof NavigationStart) || event.url === this.ownDestination) return;
    this.clearPreview();
    if (this.available()) this.captureCurrent();
    this.touch = null; ++this.generation;
    if (this.tabIndex(event.url) < 0) this.snapshots.clear();
  });

  constructor() {
    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('touchstart', this.start, { passive: true });
      this.host.addEventListener('touchmove', this.move, { passive: false });
      // Only a recognized completed swipe cancels its compatibility click.
      this.host.addEventListener('touchend', this.end, { passive: false });
      this.host.addEventListener('touchcancel', this.reset, { passive: true });
      this.host.addEventListener('click', this.preventGhostClick, true);
      window.addEventListener('blur', this.reset);
      document.addEventListener('visibilitychange', this.reset);
      this.mobileLayout.addEventListener('change', this.reset);
      window.addEventListener('resize', this.reset);
      window.addEventListener('orientationchange', this.reset);
      window.visualViewport?.addEventListener('resize', this.reset);
    });
  }

  ngOnChanges(): void { this.reset(); }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.reset();
    this.routeEvents.unsubscribe();
    this.host.removeEventListener('touchstart', this.start);
    this.host.removeEventListener('touchmove', this.move);
    this.host.removeEventListener('touchend', this.end);
    this.host.removeEventListener('touchcancel', this.reset);
    this.host.removeEventListener('click', this.preventGhostClick, true);
    window.removeEventListener('blur', this.reset);
    document.removeEventListener('visibilitychange', this.reset);
    this.mobileLayout.removeEventListener('change', this.reset);
    window.removeEventListener('resize', this.reset);
    window.removeEventListener('orientationchange', this.reset);
    window.visualViewport?.removeEventListener('resize', this.reset);
  }

  private readonly reset = (): void => {
    this.touch = null; ++this.generation; this.clearPreview(); this.snapshots.clear();
  };

  private abortGesture(): void { this.touch = null; ++this.generation; this.clearPreview(); }

  private readonly start = (event: TouchEvent): void => {
    this.abortGesture();
    if (this.navigating || event.touches.length !== 1 || !this.available() || this.hasOverlay()) return;
    const path = event.composedPath().filter(node => node instanceof Element) as Element[];
    if (this.protectedSurface(path) || this.editing()) return;
    const point = event.touches[0];
    const bounds = this.host.getBoundingClientRect();
    if (bounds.width <= 0 || point.clientX - bounds.left < 24 || bounds.right - point.clientX < 24) return;
    const sliding = path.find(node => node.matches('ion-item-sliding')) as TabTouch['sliding'];
    // An open row owns its closing gesture and its action buttons.
    if (this.host.querySelector('ion-item-sliding.item-sliding-active-slide')) return;
    const now = performance.now();
    this.touch = { id: point.identifier, x: point.clientX, y: point.clientY, startedAt: now,
      furthestX: 0, direction: 0, width: bounds.width, url: this.router.url, scope: this.tabSwipeScope, sliding: sliding ?? null,
      lastX: point.clientX, lastAt: now, velocity: 0 };
  };

  private readonly move = (event: TouchEvent): void => {
    const touch = this.touch;
    if (!touch) return;
    const point = Array.from(event.touches).find(item => item.identifier === touch.id);
    if (event.touches.length !== 1 || !point || !this.sameContext(touch) || this.hasOverlay()) { this.abortGesture(); return; }
    if (!this.track(touch, point)) return;
    const dx = point.clientX - touch.x;
    // Short row actions keep Ionic's gesture; broad deliberate sweeps acquire the page.
    const acquire = touch.sliding ? Math.max(128, touch.width * .4) : 20;
    if (touch.direction && Math.abs(dx) >= acquire) {
      this.showProgress(touch, dx);
      if (this.preview && event.cancelable) event.preventDefault();
    }
  };

  private track(touch: TabTouch, point: Touch): boolean {
    const dx = point.clientX - touch.x;
    const dy = Math.abs(point.clientY - touch.y);
    if (dy >= 12 && dy > Math.abs(dx) * .8) {
      this.abortGesture(); return false;
    }
    if (!touch.direction && Math.abs(dx) >= 20) touch.direction = Math.sign(dx);
    const distance = dx * touch.direction;
    if (touch.direction && touch.furthestX - distance >= 24) { this.abortGesture(); return false; }
    touch.furthestX = Math.max(touch.furthestX, distance);
    const now = performance.now(), elapsed = now - touch.lastAt;
    if (elapsed >= 8 && point.clientX !== touch.lastX) { touch.velocity = (point.clientX - touch.lastX) / elapsed; touch.lastX = point.clientX; touch.lastAt = now; }
    else if (elapsed > 100) touch.velocity = 0;
    return true;
  }

  private readonly end = (event: TouchEvent): void => {
    const touch = this.touch;
    this.touch = null;
    if (!touch || event.touches.length || !this.sameContext(touch) || this.hasOverlay() || this.editing()) { this.clearPreview(); return; }
    const point = Array.from(event.changedTouches).find(item => item.identifier === touch.id);
    if (!point || !this.track(touch, point)) { this.clearPreview(); return; }
    const dx = point.clientX - touch.x;
    const dy = Math.abs(point.clientY - touch.y);
    // Row action swipes remain short; a deliberate broad sweep selects a tab.
    const threshold = touch.sliding ? Math.max(128, touch.width * .4) : Math.max(64, touch.width * .2);
    const flick = !touch.sliding && Math.abs(dx) >= 48 && Math.abs(touch.velocity) >= .5
      && performance.now() - touch.lastAt < 100 && performance.now() - touch.startedAt >= 30;
    if ((Math.abs(dx) < threshold && !flick) || Math.abs(dx) < dy * 1.7) { void this.finishProgress(false); return; }
    const rtl = getComputedStyle(this.host).direction === 'rtl';
    const step = (dx < 0 ? 1 : -1) * (rtl ? -1 : 1);
    const destination = this.appTabSwipe[this.tabIndex(touch.url) + step];
    if (!destination) { void this.finishProgress(false); return; }
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
      await this.finishProgress(true);
      if (!this.sameContext(touch) || generation !== this.generation || this.hasOverlay()) return;
      this.ownDestination = destination;
      const navigated = await this.zone.run(() => this.router.navigateByUrl(destination, { replaceUrl: true }));
      if (!navigated || this.destroyed || this.tabSwipeScope !== touch.scope || this.router.url !== destination) return;
    } catch {
      // A cancelled route or detached row leaves the usual tab buttons usable.
    } finally { this.ownDestination = ''; this.clearPreview(); this.navigating = false; }
  }

  private viewport(): HTMLElement { return this.host.querySelector<HTMLElement>('.route-stage') ?? this.host; }

  private currentPage(): HTMLElement | null {
    const page = this.host.querySelector('router-outlet')?.nextElementSibling;
    return page instanceof HTMLElement && !page.hasAttribute('data-tab-preview') ? page : null;
  }

  private captureCurrent(): void {
    const page = this.currentPage(); if (!page || !this.tabSwipeScope || this.hasOverlay()) return;
    const viewport = this.viewport(), bounds = viewport.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const path = this.appTabSwipe[this.tabIndex(this.router.url)]; if (!path) return;
    this.snapshots.set(path, { node: tabSwipeSnapshot(page, bounds), width: bounds.width, height: bounds.height, appearance: this.appearanceKey() });
    while (this.snapshots.size > 5) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  private appearanceKey(): string {
    const style = getComputedStyle(this.host);
    return JSON.stringify(['--nivra-bg','--nivra-text','--nivra-muted','--nivra-panel-solid','--nivra-brand','--nivra-selection']
      .map(name => style.getPropertyValue(name).trim()).concat(style.fontFamily, style.fontSize));
  }

  private showProgress(touch: TabTouch, dx: number): void {
    const side = dx < 0 ? 1 : -1;
    const step = side * (getComputedStyle(this.host).direction === 'rtl' ? -1 : 1);
    const destination = this.appTabSwipe[this.tabIndex(touch.url) + step] ?? '';
    if (!this.preview) {
      const source = this.currentPage(); if (!source) return;
      this.captureCurrent();
      const viewport = this.viewport(), bounds = viewport.getBoundingClientRect();
      const frame = document.createElement('div'); frame.setAttribute('data-tab-preview', destination || 'edge'); frame.setAttribute('aria-hidden', 'true'); frame.inert = true;
      Object.assign(frame.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none', zIndex: '3', background: 'var(--nivra-panel-solid, #f6f8f6)' });
      const saved = this.snapshots.get(destination);
      if (saved && saved.appearance === this.appearanceKey() && Math.abs(saved.width - bounds.width) <= 1 && Math.abs(saved.height - bounds.height) <= 1) frame.appendChild(saved.node.cloneNode(true));
      else if (destination) {
        const heading = document.createElement('strong');
        const links = Array.from(this.host.closest('.workspace')?.querySelectorAll<HTMLAnchorElement>('nav.rail a.nav-btn') ?? []);
        heading.textContent = links.find(link => link.getAttribute('data-tab-path') === destination)?.querySelector('span')?.textContent ?? destination.split('/').at(-1) ?? '';
        Object.assign(heading.style, { display: 'block', fontSize: '28px', padding: '32px 20px', color: 'var(--nivra-text, #173c30)' }); frame.appendChild(heading);
        const placeholder = document.createElement('div'); placeholder.setAttribute('data-tab-preview-loading', 'true');
        Object.assign(placeholder.style, { height: '96px', margin: '0 20px', borderRadius: '18px', background: 'var(--nivra-panel-2, #e8eeea)' }); frame.appendChild(placeholder);
      }
      this.preview = { source, frame, viewport, width: bounds.width || touch.width, dx: 0, side, destination,
        sourceStyle: { transform: source.style.transform, transition: source.style.transition, willChange: source.style.willChange },
        viewportStyle: { position: viewport.style.position, overflow: viewport.style.overflow } };
      if (getComputedStyle(viewport).position === 'static') viewport.style.position = 'relative'; viewport.style.overflow = 'hidden';
      source.style.willChange = 'transform'; source.style.transition = 'none'; viewport.appendChild(frame); restoreTabSnapshotScroll(frame);
    }
    const preview = this.preview;
    const amount = Math.max(-preview.width, Math.min(preview.width, dx)) * (destination ? 1 : .14);
    preview.dx = amount; preview.source.style.transform = `translate3d(${amount}px, 0, 0)`;
    preview.frame.style.transform = `translate3d(${side * preview.width + amount}px, 0, 0)`;
  }

  private async finishProgress(commit: boolean): Promise<void> {
    const preview = this.preview; if (!preview) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('nivra-animations-off') || document.body.classList.contains('nivra-animations-off');
    const amount = commit ? -preview.side * preview.width : 0;
    const transition = reduced ? 'none' : 'transform 180ms cubic-bezier(.2,.65,.3,1)';
    preview.source.style.transition = transition; preview.frame.style.transition = transition;
    preview.source.style.transform = `translate3d(${amount}px, 0, 0)`;
    preview.frame.style.transform = `translate3d(${preview.side * preview.width + amount}px, 0, 0)`;
    if (!reduced) await new Promise<void>(resolve => window.setTimeout(resolve, 190));
    if (!commit && this.preview === preview) this.clearPreview();
  }

  private clearPreview(): void {
    const preview = this.preview; this.preview = null; if (!preview) return;
    Object.assign(preview.source.style, preview.sourceStyle); Object.assign(preview.viewport.style, preview.viewportStyle);
    preview.frame.replaceChildren(); preview.frame.remove();
  }

  private sameContext(touch: TabTouch): boolean {
    return this.available() && touch.url === this.router.url && touch.scope === this.tabSwipeScope;
  }

  private available(): boolean {
    return !this.destroyed && this.tabSwipeEnabled && this.mobileLayout.matches
      && document.visibilityState !== 'hidden' && (window.visualViewport?.scale ?? 1) <= 1.01
        && this.tabIndex(this.router.url) >= 0 && !this.host.querySelector('[data-tab-swipe-lock="true"]');
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
