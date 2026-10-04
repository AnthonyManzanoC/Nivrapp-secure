import { Component, EventEmitter, OnInit, OnDestroy, NgZone, Output, inject } from '@angular/core';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { NivraApiService } from '../core/services/nivra-api.service';

export interface RecoveryEmailState {
  email: string | null;
  verified: boolean;
}

@Component({
  selector: 'app-recovery-email', standalone: true, imports: [FormsModule, TranslatePipe],
  template: `<section class="recovery-email"><h3>{{ 'RECOVERY.TITLE' | translate:'Correo de recuperación' }}</h3>
    <p>{{ 'RECOVERY.COPY' | translate:'Un correo opcional para restablecer tu contraseña. No aparece en búsquedas ni en tu perfil público.' }}</p>
    @if (verifiedEmail && !editing) {
      <p class="verified">✓ {{ 'RECOVERY.VERIFIED' | translate:'Verificado' }}: {{ verifiedEmail }}</p>
      <button class="change-email" type="button" (click)="beginChange()">{{ 'RECOVERY.CHANGE' | translate:'Cambiar correo' }}</button>
    }
    @else if (loaded) { <p class="recovery-warning" role="status" style="padding:14px;border:1px solid #d9a32666;border-radius:12px;background:#d9a32616"><span aria-hidden="true" style="color:#ef675d">●</span> {{ 'RECOVERY.WARNING' | translate:'Añade un correo de recuperación. Si olvidas tu contraseña y pierdes todas tus sesiones, no podrás recuperar el acceso a tu cuenta.' }}</p> }
    @if (!verifiedEmail || editing) { <form (ngSubmit)="send()">
      <label>{{ 'RECOVERY.TITLE' | translate:'Correo de recuperación' }}<input type="email" name="recoveryEmail" [(ngModel)]="email" autocomplete="email" maxlength="320" required></label>
      <label>{{ 'RECOVERY.PASSWORD' | translate:'Contraseña actual' }}<input type="password" name="recoveryPassword" [(ngModel)]="password" autocomplete="current-password" maxlength="1024" required></label>
      <button type="submit" [disabled]="busy || !email || !password">{{ busy ? ('RECOVERY.SENDING' | translate:'Enviando…') : ('RECOVERY.VERIFY' | translate:'Verificar correo') }}</button>
    </form> }
    @if (notice) { <p role="status">{{ notice }}</p> } @if (error) { <p class="error" role="alert">{{ error }}</p> }
    <small>{{ 'RECOVERY.EXPIRY' | translate:'La confirmación llega por correo y vence en 15 minutos. Configúralo antes de olvidar tu contraseña.' }}</small>
  </section>`,
  styles: [`:host{display:block}.recovery-email{border:1px solid var(--nivra-line);border-radius:18px;padding:20px;margin:18px 0}h3{margin:0 0 8px}p,small{color:var(--nivra-muted);font-size:12px;line-height:1.6}form{display:grid;gap:12px}label{display:grid;gap:6px;font-size:12px}input{width:100%;border:1px solid var(--nivra-line);border-radius:10px;padding:12px;background:var(--nivra-bg);color:var(--nivra-text)}button{padding:12px;border:0;border-radius:10px;background:#25c58b;color:#062d20;font-weight:700}button:disabled{opacity:.5}.change-email{margin:0 0 12px;padding:0;background:transparent;color:var(--nivra-brand);text-align:left}.verified{color:#159b66}.error{color:var(--ion-color-danger)}small{display:block;margin-top:12px}`],
})
export class RecoveryEmailComponent implements OnInit, OnDestroy {
  private readonly zone = inject(NgZone);
  private listener?: PluginListenerHandle;
  private destroyed = false;
  private refreshing = false;
  private readonly onFocus = () => { void this.refresh(); };
  private readonly onVisible = () => { if (!document.hidden) void this.refresh(); };
  private readonly api = inject(NivraApiService);
  @Output() readonly stateChange = new EventEmitter<RecoveryEmailState>();
  email = ''; password = ''; verifiedEmail = ''; busy = false; notice = ''; error = ''; loaded = false;
  editing = false;
  async ngOnInit(): Promise<void> {
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onVisible);
    void App.addListener('appStateChange', state => { if (state.isActive) void this.refresh(); })
      .then(handle => { if (this.destroyed) void handle.remove(); else this.listener = handle; }).catch(() => undefined);
    await this.refresh();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onVisible);
    void this.listener?.remove();
  }

  async refresh(): Promise<void> {
    if (this.refreshing || this.destroyed) return;
    this.refreshing = true;
    try {
      const state = await firstValueFrom(this.api.get<RecoveryEmailState>('/auth/recovery/email'));
      if (this.destroyed) return;
      this.zone.run(() => {
        const verified = state.verified ? state.email ?? '' : '';
        if (verified && verified !== this.verifiedEmail) {
          this.editing = false; this.password = ''; this.notice = ''; this.error = '';
        }
        this.verifiedEmail = verified;
        this.loaded = true;
        this.publishState();
      });
    } catch { /* Keep the last confirmed state when offline. */ }
    finally { this.refreshing = false; }
  }

  beginChange(): void {
    this.editing = true;
    this.email = '';
    this.password = '';
    this.notice = '';
    this.error = '';
  }

  async send(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.notice = '';
    try {
      const response = await firstValueFrom(this.api.post<{ message: string }>('/auth/recovery/email/request', { email: this.email.trim(), password: this.password }));
      this.notice = response.message; this.password = '';
    } catch (error: any) { this.error = error?.error?.message || 'No se pudo enviar la verificación. Inténtalo otra vez.'; }
    finally { this.busy = false; }
  }

  private publishState(): void {
    this.stateChange.emit({ email: this.verifiedEmail || null, verified: Boolean(this.verifiedEmail) });
  }
}
