import { CommonModule } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Keyboard, KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';
import { NavigationEnd, Router } from '@angular/router';
import { IonApp, IonIcon, IonRouterOutlet } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { callOutline, videocamOutline } from 'ionicons/icons';
import { AuthService } from './core/services/auth.service';
import { CallsService } from './core/services/calls.service';
import { PushService } from './core/services/push.service';
import { SignalrService } from './core/services/signalr.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: true,
  imports: [CommonModule, IonApp, IonIcon, IonRouterOutlet],
})
export class AppComponent {
  private readonly auth = inject(AuthService);
  private readonly push = inject(PushService);
  private readonly router = inject(Router);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
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
        void this.push.notifyRealtimeEvent(event);
        if (event.type !== 'device.revoked') {
          return;
        }
        const payload = event.payload as { deviceId?: string } | null;
        const currentDeviceId = this.auth.session()?.device.id;
        if (!payload?.deviceId || payload.deviceId === currentDeviceId) {
          void this.auth.logout(true);
        }
      });

    effect(() => {
      if (this.auth.isAuthenticated()) {
        untracked(() => void this.startAuthenticatedServices());
      } else {
        void this.realtime.disconnect();
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
      } else if (data['conversationId']) {
        void this.router.navigateByUrl(`/app/chats/${data['conversationId']}`);
      }
    });
  }

  private async configureNativeKeyboard(): Promise<void> {
    try {
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
      await Keyboard.setStyle({ style: KeyboardStyle.Dark });
    } catch {
      // Web and desktop do not expose the native keyboard bridge.
    }
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
