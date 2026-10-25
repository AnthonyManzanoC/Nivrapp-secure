import { Component, computed, inject } from '@angular/core';
import { IonModal } from '@ionic/angular/standalone';
import { HistoryDeviceSyncService } from '../core/services/history-device-sync.service';
import { AppLockService } from '../core/services/app-lock.service';
import { CallsService } from '../core/services/calls.service';
import { HistorySyncNoticeComponent } from './history-sync-notice.component';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-history-approval-dialog', standalone: true,
  imports: [IonModal, HistorySyncNoticeComponent, TranslatePipe],
  template: `<ion-modal [isOpen]="show()" [backdropDismiss]="false" [canDismiss]="canDismiss" (didDismiss)="onDismiss($event)" class="history-approval-modal" [attr.aria-label]="'HISTORY_DEVICE.APPROVE_TITLE' | translate:'Vincular historial cifrado'">
    <ng-template><section class="history-dialog"><header class="history-dialog-head"><h2>{{ 'HISTORY_DEVICE.APPROVE_TITLE' | translate:'Vincular historial cifrado' }}</h2><button type="button" [disabled]="!!history.approvingRequestId()" (click)="dismiss()">{{ 'COMMON.CLOSE' | translate:'Cerrar' }}</button></header>
    <div class="history-dialog-body"><app-history-sync-notice [showWaiting]="false" [approvalLimit]="1" /></div></section></ng-template>
  </ion-modal>`,
  styleUrls: ['./history-approval-dialog.component.scss'],
})
export class HistoryApprovalDialogComponent {
  readonly history = inject(HistoryDeviceSyncService);
  private readonly lock = inject(AppLockService);
  private readonly calls = inject(CallsService);
  readonly show = computed(() => !this.lock.isContentLocked() && !this.calls.activeCall() && this.history.pendingRequests().length > 0);
  // Ionic's isOpen is one-way. Keep a visible queue inside the same modal;
  // only programmatic hiding for lock/call/empty queue can close the overlay.
  readonly canDismiss = async (): Promise<boolean> => !this.show();
  dismiss(): void { if (this.history.approvingRequestId()) return; const request = this.history.pendingRequests()[0]; if (request) this.history.dismissRequest(request.id); }
  onDismiss(event: Event): void {
    const role = (event as CustomEvent<{ role?: string }>).detail?.role;
    // Hiding for an incoming call or app lock must not decline the request.
    if (role === 'backdrop' || role === 'cancel' || role === 'gesture') this.dismiss();
  }
}
