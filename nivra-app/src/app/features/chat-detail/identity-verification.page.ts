import { Location } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBackOutline, checkmarkCircleOutline, imageOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { AuthService } from '../../core/services/auth.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { IdentityTrustService } from '../../core/services/identity-trust.service';
import { PublicKeyDirectory } from '../../core/models/nivra.models';
import { CryptoService } from '../../core/services/crypto.service';
import { TranslateService } from '../../core/services/translate.service';
import { deriveUnverifiedSafetyNumber } from '../../core/utils/identity-fingerprint';

/** Only an in-app conversation can be used as a verification return destination. */
export function identityConversationReturnUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\/app\/chats\/[a-zA-Z0-9_-]+(?:[?#][^\r\n\\]*)?$/.test(value)) return null;
  return value;
}

@Component({
  standalone: true,
  imports: [FormsModule, TranslatePipe, IonIcon, IonSpinner],
  template: `
    <main class="identity-sheet">
      <header class="identity-header">
        <button type="button" class="back-action" (click)="back()">
          <ion-icon name="arrow-back-outline" aria-hidden="true"></ion-icon>
          {{ 'IDENTITY.BACK' | translate:'Volver' }}
        </button>
        <span class="privacy-label"><ion-icon name="shield-checkmark-outline" aria-hidden="true"></ion-icon>{{ 'IDENTITY.PRIVATE_CHECK' | translate:'Comparación privada' }}</span>
      </header>
      <section class="identity-card" aria-labelledby="identity-title">
        <div class="identity-heading">
          <span class="identity-mark" aria-hidden="true"><ion-icon name="shield-checkmark-outline"></ion-icon></span>
          <h1 id="identity-title">{{ 'IDENTITY.TITLE' | translate:'Verificar identidad' }}</h1>
          <p>{{ 'IDENTITY.COPY' | translate:'Compara este código con tu contacto en persona o mediante un canal de confianza. Incluye sus dispositivos registrados; añadir o retirar uno cambia el código.' }}</p>
        </div>
        @if (loading) {
          <div class="identity-loading" role="status"><ion-spinner name="crescent"></ion-spinner><span>{{ 'IDENTITY.LOADING' | translate:'Preparando el código de seguridad…' }}</span></div>
        } @else if (qr) {
          <div class="identity-qr"><img [src]="qr" [alt]="'IDENTITY.QR_ALT' | translate:'Código QR de comparación'" width="256" height="256"></div>
          <p class="safety-code" dir="ltr">{{ code }}</p>
          <label class="comparison-field">
            <span>{{ 'IDENTITY.CONTACT_CODE' | translate:'Código que muestra tu contacto' }}</span>
            <input [(ngModel)]="comparison" autocomplete="off" autocapitalize="off" [spellcheck]="false" [disabled]="busy || scanning" [placeholder]="'IDENTITY.CODE_PLACEHOLDER' | translate:'Pega su código de seguridad'">
          </label>
          <input #qrFile type="file" accept="image/*" hidden (change)="scan($event)">
          <button type="button" class="image-action" (click)="qrFile.click()" [disabled]="busy || scanning">
            @if (scanning) { <ion-spinner name="crescent"></ion-spinner> } @else { <ion-icon name="image-outline" aria-hidden="true"></ion-icon> }
            {{ 'IDENTITY.READ_IMAGE' | translate:'Leer QR de una imagen' }}
          </button>
          <div id="identity-file-reader" class="file-reader" aria-hidden="true"></div>
          <button type="button" class="confirm-action" [disabled]="busy || scanning || !comparison.trim()" (click)="confirm()">
            @if (busy) { <ion-spinner name="crescent"></ion-spinner> } @else { <ion-icon name="checkmark-circle-outline" aria-hidden="true"></ion-icon> }
            {{ 'IDENTITY.CONFIRM' | translate:'Comparar y guardar verificación' }}
          </button>
        } @else {
          <button type="button" class="image-action" (click)="loadIdentity()">{{ 'COMMON.RETRY' | translate:'Reintentar' }}</button>
        }
        @if (message) { <p class="identity-feedback" [class.success]="verified" role="status" aria-live="polite">{{ message }}</p> }
      </section>
    </main>`,
  styles: [`
    :host{
      /* Capacitor supplies the unconsumed inset; Ionic/browser values are fallbacks, never added together. */
      --identity-safe-top:var(--safe-area-inset-top,var(--ion-safe-area-top,env(safe-area-inset-top,0px)));
      --identity-safe-bottom:var(--safe-area-inset-bottom,var(--ion-safe-area-bottom,env(safe-area-inset-bottom,0px)));
      display:block;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;color:var(--nivra-text);padding-bottom:calc(28px + var(--identity-safe-bottom));scroll-padding-top:calc(80px + var(--identity-safe-top))
    }
    *{box-sizing:border-box}.identity-sheet{max-width:640px;margin:24px auto;padding:0 20px}.identity-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.back-action{display:inline-flex;align-items:center;gap:7px;min-height:44px;padding:8px 12px;border:0;border-radius:12px;background:transparent;color:var(--nivra-text);font:inherit;font-weight:650}.privacy-label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--nivra-muted)}.privacy-label ion-icon{font-size:17px;color:var(--nivra-brand-2)}.identity-card{border:1px solid var(--nivra-line);border-radius:24px;padding:28px;background:var(--ion-background-color);box-shadow:var(--nivra-shadow-soft)}.identity-heading{text-align:center}.identity-mark{display:grid;place-items:center;margin:0 auto 16px;width:52px;height:52px;border:1px solid rgba(var(--ion-color-primary-rgb),.2);border-radius:17px;background:rgba(var(--ion-color-primary-rgb),.1);color:var(--nivra-brand-2);font-size:28px}h1{font-size:clamp(24px,5vw,30px);line-height:1.15;letter-spacing:-.025em;margin:0 0 12px}.identity-heading p{margin:0 auto 22px;max-width:52ch;color:var(--nivra-muted);font-size:14px;line-height:1.6}.identity-qr{width:min(280px,100%);margin:0 auto;background:#fff;border-radius:18px;padding:8px;box-shadow:0 0 0 1px var(--nivra-line)}img{display:block;width:100%;height:auto}.safety-code{margin:20px 0 24px;padding:14px;border:1px solid var(--nivra-line);border-radius:12px;background:rgba(var(--ion-text-color-rgb),.025);font-family:monospace;font-size:16px;line-height:1.8;overflow-wrap:anywhere;text-align:center;user-select:all}.comparison-field{display:grid;gap:9px;font-size:14px;font-weight:600}.comparison-field input{min-width:0;min-height:52px;width:100%;padding:14px;border:1px solid var(--nivra-line);border-radius:12px;background:rgba(var(--ion-text-color-rgb),.025);color:inherit;font:inherit;font-weight:400}.comparison-field input::placeholder{color:var(--nivra-muted)}.comparison-field input:focus{outline:2px solid var(--nivra-brand-2);outline-offset:2px}.image-action,.confirm-action{display:flex;justify-content:center;align-items:center;gap:9px;width:100%;min-height:50px;padding:12px 16px;border:1px solid var(--nivra-line);border-radius:12px;font:inherit;font-size:14px;font-weight:700;line-height:1.35;cursor:pointer}.image-action{margin-top:12px;color:var(--nivra-text);background:transparent}.confirm-action{margin-top:20px;color:var(--ion-color-primary-contrast);background:var(--ion-color-primary);border-color:transparent}button:focus-visible{outline:2px solid var(--nivra-brand-2);outline-offset:3px}button:disabled{opacity:.55;cursor:default}button ion-icon{font-size:21px;flex:0 0 auto}ion-spinner{width:21px;height:21px;flex:0 0 auto}.identity-feedback{margin:18px 0 0;padding:13px 15px;border:1px solid rgba(var(--ion-color-danger-rgb),.2);border-radius:12px;color:var(--nivra-text);background:rgba(var(--ion-color-danger-rgb),.07);font-size:14px;line-height:1.5}.identity-feedback.success{border-color:rgba(var(--ion-color-primary-rgb),.25);background:rgba(var(--ion-color-primary-rgb),.08)}.identity-loading{min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--nivra-muted);font-size:14px}.identity-loading ion-spinner{width:30px;height:30px;color:var(--nivra-brand-2)}.file-reader{position:absolute;width:1px;height:1px;overflow:hidden;pointer-events:none}
    .identity-sheet{margin:0 auto;padding:0 max(20px,var(--safe-area-inset-right,env(safe-area-inset-right,0px))) 0 max(20px,var(--safe-area-inset-left,env(safe-area-inset-left,0px)))}
    .identity-header{position:sticky;top:0;z-index:2;min-height:calc(80px + var(--identity-safe-top));padding:calc(18px + var(--identity-safe-top)) 0 14px;background:var(--ion-background-color);border-bottom:1px solid var(--nivra-line);margin-bottom:20px}
    .back-action{min-width:44px;flex-shrink:0;background:rgba(var(--ion-color-primary-rgb),.075);border:1px solid rgba(var(--ion-color-primary-rgb),.12);cursor:pointer;transition:background-color .16s ease,transform .12s ease}
    .back-action:hover{background:rgba(var(--ion-color-primary-rgb),.12)}.back-action:active{transform:scale(.97)}
    .privacy-label{min-width:0;line-height:1.4}.privacy-label ion-icon{flex-shrink:0}
    @media(max-width:600px){
      .identity-sheet{padding:0 max(14px,var(--safe-area-inset-right,env(safe-area-inset-right,0px))) 0 max(14px,var(--safe-area-inset-left,env(safe-area-inset-left,0px)))}
      .identity-header{min-height:calc(72px + var(--identity-safe-top));padding-top:calc(12px + var(--identity-safe-top));padding-bottom:12px;margin-bottom:16px}
      .identity-card{padding:24px 18px;border-radius:22px}.privacy-label{max-width:48%;text-align:end}.safety-code{font-size:14px}.identity-qr{width:min(264px,100%)}
    }
    @media(prefers-reduced-motion:reduce){.back-action{transition:none}.back-action:active{transform:none}}
  `],
})
export class IdentityVerificationPage implements OnInit, OnDestroy {
  private readonly crypto = inject(CryptoService);
  private readonly auth = inject(AuthService);
  private readonly api = inject(NivraApiService);
  private readonly trust = inject(IdentityTrustService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly translate = inject(TranslateService);
  private readonly navigation = this.router.getCurrentNavigation();
  private readonly returnUrl = identityConversationReturnUrl(this.navigation?.extras.state?.['identityReturnUrl'])
    ?? identityConversationReturnUrl((this.location.getState() as Record<string, unknown> | null)?.['identityReturnUrl']);
  private readonly previousUrl = this.navigation?.previousNavigation?.finalUrl?.toString();
  private target = '';
  private destroyed = false;
  code = '';
  qr = '';
  comparison = '';
  message = '';
  busy = false;
  scanning = false;
  loading = true;
  verified = false;

  constructor() {
    addIcons({ arrowBackOutline, checkmarkCircleOutline, imageOutline, shieldCheckmarkOutline });
  }

  ngOnInit(): void {
    this.target = this.route.snapshot.paramMap.get('userId') || '';
    void this.loadIdentity();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
  }

  async loadIdentity(): Promise<void> {
    this.loading = true;
    this.message = '';
    this.verified = false;
    try {
      const pair = await this.load();
      const code = (await deriveUnverifiedSafetyNumber(pair[0], pair[1])).display;
      const qrModule = await import('qrcode');
      const qr = await qrModule.toDataURL(`nivra-identity-v1:${code}`, { width: 256, margin: 2 });
      if (!this.destroyed) {
        this.code = code;
        this.qr = qr;
      }
    } catch {
      if (!this.destroyed) this.message = this.t('IDENTITY.LOAD_ERROR', 'No se pudieron cargar las llaves. Reintenta con conexión.');
    } finally {
      if (!this.destroyed) this.loading = false;
    }
  }

  private async load(): Promise<[PublicKeyDirectory, PublicKeyDirectory]> {
    const current = this.auth.session();
    if (!current || !this.target || current.user.id === this.target) throw new Error();
    const list = await firstValueFrom(this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: [current.user.id, this.target], aliases: [] }));
    const own = list.find(x => x.userId === current.user.id);
    const other = list.find(x => x.userId === this.target);
    if (!own || !other) throw new Error();
    const local = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const published = this.crypto.parsePublicJwk(own.devices.find(x => x.deviceId === current.device.id)?.keyBundle?.identityKey);
    if (!published || published.x !== local.publicJwk.x || published.y !== local.publicJwk.y) throw new Error('Published key mismatch');
    const active = this.auth.session();
    if (this.destroyed || active?.user.id !== current.user.id || active?.device.id !== current.device.id) throw new Error('Account changed');
    return [own, other];
  }

  async confirm(): Promise<void> {
    if (this.busy || this.destroyed) return;
    this.busy = true;
    this.verified = false;
    try {
      const normalized = this.comparison.replace(/^nivra-identity-v1:/, '').replace(/\s/g, '').toLowerCase();
      if (!this.code || normalized !== this.code.replace(/\s/g, '')) {
        this.message = this.t('IDENTITY.MISMATCH', 'Los códigos no coinciden. No se ha aceptado la identidad.');
        return;
      }
      const scope = this.auth.session();
      const pair = await this.load();
      if ((await deriveUnverifiedSafetyNumber(pair[0], pair[1])).display !== this.code) {
        this.message = this.t('IDENTITY.KEYS_CHANGED', 'Las llaves cambiaron durante la comparación. Vuelve a abrir esta pantalla.');
        return;
      }
      const current = this.auth.session();
      if (this.destroyed || !scope || !current || current.user.id !== scope.user.id || current.device.id !== scope.device.id) return;
      await this.trust.confirm(JSON.stringify([current.user.id, current.device.id]), pair[1]);
      if (!this.destroyed) {
        this.verified = true;
        this.message = this.t('IDENTITY.SAVED', 'Código comparado y verificación guardada en este dispositivo.');
      }
    } catch {
      if (!this.destroyed) this.message = this.t('IDENTITY.SAVE_ERROR', 'No se pudo guardar la verificación. Reintenta con conexión.');
    } finally {
      this.busy = false;
    }
  }

  async scan(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy || this.scanning || this.destroyed) return;
    this.scanning = true;
    this.message = '';
    let scanner: import('html5-qrcode').Html5Qrcode | undefined;
    try {
      const module = await import('html5-qrcode');
      if (this.destroyed) return;
      scanner = new module.Html5Qrcode('identity-file-reader');
      const comparison = await scanner.scanFile(file, false);
      if (!this.destroyed) {
        this.comparison = comparison;
        await this.confirm();
      }
    } catch {
      if (!this.destroyed) this.message = this.t('IDENTITY.SCAN_ERROR', 'No se pudo leer el QR de la imagen.');
    } finally {
      try { scanner?.clear(); } catch { /* The route may already have removed the reader. */ }
      this.scanning = false;
    }
  }

  back(): void {
    if (this.returnUrl && this.navigation?.trigger === 'imperative' && this.previousUrl === this.returnUrl) {
      this.location.back();
      return;
    }
    void this.router.navigateByUrl(this.returnUrl ?? '/app/chats', { replaceUrl: true });
  }

  private t(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }
}
