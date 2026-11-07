import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { PushService } from '../../core/services/push.service';
import { AuthService } from '../../core/services/auth.service';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

@Component({ selector: 'app-notification-check', standalone: true, imports: [RouterLink, TranslatePipe],
  templateUrl: './notification-check.component.html', styleUrl: './notification-check.component.scss' })
export class NotificationCheckComponent {
  readonly push = inject(PushService);
  private readonly auth = inject(AuthService);
  private readonly native = inject(NativeDeviceService);
  private readonly destroy = inject(DestroyRef);
  readonly android = Capacitor.getPlatform() === 'android';
  readonly desktop = typeof window !== 'undefined' && 'nivraSecureVault' in window;
  readonly busy = signal(false);
  readonly checked = signal(false);
  readonly reachable = signal(false);
  readonly registered = signal<boolean | null>(null);
  readonly notice = signal('');
  private generation = 0;
  permissionLabel(): string {
    return { granted: 'Permitido', denied: 'Bloqueado en el sistema', default: 'Pendiente de autorización', unsupported: 'No disponible en este entorno' }[this.push.permission()];
  }
  constructor() {
    effect(() => {
      this.auth.session()?.user.id; this.auth.session()?.device.id;
      ++this.generation;
      untracked(() => {
        this.checked.set(false); this.reachable.set(false); this.registered.set(null); this.busy.set(false); this.notice.set('');
        void this.check();
      });
    });
  }
  async check(register = false): Promise<void> {
    if (this.busy()) return;
    const generation = ++this.generation;
    this.busy.set(true); this.checked.set(false); this.registered.set(null); this.notice.set('');
    try {
      if (register) await this.push.requestPermissionAndRegister();
      if (generation !== this.generation || this.destroy.destroyed) return;
      const reachable = await this.push.refreshStatus();
      if (generation !== this.generation || this.destroy.destroyed) return;
      this.reachable.set(reachable);
      this.registered.set(reachable ? this.push.registeredOnServer() : null);
      this.checked.set(true);
    } catch {
      if (generation === this.generation && !this.destroy.destroyed) { this.checked.set(true); this.reachable.set(false); }
    } finally { if (generation === this.generation && !this.destroy.destroyed) this.busy.set(false); }
  }
  async settings(section: 'app' | 'calls' | 'full-screen' = 'app'): Promise<void> {
    try { await this.native.openNotificationSettings(section); }
    catch { if (!this.destroy.destroyed) this.notice.set('NOTIFY.SETTINGS_ERROR'); }
  }
}
