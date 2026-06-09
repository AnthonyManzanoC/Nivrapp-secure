import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

@Injectable({ providedIn: 'root' })
export class DeviceWipeService {
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly history = inject(LocalHistoryService);
  private readonly secureVault = inject(NativeSecureVaultService);
  private readonly router = inject(Router);
  private wiping = false;

  async nukeDevice(reason = 'FORCE_WIPE'): Promise<void> {
    if (this.wiping) {
      return;
    }
    this.wiping = true;

    await this.auth.logout(true).catch(() => undefined);
    await this.crypto.destroyLocalDeviceKeyProtector().catch(() => undefined);
    await this.secureVault.clearSecret('all').catch(() => undefined);
    await this.crypto.closeLocalStore().catch(() => undefined);
    await this.history.wipeAllLocalData().catch(() => undefined);
    this.clearBrowserStorage();
    await Promise.all([
      this.clearCapacitorPreferences(),
      this.clearOriginCaches(),
      this.unregisterServiceWorkers(),
    ]);

    await this.router.navigateByUrl('/auth', { replaceUrl: true }).catch(() => undefined);
    window.setTimeout(() => window.location.reload(), reason === 'FORCE_WIPE' ? 80 : 160);
  }

  private clearBrowserStorage(): void {
    try {
      localStorage.clear();
    } catch {
      // Storage can be blocked in private modes.
    }
    try {
      sessionStorage.clear();
    } catch {
      // Storage can be blocked in private modes.
    }
  }

  private async clearCapacitorPreferences(): Promise<void> {
    const capacitor = globalThis as {
      Capacitor?: {
        Plugins?: {
          Preferences?: {
            clear?: () => Promise<void>;
          };
        };
      };
    };
    await capacitor.Capacitor?.Plugins?.Preferences?.clear?.().catch(() => undefined);
  }

  private async clearOriginCaches(): Promise<void> {
    if (!('caches' in window)) {
      return;
    }
    const names = await caches.keys().catch(() => []);
    await Promise.all(names.map((name) => caches.delete(name).catch(() => false)));
  }

  private async unregisterServiceWorkers(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  }
}
