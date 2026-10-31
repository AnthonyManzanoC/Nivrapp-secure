import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Location } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { IonContent, IonButton, IonSpinner } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { TranslateService } from '../../core/services/translate.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { NivraApiService } from '../../core/services/nivra-api.service';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, IonContent, IonButton, IonSpinner, TranslatePipe],
  templateUrl: './recovery.page.html',
  styleUrls: ['./recovery.page.scss'],
})
export class RecoveryPage {
  readonly translate = inject(TranslateService);
  t(key: string, fallback: string): string { return this.translate.instant(`AUTH_RECOVERY.${key}`, fallback); }
  title(): string { return this.completed ? this.t('DONE', 'Todo listo') : !this.token ? this.t('TITLE', 'Recupera tu acceso') : this.purpose === 'verify-email' ? this.t('VERIFY', 'Confirma tu correo') : this.t('RESET', 'Elige una nueva contraseña'); }
  private readonly api = inject(NivraApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  token = '';
  purpose = '';
  identifier = '';
  password = '';
  confirmation = '';
  busy = false;
  completed = false;
  notice = '';
  error = '';

  constructor() {
    const fragment = new URLSearchParams(this.route.snapshot.fragment ?? '');
    const token = fragment.get('token') ?? '';
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      this.token = token;
      this.purpose = fragment.get('purpose') === 'verify-email' ? 'verify-email' : 'reset-password';
    }
    // Email scanners opening the page do not consume the token. Keep it out of
    // referrers, subsequent navigation and browser history after initial load.
    if (this.route.snapshot.fragment) this.location.replaceState('/recover');
  }

  async submit(): Promise<void> {
    if (this.busy || this.completed) return;
    this.error = ''; this.notice = '';
    if (this.token && this.purpose !== 'verify-email' && (this.password.length < 10 || this.password !== this.confirmation)) {
      this.error = this.t('PASSWORD_ERROR', 'Usa al menos 10 caracteres y comprueba que ambas contraseñas coincidan.'); return;
    }
    if (!this.token && this.identifier.trim().length < 3) { this.error = this.t('IDENTIFIER_ERROR', 'Ingresa tu ID Nivra o tu alias.'); return; }
    this.busy = true;
    try {
      const response = await firstValueFrom(this.api.post<{ message: string }>(`/auth/recovery/${this.token ? 'complete' : 'request'}`,
        this.token ? { token: this.token, newPassword: this.purpose === 'verify-email' ? null : this.password } : { identifier: this.identifier.trim() }, { skipAuth: true }));
      this.notice = this.token ? this.t('SUCCESS', 'Listo. Ya puedes volver a Nivra.') : this.t('SENT', 'Si la cuenta tiene un correo verificado, recibirá un enlace para continuar.');
      if (this.token) { this.completed = true; this.token = ''; this.password = ''; this.confirmation = ''; }
    } catch (error: any) {
      this.error = error?.status === 429 ? this.t('RATE_LIMIT', 'Has hecho varios intentos. Espera un momento.') : this.token && [400, 404, 410].includes(error?.status) ? this.t('INVALID_LINK', 'El enlace no es válido o venció. Solicita uno nuevo.') : this.t('NETWORK_ERROR', 'No pudimos completar la solicitud. Revisa tu conexión e inténtalo otra vez.');
    } finally { this.busy = false; }
  }

  startAgain(): void { this.token = ''; this.password = ''; this.confirmation = ''; this.error = ''; }
}
