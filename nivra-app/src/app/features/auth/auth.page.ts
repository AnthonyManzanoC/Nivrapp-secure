import { CommonModule } from '@angular/common';
import { Component, OnDestroy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
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
import { callOutline, eyeOutline, eyeOffOutline, globeOutline, keyOutline, logInOutline, qrCodeOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import * as QRCode from 'qrcode';
import { AuthService, QrLoginChallenge } from '../../core/services/auth.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { authErrorMessage, type AuthAction } from '../../core/utils/auth-error';
import { isLoginIdentifier } from '../../core/utils/nivra-number';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    TranslatePipe,
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
  readonly translate = inject(TranslateService);
  readonly languageOptions = [
    { native: 'Español', label: 'Spanish', labelKey: 'LANGUAGE.ES', value: 'es' },
    { native: 'English', label: 'English', labelKey: 'LANGUAGE.EN', value: 'en' },
    { native: '简体中文', label: 'Chinese (Simplified)', labelKey: 'LANGUAGE.ZH_HANS', value: 'zh-Hans' },
    { native: 'हिन्दी', label: 'Hindi', labelKey: 'LANGUAGE.HI', value: 'hi' },
    { native: 'العربية', label: 'Arabic', labelKey: 'LANGUAGE.AR', value: 'ar' },
    { native: 'Português', label: 'Portuguese', labelKey: 'LANGUAGE.PT', value: 'pt' },
    { native: 'Русский', label: 'Russian', labelKey: 'LANGUAGE.RU', value: 'ru' },
    { native: '日本語', label: 'Japanese', labelKey: 'LANGUAGE.JA', value: 'ja' },
    { native: 'Français', label: 'French', labelKey: 'LANGUAGE.FR', value: 'fr' },
    { native: 'Deutsch', label: 'German', labelKey: 'LANGUAGE.DE', value: 'de' },
  ];
  mode: 'phone' | 'alias' | 'qr' = 'alias';
  aliasMode: 'login' | 'register' | 'private' = 'login';
  phone = '';
  code = '';
  alias = '';
  password = '';
  passwordVisible = false;
  displayName = '';
  qrDataUrl = '';
  qrChallenge: QrLoginChallenge | null = null;
  notice = '';
  error = '';
  submitting = false;
  private destroyed = false;
  private readonly now = signal(Date.now());
  private readonly countdownTimer = window.setInterval(() => this.now.set(Date.now()), 1000);

  constructor() {
    addIcons({ callOutline, eyeOutline, eyeOffOutline, globeOutline, keyOutline, logInOutline, qrCodeOutline, shieldCheckmarkOutline });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    window.clearInterval(this.countdownTimer);
    void this.auth.stopQrLogin();
  }

  async sendOtp(): Promise<void> {
    await this.run(async () => {
      await this.auth.sendFirebaseOtp(this.phone);
      this.notice = this.translate.instant('LOGIN.CODE_SENT', 'Codigo enviado.');
    });
  }

  async verifyOtp(): Promise<void> {
    await this.run(async () => {
      await this.auth.verifyFirebaseOtp(this.phone, this.code);
      if (this.auth.pendingPhoneAlias()) {
        this.notice = this.translate.instant('LOGIN.PHONE_VERIFIED', 'Telefono verificado.');
      }
    });
  }

  async completeAlias(): Promise<void> {
    if (!this.isAliasValid(this.alias)) {
      this.error = this.translate.instant('LOGIN.ALIAS_ERROR', 'El alias debe tener 3 a 32 caracteres: letras, numeros, guion, punto o guion bajo.');
      return;
    }
    await this.run(() => this.auth.completePhoneAlias(this.alias, this.displayName));
  }

  async submitAlias(): Promise<void> {
    if (this.aliasMode !== 'private' && !(this.aliasMode === 'login' ? isLoginIdentifier(this.alias) : this.isAliasValid(this.alias))) {
      this.error = this.translate.instant('LOGIN.IDENTIFIER_ERROR', 'Ingresa tu ID Nivra de 9 dígitos o tu alias.');
      return;
    }
    if (!this.password || (this.aliasMode !== 'login' && this.password.length < 10)) {
      this.error = this.translate.instant(
        this.password ? 'LOGIN.ERROR_PASSWORD_SHORT' : 'LOGIN.ERROR_PASSWORD_REQUIRED',
        this.password ? 'Usa una contraseña de al menos 10 caracteres.' : 'Ingresa tu contraseña para continuar.',
      );
      return;
    }
    if (this.aliasMode === 'private') {
      await this.run(() => this.auth.createPrivateAccount(this.password));
    } else {
      const mode = this.aliasMode;
      await this.run(() => this.auth.loginWithAlias(this.alias, this.password, mode, this.displayName));
    }
  }

  async startQr(): Promise<void> {
    await this.run(async () => {
      this.qrChallenge = null;
      this.qrDataUrl = '';
      const challenge = await this.auth.startQrLogin();
      const dataUrl = await QRCode.toDataURL(challenge.qrData, {
        width: 232,
        margin: 2,
        color: { dark: '#04100d', light: '#f4fbf7' },
        errorCorrectionLevel: 'M',
      });
      if (!this.destroyed && this.mode === 'qr') {
        this.qrChallenge = challenge;
        this.qrDataUrl = dataUrl;
      }
    });
  }

  qrSecondsRemaining(): number {
    return this.qrChallenge ? Math.max(0, Math.ceil((Date.parse(this.qrChallenge.expiresAt) - this.now()) / 1000)) : 0;
  }

  qrExpired(): boolean {
    return this.auth.qrState() === 'expired' || (!!this.qrChallenge && this.qrSecondsRemaining() === 0);
  }

  qrErrorMessage(): string {
    const error = this.auth.qrError();
    return error ? this.describeError(error, 'qr') : '';
  }

  setAliasMode(mode: 'login' | 'register' | 'private'): void {
    this.aliasMode = mode;
    this.error = '';
    this.notice = '';
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

  currentLanguage(): string {
    return this.translate.currentLanguage();
  }

  setLanguage(language: string): void {
    this.translate.use(language);
  }

  isAliasValid(value = this.alias): boolean {
    return /^[a-zA-Z0-9_.-]{3,32}$/.test(value.trim());
  }

  validIdentifier(): boolean {
    return this.aliasMode === 'private' || (this.aliasMode === 'login' ? isLoginIdentifier(this.alias) : this.isAliasValid(this.alias));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.submitting || this.auth.busy()) {
      return;
    }
    this.submitting = true;
    const context: AuthAction = this.mode === 'alias' ? (this.aliasMode === 'login' ? 'alias-login' : 'alias-register') : this.mode;
    this.error = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      if (!this.destroyed && !(error instanceof Error && error.message === 'QR_CANCELLED')) {
        this.error = this.describeError(error, context);
      }
    } finally {
      this.submitting = false;
    }
  }

  private describeError(error: unknown, action: AuthAction): string {
    const message = authErrorMessage(error, action);
    return message.key ? this.translate.instant(message.key, message.fallback) : message.fallback;
  }
}
