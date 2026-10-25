import { Injectable, InjectionToken, inject } from '@angular/core';

export interface NetworkHints { effectiveType?: string; rtt?: number; saveData?: boolean; }
export interface NetworkPolicyRuntime {
  onlineHint(): boolean;
  hints(): NetworkHints;
  now(): number;
  random(): number;
}
export const NETWORK_POLICY_RUNTIME = new InjectionToken<NetworkPolicyRuntime>('NETWORK_POLICY_RUNTIME', {
  providedIn: 'root', factory: () => ({
    onlineHint: () => globalThis.navigator?.onLine !== false,
    hints: () => (globalThis.navigator as Navigator & { connection?: NetworkHints })?.connection ?? {},
    now: () => Date.now(), random: () => Math.random(),
  }),
});

/** Hints extend bounded deadlines; an online event never proves that a link is fast. */
@Injectable({ providedIn: 'root' })
export class NetworkPolicyService {
  private readonly runtime = inject(NETWORK_POLICY_RUNTIME);
  private observedUntil = 0;
  private observedDeadline = 0;

  onlineHint(): boolean { return this.runtime.onlineHint(); }

  readTimeoutMs(): number {
    const hints = this.runtime.hints();
    const hinted = hints.effectiveType === 'slow-2g' ? 120_000 : hints.effectiveType === '2g' ? 90_000 : hints.effectiveType === '3g' ? 60_000 : 30_000;
    const rtt = Number.isFinite(hints.rtt) && hints.rtt! > 0 ? hints.rtt! * 12 : 0;
    return Math.min(120_000, Math.max(hinted, rtt, this.runtime.now() < this.observedUntil ? this.observedDeadline : 0));
  }

  probeTimeoutMs(): number { return this.readTimeoutMs() > 30_000 ? 10_000 : 5000; }
  preparationBudgetMs(): number { return this.readTimeoutMs() > 30_000 ? 1500 : 1000; }
  serverTimeoutMs(): number { return Math.min(180_000, Math.max(60_000, this.readTimeoutMs() * 2)); }

  recordResponse(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 10_000) return;
    this.observedDeadline = Math.min(120_000, Math.max(30_000, elapsedMs * 3));
    this.observedUntil = this.runtime.now() + 120_000;
  }

  recordTimeout(): void {
    this.observedDeadline = Math.min(120_000, Math.max(90_000, this.readTimeoutMs() * 1.5));
    this.observedUntil = this.runtime.now() + 120_000;
  }

  retryDelayMs(attempt: number, baseMs = 2500, ceilingMs = 120_000): number {
    const exponent = Math.max(0, Math.min(8, Number.isFinite(attempt) ? Math.floor(attempt) : 0));
    const jitter = .75 + Math.max(0, Math.min(1, this.runtime.random())) * .5;
    return Math.min(ceilingMs, Math.round(baseMs * 2 ** exponent * jitter));
  }
}
