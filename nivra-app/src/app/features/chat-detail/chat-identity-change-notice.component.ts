import { Component, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chevronForwardOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

@Component({
  selector: 'app-chat-identity-change-notice',
  standalone: true,
  imports: [IonIcon, TranslatePipe],
  template: `
    <section class="identity-change-notice" role="alert" aria-live="polite">
      <span class="identity-change-mark" aria-hidden="true"><ion-icon name="shield-checkmark-outline"></ion-icon></span>
      <div class="identity-change-copy">
        <strong>{{ 'CHAT.IDENTITY_CHANGED_TITLE' | translate:'El código de seguridad cambió' }}</strong>
        <p>{{ 'CHAT.IDENTITY_CHANGED_COPY' | translate:'Puede ocurrir al vincular otro dispositivo o reinstalar. Compara el código con tu contacto para continuar.' }}</p>
      </div>
      <button type="button" class="identity-verify-action" (click)="verify.emit()" [disabled]="disabled()">
        {{ 'CHAT.IDENTITY_VERIFY_ACTION' | translate:'Verificar identidad' }}
        <ion-icon name="chevron-forward-outline" aria-hidden="true"></ion-icon>
      </button>
    </section>`,
  styles: [`
    :host { display: block; }
    .identity-change-notice { margin: 8px 10px; padding: 12px; display: grid; grid-template-columns: 28px minmax(0,1fr) auto; gap: 10px; align-items: center; border: 1px solid rgba(213,174,81,.28); border-radius: 16px; color: var(--nivra-text); background: rgba(213,174,81,.07); }
    .identity-change-mark { align-self: start; width: 28px; height: 30px; display: grid; place-items: center; color: #cda653; }
    .identity-change-mark ion-icon { font-size: 24px; }
    .identity-change-copy { min-width: 0; }
    .identity-change-copy strong { display: block; font-size: 13px; font-weight: 650; line-height: 1.4; }
    .identity-change-copy p { margin: 4px 0 0; color: var(--nivra-muted); font-size: 12px; line-height: 1.45; }
    .identity-change-notice .identity-verify-action { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 11px; border: 1px solid rgba(var(--ion-color-primary-rgb),.2); border-radius: 11px; color: var(--nivra-brand-2); background: rgba(var(--ion-color-primary-rgb),.1) !important; font: inherit; font-size: 12px; font-weight: 650; white-space: nowrap; cursor: pointer; box-shadow: none; }
    .identity-verify-action ion-icon { width: 15px; height: 15px; flex: 0 0 auto; }
    .identity-verify-action:disabled { opacity: .55; cursor: default; }
    .identity-verify-action:focus-visible { outline: 2px solid var(--nivra-brand-2); outline-offset: 3px; }
    :host-context(.nivra-light-theme) .identity-change-notice { background: #fff8e8; border-color: #ead5a9; }
    :host-context(.nivra-light-theme) .identity-change-mark { color: #947135; }
    @media (max-width: 500px) { .identity-change-notice { grid-template-columns: 28px minmax(0,1fr); gap: 6px 9px; padding: 10px; } .identity-verify-action { grid-column: 2; justify-self: start; margin-top: 3px; } }
  `],
})
export class ChatIdentityChangeNoticeComponent {
  readonly disabled = input(false);
  readonly verify = output<void>();
  constructor() { addIcons({ chevronForwardOutline, shieldCheckmarkOutline }); }
}
