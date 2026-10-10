import { Component, inject } from '@angular/core';
import { IonModal, IonContent, IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { cloudDownloadOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { AndroidUpdateService } from '../core/services/android-update.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-android-update-dialog', standalone: true,
  imports: [IonModal, IonContent, IonButton, IonIcon, TranslatePipe],
  template: `<ion-modal [isOpen]="!!updates.show()" (didDismiss)="onDismiss($event)" class="app-update-modal">
    <ng-template><ion-content><section class="update-content">
      <span class="update-icon"><ion-icon name="cloud-download-outline" /></span>
      <h2>{{ 'UPDATE.TITLE' | translate:'Una nueva versión de Nivra' }}</h2>
      <p class="update-version">Nivra {{ updates.release()?.version }}</p>
      <p>{{ 'UPDATE.DESCRIPTION' | translate:'Actualiza desde aquí y conserva tus chats y ajustes.' }}</p>
      <small><ion-icon name="shield-checkmark-outline" />{{ 'UPDATE.SECURITY' | translate:'Descarga verificada. Android confirmará la instalación.' }}</small>
      @if (updates.state().phase === 'downloading') {
        <progress max="100" [value]="updates.state().progress" [attr.aria-label]="'UPDATE.DOWNLOADING' | translate:'Descargando actualización'"></progress>
        <p role="status">{{ 'UPDATE.DOWNLOADING' | translate:'Descargando actualización' }} · {{ updates.state().progress }}%</p>
        <ion-button fill="clear" (click)="updates.cancel()">{{ 'COMMON.CANCEL' | translate:'Cancelar' }}</ion-button>
      } @else if (updates.state().phase === 'permission') {
        <p class="update-hint">{{ 'UPDATE.PERMISSION' | translate:'Permite instalar actualizaciones de Nivra en Ajustes. Después vuelve y toca Instalar.' }}</p>
        <ion-button expand="block" [disabled]="updates.installing()" (click)="updates.install()">{{ 'UPDATE.INSTALL' | translate:'Instalar actualización' }}</ion-button>
      } @else if (updates.state().phase === 'ready') {
        <ion-button expand="block" [disabled]="updates.installing()" (click)="updates.install()">{{ 'UPDATE.INSTALL' | translate:'Instalar actualización' }}</ion-button>
      } @else {
        @if (updates.state().phase === 'error') { <p role="alert" class="update-error">{{ 'UPDATE.ERROR' | translate:'No se pudo verificar o instalar la actualización. Reintenta la descarga.' }}</p> }
        <ion-button expand="block" (click)="updates.download()">{{ 'UPDATE.DOWNLOAD' | translate:'Descargar actualización' }}</ion-button>
      }
      <ion-button fill="clear" expand="block" (click)="updates.dismiss()">{{ 'UPDATE.LATER' | translate:'Más tarde' }}</ion-button>
    </section></ion-content></ng-template>
  </ion-modal>`,
  styles: [`.app-update-modal{--width:min(92vw,480px);--height:min(78vh,520px);--border-radius:28px}.update-content{padding:28px;text-align:center;color:var(--ion-text-color);padding-top:max(28px,env(safe-area-inset-top))}h2{font-size:25px;line-height:1.2;margin:18px 0 8px}.update-icon{display:inline-grid;place-items:center;width:64px;height:64px;border-radius:22px;background:#18d6a21c;color:var(--ion-color-primary)}.update-icon ion-icon{font-size:30px}.update-version{font-weight:650;color:var(--ion-color-primary)}p{line-height:1.5}small{display:flex;justify-content:center;gap:8px;line-height:1.4;opacity:.75;margin-bottom:20px}small ion-icon{flex-shrink:0;font-size:18px}progress{width:100%;height:8px;accent-color:var(--ion-color-primary)}.update-error{color:var(--ion-color-danger)}.update-hint{font-size:14px}ion-button{--border-radius:14px}`],
})
export class AndroidUpdateDialogComponent {
  readonly updates = inject(AndroidUpdateService);
  constructor() { addIcons({ cloudDownloadOutline, shieldCheckmarkOutline }); }
  onDismiss(event: Event): void {
    const role = (event as CustomEvent<{ role?: string }>).detail?.role;
    // A call/lock hides the dialog programmatically without discarding the available release.
    if (role === 'backdrop' || role === 'cancel' || role === 'gesture') this.updates.dismiss();
  }
}
