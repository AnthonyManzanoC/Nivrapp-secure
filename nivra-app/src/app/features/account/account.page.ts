import { CommonModule, DatePipe } from '@angular/common';
import { Component, NgZone, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
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
import { AppSettingsService, NivraAppSettings, NivraThemeMode, NivraVisibility } from '../../core/services/app-settings.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { PanicPinService } from '../../core/services/panic-pin.service';
import { PushService } from '../../core/services/push.service';
import { NativeDeviceService } from '../../core/services/native-device.service';

const ALIAS_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const PIN_LENGTH = 4;

type AliasStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, TranslatePipe, IonButton, IonContent, IonIcon, IonInput, IonModal, IonSpinner, IonTextarea, IonToggle],
  templateUrl: './account.page.html',
  styleUrls: ['./account.page.scss'],
})
export class AccountPage implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly account = inject(AccountService);
  readonly appLock = inject(AppLockService);
  readonly appSettings = inject(AppSettingsService);
  readonly calls = inject(CallsService);
  readonly translate = inject(TranslateService);
  readonly panicPin = inject(PanicPinService);
  readonly push = inject(PushService);
  readonly nativeDevice = inject(NativeDeviceService);
  private readonly router = inject(Router);
  private readonly loadingController = inject(LoadingController);
  private readonly ngZone = inject(NgZone);
  alias = '';
  private originalAlias = '';
  displayName = '';
  email = '';
  phone = '';
  bio = '';
  profilePhotoDataUrl = '';
  profilePhotoDirty = false;
  isDiscoverable = true;
  allowStoryReposts = true;
  saving = false;
  private noticeValue = '';
  private noticeTimer: number | null = null;
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
  storageUsageBytes = 0;
  storageQuotaBytes = 0;
  readonly themeModeOptions: Array<{ label: string; labelKey: string; value: NivraThemeMode }> = [
    { label: 'Sistema', labelKey: 'settings.theme.system', value: 'system' },
    { label: 'Oscuro', labelKey: 'settings.theme.dark', value: 'dark' },
    { label: 'Claro', labelKey: 'settings.theme.light', value: 'light' },
  ];
  readonly accentChoices = [
    { label: 'Nivra', value: 'nivra', color: '#18d6a2', second: '#72f0ca' },
    { label: 'Azul', value: 'blue', color: '#2f8cff', second: '#7cc7ff' },
    { label: 'Verde', value: 'green', color: '#34c759', second: '#8ee99f' },
    { label: 'Ambar', value: 'amber', color: '#f59f00', second: '#ffd166' },
    { label: 'Rosa', value: 'rose', color: '#e04f85', second: '#ff9fbd' },
    { label: 'Violeta', value: 'violet', color: '#8b5cf6', second: '#c4a5ff' },
    { label: 'Cian', value: 'cyan', color: '#12b5cb', second: '#75e6f2' },
    { label: 'Slate', value: 'slate', color: '#64748b', second: '#b6c2d1' },
  ];
  readonly wallpaperChoices = [
    { label: 'Nivra', labelKey: 'settings.wallpaper.nivra', value: 'nivra' },
    { label: 'Limpio', labelKey: 'settings.wallpaper.clean', value: 'clean' },
    { label: 'Botanico', labelKey: 'settings.wallpaper.botanic', value: 'botanic' },
    { label: 'Nocturno', labelKey: 'settings.wallpaper.midnight', value: 'midnight' },
    { label: 'Papel', labelKey: 'settings.wallpaper.paper', value: 'paper' },
  ];
  readonly densityOptions = [
    { label: 'Dos lineas', labelKey: 'settings.chat.twoLines', value: 'two-line' },
    { label: 'Tres lineas', labelKey: 'settings.chat.threeLines', value: 'three-line' },
  ];
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
  readonly lowDataOptions = [
    { label: 'Nunca', labelKey: 'settings.lowData.never', value: 'never' },
    { label: 'Datos moviles', labelKey: 'settings.lowData.mobile', value: 'mobile' },
    { label: 'En roaming', labelKey: 'settings.lowData.roaming', value: 'roaming' },
    { label: 'Siempre', labelKey: 'settings.lowData.always', value: 'always' },
  ];
  readonly visibilityOptions: Array<{ label: string; labelKey: string; value: NivraVisibility }> = [
    { label: 'Todos', labelKey: 'ACCOUNT.EVERYONE', value: 'everyone' },
    { label: 'Mis contactos', labelKey: 'ACCOUNT.CONTACTS', value: 'contacts' },
    { label: 'Nadie', labelKey: 'ACCOUNT.NOBODY', value: 'nobody' },
  ];
  readonly visibilityRows: Array<{ label: string; labelKey: string; key: keyof NivraAppSettings }> = [
    { label: 'Numero de telefono', labelKey: 'ACCOUNT.PHONE_NUMBER', key: 'phoneVisibility' },
    { label: 'Ultima vez y en linea', labelKey: 'ACCOUNT.LAST_SEEN', key: 'lastSeenVisibility' },
    { label: 'Fotos del perfil', labelKey: 'ACCOUNT.PROFILE_PHOTOS', key: 'profilePhotoVisibility' },
    { label: 'Mensajes reenviados', labelKey: 'ACCOUNT.FORWARDED_MESSAGES', key: 'forwardedMessagesVisibility' },
    { label: 'Llamadas', labelKey: 'TABS.CALLS', key: 'callsVisibility' },
    { label: 'Mensajes de voz', labelKey: 'ACCOUNT.VOICE_MESSAGES', key: 'voiceMessagesVisibility' },
    { label: 'Mensajes', labelKey: 'ACCOUNT.MESSAGES', key: 'messagesVisibility' },
    { label: 'Cumpleanos', labelKey: 'ACCOUNT.BIRTHDAY', key: 'birthdayVisibility' },
    { label: 'Regalos', labelKey: 'ACCOUNT.GIFTS', key: 'giftsVisibility' },
    { label: 'Biografia', labelKey: 'ACCOUNT.BIO', key: 'bioVisibility' },
    { label: 'Musica guardada', labelKey: 'ACCOUNT.SAVED_MUSIC', key: 'savedMusicVisibility' },
    { label: 'Invitaciones', labelKey: 'ACCOUNT.INVITES', key: 'invitesVisibility' },
  ];
  readonly defaultTtlOptions = [
    { label: 'Sin expiracion', labelKey: 'ACCOUNT.NO_EXPIRATION', value: 0 },
    { label: '1 hora', labelKey: 'COMMON.1_HOUR', value: 3600 },
    { label: '24 horas', labelKey: 'COMMON.24_HOURS', value: 86400 },
    { label: '7 dias', labelKey: 'COMMON.7_DAYS', value: 604800 },
  ];
  private qrScanner: import('html5-qrcode').Html5Qrcode | null = null;
  private contactScanner: import('html5-qrcode').Html5Qrcode | null = null;
  private qrScanInFlight = false;
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
    await this.refreshStorageEstimate();
  }

  ngOnDestroy(): void {
    this.aliasCheckSub?.unsubscribe();
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
    }
    void this.stopQrScanner();
    void this.stopContactScanner();
  }

  get notice(): string {
    return this.noticeValue;
  }

  set notice(value: string) {
    this.noticeValue = value;
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    if (value) {
      this.noticeTimer = window.setTimeout(() => {
        if (this.noticeValue === value) {
          this.noticeValue = '';
        }
      }, 2500);
    }
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
      this.allowStoryReposts = user.allowStoryReposts !== false;
    }
    await this.refreshStorageEstimate();
  }

  async saveProfile(): Promise<void> {
    if (!this.canSaveProfile()) {
      this.error = this.aliasStatus === 'taken'
        ? this.t('ACCOUNT.ALIAS_TAKEN_DOT', 'Alias no disponible.')
        : this.aliasStatus === 'checking'
          ? this.t('ACCOUNT.WAIT_ALIAS_VALIDATION', 'Espera la validacion del alias.')
          : this.t('ACCOUNT.REVIEW_ALIAS', 'Revisa el alias antes de guardar.');
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
        allowStoryReposts: this.allowStoryReposts,
      });
      this.alias = this.auth.session()?.user?.alias ?? alias;
      this.originalAlias = this.normalizeAlias(this.alias);
      this.aliasStatus = 'idle';
      this.profilePhotoDirty = false;
      this.notice = this.t('ACCOUNT.PROFILE_UPDATED', 'Perfil actualizado.');
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
      this.error = this.t('ACCOUNT.SELECT_VALID_IMAGE', 'Selecciona una imagen valida.');
      return;
    }
    await this.run(async () => {
      this.profilePhotoDataUrl = await this.resizeProfilePhoto(file);
      this.profilePhotoDirty = true;
      this.notice = this.t('ACCOUNT.PHOTO_READY', 'Foto lista. Guarda el perfil para publicarla.');
    });
  }

  removeProfilePhoto(): void {
    this.profilePhotoDataUrl = '';
    this.profilePhotoDirty = true;
    this.notice = this.t('ACCOUNT.PHOTO_REMOVED', 'Foto quitada. Guarda el perfil para confirmar.');
  }

  async savePrivacy(): Promise<void> {
    const privacy = this.account.privacy();
    if (!privacy) {
      return;
    }
    await this.run(async () => {
      await this.account.updatePrivacy(privacy);
      this.notice = this.t('ACCOUNT.PRIVACY_UPDATED', 'Privacidad actualizada.');
    });
  }

  patchPrivacy(key: keyof PrivacySettings, value: boolean | number | string | null): void {
    this.account.privacy.update((privacy) => privacy ? { ...privacy, [key]: value } : privacy);
    const current = this.auth.session();
    if (current) {
      this.auth.updateUser({
        ...current.user,
        privacySettings: {
          ...(current.user.privacySettings ?? {}),
          [key]: value,
        },
      });
    }
  }

  patchPrivacyTtl(value: string): void {
    this.patchPrivacy('defaultMessageTtlSeconds', Number(value || 0));
  }

  async setSecureMode(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.run(async () => {
        this.appLock.disable();
        this.notice = this.t('ACCOUNT.SAFE_MODE_DISABLED', 'Modo Seguro desactivado.');
      });
      return;
    }

    if (this.appLock.isNativePlatform()) {
      await this.run(async () => {
        await this.appLock.enableMobileBiometrics();
        this.notice = `${this.t('ACCOUNT.SAFE_MODE_ENABLED_WITH', 'Modo Seguro activado con')} ${this.appLock.biometryLabel()}.`;
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
        this.pinSetupError = this.t('ACCOUNT.PINS_DO_NOT_MATCH', 'Los PIN no coinciden.');
      } else {
        this.pinSetupError = '';
      }
    }
  }

  async confirmWebPin(): Promise<void> {
    if (!this.appLock.isValidPin(this.setupPin) || !this.appLock.isValidPin(this.setupPinConfirm)) {
      this.pinSetupError = this.t('ACCOUNT.CREATE_CONFIRM_PIN_4', 'Crea y confirma un PIN de 4 digitos.');
      return;
    }
    if (this.setupPin !== this.setupPinConfirm) {
      this.pinSetupError = this.t('ACCOUNT.PINS_DO_NOT_MATCH', 'Los PIN no coinciden.');
      return;
    }

    await this.run(async () => {
      await this.appLock.enableWebPin(this.setupPin);
      this.notice = this.t('ACCOUNT.SAFE_MODE_PIN_ENABLED', 'Modo Seguro activado con PIN.');
      this.closePinSetupModal();
    });
  }

  async savePanicPin(): Promise<void> {
    const pin = this.panicPin.normalizePin(this.panicPinValue);
    const confirm = this.panicPin.normalizePin(this.panicPinConfirm);
    if (!this.panicPin.isValidPin(pin)) {
      this.error = this.t('ACCOUNT.PANIC_PIN_LENGTH_ERROR', 'El PIN de panico debe tener de 4 a 6 digitos.');
      return;
    }
    if (pin !== confirm) {
      this.error = this.t('ACCOUNT.PANIC_PIN_CONFIRM_ERROR', 'Confirma el mismo PIN de panico.');
      return;
    }

    await this.run(async () => {
      await this.panicPin.configure(pin);
      this.panicPinValue = '';
      this.panicPinConfirm = '';
      this.notice = this.t('ACCOUNT.PANIC_PIN_CONFIGURED', 'PIN de panico configurado localmente.');
    });
  }

  async clearPanicPin(): Promise<void> {
    await this.run(async () => {
      this.panicPin.clear();
      this.panicPinValue = '';
      this.panicPinConfirm = '';
      this.notice = this.t('ACCOUNT.PANIC_PIN_REMOVED', 'PIN de panico quitado.');
    });
  }

  setLightTheme(enabled: boolean): void {
    this.lightTheme = enabled;
    this.appSettings.set('themeMode', enabled ? 'light' : 'dark');
  }

  currentThemeMode(): NivraThemeMode {
    return this.appSettings.settings().themeMode;
  }

  resolvedLightTheme(): boolean {
    return this.appSettings.resolvedLightTheme();
  }

  themeModeIcon(value: NivraThemeMode = this.currentThemeMode()): string {
    if (value === 'system') {
      return 'phone-portrait-outline';
    }
    return value === 'light' ? 'sunny-outline' : 'moon-outline';
  }

  appearanceCopy(): string {
    const mode = this.currentThemeMode();
    if (mode === 'system') {
      return this.resolvedLightTheme()
        ? this.t('settings.theme.systemLightCopy', 'Siguiendo al celular: Nivra esta en claro.')
        : this.t('settings.theme.systemDarkCopy', 'Siguiendo al celular: Nivra esta en oscuro.');
    }
    return mode === 'light'
      ? this.t('ACCOUNT.APPEARANCE_LIGHT_COPY', 'Grises iOS, texto nitido y sombras suaves.')
      : this.t('ACCOUNT.APPEARANCE_DARK_COPY', 'Oscuro Nivra con contraste nocturno.');
  }

  themeModeDescription(value: NivraThemeMode): string {
    if (value === 'system') {
      return this.t('settings.theme.systemDescription', 'Sigue el modo del celular.');
    }
    return value === 'light'
      ? this.t('settings.theme.lightDescription', 'Siempre claro.')
      : this.t('settings.theme.darkDescription', 'Siempre oscuro.');
  }

  resolvedThemeLabel(): string {
    return this.resolvedLightTheme()
      ? this.t('settings.theme.light', 'Claro')
      : this.t('settings.theme.dark', 'Oscuro');
  }

  t(key: string, fallback = ''): string {
    return this.translate.instant(key, fallback);
  }

  setThemeMode(value: string): void {
    if (value === 'system' || value === 'dark' || value === 'light') {
      this.appSettings.set('themeMode', value);
      this.lightTheme = this.appSettings.resolvedLightTheme();
      this.notice = this.t('settings.notice.themeApplied', 'Tema aplicado.');
    }
  }

  setTextSetting(key: keyof NivraAppSettings, value: unknown): void {
    if (key === 'language') {
      this.setLanguage(String(value ?? 'es'));
      return;
    }
    this.appSettings.update({ [key]: String(value ?? '') } as Partial<NivraAppSettings>);
    this.notice = this.t('settings.notice.applied', 'Ajuste aplicado.');
  }

  setNumberSetting(key: keyof NivraAppSettings, value: string | number): void {
    this.appSettings.update({ [key]: Number(value) } as Partial<NivraAppSettings>);
    this.notice = this.t('settings.notice.applied', 'Ajuste aplicado.');
  }

  setBooleanSetting(key: keyof NivraAppSettings, value: boolean): void {
    this.appSettings.update({ [key]: value } as Partial<NivraAppSettings>);
    this.notice = this.t('settings.notice.applied', 'Ajuste aplicado.');
  }

  setAccent(value: string): void {
    this.appSettings.set('accentColor', value);
    this.notice = this.t('settings.notice.colorApplied', 'Color aplicado.');
  }

  setLanguage(value: string): void {
    this.translate.use(value);
    this.notice = this.t('settings.notice.languageApplied', 'Idioma aplicado en tiempo real.');
  }

  setVisibilitySetting(key: keyof NivraAppSettings, value: string): void {
    if (value === 'everyone' || value === 'contacts' || value === 'nobody') {
      this.appSettings.update({ [key]: value } as Partial<NivraAppSettings>);
      this.notice = this.t('ACCOUNT.LOCAL_PRIVACY_SAVED', 'Regla local de privacidad guardada.');
    }
  }

  resetAppSettings(): void {
    this.appSettings.reset();
    this.lightTheme = this.appSettings.resolvedLightTheme();
    this.notice = this.t('ACCOUNT.LOCAL_SETTINGS_RESTORED', 'Ajustes locales restaurados.');
  }

  applyPrivacyPreset(value: string): void {
    const patches: Record<string, PrivacySettings> = {
      private: {
        hideNotificationContent: true,
        allowForwarding: false,
        allowScreenshots: false,
        readReceipts: true,
        defaultMessageTtlSeconds: 86400,
        privacyPreset: 'private',
      },
      balanced: {
        hideNotificationContent: true,
        allowForwarding: true,
        allowScreenshots: false,
        readReceipts: true,
        defaultMessageTtlSeconds: null,
        privacyPreset: 'balanced',
      },
      open: {
        hideNotificationContent: false,
        allowForwarding: true,
        allowScreenshots: true,
        readReceipts: true,
        defaultMessageTtlSeconds: null,
        privacyPreset: 'open',
      },
    };
    const patch = patches[value] ?? patches['balanced'];
    this.account.privacy.update((privacy) => privacy ? { ...privacy, ...patch } : privacy);
    const current = this.auth.session();
    if (current) {
      this.auth.updateUser({
        ...current.user,
        privacySettings: {
          ...(current.user.privacySettings ?? {}),
          ...patch,
        },
      });
    }
    this.notice = this.t('ACCOUNT.PRESET_READY', 'Preset listo. Guarda privacidad para sincronizarlo.');
  }

  async clearDraftsAndPreviews(): Promise<void> {
    await this.run(async () => {
      const keys: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith('nivra.draft.') || key?.startsWith('nivra.pendingAttachment.')) {
          keys.push(key);
        }
      }
      keys.forEach((key) => localStorage.removeItem(key));
      this.notice = keys.length ? this.t('ACCOUNT.DRAFTS_DELETED', 'Borradores locales eliminados.') : this.t('ACCOUNT.NO_DRAFTS', 'No habia borradores locales guardados.');
      await this.refreshStorageEstimate();
    });
  }

  async copyDiagnostics(): Promise<void> {
    await this.run(async () => {
      const payload = {
        ...(await this.nativeDevice.diagnostics()),
        pushPermission: this.push.permission(),
        pushServerReady: this.push.serverReady(),
        storage: {
          usage: this.storageUsageBytes,
          quota: this.storageQuotaBytes,
        },
      };
      await this.nativeDevice.copyToClipboard(JSON.stringify(payload, null, 2), 'Nivra diagnostics');
      this.notice = this.t('ACCOUNT.DIAGNOSTICS_COPIED', 'Diagnostico copiado.');
    });
  }

  storageUsageLabel(): string {
    if (!this.storageUsageBytes && !this.storageQuotaBytes) {
      return this.t('COMMON.NOT_AVAILABLE', 'No disponible');
    }
    return `${this.formatBytes(this.storageUsageBytes)} de ${this.formatBytes(this.storageQuotaBytes)}`;
  }

  visibilityLabel(value: NivraVisibility): string {
    return this.visibilityOptions.find((option) => option.value === value)?.label ?? this.t('ACCOUNT.EVERYONE', 'Todos');
  }

  settingValue(key: keyof NivraAppSettings): string {
    return String(this.appSettings.settings()[key] ?? '');
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
      `${name} ${this.t('ACCOUNT.SHARE_LINE_1_SUFFIX', 'te invita a Nivra, mensajeria privada con chat y boveda cifrada.')}`,
      `${this.t('ACCOUNT.SHARE_LINE_2_PREFIX', 'Buscame como')} @${alias}.`,
      this.t('ACCOUNT.SHARE_LINE_3', 'Si ya tienes Nivra, abre este enlace para iniciar el chat:'),
      this.shareUrl(),
    ].join('\n');
  }

  async copyShareMessage(): Promise<void> {
    await this.run(async () => {
      await navigator.clipboard.writeText(this.shareMessage());
      this.notice = this.t('ACCOUNT.INVITE_COPIED', 'Invitacion copiada.');
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
      if (share.share && this.appSettings.settings().directShare) {
        await share.share(payload);
        this.notice = this.t('ACCOUNT.INVITE_READY', 'Invitacion lista para enviar.');
        return;
      }
      await navigator.clipboard.writeText(this.shareMessage());
      this.notice = this.t('ACCOUNT.SHARE_FALLBACK_COPIED', 'Tu navegador no comparte directo; copie la invitacion.');
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
    this.contactScannerStatus = this.t('ACCOUNT.PREPARING_CAMERA', 'Preparando camara...');
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
        (text) => this.ngZone.run(() => void this.handleContactQr(text)),
        () => undefined,
      );
      this.contactScannerStatus = this.t('ACCOUNT.POINT_CONTACT_QR', 'Apunta la camara al QR de contacto.');
    } catch (error) {
      this.contactScannerStatus = error instanceof Error ? error.message : this.t('ACCOUNT.CAMERA_OPEN_ERROR', 'No se pudo abrir la camara.');
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
    this.contactScannerStatus = this.t('ACCOUNT.READING_IMAGE', 'Leyendo imagen...');
    let tempScanner: import('html5-qrcode').Html5Qrcode | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.stopContactScanner({ keepOpen: true });
      const { Html5Qrcode } = await import('html5-qrcode');
      tempScanner = new Html5Qrcode('contactQrScannerRegion');
      const text = await tempScanner.scanFile(file, true);
      await this.ngZone.run(() => this.handleContactQr(text, { allowWhileBusy: true }));
    } catch (error) {
      this.contactScannerStatus = error instanceof Error ? error.message : this.t('ACCOUNT.QR_READ_ERROR', 'No se pudo leer ese QR.');
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
      this.notice = this.t('ACCOUNT.DEVICE_REVOKED', 'Dispositivo revocado.');
    });
  }

  async enablePush(): Promise<void> {
    await this.run(async () => {
      const ok = await this.push.requestPermissionAndRegister();
      if (ok) {
        await this.nativeDevice.ensureBatteryOptimizationExemption({ force: true });
      }
      this.notice = ok ? this.t('ACCOUNT.NOTIFICATIONS_ENABLED', 'Notificaciones activadas.') : this.t('ACCOUNT.NOTIFICATIONS_ENABLE_ERROR', 'No se pudo activar notificaciones en este navegador.');
    });
  }

  async revokePush(): Promise<void> {
    await this.run(async () => {
      await this.push.revokeCurrentToken();
      this.notice = this.t('ACCOUNT.NOTIFICATION_TOKEN_REVOKED', 'Token de notificaciones revocado.');
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
        message: this.t('ACCOUNT.LINKING_SECURE_DEVICE', 'Vinculando dispositivo seguro...'),
        spinner: 'crescent',
        backdropDismiss: false,
      });
      await loading.present();
      try {
        await this.auth.authorizeQrLoginText(this.qrText);
        this.qrText = '';
        await this.stopQrScanner();
        await this.account.load();
        this.notice = this.t('ACCOUNT.DEVICE_LINKED_QR', 'Dispositivo vinculado por QR.');
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
    this.qrScannerStatus = this.t('ACCOUNT.PREPARING_SECURE_CAMERA', 'Preparando camara segura...');
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
        (text) => this.ngZone.run(() => void this.handleScannedQr(text)),
        () => undefined,
      );
      this.qrScannerStatus = this.t('ACCOUNT.POINT_NIVRA_QR', 'Apunta la camara al QR de Nivra.');
    } catch (error) {
      this.qrScannerStatus = error instanceof Error ? error.message : this.t('ACCOUNT.CAMERA_OPEN_ERROR', 'No se pudo abrir la camara.');
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
    this.qrScannerStatus = this.t('ACCOUNT.READING_IMAGE', 'Leyendo imagen...');
    let tempScanner: import('html5-qrcode').Html5Qrcode | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.stopQrScanner({ keepOpen: true });
      const { Html5Qrcode } = await import('html5-qrcode');
      tempScanner = new Html5Qrcode('qrScannerRegion');
      const text = await tempScanner.scanFile(file, true);
      await this.ngZone.run(() => this.handleScannedQr(text, { allowWhileBusy: true }));
    } catch (error) {
      this.qrScannerStatus = error instanceof Error ? error.message : this.t('ACCOUNT.QR_READ_ERROR', 'No se pudo leer ese QR.');
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
    if (!text || this.qrScanInFlight || (this.qrScannerBusy && !options.allowWhileBusy)) {
      return;
    }
    this.qrScanInFlight = true;
    this.qrScannerBusy = true;
    this.qrText = text;
    this.qrScannerStatus = this.t('ACCOUNT.QR_DETECTED_AUTHORIZING', 'QR detectado. Autorizando dispositivo...');
    try {
      await this.authorizeQr();
    } finally {
      this.qrScannerBusy = false;
      this.qrScanInFlight = false;
    }
  }

  private async handleContactQr(text: string, options: { allowWhileBusy?: boolean } = {}): Promise<void> {
    if (!text || (this.contactScannerBusy && !options.allowWhileBusy)) {
      return;
    }
    this.contactScannerBusy = true;
    this.contactScannerStatus = this.t('ACCOUNT.QR_DETECTED_OPENING_CONTACT', 'QR detectado. Abriendo contacto...');
    try {
      const alias = this.contactAliasFromQr(text);
      if (!alias) {
        throw new Error(this.t('ACCOUNT.INVALID_CONTACT_QR', 'Ese QR no parece ser de contacto Nivra.'));
      }
      await this.stopContactScanner();
      await this.router.navigate(['/contact'], { queryParams: { alias } });
    } catch (error) {
      this.contactScannerStatus = error instanceof Error ? error.message : this.t('ACCOUNT.CONTACT_OPEN_ERROR', 'No se pudo abrir ese contacto.');
    } finally {
      this.contactScannerBusy = false;
    }
  }

  async deleteAccount(): Promise<void> {
    if (this.deleteConfirmation !== 'DELETE' || !window.confirm(this.t('ACCOUNT.DELETE_CONFIRM', 'Esto desactiva la cuenta, revoca sesiones y minimiza datos. Continuar?'))) {
      return;
    }
    await this.run(async () => {
      await this.account.requestDataDelete(this.deleteConfirmation);
      await this.auth.logout();
      this.notice = this.t('ACCOUNT.ACCOUNT_DISABLED', 'Cuenta desactivada.');
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.saving = true;
    this.error = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.t('COMMON.ACTION_ERROR', 'No se pudo completar la accion.');
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
    this.lightTheme = this.appSettings.resolvedLightTheme();
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
      image.onerror = () => reject(new Error(this.t('ACCOUNT.IMAGE_READ_ERROR', 'No se pudo leer la imagen.')));
      image.src = objectUrl;
    }).finally(() => {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    });
  }

  async refreshStorageEstimate(): Promise<void> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      this.storageUsageBytes = Math.round(estimate?.usage ?? 0);
      this.storageQuotaBytes = Math.round(estimate?.quota ?? 0);
    } catch {
      this.storageUsageBytes = 0;
      this.storageQuotaBytes = 0;
    }
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  }
}
