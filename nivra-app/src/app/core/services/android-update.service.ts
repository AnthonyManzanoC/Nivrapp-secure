import { Injectable, InjectionToken, NgZone, computed, effect, inject, signal } from '@angular/core';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { environment } from '../../../environments/environment';
import { NativeDeviceService, type AndroidRelease, type NativeAppUpdateState } from './native-device.service';

export interface AndroidUpdateRuntime {
  supported: boolean;
  installedBuild(): Promise<number>;
  fetchRelease(): Promise<unknown>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  now(): number;
}
export const ANDROID_UPDATE_RUNTIME = new InjectionToken<AndroidUpdateRuntime>('ANDROID_UPDATE_RUNTIME', {
  providedIn: 'root', factory: () => ({
    supported: Capacitor.getPlatform() === 'android',
    installedBuild: async () => Number((await App.getInfo()).build),
    fetchRelease: async () => {
      const response = await fetch(`${environment.apiBaseUrl.replace(/\/$/, '')}/client/android-release`, {
        cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Release unavailable');
      return response.json() as Promise<unknown>;
    },
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    now: () => Date.now(),
  }),
});

export function validAndroidRelease(value: unknown, installedBuild: number): value is AndroidRelease {
  if (!value || typeof value !== 'object') return false;
  const item = value as AndroidRelease;
  return typeof item.version === 'string' && /^\d+\.\d+\.\d+$/.test(item.version)
    && Number.isSafeInteger(item.versionCode) && item.versionCode > installedBuild
    && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 256 * 1024 * 1024
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)
    && item.url === `https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v${item.version}/Nivra-${item.version}-debug.apk`;
}

@Injectable({ providedIn: 'root' })
export class AndroidUpdateService {
  private readonly native = inject(NativeDeviceService);
  private readonly zone = inject(NgZone);
  private readonly runtime = inject(ANDROID_UPDATE_RUNTIME);
  readonly supported = this.runtime.supported;
  readonly release = signal<AndroidRelease | null>(null);
  readonly state = signal<NativeAppUpdateState>({ phase: 'idle', progress: 0 });
  readonly checking = signal(false);
  readonly installing = signal(false);
  readonly checkResult = signal<'current' | 'available' | 'error' | null>(null);
  readonly dismissed = signal(false);
  readonly safe = signal(false);
  readonly foreground = signal(true);
  readonly show = computed(() => this.supported && this.release() && !this.dismissed() && this.safe() && this.foreground());
  private checkingPromise: Promise<void> | null = null;
  private started = false;
  private lastAttempt = 0;

  constructor() {
    effect(() => {
      const allowed = this.safe() && this.foreground();
      if (this.supported) void this.native.setAppUpdateAllowed(allowed).catch(() => undefined);
    });
  }

  start(): void {
    if (!this.supported || this.started) return;
    this.started = true;
    void this.native.onAppUpdateState(state => this.zone.run(() => this.state.set(state))).catch(() => undefined);
    void this.native.getAppUpdateState().then(state => this.state.set(state)).catch(() => undefined);
    void App.addListener('appStateChange', state => this.zone.run(() => {
      this.foreground.set(state.isActive);
      if (state.isActive) void this.check();
    }));
    void this.check();
  }

  check(manual = false): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (manual) this.dismissed.set(false);
    if (this.checkingPromise) return this.checkingPromise;
    if (!manual && (this.runtime.now() - this.lastAttempt < 300000 || this.checkedToday())) return Promise.resolve();
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
    const value = await this.runtime.fetchRelease();
    // Treat malformed publisher metadata as a failed check, never as "up to date".
    if (!validAndroidRelease(value, 0)) throw new Error('Invalid release');
    if (validAndroidRelease(value, build)) {
      if (this.release()?.versionCode !== value.versionCode) this.state.set({ phase: 'idle', progress: 0 });
      this.release.set(value); this.checkResult.set('available');
    } else {
      this.release.set(null); this.checkResult.set('current');
    }
    try { this.runtime.storage.setItem('nivra.androidUpdate.checkedDay', this.today()); } catch { /* Optional daily throttle. */ }
  }

  private today(): string { const date = new Date(this.runtime.now()); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
  private checkedToday(): boolean { try { return this.runtime.storage.getItem('nivra.androidUpdate.checkedDay') === this.today(); } catch { return false; } }
  dismiss(): void { this.dismissed.set(true); }

  async download(): Promise<void> {
    const release = this.release();
    if (!release || !this.safe() || !this.foreground() || this.installing() || this.state().phase === 'downloading') return;
    try {
      await this.native.setAppUpdateAllowed(this.safe() && this.foreground());
      if (!this.safe() || !this.foreground()) return;
      this.state.set(await this.native.downloadAppUpdate(release));
    }
    catch { this.state.set({ phase: 'error', progress: 0, error: 'UPDATE_NETWORK' }); }
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
