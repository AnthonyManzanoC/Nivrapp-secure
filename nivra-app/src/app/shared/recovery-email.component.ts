import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { NivraApiService } from '../core/services/nivra-api.service';

@Component({
  selector: 'app-recovery-email', standalone: true, imports: [FormsModule],
  template: `<section class="recovery-email"><h3>Correo de recuperación</h3>
    <p>Un correo opcional para restablecer tu contraseña. No aparece en búsquedas ni en tu perfil público.</p>
    @if (verifiedEmail) { <p class="verified">✓ Verificado: {{ verifiedEmail }}</p> }
    @else if (loaded) { <p class="recovery-warning" role="status" style="padding:14px;border:1px solid #d9a32666;border-radius:12px;background:#d9a32616"><span aria-hidden="true" style="color:#ef675d">●</span> Añade un correo de recuperación. Si olvidas tu contraseña y pierdes todas tus sesiones, no podrás recuperar el acceso a tu cuenta.</p> }
    <form (ngSubmit)="send()">
      <label>Correo de recuperación<input type="email" name="recoveryEmail" [(ngModel)]="email" autocomplete="email" maxlength="320" required></label>
      <label>Contraseña actual<input type="password" name="recoveryPassword" [(ngModel)]="password" autocomplete="current-password" maxlength="1024" required></label>
      <button type="submit" [disabled]="busy || !email || !password">{{ busy ? 'Enviando…' : 'Verificar correo' }}</button>
    </form>
    @if (notice) { <p role="status">{{ notice }}</p> } @if (error) { <p class="error" role="alert">{{ error }}</p> }
    <small>La confirmación llega por correo y vence en 15 minutos. Configúralo antes de olvidar tu contraseña.</small>
  </section>`,
  styles: [`:host{display:block}.recovery-email{border:1px solid var(--nivra-line);border-radius:18px;padding:20px;margin:18px 0}h3{margin:0 0 8px}p,small{color:var(--nivra-muted);font-size:12px;line-height:1.6}form{display:grid;gap:12px}label{display:grid;gap:6px;font-size:12px}input{width:100%;border:1px solid var(--nivra-line);border-radius:10px;padding:12px;background:var(--nivra-bg);color:var(--nivra-text)}button{padding:12px;border:0;border-radius:10px;background:#25c58b;color:#062d20;font-weight:700}button:disabled{opacity:.5}.verified{color:#159b66}.error{color:var(--ion-color-danger)}small{display:block;margin-top:12px}`],
})
export class RecoveryEmailComponent implements OnInit {
  private readonly api = inject(NivraApiService);
  email = ''; password = ''; verifiedEmail = ''; busy = false; notice = ''; error = ''; loaded = false;
  async ngOnInit(): Promise<void> {
    try { const state = await firstValueFrom(this.api.get<{ email: string | null; verified: boolean }>('/auth/recovery/email')); this.verifiedEmail = state.verified ? state.email ?? '' : ''; this.loaded = true; }
    catch { /* The form can retry during a rolling backend deployment. */ }
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
}
