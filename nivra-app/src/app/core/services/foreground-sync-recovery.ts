import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';

interface ForegroundSyncRuntime {
  /** Includes the account, device and account-transition generation. */
  scope(): string;
  canRun(): boolean;
  sync(): Promise<void>;
  retryDelay(attempt: number): number;
}

export function isRecoverableSyncError(error: unknown): boolean {
  return error instanceof TimeoutError || (error instanceof HttpErrorResponse
    && [0, 408, 425, 429, 500, 502, 503, 504].includes(error.status));
}

/** A link hint wakes one real reconciliation; it never certifies success itself. */
export class ForegroundSyncRecovery {
  private timer: number | null = null;
  private timerScope = '';
  private wakePending = false;
  private attempt = 0;
  private generation = 0;
  private running: object | null = null;
  private runningScope = '';

  constructor(private readonly runtime: ForegroundSyncRuntime) {}

  get pending(): boolean { return this.timer !== null || this.running !== null; }

  wake(): void { this.schedule(400, true); }

  failed(error: unknown): void {
    if (isRecoverableSyncError(error)) this.scheduleRetry();
  }

  recovered(): void {
    this.pause();
    this.attempt = 0;
  }

  pause(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.timerScope = '';
    this.wakePending = false;
  }

  reset(): void {
    this.generation += 1;
    this.pause();
    this.attempt = 0;
    this.running = null;
    this.runningScope = '';
  }

  private scheduleRetry(): void {
    if (this.timer !== null || (this.running && this.runningScope === this.runtime.scope())) return;
    this.schedule(this.runtime.retryDelay(this.attempt++), false);
  }

  private schedule(delay: number, wake: boolean): void {
    const scope = this.runtime.scope();
    if (!scope || !this.runtime.canRun() || (this.running && this.runningScope === scope)) return;
    if (this.timer !== null && this.timerScope === scope && (!wake || this.wakePending)) return;
    this.pause();
    const generation = this.generation;
    this.timerScope = scope;
    this.wakePending = wake;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.wakePending = false;
      const current = () => generation === this.generation && scope === this.runtime.scope();
      if (!current() || !this.runtime.canRun()) return;
      const operation = {};
      this.running = operation;
      this.runningScope = scope;
      void Promise.resolve().then(() => {
        if (current() && this.runtime.canRun()) return this.runtime.sync();
        return undefined;
      }).then(() => {
        if (current()) this.attempt = 0;
      }, error => {
        if (this.running === operation) this.running = null;
        if (current() && isRecoverableSyncError(error)) this.scheduleRetry();
      }).finally(() => {
        if (this.running === operation) this.running = null;
      });
    }, delay);
  }
}
