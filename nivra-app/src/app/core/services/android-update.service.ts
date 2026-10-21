import { DestroyRef, Injectable, InjectionToken, NgZone, computed, effect, inject, signal } from '@angular/core';
import { App } from '@capacitor/app';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { NativeDeviceService, type AndroidRelease, type NativeAppUpdateState } from './native-device.service';

export const NIVRA_UPDATE_FEED_URL = 'https://nivrapp-secure.vercel.app/updates/latest.json';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_THROTTLE_MS = 5 * 60 * 1000;

export interface AndroidUpdateRuntime {
  supported: boolean;
  installedBuild(): Promise<number>;
  fetchRelease(): Promise<unknown>;
  onAppStateChange(listener: (active: boolean) => void): Promise<PluginListenerHandle>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  now(): number;
}
export const ANDROID_UPDATE_RUNTIME = new InjectionToken<AndroidUpdateRuntime>('ANDROID_UPDATE_RUNTIME', {
  providedIn: 'root', factory: () => ({
    supported: Capacitor.getPlatform() === 'android',
    installedBuild: async () => Number((await App.getInfo()).build),
    onAppStateChange: listener => App.addListener('appStateChange', state => listener(state.isActive)),
    fetchRelease: async () => {
      // A permanent public feed also works before sign-in and while the API is
      // unavailable. The publisher changes this one document for every release.
      const response = await fetch(NIVRA_UPDATE_FEED_URL, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok || !validUpdateFeedResponseUrl(response.url)) throw new Error('Release unavailable');
      return response.json() as Promise<unknown>;
    },
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    now: () => Date.now(),
  }),
});

export function validUpdateFeedResponseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    return url.href === NIVRA_UPDATE_FEED_URL;
  } catch { return false; }
}

export function validAndroidRelease(value: unknown, installedBuild: number): value is AndroidRelease {
  if (!value || typeof value !== 'object') return false;
  const item = value as AndroidRelease;
  return typeof item.version === 'string' && /^\d+\.\d+\.\d+$/.test(item.version)
    && Number.isSafeInteger(item.versionCode) && item.versionCode > installedBuild
    && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 256 * 1024 * 1024
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)
    && item.url === `https://nivrapp-secure.vercel.app/downloads/Nivra-${item.version}-debug.apk`;
}

export function androidReleaseFromFeed(value: unknown): AndroidRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const feed = value as Record<string, unknown>;
  if (feed['schemaVersion'] !== 1 || typeof feed['version'] !== 'string'
    || typeof feed['publishedAt'] !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(feed['publishedAt'])
    || !Number.isFinite(Date.parse(feed['publishedAt']))) return null;
  const android = feed['android'];
  if (!validAndroidRelease(android, 0) || android.version !== feed['version']) return null;
  // Copy only the native contract. Feed extensions never cross the bridge.
  return { version: android.version, versionCode: android.versionCode, url: android.url, sha256: android.sha256, size: android.size };
}

@Injectable({ providedIn: 'root' })
export class AndroidUpdateService {
  private readonly native = inject(NativeDeviceService);
  private readonly zone = inject(NgZone);
  private readonly runtime = inject(ANDROID_UPDATE_RUNTIME);
  private readonly destroyRef = inject(DestroyRef);
  readonly supported = this.runtime.supported;
  readonly release = signal<AndroidRelease | null>(null);
  readonly state = signal<NativeAppUpdateState>({ phase: 'idle', progress: 0 });
  readonly checking = signal(false);
  readonly installing = signal(false);
  readonly startingDownload = signal(false);
  readonly checkResult = signal<'current' | 'available' | 'error' | null>(null);
  readonly dismissed = signal(false);
  readonly safe = signal(false);
  readonly foreground = signal(true);
  readonly show = computed(() => this.supported && this.release() && !this.dismissed() && this.safe() && this.foreground());
  private checkingPromise: Promise<void> | null = null;
  private started = false;
  private lastAttempt: number | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private appStateListener: Promise<PluginListenerHandle> | null = null;
  private nativeStateListener: Promise<PluginListenerHandle> | null = null;
  private destroyed = false;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      if (this.checkTimer !== null) clearInterval(this.checkTimer);
      this.checkTimer = null;
      void this.appStateListener?.then(listener => listener.remove()).catch(() => undefined);
      void this.nativeStateListener?.then(listener => listener.remove()).catch(() => undefined);
      if (this.supported) void this.native.setAppUpdateAllowed(false).catch(() => undefined);
    });
    effect(() => {
      const allowed = this.safe() && this.foreground();
      if (this.supported) void this.native.setAppUpdateAllowed(allowed).catch(() => undefined);
    });
  }

  start(): void {
    if (!this.supported || this.started || this.destroyed) return;
    this.started = true;
    this.nativeStateListener = this.native.onAppUpdateState(state => this.zone.run(() => {
      if (!this.destroyed) this.state.set(state);
    }));
    void this.nativeStateListener.catch(() => undefined);
    void this.native.getAppUpdateState().then(state => { if (!this.destroyed) this.state.set(state); }).catch(() => undefined);
    this.appStateListener = this.runtime.onAppStateChange(active => this.zone.run(() => {
      if (this.destroyed) return;
      this.foreground.set(active);
      if (active) void this.check();
    }));
    void this.appStateListener.catch(() => undefined);
    this.checkTimer = this.zone.runOutsideAngular(() => setInterval(() => {
      if (this.foreground() && !this.destroyed) this.zone.run(() => { void this.check(); });
    }, CHECK_INTERVAL_MS));
    void this.check();
  }

  check(manual = false): Promise<void> {
    if (!this.supported || this.destroyed) return Promise.resolve();
    if (manual) this.dismissed.set(false);
    if (this.checkingPromise) return this.checkingPromise;
    // Keep the descriptor bound to its verified native download until the user
    // installs or cancels it, even if a newer release appears in the meantime.
    if (this.startingDownload() || this.installing() || ['downloading', 'ready', 'permission'].includes(this.state().phase)) return Promise.resolve();
    const elapsed = this.lastAttempt === null ? null : this.runtime.now() - this.lastAttempt;
    if (!manual && ((elapsed !== null && elapsed >= 0 && elapsed < RETRY_THROTTLE_MS) || this.checkedRecently())) return Promise.resolve();
    this.lastAttempt = this.runtime.now();
    this.checking.set(true);
    this.checkResult.set(null);
    this.checkingPromise = this.fetchRelease().catch(() => this.checkResult.set('error')).finally(() => {
      this.checking.set(false); this.checkingPromise = null;
    });
    return this.checkingPromise;
  }

  private async fetchRelease(): Promise<void> {
    const build = await this.runtime.installedBuild();
    if (!Number.isSafeInteger(build) || build <= 0) throw new Error('Invalid installed build');
    const value = androidReleaseFromFeed(await this.runtime.fetchRelease());
    // Treat malformed publisher metadata as a failed check, never as "up to date".
    if (!value) throw new Error('Invalid release');
    if (validAndroidRelease(value, build)) {
      if (this.release()?.versionCode !== value.versionCode) {
        this.state.set({ phase: 'idle', progress: 0 });
        this.dismissed.set(false);
      }
      this.release.set(value); this.checkResult.set('available');
    } else {
      this.release.set(null); this.checkResult.set('current');
    }
    try { this.runtime.storage.setItem('nivra.androidUpdate.checkedAt', String(this.runtime.now())); } catch { /* Optional check throttle. */ }
  }

  private checkedRecently(): boolean {
    try {
      const saved = this.runtime.storage.getItem('nivra.androidUpdate.checkedAt');
      if (!saved) return false;
      const checkedAt = Number(saved);
      const elapsed = this.runtime.now() - checkedAt;
      return Number.isFinite(checkedAt) && elapsed >= 0 && elapsed < CHECK_INTERVAL_MS;
    } catch { return false; }
  }
  dismiss(): void { this.dismissed.set(true); }

  async download(): Promise<void> {
    const release = this.release();
    if (!release || !this.safe() || !this.foreground() || this.startingDownload() || this.installing()
      || ['downloading', 'ready', 'permission'].includes(this.state().phase)) return;
    this.startingDownload.set(true);
    try {
      await this.native.setAppUpdateAllowed(this.safe() && this.foreground());
      if (!this.safe() || !this.foreground()) return;
      this.state.set(await this.native.downloadAppUpdate(release));
    }
    catch { this.state.set({ phase: 'error', progress: 0, error: 'UPDATE_NETWORK' }); }
    finally { this.startingDownload.set(false); }
  }
  async install(): Promise<void> {
    if (!this.safe() || !this.foreground() || this.installing() || !['ready', 'permission'].includes(this.state().phase)) return;
    this.installing.set(true);
    try {
      await this.native.setAppUpdateAllowed(this.safe() && this.foreground());
      if (!this.safe() || !this.foreground()) return;
      this.state.set(await this.native.installAppUpdate());
    }
    catch { /* Keep the verified download available if a new call interrupted installation. */ }
    finally { this.installing.set(false); }
  }
  async cancel(): Promise<void> { try { this.state.set(await this.native.cancelAppUpdate()); } catch { /* Native download still owns its state. */ } }
}
