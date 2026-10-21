import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';

const DAILY_PRESENTATION_KEY = 'nivra.launch.daily.v1';
export const DAILY_APP_LAUNCH_MIN_MS = 1100;
export const DAILY_APP_LAUNCH_MAX_MS = 2200;

export interface DailyAppLaunchRuntime {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  now: () => Date;
}

export const DAILY_APP_LAUNCH_RUNTIME = new InjectionToken<DailyAppLaunchRuntime>('DailyAppLaunchRuntime', {
  providedIn: 'root',
  factory: () => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* The in-memory claim still prevents repeats in this launch. */ }
    return { storage, now: () => new Date() };
  },
});

export interface DailyAppLaunchState {
  /** An authenticated account ID, never an alias, password or session token. */
  accountId: string | null;
  /** The caller excludes login, recovery, invitations, calls, app lock and other active tasks. */
  canShow: boolean;
  /** Actual initial chat preparation has settled; this presentation never starts or delays that work. */
  ready: boolean;
}

interface ActivePresentation {
  accountId: string;
  minimumElapsed: boolean;
  minimumTimer: number;
  maximumTimer: number;
}

/**
 * A bounded, once-per-local-day presentation for every client platform.
 * It never fetches data, reloads the application or claims that synchronization has completed.
 * Background signals alone cannot display it on a new day: a fresh entry/foreground request is required.
 */
@Injectable({ providedIn: 'root' })
export class DailyAppLaunchService {
  private readonly runtime = inject(DAILY_APP_LAUNCH_RUNTIME);
  private readonly presentedDays = new Map<string, string>();
  private readonly showing = signal(false);
  private state: DailyAppLaunchState = { accountId: null, canShow: false, ready: false };
  private active: ActivePresentation | null = null;
  private pendingEntry = false;
  private destroyed = false;
  readonly visible = this.showing.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.finish();
    });
  }

  update(next: DailyAppLaunchState): void {
    if (this.destroyed) return;
    const accountId = next.accountId?.trim() || null;
    const accountChanged = accountId !== this.state.accountId;
    this.state = { ...next, accountId };
    if (accountChanged) {
      this.finish();
      // Session restoration can precede the safe application route. Wait for that route.
      this.pendingEntry = Boolean(accountId);
    }
    this.reconcile();
  }

  /** Call on returning to the foreground, rather than on every navigation or data update. */
  requestPresentation(): void {
    // Duplicate lifecycle events during a presentation are already handled by it.
    // Never leave a queued entry that a later day's unrelated data update could consume.
    if (this.destroyed || !this.state.accountId || this.active) return;
    this.pendingEntry = true;
    this.reconcile();
  }

  private reconcile(): void {
    const { accountId, canShow, ready } = this.state;
    if (this.active) {
      if (!accountId || accountId !== this.active.accountId || !canShow) {
        this.finish();
      } else if (ready && this.active.minimumElapsed) {
        this.finish();
      }
      return;
    }
    if (!accountId || !canShow || !this.pendingEntry) return;
    this.pendingEntry = false;

    const date = this.runtime.now();
    const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (!Number.isFinite(date.getTime())) return;
    const key = `${DAILY_PRESENTATION_KEY}.${encodeURIComponent(accountId)}`;
    if (this.presentedDays.get(key) === day) return;
    try {
      if (this.runtime.storage?.getItem(key) === day) {
        this.presentedDays.set(key, day);
        return;
      }
      // Claim before showing. A reload during the overlay must not replay it.
      this.runtime.storage?.setItem(key, day);
    } catch {
      // A denied or full store must not block the user or cause repeats in this process.
    }
    this.presentedDays.set(key, day);

    const presentation: ActivePresentation = {
      accountId, minimumElapsed: false, minimumTimer: 0, maximumTimer: 0,
    };
    this.active = presentation;
    this.showing.set(true);
    presentation.minimumTimer = window.setTimeout(() => {
      if (this.active !== presentation) return;
      presentation.minimumElapsed = true;
      this.reconcile();
    }, DAILY_APP_LAUNCH_MIN_MS);
    presentation.maximumTimer = window.setTimeout(() => {
      if (this.active === presentation) this.finish();
    }, DAILY_APP_LAUNCH_MAX_MS);
  }

  private finish(): void {
    if (this.active) {
      window.clearTimeout(this.active.minimumTimer);
      window.clearTimeout(this.active.maximumTimer);
      this.active = null;
    }
    this.showing.set(false);
  }
}
