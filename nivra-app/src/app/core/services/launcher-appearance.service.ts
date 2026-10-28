import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { firstValueFrom, fromEvent, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

export const LAUNCHER_ICON_IDS = ['original', 'emerald', 'ivory'] as const;
export type LauncherIconId = typeof LAUNCHER_ICON_IDS[number];
export type LauncherAppearancePlatform = 'android' | 'windows' | 'web' | 'unsupported';
export const LAUNCHER_APPEARANCE_TIMEOUT_MS = 6000;
export const LAUNCHER_SYNC_TIMEOUT_MS = 20_000;
export interface AccountAppearance { icon: LauncherIconId; revision: number; }
interface CachedAppearance extends AccountAppearance { userId: string; }
interface AppearanceContext { scope: string; epoch: number; accountId: string | null; }

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
    if (Capacitor.isNativePlatform()) {
      return Capacitor.getPlatform() === 'android' ? { platform: 'android', bridge: {
        getState: () => AndroidLauncher.getState(), setIcon: icon => AndroidLauncher.setIcon({ icon }),
      } } : { platform: 'unsupported', bridge: null };
    }
    const bridge = window.nivraLauncherAppearance;
    if (bridge || 'nivraSecureVault' in window) {
      return { platform: 'windows', bridge: bridge && typeof bridge.getState === 'function'
        && typeof bridge.setIcon === 'function' ? bridge : null };
    }
    return { platform: 'web', bridge: null };
  },
});

const CACHE_PREFIX = 'nivra.launcher.account.v1.';
function isIcon(value: unknown): value is LauncherIconId {
  return typeof value === 'string' && (LAUNCHER_ICON_IDS as readonly string[]).includes(value);
}
function isAppearance(value: unknown): value is AccountAppearance {
  const preference = value as Partial<AccountAppearance> | null;
  return !!preference && isIcon(preference.icon) && Number.isSafeInteger(preference.revision)
    && (preference.revision as number) >= 0;
}

@Injectable({ providedIn: 'root' })
export class LauncherAppearanceService {
  private readonly runtime = inject(LAUNCHER_APPEARANCE_RUNTIME);
  private readonly auth = inject(AuthService);
  private readonly api = inject(NivraApiService);
  private readonly realtime = inject(SignalrService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly selected = signal<LauncherIconId>('original');
  private readonly available = signal(false);
  private readonly account = signal<string | null>(null);
  private scope = '';
  private epoch = 0;
  private destroyed = false;
  private confirmed: AccountAppearance | null = null;
  private physicalIcon: LauncherIconId | null = null;
  private applyTask: Promise<unknown> = Promise.resolve();
  private refreshInFlight: { epoch: number; promise: Promise<void> } | null = null;
  private writing = false;
  private refreshRequested = false;
  readonly current = this.selected.asReadonly();
  readonly supported = this.available.asReadonly();
  readonly platform = signal(this.runtime.platform).asReadonly();
  readonly accountId = this.account.asReadonly();
  readonly revision = signal<number | null>(null);
  readonly synced = signal(false);
  readonly busy = signal(false);
  readonly error = signal<'unavailable' | 'failed' | 'sync' | 'conflict' | 'not-signed-in' | null>(null);

  constructor() {
    this.synchronizeScope();
    void this.refresh();
    effect(() => {
      this.auth.session();
      this.auth.isAuthenticated();
      this.auth.sessionGeneration?.();
      untracked(() => { if (this.synchronizeScope()) void this.refresh(); });
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      // Realtime payloads are hints: refresh with the current account credentials.
      if (['account.appearanceChanged', 'connected', 'reconnected'].includes(event.type)) this.requestRefresh();
    });
    fromEvent(window, 'online').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.requestRefresh());
    fromEvent(this.document, 'visibilitychange').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.document.visibilityState !== 'hidden') this.requestRefresh();
    });
    const timer = window.setInterval(() => {
      if (this.account() && this.document.visibilityState !== 'hidden' && navigator.onLine !== false) void this.refresh();
    }, 90_000);
    this.destroyRef.onDestroy(() => { this.destroyed = true; this.epoch++; window.clearInterval(timer); });
  }

  refresh(): Promise<void> {
    this.synchronizeScope();
    if (this.destroyed) return Promise.resolve();
    if (this.refreshInFlight?.epoch === this.epoch) return this.refreshInFlight.promise;
    if (this.writing) { this.refreshRequested = true; return Promise.resolve(); }
    const context = this.context();
    this.busy.set(true);
    this.error.set(null);
    const promise = this.refreshCore(context).finally(() => {
      if (this.currentContext(context)) this.busy.set(false);
      if (this.refreshInFlight?.promise === promise) this.refreshInFlight = null;
      if (this.currentContext(context) && this.refreshRequested) { this.refreshRequested = false; void this.refresh(); }
    });
    this.refreshInFlight = { epoch: context.epoch, promise };
    return promise;
  }

  async selectIcon(icon: LauncherIconId): Promise<boolean> {
    this.synchronizeScope();
    if (!isIcon(icon)) { this.error.set('failed'); return false; }
    if (!this.account()) { this.error.set('not-signed-in'); return false; }
    if (this.busy()) return false;
    if (!this.available()) { this.error.set('unavailable'); return false; }
    if (!this.confirmed) { this.error.set('sync'); return false; }
    const context = this.context();
    if (this.confirmed.icon === icon && this.selected() === icon && this.synced()) { this.error.set(null); return true; }
    this.writing = true;
    this.busy.set(true);
    this.error.set(null);
    let awaitingWrite = false;
    try {
      if (this.confirmed.icon !== icon || !this.synced()) {
        const expectedRevision = this.confirmed.revision;
        awaitingWrite = true;
        const response = await firstValueFrom(this.api.put<AccountAppearance>('/account/appearance', { icon, expectedRevision })
          .pipe(timeout(LAUNCHER_SYNC_TIMEOUT_MS)));
        awaitingWrite = false;
        if (!this.currentContext(context)) return false;
        if (!isAppearance(response) || response.icon !== icon || response.revision < expectedRevision
          || (response.revision === expectedRevision && this.confirmed.icon !== icon)) throw new Error('INVALID_APPEARANCE');
        this.accept(response, context);
      }
      if (!this.currentContext(context) || !this.confirmed) return false;
      return await this.applyPreference(context, this.confirmed);
    } catch (error: unknown) {
      if (!this.currentContext(context)) return false;
      if ((error as { status?: unknown })?.status === 409) {
        await this.readAccountPreference(context).catch(() => undefined);
        if (this.currentContext(context)) this.error.set('conflict');
      } else {
        const failure = (error && typeof error === 'object' ? error : {}) as { status?: number; name?: string };
        if (awaitingWrite && (failure.status === 0 || (failure.status ?? 0) >= 500 || failure.name === 'TimeoutError')) {
          // A lost response can follow a committed CAS write. Read back once;
          // never replay the mutation or undo the account's saved preference.
          await this.readAccountPreference(context).catch(() => undefined);
          if (!this.currentContext(context)) return false;
          if (this.synced() && this.confirmed?.icon === icon && this.selected() === icon && !this.error()) return true;
        }
        this.error.set(this.synced() && this.confirmed?.icon === icon ? 'failed' : 'sync');
      }
      return false;
    } finally {
      if (this.currentContext(context)) {
        this.writing = false;
        this.busy.set(false);
        if (this.refreshRequested) { this.refreshRequested = false; void this.refresh(); }
      }
    }
  }

  private async refreshCore(context: AppearanceContext): Promise<void> {
    await this.readDeviceState(context);
    if (!this.currentContext(context) || !context.accountId) return;
    // Only a cache explicitly owned by this account is eligible for offline use.
    if (this.confirmed && this.available()) {
      await this.applyPreference(context, this.confirmed).catch(() => {
        if (this.currentContext(context)) this.error.set('failed');
      });
    }
    try { await this.readAccountPreference(context); }
    catch { if (this.currentContext(context)) { this.synced.set(false); this.error.set('sync'); } }
  }

  private async readAccountPreference(context: AppearanceContext): Promise<void> {
    const response = await firstValueFrom(this.api.get<AccountAppearance>('/account/appearance').pipe(timeout(LAUNCHER_SYNC_TIMEOUT_MS)));
    if (!this.currentContext(context)) return;
    if (!isAppearance(response)) throw new Error('INVALID_APPEARANCE');
    this.accept(response, context);
    if (this.available() && this.confirmed) {
      try { await this.applyPreference(context, this.confirmed); if (this.currentContext(context)) this.error.set(null); }
      catch { if (this.currentContext(context)) this.error.set('failed'); }
    }
  }

  private async readDeviceState(context: AppearanceContext): Promise<void> {
    if (this.runtime.platform === 'web') {
      if (this.currentContext(context)) this.available.set(true);
      return;
    }
    if (!this.runtime.bridge || this.runtime.platform === 'unsupported') {
      if (this.currentContext(context)) {
        this.available.set(false);
        this.error.set(this.runtime.platform === 'unsupported' ? null : 'unavailable');
      }
      return;
    }
    try {
      const result = await this.withTimeout(() => this.runtime.bridge!.getState());
      if (!this.currentContext(context)) return;
      const state = result as { supported?: unknown; icon?: unknown } | null;
      if (!state || state.supported !== true || !isIcon(state.icon)) throw new Error('INVALID_NATIVE_STATE');
      this.physicalIcon = state.icon;
      this.available.set(true);
      if (!context.accountId) this.selected.set(state.icon);
    } catch {
      if (this.currentContext(context)) { this.available.set(false); this.error.set('unavailable'); }
    }
  }

  private applyPreference(context: AppearanceContext, preference: AccountAppearance): Promise<boolean> {
    const current = () => this.currentContext(context) && this.confirmed?.revision === preference.revision
      && this.confirmed?.icon === preference.icon;
    const work = this.applyTask.catch(() => undefined).then(async () => {
      if (!current()) return false;
      if (this.runtime.platform !== 'web') {
        if (!this.runtime.bridge || !this.available()) throw new Error('LAUNCHER_UNAVAILABLE');
        if (this.physicalIcon !== preference.icon) {
          const action = this.runtime.bridge.setIcon(preference.icon);
          // Native calls cannot be cancelled. A late completion from another
          // account is followed by reapplying the current account's preference.
          void action.then(() => {
            if (!current() && !this.destroyed) {
              this.physicalIcon = null;
              if (this.confirmed && this.available()) void this.applyPreference(this.context(), this.confirmed).catch(() => undefined);
            }
          }, () => undefined);
          const result = await this.withTimeout(() => action);
          const state = result as { supported?: unknown; icon?: unknown } | null;
          if (!state || state.supported !== true || state.icon !== preference.icon) throw new Error('ICON_NOT_APPLIED');
        }
      }
      if (!current()) return false;
      this.physicalIcon = preference.icon;
      this.applyBrowserMetadata(preference.icon, preference.revision);
      this.selected.set(preference.icon);
      return true;
    });
    this.applyTask = work;
    return work;
  }

  private accept(preference: AccountAppearance, context: AppearanceContext): void {
    if (!this.currentContext(context) || this.synced() && preference.revision < (this.confirmed?.revision ?? -1)) return;
    this.confirmed = { icon: preference.icon, revision: preference.revision };
    this.revision.set(preference.revision);
    this.synced.set(true);
    try { localStorage.setItem(CACHE_PREFIX + encodeURIComponent(context.accountId!), JSON.stringify({ ...this.confirmed, userId: context.accountId })); }
    catch { /* Sync works even if local display caching is unavailable. */ }
  }

  private synchronizeScope(): boolean {
    const session = this.auth.session();
    const accountId = this.auth.isAuthenticated() ? session?.user.id ?? null : null;
    const scope = accountId ? JSON.stringify([accountId, session?.device?.id ?? '', this.auth.sessionGeneration?.() ?? 0]) : '';
    if (scope === this.scope && accountId === this.account()) return false;
    this.scope = scope;
    this.epoch++;
    this.account.set(accountId);
    this.confirmed = this.readCache(accountId);
    this.revision.set(this.confirmed?.revision ?? null);
    this.selected.set('original');
    this.available.set(false);
    this.synced.set(false);
    this.error.set(null);
    this.busy.set(false);
    this.writing = false;
    this.refreshRequested = false;
    this.refreshInFlight = null;
    this.applyBrowserMetadata('original', 0);
    return true;
  }

  private context(): AppearanceContext { return { scope: this.scope, epoch: this.epoch, accountId: this.account() }; }
  private requestRefresh(): void {
    if (this.refreshInFlight || this.writing) this.refreshRequested = true;
    else void this.refresh();
  }
  private currentContext(context: AppearanceContext): boolean {
    const session = this.auth.session();
    const accountId = this.auth.isAuthenticated() ? session?.user.id ?? null : null;
    const scope = accountId ? JSON.stringify([accountId, session?.device?.id ?? '', this.auth.sessionGeneration?.() ?? 0]) : '';
    return !this.destroyed && context.epoch === this.epoch && context.scope === this.scope && context.scope === scope;
  }
  private readCache(userId: string | null): AccountAppearance | null {
    if (!userId) return null;
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + encodeURIComponent(userId)) || 'null') as CachedAppearance | null;
      return isAppearance(cached) && cached!.userId === userId ? { icon: cached.icon, revision: cached.revision } : null;
    } catch { return null; }
  }

  private applyBrowserMetadata(icon: LauncherIconId, revision: number): void {
    // Include the server revision in each browser-visible URL. The icon files
    // remain bundled and allowlisted; the query only prompts icon/manifest
    // caches to observe an account change promptly.
    const version = `?v=${revision}`;
    const href = new URL(`assets/brand/launcher-${icon}.png${version}`, this.document.baseURI).href;
    let icons = Array.from(this.document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
    if (!icons.length) {
      const link = this.document.createElement('link'); link.rel = 'icon'; this.document.head.append(link); icons = [link];
    }
    for (const link of icons) { link.type = 'image/png'; link.href = href; }
    let appleIcon = this.document.head.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (!appleIcon) {
      appleIcon = this.document.createElement('link');
      appleIcon.rel = 'apple-touch-icon';
      appleIcon.sizes = '180x180';
      this.document.head.append(appleIcon);
    }
    appleIcon.type = 'image/png';
    appleIcon.href = href;
    let maskIcon = this.document.head.querySelector<HTMLLinkElement>('link[rel="mask-icon"]');
    if (!maskIcon) {
      maskIcon = this.document.createElement('link');
      maskIcon.rel = 'mask-icon';
      this.document.head.append(maskIcon);
    }
    maskIcon.href = new URL(`assets/brand/launcher-${icon}.svg${version}`, this.document.baseURI).href;
    maskIcon.setAttribute('color', '#00a880');
    if (this.runtime.platform === 'web') {
      let manifest = this.document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      if (!manifest) { manifest = this.document.createElement('link'); manifest.rel = 'manifest'; this.document.head.append(manifest); }
      // Each manifest variant keeps Nivra's stable PWA identity/start URL while
      // pointing at this account's launcher artwork. Browsers refresh installed
      // icons on their own schedule; versioning the manifest URL prevents stale
      // HTTP caches from pinning the previous account selection.
      manifest.href = new URL(`assets/brand/manifest-${icon}.webmanifest${version}`, this.document.baseURI).href;
    }
  }

  private async withTimeout(work: () => Promise<unknown>): Promise<unknown> {
    let timer = 0;
    try {
      return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error('LAUNCHER_TIMEOUT')), LAUNCHER_APPEARANCE_TIMEOUT_MS);
      })]);
    } finally { window.clearTimeout(timer); }
  }
}
