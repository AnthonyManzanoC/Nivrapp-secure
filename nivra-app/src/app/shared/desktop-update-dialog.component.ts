import { Component, inject } from '@angular/core';
import { IonModal, IonContent, IonButton, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { cloudDownloadOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { DesktopUpdateService } from '../core/services/desktop-update.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-desktop-update-dialog', standalone: true,
  imports: [IonModal, IonContent, IonButton, IonIcon, IonSpinner, TranslatePipe],
  template: `<ion-modal [isOpen]="updates.show()" (didDismiss)="onDismiss($event)" class="desktop-update-modal" [attr.aria-label]="'UPDATE.TITLE' | translate:'Una nueva versión de Nivra'">
    <ng-template><ion-content><section class="update-content">
      <span class="update-icon" aria-hidden="true"><ion-icon name="cloud-download-outline" /></span>
      <h2>{{ 'UPDATE.TITLE' | translate:'Una nueva versión de Nivra' }}</h2>
      <p class="update-version">Nivra {{ updates.release()?.version }}</p>
      <p>{{ 'UPDATE.DESCRIPTION' | translate:'Actualiza desde aquí y conserva tus chats y ajustes.' }}</p>
      <small><ion-icon name="shield-checkmark-outline" aria-hidden="true" />{{ 'UPDATE.WINDOWS_SECURITY' | translate:'Se verifican el archivo y su integridad antes de abrir el instalador.' }}</small>
      @if (updates.state().phase === 'downloading') {
        <progress max="100" [value]="updates.state().progress" [attr.aria-label]="'UPDATE.DOWNLOADING' | translate:'Descargando actualización'"></progress>
        <p role="status">{{ 'UPDATE.DOWNLOADING' | translate:'Descargando actualización' }} · {{ updates.state().progress }}%</p>
      } @else if (updates.state().phase === 'installing') {
        <p role="status"><ion-spinner name="crescent" />{{ 'UPDATE.INSTALLING' | translate:'Abriendo el instalador… Nivra se cerrará para actualizarse.' }}</p>
      } @else if (updates.state().phase === 'ready') {
        <ion-button expand="block" (click)="updates.install()">{{ 'UPDATE.RESTART_INSTALL' | translate:'Cerrar Nivra e instalar' }}</ion-button>
      } @else {
        @if (updates.state().phase === 'error') { <p role="alert" class="update-error">{{ 'UPDATE.ERROR' | translate:'No se pudo verificar o instalar la actualización. Reintenta la descarga.' }}</p> }
        <ion-button expand="block" (click)="updates.download()">{{ 'UPDATE.DOWNLOAD' | translate:'Descargar actualización' }}</ion-button>
      }
      @if (updates.state().phase !== 'installing') { <ion-button fill="clear" expand="block" (click)="updates.dismiss()">{{ 'UPDATE.LATER' | translate:'Más tarde' }}</ion-button> }
    </section></ion-content></ng-template>
  </ion-modal>`,
  styles: [`.desktop-update-modal{--width:min(92vw,480px);--height:min(78vh,530px);--border-radius:24px}.update-content{padding:30px;text-align:center;color:var(--nivra-text)}h2{font-size:26px;line-height:1.18;letter-spacing:-.035em;margin:20px 0 8px}.update-icon{display:inline-grid;place-items:center;width:64px;height:64px;border-radius:22px;background:color-mix(in srgb,var(--nivra-brand) 12%,transparent);color:var(--nivra-brand-2)}.update-icon ion-icon{font-size:30px}.update-version{font-weight:650;color:var(--nivra-brand-2)}p{line-height:1.6}small{display:flex;justify-content:center;gap:8px;line-height:1.5;color:var(--nivra-muted);margin:0 0 24px}small ion-icon{flex-shrink:0;font-size:18px}progress{width:100%;height:8px;accent-color:var(--nivra-brand)}.update-error{color:var(--nivra-danger)}ion-button{--border-radius:14px;min-height:46px}ion-spinner{width:18px;height:18px;vertical-align:middle;margin-inline-end:8px}`],
})
export class DesktopUpdateDialogComponent {
  readonly updates = inject(DesktopUpdateService);
  constructor() { addIcons({ cloudDownloadOutline, shieldCheckmarkOutline }); }
  onDismiss(event: Event): void {
    const role = (event as CustomEvent<{ role?: string }>).detail?.role;
    if (role === 'backdrop' || role === 'cancel' || role === 'gesture') this.updates.dismiss();
  }
}
