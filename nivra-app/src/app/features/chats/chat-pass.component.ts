import { Component, OnDestroy, effect, inject, output } from '@angular/core';
import { IonButton, IonIcon, IonModal, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline, copyOutline, shareSocialOutline } from 'ionicons/icons';
import * as QRCode from 'qrcode';
import { AuthService } from '../../core/services/auth.service';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { TranslateService } from '../../core/services/translate.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { NIVRA_UPDATE_URL } from '../../core/release';

export function chatPassUrl(alias: string): string {
  // A native WebView origin (https://localhost) cannot be opened by a contact.
  return `${NIVRA_UPDATE_URL}/contact?alias=${encodeURIComponent(alias)}`;
}

@Component({
  selector: 'app-chat-pass',
  standalone: true,
  imports: [IonButton, IonIcon, IonModal, IonSpinner, TranslatePipe],
  templateUrl: './chat-pass.component.html',
  styleUrls: ['./chat-pass.component.scss'],
})
export class ChatPassComponent implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly native = inject(NativeDeviceService);
  private readonly translate = inject(TranslateService);
  readonly closed = output<void>();
  readonly alias = this.auth.session()?.user.alias ?? '';
  readonly link = chatPassUrl(this.alias);
  private readonly ownerId = this.auth.session()?.user.id;
  private active = true;
  modalOpen = true;
  qr = '';
  busy = false;
  notice = '';
  error = '';

  constructor() {
    addIcons({ closeOutline, copyOutline, shareSocialOutline });
    effect(() => {
      if (this.auth.session()?.user.id !== this.ownerId) {
        this.active = false;
        this.modalOpen = false;
        this.qr = '';
        this.notice = '';
        this.error = '';
      }
    });
    void this.loadQr();
  }

  ngOnDestroy(): void { this.active = false; }
  close(): void { this.modalOpen = false; }

  async loadQr(): Promise<void> {
    this.error = '';
    try {
      const qr = await QRCode.toDataURL(this.link, { width: 280, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#082a23', light: '#ffffff' } });
      if (this.current()) this.qr = qr;
    } catch {
      if (this.current()) this.error = this.tr('CHATS.PASS_QR_ERROR', 'No se pudo crear el QR. Puedes compartir el enlace.');
    }
  }

  async copy(): Promise<void> {
    await this.run(async () => {
      await this.native.copyToClipboard(this.link, 'Nivra');
      if (this.current()) this.notice = this.tr('CHATS.PASS_COPIED', 'Enlace copiado. Envíalo a tu contacto para empezar.');
    });
  }

  async share(): Promise<void> {
    await this.run(async () => {
      if (navigator.share) {
        await navigator.share({ title: 'Nivra', text: `@${this.alias}`, url: this.link });
      } else {
        await this.native.copyToClipboard(this.link, 'Nivra');
        if (this.current()) this.notice = this.tr('CHATS.PASS_COPIED', 'Enlace copiado. Envíalo a tu contacto para empezar.');
      }
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy || !this.current()) return;
    this.busy = true;
    this.error = '';
    this.notice = '';
    try { await action(); }
    catch (error) {
      if (this.current() && !(error instanceof DOMException && error.name === 'AbortError')) {
        this.error = this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la acción.');
      }
    } finally { if (this.current()) this.busy = false; }
  }

  private current(): boolean { return this.active && this.auth.session()?.user.id === this.ownerId; }
  private tr(key: string, fallback: string): string { return this.translate.instant(key, fallback); }
}
