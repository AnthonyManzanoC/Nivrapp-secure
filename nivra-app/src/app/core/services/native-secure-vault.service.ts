import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { NivraNative } from './native-plugin';

export type NativeSecureSecretName = 'local-db' | 'device-keys' | 'auth-session';

interface SecureSecretResponse {
  name?: string;
  secret?: string;
  created?: boolean;
  available?: boolean;
}

export interface NativeLocalHistoryInspection {
  databaseExists: boolean;
  databaseFormat: 'missing' | 'sqlite' | 'encrypted-or-unknown' | 'unavailable';
}

export interface NivraNativeSecurePlugin {
  getOrCreateSecureSecret(options: { name: NativeSecureSecretName; create?: boolean }): Promise<SecureSecretResponse>;
  clearSecureSecret(options: { name?: NativeSecureSecretName | 'all' }): Promise<void>;
  retryLocalHistoryInitialization(): Promise<void>;
  inspectLocalHistoryStorage(): Promise<NativeLocalHistoryInspection>;
}

interface DesktopSecureVaultBridge {
  readonly readOnlySupported?: boolean;
  getOrCreateSecret(name: NativeSecureSecretName, options?: { create?: boolean }): Promise<SecureSecretResponse>;
  clearSecret(name: NativeSecureSecretName | 'all'): Promise<void>;
}

declare global {
  interface Window {
    nivraSecureVault?: DesktopSecureVaultBridge;
  }
}

@Injectable({ providedIn: 'root' })
export class NativeSecureVaultService {
  readonly native = Boolean(Capacitor.isNativePlatform?.());
  private readonly desktop = this.resolveDesktopVault();
  private readonly secureVaultExpected = this.native || Boolean(this.desktop);

  async getOrCreateSecret(name: NativeSecureSecretName, options: { create?: boolean } = {}): Promise<string | null> {
    // An older preload silently ignores additional arguments. Fail closed on
    // a read-only request rather than letting that binary create a new key.
    if (!this.native && this.desktop && options.create === false && !this.desktop.readOnlySupported) return null;
    const response = this.native
      ? await NivraNative.getOrCreateSecureSecret(options.create === false ? { name, create: false } : { name })
      : await this.desktop?.getOrCreateSecret(name, options.create === false ? { create: false } : undefined);
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

  async retryLocalHistoryInitialization(): Promise<boolean> {
    if (!this.native || Capacitor.getPlatform() !== 'android') return false;
    try {
      await NivraNative.retryLocalHistoryInitialization();
      return true;
    } catch {
      return false;
    }
  }

  async inspectLocalHistoryStorage(): Promise<NativeLocalHistoryInspection | null> {
    if (!this.native || Capacitor.getPlatform() !== 'android') return null;
    try {
      const result = await NivraNative.inspectLocalHistoryStorage();
      const format = ['missing', 'sqlite', 'encrypted-or-unknown', 'unavailable'].includes(result.databaseFormat)
        ? result.databaseFormat : 'unavailable';
      return { databaseExists: result.databaseExists === true, databaseFormat: format };
    } catch { return null; }
  }

  private resolveDesktopVault(): DesktopSecureVaultBridge | null {
    if (typeof window === 'undefined') {
      return null;
    }
    return window.nivraSecureVault ?? null;
  }
}
