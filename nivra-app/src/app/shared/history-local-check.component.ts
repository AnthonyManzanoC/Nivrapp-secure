import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { IonIcon, IonModal, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chevronForwardOutline, closeOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-history-local-check', standalone: true,
  imports: [NgTemplateOutlet, IonIcon, IonModal, IonSpinner, TranslatePipe],
  template: `<ng-template #notice>
    <section class="local-check" role="status" aria-live="polite" [attr.aria-busy]="state === 'checking'">
      <span class="check-icon" aria-hidden="true">@if (state === 'checking') { <ion-spinner name="crescent" /> } @else { <ion-icon name="shield-checkmark-outline" /> }</span>
      <div class="check-copy">
        <small>{{ 'HISTORY_LOCAL.DEVICE' | translate:'En este dispositivo' }}</small>
        <h3>{{ titleKey() | translate:title() }}</h3>
        <p>{{ descriptionKey() | translate:description() }}</p>
      </div>
      @if (state !== 'checking') { <button class="check-action" type="button" (click)="retry.emit()">{{ 'HISTORY_LOCAL.RETRY' | translate:'Comprobar ahora' }}</button> }
    </section>
  </ng-template>
  @if (state !== 'idle') {
    @if (compact) {
      <button type="button" class="compact-check" (click)="open = true" aria-haspopup="dialog">
        <ion-icon name="shield-checkmark-outline" aria-hidden="true" /><span>{{ titleKey() | translate:title() }}</span><ion-icon name="chevron-forward-outline" aria-hidden="true" />
      </button>
      <ion-modal [isOpen]="open" (didDismiss)="open = false">
        <ng-template><div class="check-dialog"><header><h2>{{ 'CHATS.SYNC' | translate:'Sincronizar' }}</h2><button type="button" (click)="open = false" [attr.aria-label]="'COMMON.CLOSE' | translate:'Cerrar'"><ion-icon name="close-outline" /></button></header><ng-container [ngTemplateOutlet]="notice" /></div></ng-template>
      </ion-modal>
    } @else { <ng-container [ngTemplateOutlet]="notice" /> }
  }
  `,
  styleUrl: './history-local-check.component.scss',
})
export class HistoryLocalCheckComponent implements OnChanges {
  @Input() state: 'idle' | 'checking' | 'retryable' | 'unavailable' = 'idle';
  @Input() compact = false;
  @Output() retry = new EventEmitter<void>();
  open = false;
  constructor() { addIcons({ chevronForwardOutline, closeOutline, shieldCheckmarkOutline }); }
  ngOnChanges(): void { if (this.state === 'idle') this.open = false; }
  titleKey(): string { return this.state === 'checking' ? 'HISTORY_LOCAL.CHECKING' : 'HISTORY_LOCAL.PENDING'; }
  title(): string { return this.state === 'checking' ? 'Revisando tus mensajes guardados' : 'Quedan mensajes por comprobar'; }
  descriptionKey(): string { return this.state === 'checking' ? 'HISTORY_LOCAL.CHECKING_COPY' : this.state === 'retryable' ? 'HISTORY_LOCAL.RETRY_COPY' : 'HISTORY_LOCAL.UNAVAILABLE_COPY'; }
  description(): string {
    return this.state === 'checking' ? 'Buscamos las copias disponibles y probamos las llaves guardadas aquí. Esta comprobación no requiere otro dispositivo.'
      : this.state === 'retryable' ? 'La comprobación no terminó. Al recuperar la conexión volveremos a intentarlo. Tu historial se conserva.'
        : 'Algunas copias antiguas aún no están disponibles. Puedes comprobarlas de nuevo. Esto no impide que sigas usando tus chats.';
  }
}
