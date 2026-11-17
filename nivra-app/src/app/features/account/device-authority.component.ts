import { Component, inject } from '@angular/core';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { DeviceAuthorityService } from '../../core/services/device-authority.service';

@Component({
  selector: 'app-device-authority', standalone: true, imports: [TranslatePipe],
  template: `@if (devices.authority()?.primaryDeviceId) {
    <p class="authority-copy">{{ 'ACCOUNT.AUTHORITY_HELP' | translate:'Nivra elige el equipo principal automáticamente y da prioridad al Android con mayor antigüedad verificada. Todos tus equipos pueden recibir mensajes y recuperar el historial.' }}</p>
  }`,
  styles: [`.authority-copy { color: var(--ion-color-medium-shade); font-size: .82rem; line-height: 1.5; margin: 0 0 1rem; }`],
})
export class DeviceAuthorityComponent { readonly devices = inject(DeviceAuthorityService); }
