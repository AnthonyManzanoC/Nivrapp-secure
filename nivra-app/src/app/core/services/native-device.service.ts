import { Injectable, inject } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { AppSettingsService, type NivraAppSettings } from './app-settings.service';
import { AuthService } from './auth.service';

type AudioFocusMode = 'record' | 'playback';
type MediaKind = 'image' | 'video' | 'audio' | 'document';

declare global {
  interface Window {
    nivraContentProtection?: {
      setSecureScreen(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
    };
  }
}
export type RaiseGestureEvent = { kind: 'listen' | 'talk'; near: boolean; at: number };
export type NativeShareFile = {
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
};
export type NativeShareIntent = {
  id: string;
  action?: string;
  mimeType?: string;
  subject?: string;
  text?: string;
  files?: NativeShareFile[];
  at?: number;
};
export type NativeCallActionEvent = {
  action: 'answer' | 'reject' | 'open';
  callId?: string;
  callerName?: string;
  callerUserId?: string;
  callType?: string;
  conversationId?: string;
  at?: number;
};
export type NativeDeviceContact = {
  id?: string;
  displayName?: string;
  tel: string[];
};
export type FirebaseSigningDiagnostics = {
  platform: string;
  packageName: string;
  appVersion: string;
  appBuild: string;
  signingSha1: string;
  signingSha256: string;
};

interface NativeDiagnostics {
  platform?: string;
  packageName?: string;
  osVersion?: string;
  sdkInt?: number;
  manufacturer?: string;
  model?: string;
  appVersion?: string;
  appBuild?: string;
  signingSha1?: string;
  signingSha256?: string;
  memoryClassMb?: number;
  availableMemoryMb?: number;
  lowMemory?: boolean;
  powerSaveMode?: boolean;
  thermalStatus?: number;
}

interface SaveSessionResponse {
  sessionId: string;
}

interface SaveFileResponse {
  uri?: string;
  path?: string;
  public?: boolean;
}

interface PendingShareResponse {
  share?: NativeShareIntent | null;
}

interface SharedChunkResponse {
  base64?: string;
  bytesRead?: number;
  eof?: boolean;
}

interface DeviceContactsResponse {
  contacts?: NativeDeviceContact[];
  permission?: string;
}

interface NivraNativePlugin {
  setSecureScreen(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  setAudioFocus(options: { active: boolean; mode: AudioFocusMode }): Promise<{ active: boolean }>;
  configureRaiseGestures(options: { listen: boolean; talk: boolean }): Promise<{ enabled: boolean }>;
  diagnostics(): Promise<NativeDiagnostics>;
  writeClipboard(options: { value: string; label?: string }): Promise<void>;
  saveFileChunkedStart(options: { fileName: string; mimeType: string; public: boolean; mediaKind: MediaKind }): Promise<SaveSessionResponse>;
  saveFileChunk(options: { sessionId: string; base64: string }): Promise<void>;
  saveFileChunkedFinish(options: { sessionId: string }): Promise<SaveFileResponse>;
  saveFileChunkedAbort(options: { sessionId: string }): Promise<void>;
  showIncomingCall(options: {
    callId: string;
    callerName: string;
    callerUserId?: string;
    callType?: string;
    conversationId?: string;
  }): Promise<void>;
  clearIncomingCall(options: { callId: string }): Promise<void>;
  getPendingShareIntent(): Promise<PendingShareResponse>;
  clearPendingShareIntent(options: { id?: string }): Promise<void>;
  readSharedFileChunk(options: { uri: string; offset: number; length: number }): Promise<SharedChunkResponse>;
  getDeviceContacts(options: { requestPermission?: boolean; limit?: number }): Promise<DeviceContactsResponse>;
  addListener(eventName: 'raiseGesture', listener: (event: RaiseGestureEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'nativeCallAction', listener: (event: NativeCallActionEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'nativeShareIntent', listener: (event: NativeShareIntent) => void): Promise<PluginListenerHandle>;
}

const NivraNative = registerPlugin<NivraNativePlugin>('NivraNative');

@Injectable({ providedIn: 'root' })
export class NativeDeviceService {
  private readonly auth = inject(AuthService);
  private readonly appSettings = inject(AppSettingsService);

  readonly native = Capacitor.isNativePlatform();

  async setScreenshotsAllowed(allowed: boolean): Promise<void> {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('nivra-secure-screen', !allowed);
      document.body?.classList.toggle('nivra-secure-screen', !allowed);
    }
    if (!this.native) {
      await window.nivraContentProtection?.setSecureScreen({ enabled: !allowed }).catch(() => undefined);
      return;
    }
    await NivraNative.setSecureScreen({ enabled: !allowed }).catch(() => undefined);
  }

  async setAudioFocus(active: boolean, mode: AudioFocusMode): Promise<void> {
    if (!this.native) {
      return;
    }
    await NivraNative.setAudioFocus({ active, mode }).catch(() => undefined);
  }

  async configureRaiseGestures(settings: Pick<NivraAppSettings, 'raiseToListen' | 'raiseToTalk'>): Promise<void> {
    if (!this.native) {
      return;
    }
    await NivraNative.configureRaiseGestures({
      listen: Boolean(settings.raiseToListen),
      talk: Boolean(settings.raiseToTalk),
    }).catch(() => undefined);
  }

  async onRaiseGesture(listener: (event: RaiseGestureEvent) => void): Promise<PluginListenerHandle | null> {
    if (!this.native) {
      return null;
    }
    return NivraNative.addListener('raiseGesture', listener);
  }

  async showIncomingCall(options: {
    callId: string;
    callerName: string;
    callerUserId?: string;
    callType?: string;
    conversationId?: string;
  }): Promise<void> {
    if (!this.native || !options.callId) {
      return;
    }
    await NivraNative.showIncomingCall(options).catch(() => undefined);
  }

  async clearIncomingCall(callId: string | null | undefined): Promise<void> {
    if (!this.native || !callId) {
      return;
    }
    await NivraNative.clearIncomingCall({ callId }).catch(() => undefined);
  }

  async onNativeCallAction(listener: (event: NativeCallActionEvent) => void): Promise<PluginListenerHandle | null> {
    if (!this.native) {
      return null;
    }
    return NivraNative.addListener('nativeCallAction', listener);
  }

  async onNativeShareIntent(listener: (event: NativeShareIntent) => void): Promise<PluginListenerHandle | null> {
    if (!this.native) {
      return null;
    }
    return NivraNative.addListener('nativeShareIntent', listener);
  }

  async getPendingShareIntent(): Promise<NativeShareIntent | null> {
    if (!this.native) {
      return null;
    }
    const response = await NivraNative.getPendingShareIntent().catch(() => ({ share: null }));
    return response.share ?? null;
  }

  async clearPendingShareIntent(id?: string): Promise<void> {
    if (!this.native) {
      return;
    }
    await NivraNative.clearPendingShareIntent({ id }).catch(() => undefined);
  }

  async readDeviceContacts(options: { requestPermission?: boolean; limit?: number } = {}): Promise<NativeDeviceContact[]> {
    if (!this.native) {
      return [];
    }
    const response = await NivraNative.getDeviceContacts({
      requestPermission: options.requestPermission ?? true,
      limit: options.limit ?? 5000,
    });
    const contacts = Array.isArray(response.contacts) ? response.contacts : [];
    return contacts
      .map((contact) => ({
        id: typeof contact.id === 'string' ? contact.id : '',
        displayName: typeof contact.displayName === 'string' ? contact.displayName : '',
        tel: Array.isArray(contact.tel) ? contact.tel.map(String).filter(Boolean) : [],
      }))
      .filter((contact) => contact.tel.length > 0);
  }

  async sharedFileToFile(item: NativeShareFile): Promise<File> {
    if (!this.native || !item.uri) {
      throw new Error('Archivo compartido no disponible.');
    }
    const chunkSize = 384 * 1024;
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await NivraNative.readSharedFileChunk({
        uri: item.uri,
        offset,
        length: chunkSize,
      });
      const bytes = this.base64ToBytes(chunk.base64 || '');
      if (bytes.length) {
        chunks.push(bytes);
        offset += bytes.length;
      }
      if (chunk.eof || !bytes.length) {
        break;
      }
    }
    const mimeType = item.mimeType || 'application/octet-stream';
    const fileName = this.safeSharedFileName(item.name, mimeType);
    const parts = chunks.map((bytes) => bytes.slice().buffer as ArrayBuffer);
    return new File(parts, fileName, { type: mimeType, lastModified: Date.now() });
  }

  async copyToClipboard(value: string, label = 'Nivra'): Promise<void> {
    if (this.native) {
      await NivraNative.writeClipboard({ value, label });
      return;
    }
    await navigator.clipboard.writeText(value);
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const nativeDiagnostics = this.native ? await NivraNative.diagnostics().catch(() => ({})) : {};
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
    return {
      app: 'Nivra',
      platform: Capacitor.getPlatform(),
      native: this.native,
      userId: this.auth.session()?.user.id ?? null,
      alias: this.auth.session()?.user.alias ?? null,
      deviceId: this.auth.session()?.device.id ?? null,
      deviceName: this.auth.session()?.device.name ?? null,
      settings: this.appSettings.settings(),
      browser: typeof navigator !== 'undefined' ? {
        userAgent: navigator.userAgent,
        language: navigator.language,
        online: navigator.onLine,
      } : null,
      webMemory: memory ? {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      } : null,
      nativeDiagnostics,
      createdAt: new Date().toISOString(),
    };
  }

  async firebaseSigningDiagnostics(): Promise<FirebaseSigningDiagnostics | null> {
    if (!this.native) {
      return null;
    }
    const diagnostics = await NivraNative.diagnostics().catch(() => null);
    if (!diagnostics) {
      return null;
    }
    return {
      platform: String(diagnostics.platform || Capacitor.getPlatform()),
      packageName: String(diagnostics.packageName || 'com.nivra.app'),
      appVersion: String(diagnostics.appVersion || ''),
      appBuild: String(diagnostics.appBuild || ''),
      signingSha1: String(diagnostics.signingSha1 || ''),
      signingSha256: String(diagnostics.signingSha256 || ''),
    };
  }

  async saveBlob(blob: Blob, fileName: string, mimeType: string, savePublic: boolean, mediaKind: MediaKind): Promise<SaveFileResponse | null> {
    if (!this.native) {
      return null;
    }

    const session = await NivraNative.saveFileChunkedStart({
      fileName,
      mimeType,
      public: savePublic,
      mediaKind,
    });
    const sessionId = session.sessionId;
    try {
      const chunkSize = 512 * 1024;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const chunk = blob.slice(offset, Math.min(blob.size, offset + chunkSize));
        await NivraNative.saveFileChunk({
          sessionId,
          base64: await this.blobToBase64(chunk),
        });
      }
      return await NivraNative.saveFileChunkedFinish({ sessionId });
    } catch (error) {
      await NivraNative.saveFileChunkedAbort({ sessionId }).catch(() => undefined);
      throw error;
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  private base64ToBytes(value: string): Uint8Array {
    if (!value) {
      return new Uint8Array();
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private safeSharedFileName(name: string | null | undefined, mimeType: string): string {
    const cleaned = (name || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim();
    if (cleaned) {
      return cleaned;
    }
    const extension = mimeType.startsWith('image/') ? mimeType.slice(6)
      : mimeType.startsWith('video/') ? mimeType.slice(6)
        : mimeType.startsWith('audio/') ? mimeType.slice(6)
          : 'bin';
    return `nivra-share.${extension || 'bin'}`;
  }
}
