import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, computed, ElementRef, inject, NgZone, OnDestroy, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { IonApp, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  albumsOutline,
  callOutline,
  chatbubbleEllipsesOutline,
  closeOutline,
  globeOutline,
  lockClosedOutline,
  logOutOutline,
  personCircleOutline,
  videocamOutline,
} from 'ionicons/icons';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { SignalrService } from '../../core/services/signalr.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { ClientCompatibilityService } from '../../core/services/client-compatibility.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { UnreadTabService } from '../../core/services/unread-tab.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { TabSwipeDirective } from '../../shared/tab-swipe.directive';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [LocalizedDatePipe, CommonModule, RouterLink, RouterLinkActive, RouterOutlet, TranslatePipe, IonApp, IonIcon, TabSwipeDirective],
  templateUrl: './shell.page.html',
  styleUrls: ['./shell.page.scss'],
})
export class ShellPage implements AfterViewInit, OnDestroy {
  readonly failedAvatar = signal('');
  readonly auth = inject(AuthService);
  readonly calls = inject(CallsService);
  readonly realtime = inject(SignalrService);
  readonly unread = inject(UnreadTabService);
  readonly compatibility = inject(ClientCompatibilityService);
  readonly appLock = inject(AppLockService);
  private readonly api = inject(NivraApiService);
  private readonly router = inject(Router);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);
  readonly hideMobileNav = signal(this.isMobileImmersiveRoute(this.router.url));
  readonly onCallsPage = signal(this.router.url.startsWith('/app/calls'));

  readonly nav = [
    { path: '/app/chats', icon: 'chatbubble-ellipses-outline', label: 'Chats', labelKey: 'TABS.CHATS' },
    { path: '/app/world', icon: 'globe-outline', label: 'Mundo', labelKey: 'TABS.WORLD' },
    { path: '/app/vault', icon: 'lock-closed-outline', label: 'Boveda', labelKey: 'TABS.VAULT' },
    { path: '/app/calls', icon: 'call-outline', label: 'Llamadas', labelKey: 'TABS.CALLS' },
    { path: '/app/account', icon: 'person-circle-outline', label: 'Cuenta', labelKey: 'TABS.ACCOUNT' },
  ];
  readonly tabPaths = this.nav.map(item => item.path);
  private readonly otherAccount = computed(() => {
    const current = this.auth.session();
    const accounts = this.auth.savedAccounts();
    if (!current?.user.id || !current.device.id || accounts.length !== 2
      || accounts.some(account => !account.id) || accounts[0].id === accounts[1].id
      || accounts.filter(account => account.active).length !== 1
      || !accounts.some(account => account.id === current.user.id && account.active)) return null;
    return accounts.find(account => !account.active && account.id !== current.user.id) ?? null;
  });
  readonly accountShortcutAvailable = computed(() => Boolean(this.otherAccount())
    && !this.auth.accountsBusy() && !this.auth.addingAccount()
    && !this.appLock.isContentLocked() && !this.calls.activeCall() && !this.calls.resumableCall());
  private accountTap: { at: number; scope: string; targetId: string } | null = null;
  private accountShortcutInFlight = false;
  private accountShortcutSuppressedUntil = 0;
  private destroyed = false;
  private readonly onNavigationClick = (event: MouseEvent): void => this.handleNavigationClick(event);
  private readonly clearAccountTap = (): void => { this.accountTap = null; };

  constructor() {
    void this.compatibility.check(this.api.baseUrl);
    addIcons({
      albumsOutline,
      callOutline,
      chatbubbleEllipsesOutline,
      closeOutline,
      globeOutline,
      lockClosedOutline,
      logOutOutline,
      personCircleOutline,
      videocamOutline,
    });

    this.router.events
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event instanceof NavigationEnd) {
          this.hideMobileNav.set(this.isMobileImmersiveRoute(event.urlAfterRedirects));
          this.onCallsPage.set(event.urlAfterRedirects.startsWith('/app/calls'));
          if (event.urlAfterRedirects.split(/[?#]/, 1)[0] !== '/app/account') this.clearAccountTap();
        }
      });
  }

  ngAfterViewInit(): void {
    // Capture the second tap before RouterLink can navigate back to Cuenta
    // after AuthService has completed the account switch to Chats.
    this.zone.runOutsideAngular(() => {
      this.element.nativeElement.addEventListener('click', this.onNavigationClick, true);
      window.addEventListener('blur', this.clearAccountTap);
      document.addEventListener('visibilitychange', this.clearAccountTap);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearAccountTap();
    this.element.nativeElement.removeEventListener('click', this.onNavigationClick, true);
    window.removeEventListener('blur', this.clearAccountTap);
    document.removeEventListener('visibilitychange', this.clearAccountTap);
  }

  private handleNavigationClick(event: MouseEvent): void {
    const link = event.target instanceof Element
      ? event.target.closest('nav.rail > a.nav-btn[data-account-shortcut="true"]') : null;
    if (!link || !this.element.nativeElement.contains(link)) { this.clearAccountTap(); return; }
    if (this.accountShortcutInFlight) { this.consumeAccountTap(event); return; }
    if (event.detail === 0 || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      this.clearAccountTap(); return;
    }
    const now = performance.now();
    if (now < this.accountShortcutSuppressedUntil) { this.consumeAccountTap(event); return; }
    const target = this.otherAccount();
    if (this.destroyed || !target || !this.accountShortcutAvailable() || this.hideMobileNav()
      || document.visibilityState === 'hidden' || !this.tabPaths.includes(this.router.url.split(/[?#]/, 1)[0])) {
      this.clearAccountTap(); return;
    }
    const session = this.auth.session()!;
    const scope = JSON.stringify([session.user.id, session.device.id, this.auth.sessionGeneration()]);
    const previous = this.accountTap;
    this.accountTap = { at: now, scope, targetId: target.id };
    if (!previous || previous.scope !== scope || previous.targetId !== target.id || now - previous.at > 350) return;
    this.clearAccountTap();
    this.consumeAccountTap(event);
    this.accountShortcutInFlight = true;
    this.zone.run(() => { void this.switchByAccountShortcut(target.id, scope); });
  }

  private consumeAccountTap(event: MouseEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private async switchByAccountShortcut(userId: string, sourceScope: string): Promise<void> {
    try { await this.auth.switchAccount(userId); }
    catch {
      const current = this.auth.session();
      const currentScope = JSON.stringify([current?.user.id, current?.device.id, this.auth.sessionGeneration()]);
      if (!this.destroyed && currentScope === sourceScope) {
        this.auth.accountError.set('No se pudo abrir esta cuenta. Sus sesiones e historial se han conservado.');
      }
    } finally {
      this.accountShortcutInFlight = false;
      // A third tap from the same burst must not open Cuenta on the new profile.
      this.accountShortcutSuppressedUntil = performance.now() + 350;
    }
  }

  async openCalls(): Promise<void> {
    await this.router.navigateByUrl('/app/calls');
  }

  async acceptCall(): Promise<void> {
    await this.calls.accept();
    await this.openCalls();
  }

  async declineCall(): Promise<void> {
    await this.calls.decline();
  }

  async endCall(): Promise<void> {
    await this.calls.end();
  }

  async logout(): Promise<void> {
    if (this.calls.activeCall()) {
      await this.calls.end().catch(() => undefined);
    }
    this.calls.releaseLocalResources();
    await this.auth.logout();
  }

  private isMobileImmersiveRoute(url: string): boolean {
    return /^\/app\/chats\/[^/?#]+/.test(url) || /^\/app\/share(?:[/?#]|$)/.test(url);
  }
}
