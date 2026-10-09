import { Component, Input, effect, inject } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { HistoryDeviceSyncService } from '../core/services/history-device-sync.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { addIcons } from 'ionicons';
import { lockClosedOutline } from 'ionicons/icons';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-history-sync-notice', standalone: true, imports: [IonIcon, IonSpinner, TranslatePipe, FormsModule],
  template: `@if (showWaiting && history.state() !== 'idle') {
    <aside class="history-notice" role="status" aria-live="polite">
      <span class="history-notice-icon">@if (history.state() === 'syncing') {<ion-spinner name="crescent" />} @else {<ion-icon name="lock-closed-outline" />}</span>
      <div><strong>{{ (history.state() === 'syncing' ? 'HISTORY_DEVICE.SYNCING' : 'HISTORY_DEVICE.PENDING') | translate:(history.state() === 'syncing' ? 'Sincronizando tu historial' : 'Historial cifrado pendiente') }}</strong>
      <p>{{ 'HISTORY_DEVICE.HINT' | translate:'Abre la versión actual de Nivra en un dispositivo donde ya veas tus chats y autoriza este código. Después tu historial se sincronizará cifrado.' }}</p>
      @if (history.targetFingerprint()) {<code dir="ltr">{{ history.targetFingerprint() }}</code>}</div>
      <button type="button" (click)="history.retry()">{{ 'COMMON.RETRY' | translate:'Reintentar' }}</button>
    </aside>
  }
  @if (showApprovals) { @for (request of history.pendingRequests().slice(0, approvalLimit); track request.id) {
    <aside class="history-notice history-approval" role="region" [attr.aria-label]="'HISTORY_DEVICE.APPROVE_TITLE' | translate:'Vincular historial cifrado'">
      <div><strong>{{ 'HISTORY_DEVICE.APPROVE_TITLE' | translate:'Vincular historial cifrado' }}</strong><p>{{ request.targetDeviceName || ('HISTORY_DEVICE.NEW_DEVICE' | translate:'Nuevo dispositivo') }}</p>
        <p>{{ 'HISTORY_DEVICE.COMPARE_HINT' | translate:'Compara este código con el que aparece en tu otro dispositivo. Compártelo sólo si ambos coinciden.' }}</p><code dir="ltr">{{ request.fingerprint }}</code>
        <label><input type="checkbox" [ngModel]="compared[request.id] === request.fingerprint" (ngModelChange)="compared[request.id] = $event ? request.fingerprint : ''"><span>{{ 'HISTORY_DEVICE.COMPARED' | translate:'Los códigos coinciden en mis dos dispositivos' }}</span></label>
        <div class="history-approval-actions"><button type="button" class="history-share" [disabled]="compared[request.id] !== request.fingerprint || !!history.approvingRequestId()" (click)="history.approveRequest(request.id)">{{ 'HISTORY_DEVICE.SHARE' | translate:'Compartir mi historial' }}</button><button type="button" (click)="history.dismissRequest(request.id)">{{ 'COMMON.CANCEL' | translate:'Cancelar' }}</button></div>
        @if (history.approvalError()) {<p role="alert">{{ 'HISTORY_DEVICE.ERROR' | translate:'No se pudo compartir el historial. Comprueba el código y vuelve a intentar.' }}</p>}
      </div>
    </aside>
  } }`,
  styles: [`.history-notice{display:flex;align-items:center;gap:10px;margin:10px 12px;padding:12px;border:1px solid rgba(45,151,130,.2);border-radius:16px;background:var(--ion-background-color,#fff);color:var(--ion-text-color,#183e39);box-shadow:0 3px 12px rgba(13,49,40,.035)}.history-notice-icon{display:grid;place-items:center;flex:0 0 32px;color:var(--ion-color-primary,#00856c)}ion-icon,ion-spinner{width:22px;height:22px}.history-notice div{min-width:0;flex:1}strong{font-size:13px;font-weight:650}p{font-size:12px;line-height:1.5;margin:4px 0 0;opacity:.75}.history-notice button{align-self:center;flex:0 0 auto;border:0;background:transparent;color:var(--ion-color-primary,#00856c);font:inherit;font-size:12px;padding:9px;border-radius:10px;cursor:pointer}code{display:block;margin-top:8px;font-size:12px;line-height:1.8;letter-spacing:.045em;font-weight:650;overflow-wrap:anywhere}.history-approval label{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5;margin-top:10px}.history-approval label input{margin-top:3px;accent-color:var(--ion-color-primary,#00856c)}.history-approval-actions{display:flex;gap:8px;margin-top:10px}.history-notice .history-share{background:var(--ion-color-primary,#00856c);color:var(--ion-color-primary-contrast,#fff);padding:10px}.history-share:disabled{opacity:.45;cursor:default}@media(max-width:420px){.history-notice{flex-wrap:wrap}.history-notice>button{margin-left:42px;padding:4px 0}.history-notice>div{flex-basis:calc(100% - 42px)}}`],
})
export class HistorySyncNoticeComponent {
  readonly history = inject(HistoryDeviceSyncService);
  readonly compared: Record<string, string> = {};
  @Input() showWaiting = true;
  @Input() showApprovals = true;
  @Input() approvalLimit = 32;
  constructor() { addIcons({ lockClosedOutline }); effect(() => { this.history.approvalEpoch(); for (const id of Object.keys(this.compared)) delete this.compared[id]; }); }
}
