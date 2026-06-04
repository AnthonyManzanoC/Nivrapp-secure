import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
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

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet, TranslatePipe, IonApp, IonIcon],
  templateUrl: './shell.page.html',
  styleUrls: ['./shell.page.scss'],
})
export class ShellPage {
  readonly auth = inject(AuthService);
  readonly calls = inject(CallsService);
  readonly realtime = inject(SignalrService);
  private readonly router = inject(Router);
  readonly hideMobileNav = signal(this.isChatDetailRoute(this.router.url));

  readonly nav = [
    { path: '/app/chats', icon: 'chatbubble-ellipses-outline', label: 'Chats', labelKey: 'TABS.CHATS' },
    { path: '/app/world', icon: 'globe-outline', label: 'Mundo', labelKey: 'TABS.WORLD' },
    { path: '/app/vault', icon: 'lock-closed-outline', label: 'Boveda', labelKey: 'TABS.VAULT' },
    { path: '/app/calls', icon: 'call-outline', label: 'Llamadas', labelKey: 'TABS.CALLS' },
    { path: '/app/account', icon: 'person-circle-outline', label: 'Cuenta', labelKey: 'TABS.ACCOUNT' },
  ];

  constructor() {
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
          this.hideMobileNav.set(this.isChatDetailRoute(event.urlAfterRedirects));
        }
      });
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
    await this.router.navigateByUrl('/auth');
  }

  private isChatDetailRoute(url: string): boolean {
    return /^\/app\/chats\/[^/?#]+/.test(url);
  }
}
