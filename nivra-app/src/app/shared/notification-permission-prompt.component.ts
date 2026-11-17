import { AfterViewInit, Component, DestroyRef, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { notificationsOutline } from 'ionicons/icons';
import { AuthService } from '../core/services/auth.service';
import { AppLockService } from '../core/services/app-lock.service';
import { CallsService } from '../core/services/calls.service';
import { NativeDeviceService } from '../core/services/native-device.service';
import { NotificationPermissionPromptService } from '../core/services/notification-permission-prompt.service';
import { PushService } from '../core/services/push.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-notification-permission-prompt', standalone: true, imports: [IonIcon, TranslatePipe],
  template: `@if (visible()) {
    <aside aria-label="Notificaciones" class="notification-reminder">
      <ion-icon name="notifications-outline" aria-hidden="true" />
      <div class="reminder-copy"><strong>{{ 'NOTIFY.CHATS_REMINDER_TITLE' | translate:'No te pierdas tus mensajes' }}</strong>
        <p>{{ 'NOTIFY.CHATS_REMINDER_COPY' | translate:'Activa las notificaciones para recibir avisos cuando no estés en Nivra.' }}</p>
        @if (notice()) { <p role="status">{{ notice() | translate:'No pudimos abrir los avisos. Puedes revisarlos desde Cuenta → Notificaciones.' }}</p> }
        <div class="reminder-actions">
          <button type="button" class="activate" [disabled]="busy()" (click)="activate()">{{ (needsSettings() ? 'NOTIFY.OPEN_SETTINGS' : 'NOTIFY.CHATS_ENABLE') | translate:(needsSettings() ? 'Abrir ajustes' : 'Activar') }}</button>
          <button type="button" [disabled]="busy()" (click)="dismiss()">{{ 'NOTIFY.NOT_NOW' | translate:'Ahora no' }}</button>
        </div>
      </div>
    </aside>
  }`,
  styles: [`:host{display:block}.notification-reminder{display:flex;align-items:flex-start;gap:11px;margin:0 16px 12px;padding:14px;border:1px solid var(--nivra-line);border-radius:16px;color:var(--nivra-text);background:color-mix(in srgb,var(--nivra-brand) 7%,var(--nivra-panel-solid))}ion-icon{flex:none;font-size:23px;color:var(--nivra-brand-2);margin-top:2px}.reminder-copy{min-width:0}strong{font-size:13px}p{margin:5px 0 0;color:var(--nivra-muted);font-size:12px;line-height:1.5}.reminder-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}button{min-height:38px;padding:7px 12px;border:0;border-radius:10px;font:inherit;font-size:12px;font-weight:650;cursor:pointer;color:var(--nivra-muted);background:transparent}button.activate{color:var(--nivra-on-brand);background:var(--nivra-brand)}button:disabled{opacity:.6;cursor:wait}button:focus-visible{outline:2px solid var(--nivra-brand-2);outline-offset:3px}`],
})
export class NotificationPermissionPromptComponent implements AfterViewInit {
  readonly push = inject(PushService);
  private readonly auth = inject(AuthService);
  private readonly lock = inject(AppLockService);
  private readonly calls = inject(CallsService);
  private readonly native = inject(NativeDeviceService);
  private readonly policy = inject(NotificationPermissionPromptService);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  readonly android = Capacitor.getPlatform() === 'android';
  readonly busy = signal(false);
  readonly notice = signal('');
  private timer: number | null = null;

  constructor() {
    addIcons({ notificationsOutline });
    const resume = () => this.scheduleCheck();
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    const navigation = this.router.events.subscribe(event => { if (event instanceof NavigationEnd) this.scheduleCheck(); });
    this.destroy.onDestroy(() => {
      if (this.timer !== null) window.clearTimeout(this.timer);
      window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); navigation.unsubscribe();
    });
  }
  ngAfterViewInit(): void { this.scheduleCheck(); }
  visible(): boolean {
    return this.android && this.policy.showReminder() && (this.push.permission() !== 'granted' || Boolean(this.push.settingsBlocked?.()))
      && this.push.permission() !== 'unsupported';
  }
  needsSettings(): boolean { return this.push.permission() === 'denied' || Boolean(this.push.settingsBlocked?.()); }
  dismiss(): void { this.policy.remindTomorrow(); }

  async activate(): Promise<void> {
    if (this.busy() || !this.canPrompt()) return;
    this.busy.set(true); this.notice.set('');
    try {
      if (this.needsSettings()) await this.native.openNotificationSettings('app');
      else {
        this.policy.markAttempted();
        await this.push.requestPermissionAndRegister();
      }
    } catch { this.notice.set('NOTIFY.CHATS_SETTINGS_ERROR'); }
    finally { if (!this.destroy.destroyed) this.busy.set(false); }
  }

  private scheduleCheck(): void {
    if (!this.android || this.destroy.destroyed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.checkAutomaticPrompt(); }, 1200);
  }
  private canPrompt(): boolean {
    const session = this.auth.session();
    return Boolean(session?.user.id && session?.device?.id) && !this.destroy.destroyed && document.visibilityState !== 'hidden'
      && this.router.url.split(/[?#]/, 1)[0] === '/app/chats' && !this.lock.isContentLocked()
      && !this.calls.activeCall() && !this.calls.resumableCall();
  }
  private async checkAutomaticPrompt(): Promise<void> {
    if (!this.canPrompt() || this.busy()) return;
    const scope = this.auth.session();
    try {
      await this.push.refreshPermission();
      if (!this.canPrompt() || this.auth.session() !== scope || this.push.permission() !== 'default'
        || document.querySelector('.daily-launch, ion-modal.modal-show, ion-alert:not(.overlay-hidden)')
        || !this.policy.claimAutomaticPrompt()) return;
      this.busy.set(true);
      await this.push.requestPermissionAndRegister();
    } catch { /* Keep the quiet manual action available; do not loop system prompts. */ }
    finally { if (!this.destroy.destroyed) this.busy.set(false); }
  }
}
