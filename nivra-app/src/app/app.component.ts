import { CommonModule } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { App } from '@capacitor/app';
import { Keyboard, KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';
import { NavigationEnd, Router } from '@angular/router';
import { IonApp, IonIcon, IonRouterOutlet } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { callOutline, videocamOutline } from 'ionicons/icons';
import { AuthService } from './core/services/auth.service';
import { AppLockService } from './core/services/app-lock.service';
import { AppSettingsService } from './core/services/app-settings.service';
import { CallsService } from './core/services/calls.service';
import { ContactSyncService } from './core/services/contact-sync.service';
import { DeviceWipeService } from './core/services/device-wipe.service';
import { PushService } from './core/services/push.service';
import { SignalrService } from './core/services/signalr.service';
import { TranslatePipe } from './core/pipes/translate.pipe';
import { TranslateService } from './core/services/translate.service';
import { AppLockScreenComponent } from './shared/app-lock-screen.component';

const THEME_STORAGE_KEY = 'nivra.theme';
const CONTACT_ALIAS_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: true,
  imports: [CommonModule, TranslatePipe, IonApp, IonIcon, IonRouterOutlet, AppLockScreenComponent],
})
export class AppComponent {
  private readonly auth = inject(AuthService);
  private readonly appLock = inject(AppLockService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly contactSync = inject(ContactSyncService);
  private readonly deviceWipe = inject(DeviceWipeService);
  private readonly push = inject(PushService);
  private readonly router = inject(Router);
  private readonly realtime = inject(SignalrService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly systemThemeQuery = typeof window !== 'undefined' && 'matchMedia' in window
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;
  readonly calls = inject(CallsService);
  private readonly now = signal(Date.now());
  private readonly onCallsRoute = signal(this.router.url.startsWith('/app/calls'));
  private startServicesPromise: Promise<void> | null = null;
  private lastPushRouteKey = '';
  readonly showCallBanner = computed(() => {
    const phase = this.calls.phase();
    return this.auth.isAuthenticated()
      && Boolean(this.calls.activeCall())
      && phase !== 'idle'
      && phase !== 'ringing'
      && !this.onCallsRoute();
  });
  readonly callElapsed = computed(() => {
    const call = this.calls.activeCall();
    const started = Date.parse(call?.startedAt || '');
    if (!call || !Number.isFinite(started)) {
      return '00:00';
    }
    return this.formatDuration(Math.max(0, this.now() - started));
  });

  constructor() {
    void this.translate;
    this.applyStoredTheme();
    this.bindSystemTheme();
    this.bindAppLinks();
    this.bindAppLifecycleLock();
    addIcons({ callOutline, videocamOutline });
    void this.configureNativeKeyboard();

    const timer = window.setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => window.clearInterval(timer));

    this.router.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event instanceof NavigationEnd) {
          this.onCallsRoute.set(event.urlAfterRedirects.startsWith('/app/calls'));
        }
      });

    this.realtime.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (this.shouldForceWipe(event)) {
          void this.deviceWipe.nukeDevice();
          return;
        }
        void this.push.notifyRealtimeEvent(event);
      });

    effect(() => {
      if (this.auth.isAuthenticated()) {
        untracked(() => void this.startAuthenticatedServices());
      } else {
        void this.realtime.disconnect();
      }
    });

    effect(() => {
      const request = this.auth.forceWipeRequested();
      if (request > 0) {
        untracked(() => void this.deviceWipe.nukeDevice());
      }
    });

    effect(() => {
      const message = this.push.lastMessage();
      const data = message?.data as Record<string, string> | undefined;
      if (!this.auth.isAuthenticated() || !data) {
        return;
      }
      if (data['nivraRouteIntent'] !== 'tap') {
        return;
      }
      const key = data['tag'] || data['messageId'] || data['callId'] || JSON.stringify(data);
      if (key === this.lastPushRouteKey) {
        return;
      }
      this.lastPushRouteKey = key;
      const pushType = (data['type'] || '').replace(/_/g, '-').toLowerCase();
      if (data['callId'] || pushType.includes('call')) {
        void this.router.navigateByUrl('/app/calls');
      } else if (pushType === 'contact-joined') {
        void this.router.navigateByUrl('/app/world');
      } else if (data['conversationId']) {
        void this.router.navigateByUrl(`/app/chats/${data['conversationId']}`);
      }
    });
  }

  private async configureNativeKeyboard(): Promise<void> {
    try {
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
      await Keyboard.setStyle({ style: this.lightThemeEnabled() ? KeyboardStyle.Light : KeyboardStyle.Dark });
    } catch {
      // Web and desktop do not expose the native keyboard bridge.
    }
  }

  private applyStoredTheme(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const enabled = this.prefersLightTheme();
    document.body.classList.toggle('nivra-light-theme', enabled);
    document.documentElement.classList.toggle('nivra-light-theme', enabled);
  }

  private readStoredTheme(): 'dark' | 'light' | 'system' {
    try {
      const value = localStorage.getItem(THEME_STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : 'system';
    } catch {
      return 'system';
    }
  }

  private prefersLightTheme(): boolean {
    const stored = this.readStoredTheme();
    if (stored === 'light') {
      return true;
    }
    if (stored === 'dark') {
      return false;
    }
    return this.systemThemeQuery?.matches ?? false;
  }

  private bindSystemTheme(): void {
    const query = this.systemThemeQuery;
    if (!query) {
      return;
    }
    const listener = () => {
      if (this.readStoredTheme() !== 'system') {
        return;
      }
      this.applyStoredTheme();
      void Keyboard.setStyle({ style: this.lightThemeEnabled() ? KeyboardStyle.Light : KeyboardStyle.Dark }).catch(() => undefined);
    };
    query.addEventListener('change', listener);
    this.destroyRef.onDestroy(() => query.removeEventListener('change', listener));
  }

  private bindAppLinks(): void {
    void App.addListener('appUrlOpen', (event) => this.handleAppUrlOpen(event.url))
      .then((handle) => this.destroyRef.onDestroy(() => void handle.remove()))
      .catch(() => undefined);
  }

  private bindAppLifecycleLock(): void {
    void App.addListener('appStateChange', (state) => {
      if (!state.isActive) {
        this.appLock.lock();
        return;
      }
      void this.appLock.refreshBiometryAvailability();
    })
      .then((handle) => this.destroyRef.onDestroy(() => void handle.remove()))
      .catch(() => undefined);
  }

  private handleAppUrlOpen(rawUrl: string): void {
    if (!rawUrl) {
      return;
    }

    try {
      const url = new URL(rawUrl);
      if (url.hostname.toLowerCase() !== 'nivrapp-secure.vercel.app') {
        return;
      }

      const path = url.pathname.replace(/\/+$/, '');
      if (path === '/contact') {
        const alias = this.normalizeContactAlias(url.searchParams.get('alias') || '');
        if (alias) {
          void this.router.navigate(['/contact'], { queryParams: { alias } });
        }
        return;
      }

      if (path === '/vault/invite') {
        const code = (url.searchParams.get('code') || '').trim();
        if (code) {
          void this.router.navigate(['/vault/invite'], { queryParams: { code } });
        }
      }
    } catch {
      // Ignore URLs that do not belong to Nivra app links.
    }
  }

  private normalizeContactAlias(value: string): string {
    const alias = value.trim().replace(/^@+/, '');
    return CONTACT_ALIAS_PATTERN.test(alias) ? alias.toLowerCase() : '';
  }

  private shouldForceWipe(event: { type: string; payload: unknown }): boolean {
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as { code?: unknown; deviceId?: unknown }
      : null;
    const currentDeviceId = this.auth.session()?.device.id;
    if (event.type === 'FORCE_WIPE') {
      return !payload?.deviceId || payload.deviceId === currentDeviceId;
    }
    if (payload?.code === 'FORCE_WIPE') {
      return !payload.deviceId || payload.deviceId === currentDeviceId;
    }
    return event.type === 'device.revoked' && (!payload?.deviceId || payload.deviceId === currentDeviceId);
  }

  private lightThemeEnabled(): boolean {
    return typeof document !== 'undefined' && document.body.classList.contains('nivra-light-theme');
  }

  async openActiveCall(): Promise<void> {
    await this.router.navigateByUrl('/app/calls');
  }

  private async startAuthenticatedServices(): Promise<void> {
    if (this.startServicesPromise) {
      return this.startServicesPromise;
    }
    this.startServicesPromise = (async () => {
      if (!await this.auth.ensureFreshSession()) {
        return;
      }
      await this.realtime.connect();
      await this.push.initialize();
      void this.contactSync.syncCachedContactsInBackground();
    })().finally(() => {
      this.startServicesPromise = null;
    });
    return this.startServicesPromise;
  }

  private formatDuration(durationMs: number): string {
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}
