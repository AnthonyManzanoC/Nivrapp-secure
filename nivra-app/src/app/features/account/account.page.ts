import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  IonSpinner,
  IonTextarea,
  IonToggle,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { cameraOutline, imageOutline, logOutOutline, notificationsOffOutline, notificationsOutline, qrCodeOutline, refreshOutline, scanOutline, shieldCheckmarkOutline, trashOutline, warningOutline } from 'ionicons/icons';
import { AccountService } from '../../core/services/account.service';
import { AuthService } from '../../core/services/auth.service';
import { PrivacySettings } from '../../core/models/nivra.models';
import { PushService } from '../../core/services/push.service';

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea, IonToggle],
  templateUrl: './account.page.html',
  styleUrls: ['./account.page.scss'],
})
export class AccountPage implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly account = inject(AccountService);
  readonly push = inject(PushService);
  displayName = '';
  email = '';
  phone = '';
  bio = '';
  isDiscoverable = true;
  saving = false;
  notice = '';
  error = '';
  deleteConfirmation = '';
  qrText = '';
  qrScannerOpen = false;
  qrScannerBusy = false;
  qrScannerStatus = 'Listo para escanear.';
  private qrScanner: import('html5-qrcode').Html5Qrcode | null = null;

  constructor() {
    addIcons({ cameraOutline, imageOutline, logOutOutline, notificationsOffOutline, notificationsOutline, qrCodeOutline, refreshOutline, scanOutline, shieldCheckmarkOutline, trashOutline, warningOutline });
  }

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  ngOnDestroy(): void {
    void this.stopQrScanner();
  }

  async reload(): Promise<void> {
    await this.account.load();
    const user = this.auth.session()?.user;
    if (user) {
      this.displayName = user.displayName ?? '';
      this.email = user.email ?? '';
      this.phone = user.phone ?? '';
      this.bio = user.bio ?? '';
      this.isDiscoverable = user.isDiscoverable;
    }
  }

  async saveProfile(): Promise<void> {
    await this.run(async () => {
      await this.account.updateProfile({
        displayName: this.displayName || null,
        email: this.email || null,
        phone: this.phone || null,
        bio: this.bio || null,
        isDiscoverable: this.isDiscoverable,
      });
      this.notice = 'Perfil actualizado.';
    });
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

  async authorizeQr(): Promise<void> {
    await this.run(async () => {
      await this.auth.authorizeQrLoginText(this.qrText);
      this.qrText = '';
      await this.stopQrScanner();
      await this.account.load();
      this.notice = 'Dispositivo vinculado por QR.';
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
}
