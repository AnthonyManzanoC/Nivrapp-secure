import { Component, computed, inject } from '@angular/core';
import { IonModal, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton } from '@ionic/angular/standalone';
import { HistoryDeviceSyncService } from '../core/services/history-device-sync.service';
import { AppLockService } from '../core/services/app-lock.service';
import { CallsService } from '../core/services/calls.service';
import { HistorySyncNoticeComponent } from './history-sync-notice.component';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-history-approval-dialog', standalone: true,
  imports: [IonModal, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, HistorySyncNoticeComponent, TranslatePipe],
  template: `<ion-modal [isOpen]="show()" [backdropDismiss]="false" [canDismiss]="canDismiss" (didDismiss)="onDismiss($event)" class="history-approval-modal">
    <ng-template><ion-header><ion-toolbar><ion-title>{{ 'HISTORY_DEVICE.APPROVE_TITLE' | translate:'Vincular historial cifrado' }}</ion-title><ion-buttons slot="end"><ion-button (click)="dismiss()">{{ 'COMMON.CLOSE' | translate:'Cerrar' }}</ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content><app-history-sync-notice [showWaiting]="false" [approvalLimit]="1" /></ion-content></ng-template>
  </ion-modal>`,
  styles: [`.history-approval-modal{--width:min(92vw,520px);--height:min(80vh,600px);--border-radius:24px;--box-shadow:0 20px 80px #071c2733}ion-toolbar{padding-top:4px}ion-title{font-size:16px;font-weight:650}ion-content{--padding-top:8px;--padding-bottom:16px}`],
})
export class HistoryApprovalDialogComponent {
  private readonly history = inject(HistoryDeviceSyncService);
  private readonly lock = inject(AppLockService);
  private readonly calls = inject(CallsService);
  readonly show = computed(() => !this.lock.isLocked() && !this.calls.activeCall() && this.history.pendingRequests().length > 0);
  // Ionic's isOpen is one-way. Keep a visible queue inside the same modal;
  // only programmatic hiding for lock/call/empty queue can close the overlay.
  readonly canDismiss = async (): Promise<boolean> => !this.show();
  dismiss(): void { const request = this.history.pendingRequests()[0]; if (request) this.history.dismissRequest(request.id); }
  onDismiss(event: Event): void {
    const role = (event as CustomEvent<{ role?: string }>).detail?.role;
    // Hiding for an incoming call or app lock must not decline the request.
    if (role === 'backdrop' || role === 'cancel' || role === 'gesture') this.dismiss();
  }
}
