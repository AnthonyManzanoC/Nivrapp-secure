import { CommonModule } from '@angular/common';
import { Component, OnDestroy, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  IonLabel,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonText,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { callOutline, keyOutline, logInOutline, qrCodeOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import * as QRCode from 'qrcode';
import { AuthService, QrLoginChallenge } from '../../core/services/auth.service';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonButton,
    IonContent,
    IonIcon,
    IonInput,
    IonLabel,
    IonNote,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    IonText,
  ],
  templateUrl: './auth.page.html',
  styleUrls: ['./auth.page.scss'],
})
export class AuthPage implements OnDestroy {
  readonly auth = inject(AuthService);
  mode: 'phone' | 'alias' | 'qr' = 'phone';
  aliasMode: 'login' | 'register' = 'login';
  phone = '';
  code = '';
  alias = '';
  password = '';
  displayName = '';
  qrDataUrl = '';
  qrChallenge: QrLoginChallenge | null = null;
  notice = '';
  error = '';

  constructor() {
    addIcons({ callOutline, keyOutline, logInOutline, qrCodeOutline, shieldCheckmarkOutline });
  }

  ngOnDestroy(): void {
    void this.auth.stopQrLogin();
  }

  async sendOtp(): Promise<void> {
    await this.run(async () => {
      await this.auth.sendFirebaseOtp(this.phone);
      this.notice = 'Codigo enviado.';
    });
  }

  async verifyOtp(): Promise<void> {
    await this.run(async () => {
      await this.auth.verifyFirebaseOtp(this.phone, this.code);
      if (this.auth.pendingPhoneAlias()) {
        this.notice = 'Telefono verificado.';
      }
    });
  }

  async completeAlias(): Promise<void> {
    if (!this.isAliasValid(this.alias)) {
      this.error = 'El alias debe tener 3 a 32 caracteres: letras, numeros, guion, punto o guion bajo.';
      return;
    }
    await this.run(() => this.auth.completePhoneAlias(this.alias, this.displayName));
  }

  async submitAlias(): Promise<void> {
    if (!this.isAliasValid(this.alias)) {
      this.error = 'El alias debe tener 3 a 32 caracteres: letras, numeros, guion, punto o guion bajo.';
      return;
    }
    await this.run(() => this.auth.loginWithAlias(this.alias, this.password, this.aliasMode, this.displayName));
  }

  async startQr(): Promise<void> {
    await this.run(async () => {
      const challenge = await this.auth.startQrLogin();
      this.qrChallenge = challenge;
      this.qrDataUrl = await QRCode.toDataURL(challenge.qrData, {
        width: 232,
        margin: 2,
        color: { dark: '#04100d', light: '#f4fbf7' },
        errorCorrectionLevel: 'L',
      });
      this.notice = 'QR activo.';
    });
  }

  setMode(mode: 'phone' | 'alias' | 'qr'): void {
    this.mode = mode;
    this.error = '';
    this.notice = '';
    if (mode !== 'qr') {
      this.qrChallenge = null;
      this.qrDataUrl = '';
      void this.auth.stopQrLogin();
    }
  }

  isAliasValid(value = this.alias): boolean {
    return /^[a-zA-Z0-9_.-]{3,32}$/.test(value.trim());
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.error = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Nivra no pudo completar la accion.';
    }
  }
}
