import { Location } from '@angular/common';
import { Component, InjectionToken, NgZone, OnDestroy, OnInit, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBackOutline, cameraOutline, checkmarkCircleOutline, closeOutline, copyOutline, imageOutline, shieldCheckmarkOutline, warningOutline } from 'ionicons/icons';
import { firstValueFrom, Subscription } from 'rxjs';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { AuthService } from '../../core/services/auth.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { IdentityContinuity, IdentityTrustService } from '../../core/services/identity-trust.service';
import { PublicKeyDirectory } from '../../core/models/nivra.models';
import { CryptoService } from '../../core/services/crypto.service';
import { TranslateService } from '../../core/services/translate.service';
import { deriveUnverifiedSafetyNumber } from '../../core/utils/identity-fingerprint';

type IdentityQrScanner = Pick<import('html5-qrcode').Html5Qrcode, 'start' | 'stop' | 'clear' | 'scanFile'>;
export const IDENTITY_QR_SCANNER_LOADER = new InjectionToken<() => Promise<(elementId: string) => IdentityQrScanner>>('IDENTITY_QR_SCANNER_LOADER', {
  providedIn: 'root', factory: () => async () => {
    const { Html5Qrcode } = await import('html5-qrcode');
    return (elementId) => new Html5Qrcode(elementId);
  },
});

/** Only an in-app conversation can be used as a verification return destination. */
export function identityConversationReturnUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\/app\/chats\/[a-zA-Z0-9_-]+(?:[?#][^\r\n\\]*)?$/.test(value)) return null;
  return value;
}

@Component({
  standalone: true,
  imports: [FormsModule, TranslatePipe, LocalizedDatePipe, IonIcon, IonSpinner],
  templateUrl: './identity-verification.page.html',
  styleUrls: ['./identity-verification.page.scss'],
})
export class IdentityVerificationPage implements OnInit, OnDestroy {
  private readonly crypto = inject(CryptoService);
  private readonly auth = inject(AuthService);
  private readonly lock = inject(AppLockService);
  private readonly api = inject(NivraApiService);
  private readonly trust = inject(IdentityTrustService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly translate = inject(TranslateService);
  private readonly zone = inject(NgZone);
  private readonly scannerLoader = inject(IDENTITY_QR_SCANNER_LOADER);
  private readonly navigation = this.router.getCurrentNavigation();
  private readonly returnUrl = identityConversationReturnUrl(this.navigation?.extras.state?.['identityReturnUrl'])
    ?? identityConversationReturnUrl((this.location.getState() as Record<string, unknown> | null)?.['identityReturnUrl']);
  private readonly previousUrl = this.navigation?.previousNavigation?.finalUrl?.toString();
  private target = '';
  private destroyed = false;
  private comparisonRequest = 0;
  private cameraEpoch = 0;
  private cameraScanner: IdentityQrScanner | null = null;
  private cameraHandling = false;
  private routeSub?: Subscription;
  private boundScope = this.sessionScope();
  private wasLocked = this.lock.isLocked();
  private readonly scopeEffect = effect(() => {
    const scope = this.sessionScope();
    const locked = this.lock.isLocked();
    if (scope !== this.boundScope || (locked && !this.wasLocked)) {
      this.boundScope = scope;
      this.comparisonRequest++;
      this.clearComparison();
      void this.stopCamera();
    } else if (!locked && this.wasLocked && this.target) {
      untracked(() => void this.loadIdentity());
    }
    this.wasLocked = locked;
  });
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden' && this.cameraOpen) this.cancelCamera();
  };
  code = '';
  qr = '';
  comparison = '';
  message = '';
  busy = false;
  scanning = false;
  loading = true;
  verified = false;
  continuity: IdentityContinuity['state'] | 'idle' = 'idle';
  verifiedAt = '';
  checkedAt = '';
  contactAlias = '';
  cameraOpen = false;
  cameraStarting = false;
  cameraCapturePending = false;
  cameraMessage = '';

  constructor() {
    addIcons({ arrowBackOutline, cameraOutline, checkmarkCircleOutline, closeOutline, copyOutline, imageOutline, shieldCheckmarkOutline, warningOutline });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  ngOnInit(): void {
    this.target = this.route.snapshot.paramMap.get('userId') || '';
    if (this.route.paramMap) {
      this.routeSub = this.route.paramMap.subscribe((params) => {
        const target = params.get('userId') || '';
        if (target !== this.target) {
          this.comparisonRequest++;
          this.clearComparison();
          void this.stopCamera();
          this.target = target;
          void this.loadIdentity();
        }
      });
    }
    void this.loadIdentity();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.comparisonRequest++;
    this.scopeEffect.destroy();
    this.routeSub?.unsubscribe();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    void this.stopCamera();
  }

  async loadIdentity(): Promise<void> {
    if (this.destroyed || this.lock.isLocked()) return;
    const scope = this.auth.session();
    const target = this.target;
    const request = ++this.comparisonRequest;
    const active = () => this.active(request, scope?.user.id, scope?.device.id, target);
    this.loading = true;
    this.message = '';
    this.verified = false;
    this.continuity = 'idle';
    this.code = '';
    this.qr = '';
    this.comparison = '';
    try {
      await this.stopCamera();
      if (!active()) return;
      const pair = await this.load();
      const code = (await deriveUnverifiedSafetyNumber(pair[0], pair[1])).display;
      if (!active()) return;
      const continuity = await this.trust.continuity(JSON.stringify([scope!.user.id, scope!.device.id]), pair[1]);
      const qr = await this.qrForComparison(code);
      if (active()) {
        this.code = code;
        this.qr = qr;
        this.contactAlias = pair[1].alias;
        this.continuity = continuity.state;
        this.verified = continuity.state === 'verified';
        this.verifiedAt = continuity.verifiedAt ?? '';
        this.checkedAt = new Date().toISOString();
      }
    } catch {
      if (active()) this.message = this.t('IDENTITY.LOAD_ERROR', 'No se pudieron cargar las llaves. Reintenta con conexión.');
    } finally {
      if (active()) this.loading = false;
    }
  }

  private async qrForComparison(code: string): Promise<string> {
    const qrModule = await import('qrcode');
    return qrModule.toDataURL(`nivra-identity-v1:${code}`, { width: 256, margin: 2 });
  }

  private sessionScope(): string {
    const session = this.auth.session();
    return JSON.stringify([session?.user.id ?? '', session?.device.id ?? '']);
  }

  private active(request: number, userId: string | undefined, deviceId: string | undefined, target: string): boolean {
    const current = this.auth.session();
    return !this.destroyed && !this.lock.isLocked() && request === this.comparisonRequest && Boolean(userId && deviceId)
      && current?.user.id === userId && current?.device.id === deviceId && this.target === target;
  }

  private clearComparison(): void {
    this.code = ''; this.qr = ''; this.comparison = ''; this.message = ''; this.contactAlias = '';
    this.verified = false; this.verifiedAt = ''; this.checkedAt = ''; this.continuity = 'idle';
    this.loading = false; this.busy = false; this.scanning = false;
  }

  private async load(): Promise<[PublicKeyDirectory, PublicKeyDirectory]> {
    const current = this.auth.session();
    const target = this.target;
    if (!current || !target || current.user.id === target) throw new Error();
    const list = await firstValueFrom(this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: [current.user.id, target], aliases: [] }));
    const own = list.find(x => x.userId === current.user.id);
    const other = list.find(x => x.userId === target);
    if (!own || !other) throw new Error();
    const local = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const published = this.crypto.parsePublicJwk(own.devices.find(x => x.deviceId === current.device.id)?.keyBundle?.identityKey);
    if (!published || published.x !== local.publicJwk.x || published.y !== local.publicJwk.y) throw new Error('Published key mismatch');
    const active = this.auth.session();
    if (this.destroyed || this.lock.isLocked() || target !== this.target || active?.user.id !== current.user.id || active.device.id !== current.device.id) throw new Error('Comparison changed');
    return [own, other];
  }

  async confirm(): Promise<void> {
    if (this.busy || this.destroyed || this.lock.isLocked()) return;
    const scope = this.auth.session();
    const target = this.target;
    const request = this.comparisonRequest;
    const active = () => this.active(request, scope?.user.id, scope?.device.id, target);
    const displayedCode = this.code;
    const normalized = this.comparison.replace(/^nivra-identity-v1:/, '').replace(/\s/g, '').toLowerCase();
    this.busy = true;
    this.verified = false;
    try {
      if (!displayedCode || !/^[a-f0-9]{64}$/.test(normalized) || normalized !== displayedCode.replace(/\s/g, '')) {
        this.message = this.t('IDENTITY.MISMATCH', 'Los códigos no coinciden. No se ha aceptado la identidad.');
        return;
      }
      const pair = await this.load();
      const latestCode = (await deriveUnverifiedSafetyNumber(pair[0], pair[1])).display;
      if (!active()) return;
      if (latestCode !== displayedCode) {
        this.message = this.t('IDENTITY.KEYS_CHANGED', 'Las llaves cambiaron durante la comparación. Vuelve a abrir esta pantalla.');
        this.continuity = 'changed';
        return;
      }
      const current = this.auth.session();
      if (!active() || !current) return;
      // Recheck scope inside the IDB write callback as well as after every await.
      await this.trust.confirm(JSON.stringify([current.user.id, current.device.id]), pair[1], active);
      if (active()) {
        this.verified = true;
        this.continuity = 'verified';
        this.verifiedAt = new Date().toISOString();
        this.message = this.t('IDENTITY.SAVED', 'Código comparado y verificación guardada en este dispositivo.');
      }
    } catch {
      if (active()) this.message = this.t('IDENTITY.SAVE_ERROR', 'No se pudo guardar la verificación. Reintenta con conexión.');
    } finally {
      if (active()) this.busy = false;
    }
  }

  async startCamera(): Promise<void> {
    if (this.cameraCapturePending || this.cameraStarting || this.cameraOpen || this.busy || this.scanning || !this.code || this.lock.isLocked()) return;
    const scope = this.auth.session();
    const target = this.target;
    const request = this.comparisonRequest;
    const epoch = ++this.cameraEpoch;
    const active = () => epoch === this.cameraEpoch && this.active(request, scope?.user.id, scope?.device.id, target);
    this.cameraOpen = true;
    this.cameraStarting = true;
    this.cameraCapturePending = true;
    this.cameraHandling = false;
    this.message = '';
    this.cameraMessage = this.t('IDENTITY.CAMERA_PREPARING', 'Preparando la cámara…');
    let scanner: IdentityQrScanner | null = null;
    try {
      await this.waitForCameraElement();
      const create = await this.scannerLoader();
      if (!active()) return;
      scanner = create('identity-camera-reader');
      this.cameraScanner = scanner;
      await scanner.start({ facingMode: 'environment' }, { fps: 8, qrbox: (width, height) => ({ width: Math.floor(Math.min(width, height) * .7), height: Math.floor(Math.min(width, height) * .7) }) }, (text) => {
        if (active() && !this.cameraHandling) {
          this.cameraHandling = true;
          this.zone.run(() => void this.acceptCameraCode(text, request, scope?.user.id, scope?.device.id, target));
        }
      }, () => undefined);
      if (!active()) { await this.disposeScanner(scanner); return; }
      this.cameraMessage = this.t('IDENTITY.CAMERA_POINT', 'Apunta al QR que muestra tu contacto en su dispositivo.');
    } catch {
      if (active()) {
        this.message = this.t('IDENTITY.CAMERA_ERROR', 'No se pudo abrir la cámara. Revisa el permiso o usa una imagen del QR.');
        await this.stopCamera();
      } else if (scanner) await this.disposeScanner(scanner);
    } finally {
      this.cameraCapturePending = false;
      if (epoch === this.cameraEpoch) this.cameraStarting = false;
    }
  }

  private async waitForCameraElement(): Promise<void> {
    // Let Angular render the reader before html5-qrcode creates its video element.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }

  private async acceptCameraCode(text: string, request: number, userId: string | undefined, deviceId: string | undefined, target: string): Promise<void> {
    await this.stopCamera();
    if (this.active(request, userId, deviceId, target)) await this.compareQr(text);
  }

  cancelCamera(): void {
    this.comparisonRequest++;
    void this.stopCamera();
  }

  async stopCamera(): Promise<void> {
    this.cameraEpoch++;
    this.cameraOpen = false;
    this.cameraStarting = false;
    const scanner = this.cameraScanner;
    this.cameraScanner = null;
    if (scanner) await this.disposeScanner(scanner);
  }

  private async disposeScanner(scanner: IdentityQrScanner): Promise<void> {
    try { await scanner.stop(); } catch { /* Html5Qrcode can throw synchronously while start is pending. */ }
    try { scanner.clear(); } catch { /* A pending start or route removal may still own the element. */ }
  }

  /** Only a QR explicitly obtained from the contact can establish a new local pin. */
  async compareQr(text: string): Promise<void> {
    if (!/^nivra-identity-v1:[a-fA-F0-9\s]+$/.test(text) || text.length > 180) {
      this.message = this.t('IDENTITY.INVALID_QR', 'Este QR no es un código de identidad de Nivra.');
      return;
    }
    this.comparison = text;
    await this.confirm();
  }

  async scan(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy || this.scanning || this.destroyed || this.lock.isLocked()) return;
    const scope = this.auth.session();
    const target = this.target;
    const request = this.comparisonRequest;
    const active = () => this.active(request, scope?.user.id, scope?.device.id, target);
    this.scanning = true;
    this.message = '';
    let scanner: IdentityQrScanner | undefined;
    try {
      const create = await this.scannerLoader();
      if (!active()) return;
      scanner = create('identity-file-reader');
      const comparison = await scanner.scanFile(file, false);
      if (active()) await this.compareQr(comparison);
    } catch {
      if (active()) this.message = this.t('IDENTITY.SCAN_ERROR', 'No se pudo leer el QR de la imagen.');
    } finally {
      try { scanner?.clear(); } catch { /* The route may already have removed the reader. */ }
      if (active()) this.scanning = false;
    }
  }

  async pasteCode(): Promise<void> {
    if (this.busy || this.scanning || this.destroyed || this.lock.isLocked()) return;
    const scope = this.auth.session();
    const request = this.comparisonRequest;
    const target = this.target;
    try {
      const comparison = await navigator.clipboard.readText();
      if (!this.active(request, scope?.user.id, scope?.device.id, target)) return;
      this.comparison = comparison.trim();
      await this.confirm();
    } catch {
      if (this.active(request, scope?.user.id, scope?.device.id, target)) this.message = this.t('IDENTITY.PASTE_ERROR', 'No se pudo leer el portapapeles. Puedes pegar el código en el campo.');
    }
  }

  back(): void {
    this.comparisonRequest++;
    void this.stopCamera();
    if (this.returnUrl && this.navigation?.trigger === 'imperative' && this.previousUrl === this.returnUrl) {
      this.location.back();
      return;
    }
    void this.router.navigateByUrl(this.returnUrl ?? '/app/chats', { replaceUrl: true });
  }

  private t(key: string, fallback: string): string { return this.translate.instant(key, fallback); }
}
