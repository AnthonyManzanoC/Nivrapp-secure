import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { NIVRA_VERSION } from '../release';

const DAILY_CHECK_KEY = 'nivra.web.dailyCheck.v1';
export const WEB_LAUNCH_TIMEOUT_MS = 1200;

export interface WebLaunchRuntime {
  isWeb: boolean;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  now: () => Date;
  sensitiveRoute: () => boolean;
  fetchVersion: (signal: AbortSignal) => Promise<unknown>;
  reload: () => void;
}

export const WEB_LAUNCH_RUNTIME = new InjectionToken<WebLaunchRuntime>('WebLaunchRuntime', {
  providedIn: 'root',
  factory: () => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* Private browsing may deny storage. */ }
    return {
      isWeb: !Capacitor.isNativePlatform() && !('nivraSecureVault' in window)
        && ['http:', 'https:'].includes(location.protocol),
      storage,
      now: () => new Date(),
      sensitiveRoute: () => /^\/(?:auth|recover|contact|vault\/invite)(?:\/|$)/.test(location.pathname),
      fetchVersion: async (signal) => {
        const response = await fetch(`/assets/release.json?client=${encodeURIComponent(NIVRA_VERSION)}`, {
          cache: 'no-store', credentials: 'omit', signal,
        });
        if (!response.ok) throw new Error('Version check unavailable');
        return response.json();
      },
      reload: () => location.reload(),
    };
  },
});

export function isNewerWebVersion(value: unknown, current = NIVRA_VERSION): value is string {
  if (typeof value !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value)) return false;
  const latest = value.split('.').map(Number);
  const installed = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== installed[i]) return latest[i] > installed[i];
  }
  return false;
}

@Injectable({ providedIn: 'root' })
export class WebLaunchService {
  private readonly runtime = inject(WEB_LAUNCH_RUNTIME);
  private inFlight: Promise<void> | null = null;
  private attempted = false;
  readonly checking = signal(false);

  start(canReload: () => boolean = () => true): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.attempted || !this.runtime.isWeb || this.runtime.sensitiveRoute()) return Promise.resolve();
    this.attempted = true;
    const now = this.runtime.now();
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    let claimed = false;
    try {
      if (this.runtime.storage?.getItem(DAILY_CHECK_KEY) === day) return Promise.resolve();
      this.runtime.storage?.setItem(DAILY_CHECK_KEY, day);
      claimed = Boolean(this.runtime.storage);
    } catch { /* Checking is still useful, but reloading cannot be made loop-safe. */ }
    this.checking.set(true);
    this.inFlight = this.check(day, claimed, canReload).finally(() => {
      this.checking.set(false);
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async check(day: string, claimed: boolean, canReload: () => boolean): Promise<void> {
    const controller = new AbortController();
    let timeoutId = 0;
    try {
      const result = await Promise.race([
        this.runtime.fetchVersion(controller.signal),
        new Promise<null>((resolve) => { timeoutId = window.setTimeout(() => resolve(null), WEB_LAUNCH_TIMEOUT_MS); }),
      ]);
      const version = result && typeof result === 'object' ? (result as { version?: unknown }).version : null;
      if (!isNewerWebVersion(version) || !claimed || this.runtime.sensitiveRoute() || !canReload()) return;
      // Require the persisted daily claim before reload, so stale HTML cannot loop.
      if (this.runtime.storage?.getItem(DAILY_CHECK_KEY) !== day) return;
      this.runtime.reload();
    } catch {
      // Offline or a partial deployment must leave the existing application usable.
    } finally {
      window.clearTimeout(timeoutId);
      controller.abort();
    }
  }
}
