import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

export type NativeSecureSecretName = 'local-db' | 'device-keys' | 'auth-session';

interface SecureSecretResponse {
  name?: string;
  secret?: string;
  created?: boolean;
  available?: boolean;
}

interface NivraNativeSecurePlugin {
  getOrCreateSecureSecret(options: { name: NativeSecureSecretName }): Promise<SecureSecretResponse>;
  clearSecureSecret(options: { name?: NativeSecureSecretName | 'all' }): Promise<void>;
}

interface DesktopSecureVaultBridge {
  getOrCreateSecret(name: NativeSecureSecretName): Promise<SecureSecretResponse>;
  clearSecret(name: NativeSecureSecretName | 'all'): Promise<void>;
}

declare global {
  interface Window {
    nivraSecureVault?: DesktopSecureVaultBridge;
  }
}

const NivraNative = registerPlugin<NivraNativeSecurePlugin>('NivraNative');

@Injectable({ providedIn: 'root' })
export class NativeSecureVaultService {
  readonly native = Boolean(Capacitor.isNativePlatform?.());
  private readonly desktop = this.resolveDesktopVault();
  private readonly secureVaultExpected = this.native || Boolean(this.desktop);

  async getOrCreateSecret(name: NativeSecureSecretName): Promise<string | null> {
    const response = this.native
      ? await NivraNative.getOrCreateSecureSecret({ name })
      : await this.desktop?.getOrCreateSecret(name);
    if (!response || response.available === false) {
      return null;
    }
    const secret = String(response.secret || '').trim();
    return secret || null;
  }

  async clearSecret(name: NativeSecureSecretName | 'all'): Promise<void> {
    if (this.native) {
      await NivraNative.clearSecureSecret({ name }).catch(() => undefined);
    } else {
      await this.desktop?.clearSecret(name).catch(() => undefined);
    }
  }

  requiresProtection(): boolean {
    return this.secureVaultExpected;
  }

  private resolveDesktopVault(): DesktopSecureVaultBridge | null {
    if (typeof window === 'undefined') {
      return null;
    }
    return window.nivraSecureVault ?? null;
  }
}
