import { Component, EventEmitter, Input, Output, computed, effect, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { IonIcon, IonModal, IonSpinner } from '@ionic/angular/standalone';
import { HistoryDeviceSyncService, PendingHistoryApproval } from '../core/services/history-device-sync.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { addIcons } from 'ionicons';
import { chevronForwardOutline, closeOutline, lockClosedOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-history-sync-notice', standalone: true, imports: [NgTemplateOutlet, IonIcon, IonModal, IonSpinner, TranslatePipe, FormsModule],
  template: `<ng-template #waitingNotice>
    <aside class="history-notice" [class.history-unavailable]="history.state() === 'unavailable'" [class.history-syncing]="history.state() === 'syncing'" role="status" aria-live="polite" aria-atomic="true" [attr.aria-busy]="retryBusy()">
      <span class="history-notice-icon" aria-hidden="true">@if (retryBusy()) {<ion-spinner name="crescent" />} @else {<ion-icon name="lock-closed-outline" />}</span>
      <div class="history-copy">
        <strong>{{ titleKey() | translate:titleFallback() }}</strong>
        <p>{{ descriptionKey() | translate:descriptionFallback() }}</p>
        @if (!identityError && history.state() !== 'syncing' && history.preferredSource(); as source) {
          <p class="history-source-hint">{{ 'HISTORY_DEVICE.SOURCE_SUGGESTION' | translate:'Prueba primero en:' }} {{ source.deviceName }}. {{ 'HISTORY_DEVICE.SOURCE_HINT' | translate:'Si conserva tus chats, compara el código y aprueba allí. También puedes usar otro equipo que aún tenga el historial.' }}</p>
        }
        @if (history.targetFingerprint() && history.state() !== 'syncing' && !identityError) {
          <div class="history-code"><span>{{ 'HISTORY_DEVICE.CODE_LABEL' | translate:'Código de vinculación' }}</span><code dir="ltr">{{ history.targetFingerprint() }}</code></div>
        }
      </div>
      @if (needsRelink) {
        <button class="history-retry" type="button" (click)="relinkRequested.emit()">{{ 'HISTORY_DEVICE.RELINK' | translate:'Volver a vincular' }}</button>
      } @else if (history.state() !== 'syncing') {
        <button class="history-retry" type="button" [disabled]="retryBusy()" (click)="history.retry()">{{ (retryBusy() ? 'HISTORY_DEVICE.CHECKING' : 'COMMON.RETRY') | translate:(retryBusy() ? 'Comprobando…' : 'Reintentar') }}</button>
      }
    </aside>
  </ng-template>
  @if (showWaiting && (history.state() !== 'idle' || identityError)) {
    @if (compact) {
      <button type="button" class="history-compact" (click)="detailsOpen = true" aria-haspopup="dialog" [attr.aria-label]="titleKey() | translate:titleFallback()">
        @if (retryBusy()) { <ion-spinner name="crescent" aria-hidden="true" /> } @else { <ion-icon name="lock-closed-outline" aria-hidden="true" /> }
        <span>{{ titleKey() | translate:titleFallback() }}</span><ion-icon name="chevron-forward-outline" aria-hidden="true" />
      </button>
      <ion-modal class="history-sync-modal" [isOpen]="detailsOpen" (didDismiss)="detailsOpen = false">
        <ng-template><section class="history-sync-details"><header><h2>{{ 'CHATS.SYNC' | translate:'Sincronizar' }}</h2><button type="button" (click)="detailsOpen = false" [attr.aria-label]="'COMMON.CLOSE' | translate:'Cerrar'"><ion-icon name="close-outline" aria-hidden="true" /></button></header><ng-container [ngTemplateOutlet]="waitingNotice" /></section></ng-template>
      </ion-modal>
    } @else { <ng-container [ngTemplateOutlet]="waitingNotice" /> }
  }
  @if (showApprovals) { @for (request of history.pendingRequests().slice(0, approvalLimit); track request.id) {
    <aside class="history-notice history-approval" role="region" [attr.aria-label]="'HISTORY_DEVICE.APPROVE_TITLE' | translate:'Vincular historial cifrado'" [attr.aria-busy]="history.approvingRequestId() === request.id">
      <div class="history-approval-head"><span class="history-notice-icon" aria-hidden="true"><ion-icon name="shield-checkmark-outline" /></span><div><span class="history-eyebrow">{{ 'HISTORY_DEVICE.APPROVAL_TAG' | translate:'Vinculación de dispositivo' }}</span><strong>{{ 'HISTORY_DEVICE.APPROVE_TITLE' | translate:'Vincular historial cifrado' }}</strong><p class="history-device-name">{{ request.targetDeviceName || ('HISTORY_DEVICE.NEW_DEVICE' | translate:'Nuevo dispositivo') }}</p></div></div>
      <div class="history-copy">
        <p>{{ 'HISTORY_DEVICE.COMPARE_HINT' | translate:'Compara este código con el que aparece en tu otro dispositivo. Compártelo sólo si ambos coinciden.' }}</p>
        <div class="history-code"><span>{{ 'HISTORY_DEVICE.CODE_LABEL' | translate:'Código de vinculación' }}</span><code dir="ltr">{{ request.fingerprint }}</code></div>
        <label class="history-comparison"><input type="checkbox" [disabled]="!!history.approvingRequestId()" [ngModel]="compared[request.id] === request.fingerprint" (ngModelChange)="compared[request.id] = $event ? request.fingerprint : ''"><span>{{ 'HISTORY_DEVICE.COMPARED' | translate:'Los códigos coinciden en mis dos dispositivos' }}</span></label>
        <div class="history-approval-actions"><button type="button" class="history-share" [disabled]="compared[request.id] !== request.fingerprint || !!history.approvingRequestId()" (click)="approve(request)">@if (history.approvingRequestId() === request.id) { <ion-spinner name="crescent" aria-hidden="true" /> }{{ (history.approvingRequestId() === request.id ? 'HISTORY_DEVICE.SHARING' : 'HISTORY_DEVICE.SHARE') | translate:(history.approvingRequestId() === request.id ? 'Compartiendo de forma segura…' : 'Compartir mi historial') }}</button><button type="button" [disabled]="!!history.approvingRequestId()" (click)="history.dismissRequest(request.id)">{{ 'COMMON.CANCEL' | translate:'Cancelar' }}</button></div>
        @if (history.approvalError()) {<p class="history-error" role="alert">{{ 'HISTORY_DEVICE.APPROVAL_ERROR' | translate:'No se pudo compartir el historial. Comprueba el código y vuelve a intentar.' }}</p>}
      </div>
    </aside>
  } }`,
  styleUrls: ['./history-sync-notice.component.scss'],
})
export class HistorySyncNoticeComponent {
  readonly history = inject(HistoryDeviceSyncService);
  readonly compared: Record<string, string> = {};
  readonly retryBusy = computed(() => this.history.checking() || this.history.state() === 'syncing');
  @Input() showWaiting = true;
  @Input() showApprovals = true;
  @Input() approvalLimit = 32;
  @Input() compact = false;
  @Input() identityError = false;
  @Input() needsRelink = false;
  @Output() readonly relinkRequested = new EventEmitter<void>();
  detailsOpen = false;
  constructor() {
    addIcons({ chevronForwardOutline, closeOutline, lockClosedOutline, shieldCheckmarkOutline });
    effect(() => { this.history.approvalEpoch(); this.detailsOpen = false; for (const id of Object.keys(this.compared)) delete this.compared[id]; });
  }
  titleKey(): string {
    if (this.needsRelink) return 'HISTORY_DEVICE.RELINK_REQUIRED';
    if (this.identityError) return 'CHATS.HISTORY_UNAVAILABLE';
    return this.history.state() === 'syncing' ? 'HISTORY_DEVICE.SYNCING'
      : this.history.state() === 'unavailable' ? 'HISTORY_DEVICE.UNAVAILABLE_TITLE' : 'HISTORY_DEVICE.PENDING';
  }
  titleFallback(): string {
    if (this.needsRelink) return 'Vuelve a vincular este equipo';
    if (this.identityError) return 'Historial temporalmente no disponible';
    return this.history.state() === 'syncing' ? 'Sincronizando tu historial'
      : this.history.state() === 'unavailable' ? 'El historial sigue pendiente' : 'Historial cifrado pendiente';
  }
  descriptionKey(): string {
    if (this.identityError) return this.needsRelink ? 'HISTORY_DEVICE.RELINK_COPY' : 'HISTORY_DEVICE.IDENTITY_ERROR_COPY';
    return this.history.state() === 'syncing' ? 'HISTORY_DEVICE.SYNCING_COPY'
      : this.history.state() === 'unavailable' ? 'HISTORY_DEVICE.UNAVAILABLE_COPY' : 'HISTORY_DEVICE.WAITING_COPY';
  }
  descriptionFallback(): string {
    if (this.identityError) return this.needsRelink
      ? 'Vuelve a vincular este equipo desde tu teléfono para recuperar los chats. El historial guardado se conserva.'
      : 'No se pudo abrir la identidad de este equipo. Comprueba la conexión, desbloquea el dispositivo y vuelve a intentar.';
    return this.history.state() === 'syncing' ? 'Estamos comprobando las llaves y preparando tus mensajes disponibles.'
      : this.history.state() === 'unavailable' ? 'No pudimos completar la recuperación. Revisa la conexión y autoriza el código desde tu otro dispositivo.'
        : 'Abre Nivra en un equipo que conserve tus chats y autoriza este código para recuperar tu historial.';
  }
  approve(request: PendingHistoryApproval): void {
    const current = this.history.pendingRequests().find(candidate => candidate.id === request.id);
    if (this.history.approvingRequestId() || !current || current.fingerprint !== request.fingerprint
      || this.compared[request.id] !== current.fingerprint) return;
    void this.history.approveRequest(request.id);
  }
}
