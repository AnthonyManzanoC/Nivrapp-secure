import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Keyboard, KeyboardStyle } from '@capacitor/keyboard';
import { Subject, Subscription, from, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  LoadingController,
  IonModal,
  IonSpinner,
  IonTextarea,
  IonToggle,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { backspaceOutline, cameraOutline, closeOutline, copyOutline, fingerPrintOutline, imageOutline, keypadOutline, lockClosedOutline, logOutOutline, moonOutline, notificationsOffOutline, notificationsOutline, personAddOutline, phonePortraitOutline, qrCodeOutline, refreshOutline, scanOutline, shareSocialOutline, shieldCheckmarkOutline, sunnyOutline, trashOutline, warningOutline } from 'ionicons/icons';
import { AccountService } from '../../core/services/account.service';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { PrivacySettings } from '../../core/models/nivra.models';
import { AppLockService } from '../../core/services/app-lock.service';
import { PanicPinService } from '../../core/services/panic-pin.service';
import { PushService } from '../../core/services/push.service';

const THEME_STORAGE_KEY = 'nivra.theme';
const ALIAS_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const PIN_LENGTH = 4;

type AliasStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, IonButton, IonContent, IonIcon, IonInput, IonModal, IonSpinner, IonTextarea, IonToggle],
  templateUrl: './account.page.html',
  styleUrls: ['./account.page.scss'],
})
export class AccountPage implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly account = inject(AccountService);
  readonly appLock = inject(AppLockService);
  readonly calls = inject(CallsService);
  readonly panicPin = inject(PanicPinService);
  readonly push = inject(PushService);
  private readonly router = inject(Router);
  private readonly loadingController = inject(LoadingController);
  alias = '';
  private originalAlias = '';
  displayName = '';
  email = '';
  phone = '';
  bio = '';
  profilePhotoDataUrl = '';
  profilePhotoDirty = false;
  isDiscoverable = true;
  saving = false;
  notice = '';
  error = '';
  deleteConfirmation = '';
  qrText = '';
  qrScannerOpen = false;
  qrScannerBusy = false;
  qrScannerStatus = 'Listo para escanear.';
  shareModalOpen = false;
  shareQrDataUrl = '';
  shareBusy = false;
  pinSetupModalOpen = false;
  setupPin = '';
  setupPinConfirm = '';
  pinSetupError = '';
  panicPinValue = '';
  panicPinConfirm = '';
  contactScannerOpen = false;
  contactScannerBusy = false;
  contactScannerStatus = 'Listo para escanear contacto.';
  lightTheme = false;
  private qrScanner: import('html5-qrcode').Html5Qrcode | null = null;
  private contactScanner: import('html5-qrcode').Html5Qrcode | null = null;
  private readonly aliasChecks = new Subject<string>();
  private aliasCheckSub?: Subscription;
  aliasStatus: AliasStatus = 'idle';
  readonly setupPinKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'backspace'];
  readonly pinSlots = [0, 1, 2, 3];

  constructor() {
    addIcons({ backspaceOutline, cameraOutline, closeOutline, copyOutline, fingerPrintOutline, imageOutline, keypadOutline, lockClosedOutline, logOutOutline, moonOutline, notificationsOffOutline, notificationsOutline, personAddOutline, phonePortraitOutline, qrCodeOutline, refreshOutline, scanOutline, shareSocialOutline, shieldCheckmarkOutline, sunnyOutline, trashOutline, warningOutline });
  }

  async ngOnInit(): Promise<void> {
    this.initializeTheme();
    this.listenForAliasChecks();
    await this.reload();
  }

  ngOnDestroy(): void {
    this.aliasCheckSub?.unsubscribe();
    void this.stopQrScanner();
    void this.stopContactScanner();
  }

  async reload(): Promise<void> {
    await this.account.load();
    const user = this.auth.session()?.user;
    if (user) {
      this.alias = user.alias ?? '';
      this.originalAlias = this.normalizeAlias(user.alias);
      this.aliasStatus = 'idle';
      this.displayName = user.displayName ?? '';
      this.email = user.email ?? '';
      this.phone = user.phone ?? '';
      this.bio = user.bio ?? '';
      this.profilePhotoDataUrl = user.profilePhotoDataUrl ?? '';
      this.profilePhotoDirty = false;
      this.isDiscoverable = user.isDiscoverable;
    }
  }

  async saveProfile(): Promise<void> {
    if (!this.canSaveProfile()) {
      this.error = this.aliasStatus === 'taken'
        ? 'Alias no disponible.'
        : this.aliasStatus === 'checking'
          ? 'Espera la validacion del alias.'
          : 'Revisa el alias antes de guardar.';
      return;
    }

    await this.run(async () => {
      const alias = this.normalizeAlias(this.alias);
      await this.account.updateProfile({
        alias,
        displayName: this.displayName || null,
        email: this.email || null,
        phone: this.phone || null,
        bio: this.bio || null,
        ...(this.profilePhotoDirty ? { profilePhotoDataUrl: this.profilePhotoDataUrl } : {}),
        isDiscoverable: this.isDiscoverable,
      });
      this.alias = this.auth.session()?.user?.alias ?? alias;
      this.originalAlias = this.normalizeAlias(this.alias);
      this.aliasStatus = 'idle';
      this.profilePhotoDirty = false;
      this.notice = 'Perfil actualizado.';
    });
  }

  aliasChanged(value: string | number | null | undefined): void {
    this.alias = this.normalizeAlias(String(value ?? ''));
    const alias = this.normalizeAlias(this.alias);
    if (alias === this.originalAlias) {
      this.aliasStatus = 'idle';
      return;
    }
    if (!ALIAS_PATTERN.test(alias)) {
      this.aliasStatus = 'invalid';
      return;
    }
    this.aliasStatus = 'checking';
    this.aliasChecks.next(alias);
  }

  canSaveProfile(): boolean {
    const alias = this.normalizeAlias(this.alias);
    if (!ALIAS_PATTERN.test(alias)) {
      return false;
    }
    if (alias === this.originalAlias) {
      return true;
    }
    return this.aliasStatus === 'available';
  }

  async pickProfilePhoto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      this.error = 'Selecciona una imagen valida.';
      return;
    }
    await this.run(async () => {
      this.profilePhotoDataUrl = await this.resizeProfilePhoto(file);
      this.profilePhotoDirty = true;
      this.notice = 'Foto lista. Guarda el perfil para publicarla.';
    });
  }

  removeProfilePhoto(): void {
    this.profilePhotoDataUrl = '';
    this.profilePhotoDirty = true;
    this.notice = 'Foto quitada. Guarda el perfil para confirmar.';
  }

  async savePrivacy(): Promise<void> {
    const privacy = this.account.privacy();
    if (!privacy) {
      return;
    }
    await this.run(async () => {
      await this.account.updatePrivacy(privacy);
      this.notice = 'Privacidad actualizada.';
    });
  }

  patchPrivacy(key: keyof PrivacySettings, value: boolean | number | null): void {
    this.account.privacy.update((privacy) => privacy ? { ...privacy, [key]: value } : privacy);
  }

  async setSecureMode(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.run(async () => {
        this.appLock.disable();
        this.notice = 'Modo Seguro desactivado.';
      });
      return;
    }

    if (this.appLock.isNativePlatform()) {
      await this.run(async () => {
        await this.appLock.enableMobileBiometrics();
        this.notice = `Modo Seguro activado con ${this.appLock.biometryLabel()}.`;
      });
      return;
    }

    this.openPinSetupModal();
  }

  openPinSetupModal(): void {
    this.setupPin = '';
    this.setupPinConfirm = '';
    this.pinSetupError = '';
    this.pinSetupModalOpen = true;
  }

  closePinSetupModal(): void {
    this.pinSetupModalOpen = false;
    this.setupPin = '';
    this.setupPinConfirm = '';
    this.pinSetupError = '';
  }

  pressSetupPinKey(key: string): void {
    if (!key || this.saving) {
      return;
    }
    if (key === 'backspace') {
      if (this.setupPinConfirm) {
        this.setupPinConfirm = this.setupPinConfirm.slice(0, -1);
      } else {
        this.setupPin = this.setupPin.slice(0, -1);
      }
      this.pinSetupError = '';
      return;
    }

    if (this.setupPin.length < PIN_LENGTH) {
      this.setupPin = this.appLock.normalizePin(`${this.setupPin}${key}`);
      return;
    }
    if (this.setupPinConfirm.length < PIN_LENGTH) {
      this.setupPinConfirm = this.appLock.normalizePin(`${this.setupPinConfirm}${key}`);
      if (this.setupPinConfirm.length === PIN_LENGTH && this.setupPinConfirm !== this.setupPin) {
        this.pinSetupError = 'Los PIN no coinciden.';
      } else {
        this.pinSetupError = '';
      }
    }
  }

  async confirmWebPin(): Promise<void> {
    if (!this.appLock.isValidPin(this.setupPin) || !this.appLock.isValidPin(this.setupPinConfirm)) {
      this.pinSetupError = 'Crea y confirma un PIN de 4 digitos.';
      return;
    }
    if (this.setupPin !== this.setupPinConfirm) {
      this.pinSetupError = 'Los PIN no coinciden.';
      return;
    }

    await this.run(async () => {
      await this.appLock.enableWebPin(this.setupPin);
      this.notice = 'Modo Seguro activado con PIN.';
      this.closePinSetupModal();
    });
  }

  async savePanicPin(): Promise<void> {
    const pin = this.panicPin.normalizePin(this.panicPinValue);
    const confirm = this.panicPin.normalizePin(this.panicPinConfirm);
    if (!this.panicPin.isValidPin(pin)) {
      this.error = 'El PIN de panico debe tener de 4 a 6 digitos.';
      return;
    }
    if (pin !== confirm) {
      this.error = 'Confirma el mismo PIN de panico.';
      return;
    }

    await this.run(async () => {
      await this.panicPin.configure(pin);
      this.panicPinValue = '';
      this.panicPinConfirm = '';
      this.notice = 'PIN de panico configurado localmente.';
    });
  }

  async clearPanicPin(): Promise<void> {
    await this.run(async () => {
      this.panicPin.clear();
      this.panicPinValue = '';
      this.panicPinConfirm = '';
      this.notice = 'PIN de panico quitado.';
    });
  }

  setLightTheme(enabled: boolean): void {
    this.lightTheme = enabled;
    this.applyTheme(enabled);
    this.writeStoredTheme(enabled);
    void this.syncNativeKeyboard(enabled);
  }

  identityMode(): 'ghost' | 'public' {
    return this.phone.trim() ? 'public' : 'ghost';
  }

  shareUrl(): string {
    const alias = this.auth.session()?.user?.alias || '';
    const origin = window.location.origin || window.location.href.split('/').slice(0, 3).join('/');
    return `${origin}/contact?alias=${encodeURIComponent(alias)}`;
  }

  shareMessage(): string {
    const user = this.auth.session()?.user;
    const alias = user?.alias || '';
    const name = user?.displayName || alias;
    return [
      `${name} te invita a Nivra, mensajeria privada con chat y boveda cifrada.`,
      `Buscame como @${alias}.`,
      'Si ya tienes Nivra, abre este enlace para iniciar el chat:',
      this.shareUrl(),
    ].join('\n');
  }

  async copyShareMessage(): Promise<void> {
    await this.run(async () => {
      await navigator.clipboard.writeText(this.shareMessage());
      this.notice = 'Invitacion copiada.';
    });
  }

  async shareAccount(): Promise<void> {
    await this.run(async () => {
      const payload = {
        title: 'Nivra',
        text: this.shareMessage(),
        url: this.shareUrl(),
      };
      const share = navigator as Navigator & { share?: (data: typeof payload) => Promise<void> };
      if (share.share) {
        await share.share(payload);
        this.notice = 'Invitacion lista para enviar.';
        return;
      }
      await navigator.clipboard.writeText(this.shareMessage());
      this.notice = 'Tu navegador no comparte directo; copie la invitacion.';
    });
  }

  async openShareModal(): Promise<void> {
    await this.run(async () => {
      await this.ensureShareQr();
      this.shareModalOpen = true;
    });
  }

  closeShareModal(): void {
    this.shareModalOpen = false;
  }

  async startContactScanner(): Promise<void> {
    if (this.contactScannerBusy) {
      return;
    }
    this.contactScannerOpen = true;
    this.contactScannerBusy = true;
    this.contactScannerStatus = 'Preparando camara...';
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { Html5Qrcode } = await import('html5-qrcode');
      await this.stopContactScanner({ keepOpen: true });
      this.contactScanner = new Html5Qrcode('contactQrScannerRegion');
      await this.contactScanner.start(
        { facingMode: 'environment' },
        {
          fps: 8,
          qrbox: (width, height) => {
            const size = Math.floor(Math.min(width, height) * 0.72);
            return { width: size, height: size };
          },
        },
        (text) => void this.handleContactQr(text),
        () => undefined,
      );
      this.contactScannerStatus = 'Apunta la camara al QR de contacto.';
    } catch (error) {
      this.contactScannerStatus = error instanceof Error ? error.message : 'No se pudo abrir la camara.';
      await this.stopContactScanner({ keepOpen: true });
    } finally {
      this.contactScannerBusy = false;
    }
  }

  async stopContactScanner(options: { keepOpen?: boolean } = {}): Promise<void> {
    const scanner = this.contactScanner;
    this.contactScanner = null;
    if (scanner) {
      await scanner.stop().catch(() => undefined);
      try {
        scanner.clear();
      } catch {
        // Contact scanner cleanup is best-effort because html5-qrcode throws when already cleared.
      }
    }
    if (!options.keepOpen) {
      this.contactScannerOpen = false;
    }
  }

  async scanContactQrFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file || this.contactScannerBusy) {
      return;
    }
    this.contactScannerOpen = true;
    this.contactScannerBusy = true;
    this.contactScannerStatus = 'Leyendo imagen...';
    let tempScanner: import('html5-qrcode').Html5Qrcode | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.stopContactScanner({ keepOpen: true });
      const { Html5Qrcode } = await import('html5-qrcode');
      tempScanner = new Html5Qrcode('contactQrScannerRegion');
      const text = await tempScanner.scanFile(file, true);
      await this.handleContactQr(text, { allowWhileBusy: true });
    } catch (error) {
      this.contactScannerStatus = error instanceof Error ? error.message : 'No se pudo leer ese QR.';
    } finally {
      if (tempScanner && tempScanner !== this.contactScanner) {
        try {
          tempScanner.clear();
        } catch {
          // Contact scanner cleanup is best-effort because html5-qrcode throws when already cleared.
        }
      }
      this.contactScannerBusy = false;
    }
  }

  async revoke(deviceId: string): Promise<void> {
    await this.run(async () => {
      await this.account.revokeDevice(deviceId);
      this.notice = 'Dispositivo revocado.';
    });
  }

  async enablePush(): Promise<void> {
    await this.run(async () => {
      const ok = await this.push.requestPermissionAndRegister();
      this.notice = ok ? 'Notificaciones activadas.' : 'No se pudo activar notificaciones en este navegador.';
    });
  }

  async revokePush(): Promise<void> {
    await this.run(async () => {
      await this.push.revokeCurrentToken();
      this.notice = 'Token de notificaciones revocado.';
    });
  }

  async logout(): Promise<void> {
    await this.run(async () => {
      if (this.calls.activeCall()) {
        await this.calls.end().catch(() => undefined);
      }
      this.calls.releaseLocalResources();
      await this.auth.logout();
      await this.router.navigateByUrl('/auth');
    });
  }

  async authorizeQr(): Promise<void> {
    await this.run(async () => {
      const loading = await this.loadingController.create({
        message: 'Vinculando dispositivo seguro...',
        spinner: 'crescent',
        backdropDismiss: false,
      });
      await loading.present();
      try {
        await this.auth.authorizeQrLoginText(this.qrText);
        this.qrText = '';
        await this.stopQrScanner();
        await this.account.load();
        this.notice = 'Dispositivo vinculado por QR.';
      } finally {
        await loading.dismiss().catch(() => undefined);
      }
    });
  }

  async startQrScanner(): Promise<void> {
    if (this.qrScannerBusy) {
      return;
    }
    this.qrScannerOpen = true;
    this.qrScannerBusy = true;
    this.qrScannerStatus = 'Preparando camara segura...';
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { Html5Qrcode } = await import('html5-qrcode');
      await this.stopQrScanner({ keepOpen: true });
      this.qrScanner = new Html5Qrcode('qrScannerRegion');
      await this.qrScanner.start(
        { facingMode: 'environment' },
        {
          fps: 8,
          qrbox: (width, height) => {
            const size = Math.floor(Math.min(width, height) * 0.72);
            return { width: size, height: size };
          },
        },
        (text) => void this.handleScannedQr(text),
        () => undefined,
      );
      this.qrScannerStatus = 'Apunta la camara al QR de Nivra.';
    } catch (error) {
      this.qrScannerStatus = error instanceof Error ? error.message : 'No se pudo abrir la camara.';
      await this.stopQrScanner({ keepOpen: true });
    } finally {
      this.qrScannerBusy = false;
    }
  }

  async stopQrScanner(options: { keepOpen?: boolean } = {}): Promise<void> {
    const scanner = this.qrScanner;
    this.qrScanner = null;
    if (scanner) {
      await scanner.stop().catch(() => undefined);
      try {
        scanner.clear();
      } catch {
        // Scanner cleanup is best-effort because html5-qrcode throws when already cleared.
      }
    }
    if (!options.keepOpen) {
      this.qrScannerOpen = false;
    }
  }

  async scanQrFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file || this.qrScannerBusy) {
      return;
    }
    this.qrScannerOpen = true;
    this.qrScannerBusy = true;
    this.qrScannerStatus = 'Leyendo imagen...';
    let tempScanner: import('html5-qrcode').Html5Qrcode | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.stopQrScanner({ keepOpen: true });
      const { Html5Qrcode } = await import('html5-qrcode');
      tempScanner = new Html5Qrcode('qrScannerRegion');
      const text = await tempScanner.scanFile(file, true);
      await this.handleScannedQr(text, { allowWhileBusy: true });
    } catch (error) {
      this.qrScannerStatus = error instanceof Error ? error.message : 'No se pudo leer ese QR.';
    } finally {
      if (tempScanner && tempScanner !== this.qrScanner) {
        try {
          tempScanner.clear();
        } catch {
          // Scanner cleanup is best-effort because html5-qrcode throws when already cleared.
        }
      }
      this.qrScannerBusy = false;
    }
  }

  private async handleScannedQr(text: string, options: { allowWhileBusy?: boolean } = {}): Promise<void> {
    if (!text || (this.qrScannerBusy && !options.allowWhileBusy)) {
      return;
    }
    this.qrScannerBusy = true;
    this.qrText = text;
    this.qrScannerStatus = 'QR detectado. Autorizando dispositivo...';
    try {
      await this.authorizeQr();
    } finally {
      this.qrScannerBusy = false;
    }
  }

  private async handleContactQr(text: string, options: { allowWhileBusy?: boolean } = {}): Promise<void> {
    if (!text || (this.contactScannerBusy && !options.allowWhileBusy)) {
      return;
    }
    this.contactScannerBusy = true;
    this.contactScannerStatus = 'QR detectado. Abriendo contacto...';
    try {
      const alias = this.contactAliasFromQr(text);
      if (!alias) {
        throw new Error('Ese QR no parece ser de contacto Nivra.');
      }
      await this.stopContactScanner();
      await this.router.navigate(['/contact'], { queryParams: { alias } });
    } catch (error) {
      this.contactScannerStatus = error instanceof Error ? error.message : 'No se pudo abrir ese contacto.';
    } finally {
      this.contactScannerBusy = false;
    }
  }

  async deleteAccount(): Promise<void> {
    if (this.deleteConfirmation !== 'DELETE' || !window.confirm('Esto desactiva la cuenta, revoca sesiones y minimiza datos. Continuar?')) {
      return;
    }
    await this.run(async () => {
      await this.account.requestDataDelete(this.deleteConfirmation);
      await this.auth.logout();
      this.notice = 'Cuenta desactivada.';
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.saving = true;
    this.error = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'No se pudo completar la accion.';
    } finally {
      this.saving = false;
    }
  }

  private listenForAliasChecks(): void {
    this.aliasCheckSub = this.aliasChecks.pipe(
      debounceTime(500),
      distinctUntilChanged(),
      switchMap((alias) => from(this.account.checkAliasAvailable(alias)).pipe(
        map((available) => ({ alias, available, failed: false })),
        catchError(() => of({ alias, available: false, failed: true })),
      )),
    ).subscribe(({ alias, available, failed }) => {
      if (alias !== this.normalizeAlias(this.alias) || alias === this.originalAlias) {
        return;
      }
      this.aliasStatus = failed
        ? 'idle'
        : available ? 'available' : 'taken';
    });
  }

  private async ensureShareQr(): Promise<void> {
    if (this.shareQrDataUrl) {
      return;
    }
    this.shareBusy = true;
    try {
      const QRCode = await import('qrcode');
      this.shareQrDataUrl = await QRCode.toDataURL(this.shareUrl(), {
        margin: 1,
        width: 280,
        color: {
          dark: '#03100d',
          light: '#ffffff',
        },
      });
    } finally {
      this.shareBusy = false;
    }
  }

  private initializeTheme(): void {
    this.lightTheme = this.readStoredTheme();
    this.applyTheme(this.lightTheme);
  }

  private applyTheme(enabled: boolean): void {
    if (typeof document === 'undefined') {
      return;
    }
    document.body.classList.toggle('nivra-light-theme', enabled);
    document.documentElement.classList.toggle('nivra-light-theme', enabled);
  }

  private readStoredTheme(): boolean {
    try {
      const value = localStorage.getItem(THEME_STORAGE_KEY);
      if (value === 'light') {
        return true;
      }
      if (value === 'dark') {
        return false;
      }
      return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
    } catch {
      return false;
    }
  }

  private writeStoredTheme(enabled: boolean): void {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, enabled ? 'light' : 'dark');
    } catch {
      // Theme preference is nice to keep, but private modes can block storage.
    }
  }

  private async syncNativeKeyboard(enabled: boolean): Promise<void> {
    try {
      await Keyboard.setStyle({ style: enabled ? KeyboardStyle.Light : KeyboardStyle.Dark });
    } catch {
      // Web and desktop do not expose the native keyboard bridge.
    }
  }

  private contactAliasFromQr(text: string): string | null {
    const value = text.trim();
    if (!value) {
      return null;
    }
    try {
      const url = new URL(value);
      const alias = url.searchParams.get('alias') || '';
      return this.normalizeContactAlias(alias);
    } catch {
      return this.normalizeContactAlias(value);
    }
  }

  private normalizeContactAlias(value: string): string | null {
    const alias = value.trim().replace(/^@/, '');
    return /^[a-zA-Z0-9_.-]{3,32}$/.test(alias) ? alias.toLowerCase() : null;
  }

  private normalizeAlias(value: string): string {
    return value.trim().replace(/^@+/, '').toLowerCase();
  }

  private async resizeProfilePhoto(file: File): Promise<string> {
    const image = await this.loadImage(file);
    const maxSide = 512;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
    let width = Math.max(1, Math.round((image.naturalWidth || maxSide) * scale));
    let height = Math.max(1, Math.round((image.naturalHeight || maxSide) * scale));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('No se pudo preparar la imagen.');
    }

    let quality = 0.86;
    let dataUrl = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= 340000) {
        return dataUrl;
      }
      quality = Math.max(0.56, quality - 0.08);
      width = Math.max(160, Math.round(width * 0.82));
      height = Math.max(160, Math.round(height * 0.82));
    }
    if (dataUrl.length > 350000) {
      throw new Error('La imagen sigue siendo muy grande. Prueba otra foto.');
    }
    return dataUrl;
  }

  private loadImage(file: File): Promise<HTMLImageElement> {
    const objectUrl = URL.createObjectURL(file);
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      image.src = objectUrl;
    }).finally(() => {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    });
  }
}
