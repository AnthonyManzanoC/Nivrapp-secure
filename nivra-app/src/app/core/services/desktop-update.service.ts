import { DestroyRef, Injectable, InjectionToken, NgZone, computed, inject, signal } from '@angular/core';

export interface DesktopUpdateState {
  phase: 'idle' | 'downloading' | 'ready' | 'error' | 'installing';
  progress: number;
  error?: string;
}
export interface DesktopUpdateResult {
  status: 'current' | 'available' | 'downloaded' | 'installing';
  currentVersion: string;
  version?: string;
  size?: number;
}
export interface DesktopUpdateBridge {
  checkForUpdate(): Promise<DesktopUpdateResult>;
  downloadUpdate(): Promise<DesktopUpdateResult>;
  installUpdate(): Promise<DesktopUpdateResult>;
  getUpdateState(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}
declare global { interface Window { nivraDesktopUpdates?: DesktopUpdateBridge; } }
export interface DesktopUpdateRuntime {
  bridge: DesktopUpdateBridge | null;
  now(): number;
}
export const DESKTOP_UPDATE_RUNTIME = new InjectionToken<DesktopUpdateRuntime>('DESKTOP_UPDATE_RUNTIME', {
  providedIn: 'root', factory: () => ({ bridge: window.nivraDesktopUpdates ?? null, now: () => Date.now() }),
});
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class DesktopUpdateService {
  private readonly runtime = inject(DESKTOP_UPDATE_RUNTIME);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  readonly supported = !!this.runtime.bridge;
  readonly release = signal<{ version: string; size: number } | null>(null);
  readonly state = signal<DesktopUpdateState>({ phase: 'idle', progress: 0 });
  readonly checking = signal(false);
  readonly checkResult = signal<'current' | 'available' | 'error' | null>(null);
  readonly dismissed = signal(false);
  readonly safe = signal(false);
  readonly foreground = signal(document.visibilityState !== 'hidden');
  readonly show = computed(() => this.supported && !!this.release() && !this.dismissed() && this.safe() && this.foreground());
  private started = false;
  private checkInFlight: Promise<void> | null = null;
  private downloading = false;
  private installing = false;
  private lastSuccess: number | null = null;
  private lastAttempt: number | null = null;

  start(): void {
    const bridge = this.runtime.bridge;
    if (!bridge || this.started) return;
    this.started = true;
    const unsubscribe = bridge.onUpdateState((state) => this.zone.run(() => this.state.set(state)));
    const onVisibility = () => {
      this.foreground.set(document.visibilityState !== 'hidden');
      if (this.foreground()) void this.check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => { if (this.foreground()) void this.check(); }, CHECK_INTERVAL_MS);
    this.destroyRef.onDestroy(() => {
      unsubscribe(); window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    });
    void this.check();
  }

  check(manual = false): Promise<void> {
    if (!this.runtime.bridge) return Promise.resolve();
    if (manual) this.dismissed.set(false);
    if (this.checkInFlight) return this.checkInFlight;
    if (this.downloading || this.installing) return Promise.resolve();
    const now = this.runtime.now();
    if (!manual && ((this.lastSuccess !== null && now - this.lastSuccess < CHECK_INTERVAL_MS)
      || (this.lastAttempt !== null && now - this.lastAttempt < 5 * 60 * 1000))) return Promise.resolve();
    this.lastAttempt = now;
    this.checking.set(true);
    this.checkResult.set(null);
    this.checkInFlight = this.fetchRelease().catch(() => this.checkResult.set('error')).finally(() => {
      this.checking.set(false); this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  private async fetchRelease(): Promise<void> {
    const result = await this.runtime.bridge!.checkForUpdate();
    this.applyResult(result);
    this.lastSuccess = this.runtime.now();
    this.checkResult.set(result.status === 'current' ? 'current' : 'available');
  }

  private applyResult(result: DesktopUpdateResult): void {
    if (result.status === 'current') {
      this.release.set(null);
      this.state.set({ phase: 'idle', progress: 0 });
      return;
    }
    if (!result.version || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(result.version)
      || !Number.isSafeInteger(result.size) || result.size! <= 0) throw new Error('UPDATE_INVALID_MANIFEST');
    if (this.release()?.version !== result.version) {
      this.state.set({ phase: 'idle', progress: 0 });
      this.dismissed.set(false);
    }
    this.release.set({ version: result.version, size: result.size! });
    if (result.status === 'downloaded') this.state.set({ phase: 'ready', progress: 100 });
    if (result.status === 'installing') this.state.set({ phase: 'installing', progress: 100 });
  }

  dismiss(): void { this.dismissed.set(true); }

  async download(): Promise<void> {
    if (!this.runtime.bridge || !this.release() || !this.safe() || !this.foreground() || this.downloading || this.installing) return;
    this.downloading = true;
    this.state.set({ phase: 'downloading', progress: 0 });
    try { this.applyResult(await this.runtime.bridge.downloadUpdate()); }
    catch { this.state.set({ phase: 'error', progress: 0 }); }
    finally { this.downloading = false; }
  }

  async install(): Promise<void> {
    if (!this.runtime.bridge || !this.safe() || !this.foreground() || this.installing || this.state().phase !== 'ready') return;
    this.installing = true;
    this.state.set({ phase: 'installing', progress: 100 });
    try { this.applyResult(await this.runtime.bridge.installUpdate()); }
    catch { this.state.set({ phase: 'error', progress: 0 }); }
    finally { this.installing = false; }
  }
}
