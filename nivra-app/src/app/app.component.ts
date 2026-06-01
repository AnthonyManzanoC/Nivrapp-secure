import { Component, DestroyRef, effect, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Keyboard, KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';
import { Router } from '@angular/router';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { AuthService } from './core/services/auth.service';
import { PushService } from './core/services/push.service';
import { SignalrService } from './core/services/signalr.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: true,
  imports: [IonApp, IonRouterOutlet],
})
export class AppComponent {
  private readonly auth = inject(AuthService);
  private readonly push = inject(PushService);
  private readonly router = inject(Router);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private lastPushRouteKey = '';

  constructor() {
    void this.configureNativeKeyboard();

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
        void this.realtime.connect();
        void this.push.initialize();
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
}
