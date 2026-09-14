import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Location } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { IonContent, IonButton, IonInput, IonSpinner } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { NivraApiService } from '../../core/services/nivra-api.service';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, IonContent, IonButton, IonInput, IonSpinner],
  template: `
    <ion-content fullscreen><main class="recovery-surface"><section class="recovery-card">
      <a routerLink="/auth" class="brand">NIVRA <span>Tu espacio privado</span></a>
      <div class="recovery-symbol" aria-hidden="true">✦</div>
      <p class="eyebrow">SEGURIDAD DE TU CUENTA</p>
      <h1>{{ completed ? 'Todo listo' : token ? (purpose === 'verify-email' ? 'Confirma tu correo' : 'Elige una nueva contraseña') : 'Recupera tu acceso' }}</h1>
      @if (!completed) {
        <p class="copy">{{ token ? (purpose === 'verify-email' ? 'Confirma este correo para poder recuperar el acceso a tu cuenta cuando lo necesites.' : 'Tu nueva contraseña cerrará las sesiones anteriores. Tus claves privadas se conservan en los dispositivos donde ya estaban.') : 'Ingresa tu ID Nivra o alias. Te enviaremos un enlace al correo de recuperación que verificaste en Cuenta.' }}</p>
        <form (ngSubmit)="submit()">
          @if (!token) {
            <label>ID Nivra o @alias<ion-input name="identifier" [(ngModel)]="identifier" fill="outline" autocomplete="username" autocapitalize="off" maxlength="40" required></ion-input></label>
          } @else if (purpose !== 'verify-email') {
            <label>Nueva contraseña<ion-input name="newPassword" [(ngModel)]="password" fill="outline" type="password" autocomplete="new-password" minlength="10" maxlength="1024" required></ion-input></label>
            <label>Repite la contraseña<ion-input name="confirmPassword" [(ngModel)]="confirmation" fill="outline" type="password" autocomplete="new-password" required></ion-input></label>
            <small>Al menos 10 caracteres. Puedes pegar una contraseña de tu gestor.</small>
          }
          <ion-button expand="block" type="submit" [disabled]="busy">@if (busy) { <ion-spinner name="crescent"></ion-spinner> } {{ token ? (purpose === 'verify-email' ? 'Confirmar mi correo' : 'Guardar contraseña') : 'Enviar enlace seguro' }}</ion-button>
        </form>
      }
      @if (notice) { <p class="notice" role="status">{{ notice }}</p> }
      @if (error) { <p class="error" role="alert">{{ error }}</p> }
      @if (token && error) { <button class="text-link" type="button" (click)="startAgain()">Solicitar otro enlace</button> }
      <a class="back-link" routerLink="/auth">Volver a Nivra</a>
      @if (!completed && !token) {
        <details><summary>No configuré un correo de recuperación</summary><p class="copy">Sin un correo de recuperación previamente verificado, no es posible restablecer tu contraseña por correo. Por seguridad, no podemos sustituirlo desde esta pantalla. Si conservas una sesión abierta, entra a Cuenta para revisar tus opciones.</p></details>
      }
      <p class="privacy-note">El correo recupera tu acceso, no las claves de conversaciones que ya no estén en tus dispositivos. Sin un correo previamente verificado, usa una sesión abierta para configurarlo.</p>
    </section></main></ion-content>`,
  styleUrls: ['./recovery.page.scss'],
})
export class RecoveryPage {
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
    if (this.busy) return;
    this.error = ''; this.notice = '';
    if (this.token && this.purpose !== 'verify-email' && (this.password.length < 10 || this.password !== this.confirmation)) {
      this.error = 'Usa al menos 10 caracteres y comprueba que ambas contraseñas coincidan.'; return;
    }
    if (!this.token && this.identifier.trim().length < 3) { this.error = 'Ingresa tu ID Nivra o tu alias.'; return; }
    this.busy = true;
    try {
      const response = await firstValueFrom(this.api.post<{ message: string }>(`/auth/recovery/${this.token ? 'complete' : 'request'}`,
        this.token ? { token: this.token, newPassword: this.purpose === 'verify-email' ? null : this.password } : { identifier: this.identifier.trim() }, { skipAuth: true }));
      this.notice = response.message;
      if (this.token) { this.completed = true; this.token = ''; this.password = ''; this.confirmation = ''; }
    } catch (error: any) {
      this.error = error?.error?.message || (error?.status === 429 ? 'Has hecho varios intentos. Espera un momento.' : 'No pudimos conectar. Revisa tu conexión e inténtalo otra vez.');
    } finally { this.busy = false; }
  }

  startAgain(): void { this.token = ''; this.password = ''; this.confirmation = ''; this.error = ''; }
}
