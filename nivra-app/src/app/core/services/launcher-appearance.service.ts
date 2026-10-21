import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

export const LAUNCHER_ICON_IDS = ['original', 'emerald', 'ivory'] as const;
export type LauncherIconId = typeof LAUNCHER_ICON_IDS[number];
export type LauncherAppearancePlatform = 'android' | 'windows' | 'unsupported';
export const LAUNCHER_APPEARANCE_TIMEOUT_MS = 6000;

export interface LauncherAppearanceBridge {
  getState(): Promise<unknown>;
  setIcon(icon: LauncherIconId): Promise<unknown>;
}

interface AndroidLauncherAppearance {
  getState(): Promise<unknown>;
  setIcon(options: { icon: LauncherIconId }): Promise<unknown>;
}

const AndroidLauncher = registerPlugin<AndroidLauncherAppearance>('LauncherAppearance');
declare global { interface Window { nivraLauncherAppearance?: LauncherAppearanceBridge; } }

export interface LauncherAppearanceRuntime {
  platform: LauncherAppearancePlatform;
  bridge: LauncherAppearanceBridge | null;
}

export const LAUNCHER_APPEARANCE_RUNTIME = new InjectionToken<LauncherAppearanceRuntime>('LauncherAppearanceRuntime', {
  providedIn: 'root',
  factory: () => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      return { platform: 'android', bridge: {
        getState: () => AndroidLauncher.getState(),
        setIcon: icon => AndroidLauncher.setIcon({ icon }),
      } };
    }
    const bridge = window.nivraLauncherAppearance;
    if (bridge || 'nivraSecureVault' in window) {
      return { platform: 'windows', bridge: bridge && typeof bridge.getState === 'function'
        && typeof bridge.setIcon === 'function' ? bridge : null };
    }
    return { platform: 'unsupported', bridge: null };
  },
});

function isIcon(value: unknown): value is LauncherIconId {
  return typeof value === 'string' && (LAUNCHER_ICON_IDS as readonly string[]).includes(value);
}

@Injectable({ providedIn: 'root' })
export class LauncherAppearanceService {
  private readonly runtime = inject(LAUNCHER_APPEARANCE_RUNTIME);
  private readonly selected = signal<LauncherIconId>('original');
  private readonly available = signal(false);
  private readonly clientPlatform = signal(this.runtime.platform);
  readonly current = this.selected.asReadonly();
  readonly supported = this.available.asReadonly();
  readonly platform = this.clientPlatform.asReadonly();
  readonly busy = signal(false);
  readonly error = signal<'unavailable' | 'failed' | null>(null);
  private refreshInFlight: Promise<void> | null = null;

  constructor() { void this.refresh(); }

  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (this.busy()) return Promise.resolve();
    if (!this.runtime.bridge || this.runtime.platform === 'unsupported') {
      this.available.set(false);
      this.error.set(this.runtime.platform === 'unsupported' ? null : 'unavailable');
      return Promise.resolve();
    }
    this.busy.set(true);
    this.error.set(null);
    this.refreshInFlight = this.readState().finally(() => {
      this.busy.set(false);
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async selectIcon(icon: LauncherIconId): Promise<boolean> {
    if (!isIcon(icon)) { this.error.set('failed'); return false; }
    if (this.busy()) return false;
    if (!this.runtime.bridge || !this.available()) { this.error.set('unavailable'); return false; }
    if (this.selected() === icon) { this.error.set(null); return true; }
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.withTimeout(() => this.runtime.bridge!.setIcon(icon));
      if (!result || typeof result !== 'object') throw new Error('Invalid native state');
      const state = result as { supported?: unknown; icon?: unknown };
      if (state.supported !== true || state.icon !== icon) throw new Error('Icon was not applied');
      this.selected.set(icon);
      return true;
    } catch {
      // Native diagnostics may contain paths. Product UI receives a bounded state only.
      this.error.set('failed');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private async readState(): Promise<void> {
    try {
      const result = await this.withTimeout(() => this.runtime.bridge!.getState());
      if (!result || typeof result !== 'object') throw new Error('Invalid native state');
      const state = result as { supported?: unknown; icon?: unknown };
      if (state.supported !== true || !isIcon(state.icon)) throw new Error('Unsupported native state');
      this.selected.set(state.icon);
      this.available.set(true);
    } catch {
      this.available.set(false);
      this.error.set('unavailable');
    }
  }

  private async withTimeout(work: () => Promise<unknown>): Promise<unknown> {
    let timer = 0;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = window.setTimeout(() => reject(new Error('Launcher action timed out')), LAUNCHER_APPEARANCE_TIMEOUT_MS);
        }),
      ]);
    } finally { window.clearTimeout(timer); }
  }
}
