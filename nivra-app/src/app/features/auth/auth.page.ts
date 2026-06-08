import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
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
import { callOutline, copyOutline, globeOutline, informationCircleOutline, keyOutline, logInOutline, qrCodeOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import * as QRCode from 'qrcode';
import { AuthService, QrLoginChallenge } from '../../core/services/auth.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { FirebaseSigningDiagnostics, NativeDeviceService } from '../../core/services/native-device.service';

const FIREBASE_SHA_ALERT_KEY = 'nivra.firebaseShaAlertShown';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
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
export class AuthPage implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly translate = inject(TranslateService);
  private readonly nativeDevice = inject(NativeDeviceService);
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
  firebaseDiagnostics: FirebaseSigningDiagnostics | null = null;
  firebaseDiagnosticsText = '';
  firebaseDiagnosticsCopied = false;
  firebaseDiagnosticsLoading = false;

  constructor() {
    addIcons({ callOutline, copyOutline, globeOutline, informationCircleOutline, keyOutline, logInOutline, qrCodeOutline, shieldCheckmarkOutline });
  }

  ngOnInit(): void {
    void this.loadFirebaseDiagnostics({ autoAlert: true });
  }

  ngOnDestroy(): void {
    void this.auth.stopQrLogin();
  }

  async sendOtp(): Promise<void> {
    await this.run(async () => {
      await this.auth.sendFirebaseOtp(this.phone);
      this.notice = this.translate.instant('LOGIN.CODE_SENT', 'Codigo enviado.');
    });
    if (this.isFirebaseOriginBlocked(this.error)) {
      await this.loadFirebaseDiagnostics({ autoAlert: false, forceAlert: true });
    }
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
    if (!this.isAliasValid(this.alias)) {
      this.error = this.translate.instant('LOGIN.ALIAS_ERROR', 'El alias debe tener 3 a 32 caracteres: letras, numeros, guion, punto o guion bajo.');
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
      this.notice = this.translate.instant('LOGIN.QR_ACTIVE', 'QR activo.');
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

  currentLanguage(): string {
    return this.translate.currentLanguage();
  }

  setLanguage(language: string): void {
    this.translate.use(language);
  }

  async copyFirebaseDiagnostics(): Promise<void> {
    if (!this.firebaseDiagnosticsText) {
      await this.loadFirebaseDiagnostics({ autoAlert: false });
    }
    if (!this.firebaseDiagnosticsText) {
      return;
    }
    await this.nativeDevice.copyToClipboard(this.firebaseDiagnosticsText, 'Nivra Firebase SHA');
    this.firebaseDiagnosticsCopied = true;
    window.setTimeout(() => {
      this.firebaseDiagnosticsCopied = false;
    }, 1800);
  }

  async showFirebaseDiagnosticsAlert(): Promise<void> {
    if (!this.firebaseDiagnosticsText) {
      await this.loadFirebaseDiagnostics({ autoAlert: false });
    }
    if (this.firebaseDiagnosticsText) {
      window.alert(this.firebaseDiagnosticsText);
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
      this.error = error instanceof Error ? error.message : this.translate.instant('COMMON.ACTION_ERROR_NIVRA', 'Nivra no pudo completar la accion.');
    }
  }

  private async loadFirebaseDiagnostics(options: { autoAlert?: boolean; forceAlert?: boolean } = {}): Promise<void> {
    if (this.firebaseDiagnosticsLoading || !this.nativeDevice.native) {
      return;
    }
    this.firebaseDiagnosticsLoading = true;
    try {
      const diagnostics = await this.nativeDevice.firebaseSigningDiagnostics();
      if (!diagnostics) {
        return;
      }
      this.firebaseDiagnostics = diagnostics;
      this.firebaseDiagnosticsText = this.formatFirebaseDiagnostics(diagnostics);
      if (options.forceAlert || this.shouldAutoShowFirebaseSha(options.autoAlert === true)) {
        window.setTimeout(() => this.showFirebaseDiagnosticsAlert(), 250);
      }
    } finally {
      this.firebaseDiagnosticsLoading = false;
    }
  }

  private shouldAutoShowFirebaseSha(autoAlert: boolean): boolean {
    if (!autoAlert) {
      return false;
    }
    try {
      if (sessionStorage.getItem(FIREBASE_SHA_ALERT_KEY) === '1') {
        return false;
      }
      sessionStorage.setItem(FIREBASE_SHA_ALERT_KEY, '1');
      return true;
    } catch {
      return true;
    }
  }

  private formatFirebaseDiagnostics(diagnostics: FirebaseSigningDiagnostics): string {
    return [
      'Nivra Android - Firebase SMS',
      `Package: ${diagnostics.packageName}`,
      `Version: ${diagnostics.appVersion || 'desconocida'}`,
      `Build: ${diagnostics.appBuild || 'desconocido'}`,
      '',
      'SHA-1:',
      diagnostics.signingSha1 || '(no disponible)',
      '',
      'SHA-256:',
      diagnostics.signingSha256 || '(no disponible)',
      '',
      'Config frontend:',
      ...this.auth.firebaseClientDiagnostics(),
      '',
      'Accion en Firebase Console:',
      'Project settings > General > Your apps > Android > Add fingerprint.',
      'Registra SHA-1 y SHA-256, descarga google-services.json actualizado si Firebase te lo pide, espera 10-15 minutos y reinstala la APK.',
    ].join('\n');
  }

  private isFirebaseOriginBlocked(message: string): boolean {
    const value = message.toLowerCase();
    return value.includes('firebase bloqueo el origen')
      || value.includes('app-not-authorized')
      || value.includes('unauthorized-domain')
      || value.includes('requests-from-referer');
  }
}
