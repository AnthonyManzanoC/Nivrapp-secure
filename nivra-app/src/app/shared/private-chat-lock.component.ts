import { Component, inject, input, OnDestroy, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { lockClosedOutline } from 'ionicons/icons';
import { TranslateService } from '../core/services/translate.service';
import { PrivateChatLockService, type PrivateChatAction } from '../core/services/private-chat-lock.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-private-chat-lock', standalone: true, imports: [FormsModule, TranslatePipe, IonIcon],
  template: `<section class="private-chat-sheet" [attr.aria-label]="title()">
    <span class="private-chat-mark" aria-hidden="true"><ion-icon name="lock-closed-outline" /></span>
    <h2>{{ title() }}</h2>
    <p>{{ action() === 'protect' ? ('PRIVATE_CHAT.PROTECT_COPY' | translate:'Oculta el contenido del chat en este dispositivo. Para volver a abrirlo, verifica tu identidad con Modo Seguro.') : action() === 'remove' ? ('PRIVATE_CHAT.REMOVE_COPY' | translate:'Confirma tu identidad para quitar la protección de esta conversación en este dispositivo.') : ('PRIVATE_CHAT.LOCKED_COPY' | translate:'El contenido permanece oculto hasta que verifiques tu identidad. Usa el PIN de Modo Seguro o la biometría disponible.') }}</p>
    @if (!locks.ready()) {
      <p role="status">{{ 'PRIVATE_CHAT.SETUP_COPY' | translate:'Primero configura el PIN de Modo Seguro en Cuenta. La protección se aplica en esta instalación; no bloquea al contacto.' }}</p>
      <button type="button" class="primary" (click)="locks.configure()">{{ 'PRIVATE_CHAT.SETUP' | translate:'Configurar Modo Seguro en Cuenta' }}</button>
    } @else {
      <form (ngSubmit)="verify(false)">
        <label>{{ 'PRIVATE_CHAT.PIN' | translate:'PIN de Modo Seguro' }}
          <input type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" name="privateChatPin" [ngModel]="pin()" (ngModelChange)="setPin($event)" [disabled]="locks.busy()" />
        </label>
        @if (locks.error()) { <p class="private-chat-error" role="alert">{{ locks.error() }}</p> }
        @if (locks.appLock.pinRetrySeconds()) { <p role="status">{{ 'PRIVATE_CHAT.WAIT' | translate:'Espera antes de volver a intentar.' }} {{ locks.appLock.pinRetrySeconds() }} s</p> }
        <button class="primary" type="submit" [disabled]="pin().length !== 4 || locks.busy() || !!locks.appLock.pinRetrySeconds()">{{ locks.busy() ? ('COMMON.LOADING' | translate:'Cargando') : ('PRIVATE_CHAT.CONFIRM' | translate:'Confirmar con PIN') }}</button>
        @if (locks.appLock.canUseBiometric()) {
          <button type="button" class="secondary" (click)="verify(true)" [disabled]="locks.busy() || !!locks.appLock.pinRetrySeconds()">{{ 'PRIVATE_CHAT.BIOMETRIC' | translate:'Usar verificación del dispositivo' }}</button>
        }
      </form>
    }
    <button type="button" class="cancel" (click)="cancel()">{{ 'COMMON.CANCEL' | translate:'Cancelar' }}</button>
    <small>{{ 'PRIVATE_CHAT.LOCAL_COPY' | translate:'Se vuelve a cerrar al salir del chat, cambiar de cuenta o poner la app en segundo plano. Sus notificaciones no muestran remitente ni contenido.' }}</small>
  </section>`,
  styles: [`:host{display:block;color:var(--nivra-text);background:var(--nivra-panel-solid)}
    .private-chat-sheet{max-width:480px;margin:0 auto;padding:28px 24px;box-sizing:border-box;text-align:center}
    .private-chat-mark{display:grid;place-items:center;width:58px;height:58px;margin:0 auto 18px;border:1px solid var(--nivra-line);border-radius:20px;background:color-mix(in srgb,var(--nivra-brand) 10%,transparent);font-size:27px}
    h2{margin:0 0 12px;font-size:clamp(22px,5vw,28px);line-height:1.2;letter-spacing:-.035em}
    p{color:var(--nivra-muted);font-size:14px;line-height:1.6;margin:10px 0 18px;overflow-wrap:anywhere}
    form{display:grid;gap:12px;margin-top:20px}label{display:grid;gap:9px;text-align:start;font-size:13px;font-weight:600}
    input{box-sizing:border-box;min-height:50px;width:100%;padding:12px;border:1px solid var(--nivra-line);border-radius:14px;background:var(--nivra-input-bg);color:var(--nivra-text);font:inherit;font-size:20px;letter-spacing:.4em;text-align:center}
    button{box-sizing:border-box;min-height:46px;width:100%;padding:12px 15px;border:1px solid var(--nivra-line);border-radius:14px;font:inherit;font-size:14px;font-weight:650;cursor:pointer;color:var(--nivra-text);background:var(--nivra-panel-solid)}
    .primary{background:var(--nivra-brand);color:#062c23;border-color:transparent}.cancel{margin:12px 0;background:transparent;border-color:transparent}
    button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid var(--nivra-brand);outline-offset:3px}
    .private-chat-error{color:var(--ion-color-danger);margin:0}small{display:block;font-size:12px;line-height:1.6;color:var(--nivra-muted)}
    @media(max-width:360px){.private-chat-sheet{padding:22px 16px}}`],
})
export class PrivateChatLockComponent implements OnDestroy {
  readonly locks = inject(PrivateChatLockService);
  private readonly translate = inject(TranslateService);
  readonly conversationId = input.required<string>();
  readonly action = input<PrivateChatAction>('unlock');
  readonly completed = output<void>();
  readonly cancelled = output<void>();
  readonly pin = signal('');
  private completedSuccessfully = false;
  private destroyed = false;
  private verifyEpoch = 0;
  constructor() { addIcons({ lockClosedOutline }); }
  title(): string {
    return this.action() === 'protect' ? this.translate.instant('PRIVATE_CHAT.PROTECT', 'Proteger conversación')
      : this.action() === 'remove' ? this.translate.instant('PRIVATE_CHAT.REMOVE', 'Quitar protección')
      : this.translate.instant('PRIVATE_CHAT.LOCKED', 'Conversación protegida');
  }
  setPin(value: string): void { this.pin.set(String(value ?? '').replace(/[^0-9]/g, '').slice(0, 4)); }
  async verify(biometric: boolean): Promise<void> {
    const epoch = this.verifyEpoch;
    const pin = this.pin(); this.pin.set('');
    const accepted = await this.locks.authenticate(this.conversationId(), this.action(), pin, biometric);
    if (this.destroyed || epoch !== this.verifyEpoch) return;
    if (accepted) {
      this.completedSuccessfully = true;
      this.completed.emit();
    }
  }
  cancel(): void { this.verifyEpoch++; this.pin.set(''); this.locks.relock(); this.cancelled.emit(); }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.verifyEpoch++;
    // Dismissing the sheet while a PIN/biometric prompt is pending must cancel
    // that operation, so a late authentication result cannot unlock the chat.
    // Keep a successful grant alive while the parent closes the modal.
    if (!this.completedSuccessfully) this.locks.relock();
  }
}
