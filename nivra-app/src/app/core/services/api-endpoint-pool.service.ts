import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { NIVRA_CALL_PROTOCOL } from '../release';
import { NetworkPolicyService } from './network-policy.service';

export interface ApiPoolRuntime {
  origins: readonly string[];
  primary: string;
  expectedFingerprint?: string;
  preferred?: string;
  fetch: typeof fetch;
  now(): number;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
}
export const API_POOL_RUNTIME = new InjectionToken<ApiPoolRuntime>('API_POOL_RUNTIME', {
  providedIn: 'root', factory: () => {
    const primary = environment.apiBaseUrl;
    let preferred = '';
    try {
      preferred = new URLSearchParams(globalThis.location?.search).get('apiBaseUrl')
        || String((globalThis as { NIVRA_NATIVE_API_BASE_URL?: unknown }).NIVRA_NATIVE_API_BASE_URL || '');
    } catch { /* An optional, pinned preference. */ }
    return {
      primary, origins: environment.apiEndpoints, preferred,
      expectedFingerprint: environment.apiClusterFingerprint,
      fetch: (input, init) => globalThis.fetch(input, init), now: () => Date.now(),
      storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    };
  },
});

interface Readiness {
  status: string; failoverProtocol: number; callProtocol: number; minimumCallProtocol: number;
  apiFailoverReady?: boolean; sharedStorageReady?: boolean; realtimeSharedReady?: boolean; durableSigningKeyReady?: boolean;
  multiInstanceReady: boolean; clusterFingerprint: string; push?: { fcm?: boolean; webPush?: boolean };
}
const fingerprintPattern = /^[a-f0-9]{64}$/;
export function apiOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.pathname === '/' ? url.origin : null;
  } catch { return null; }
}

/** Only an explicitly shipped origin with matching shared infrastructure receives credentials. */
@Injectable({ providedIn: 'root' })
export class ApiEndpointPool {
  private readonly runtime = inject(API_POOL_RUNTIME);
  private readonly network = inject(NetworkPolicyService);
  readonly primary = apiOrigin(this.runtime.primary) || environment.apiBaseUrl;
  readonly origins = [...new Set([this.primary, ...this.runtime.origins.map(apiOrigin).filter((v): v is string => Boolean(v))])];
  readonly current = signal(this.primary);
  readonly clusterFingerprint = signal('');
  readonly changes$ = new Subject<string>();
  private readonly verified = new Set([this.primary]);
  private readonly failedUntil = new Map<string, number>();
  private readonly pinKey = `nivra.apiCluster.v1.${this.primary}`;
  private recovery: Promise<boolean> | null = null;
  private preparation: Promise<void> | null = null;
  private preparedAt = 0;
  private candidateCursor = 0;
  private lastSuccessfulOrigin = '';
  private lastSuccessfulAt = 0;
  private recoveryNotBefore = 0;
  private recoveryFailures = 0;

  constructor() {
    const configured = this.runtime.expectedFingerprint || '';
    let stored = '';
    try { stored = this.runtime.storage.getItem(this.pinKey) || ''; } catch { /* Storage may be unavailable. */ }
    this.clusterFingerprint.set(fingerprintPattern.test(configured) ? configured : fingerprintPattern.test(stored) ? stored : '');
  }

  isConfiguredUrl(value: string): boolean { return this.originOf(value) !== null; }
  isTrustedUrl(value: string): boolean {
    const origin = this.originOf(value);
    return origin !== null && this.verified.has(origin);
  }
  rewrite(value: string): string {
    const origin = this.originOf(value);
    if (!origin) return value;
    const url = new URL(value);
    return `${this.current()}${url.pathname}${url.search}`;
  }

  prepare(): Promise<void> {
    if (this.preparation) return this.preparation;
    if (this.lastSuccessfulOrigin === this.current() && this.runtime.now() - this.lastSuccessfulAt < 60_000) return Promise.resolve();
    if (this.preparedAt && this.runtime.now() - this.preparedAt < 60000) return Promise.resolve();
    this.preparation = this.prepareOnce().finally(() => { this.preparation = null; this.preparedAt = this.runtime.now(); });
    return this.preparation;
  }

  /** Readiness can continue in the background without blocking useful API traffic. */
  prepareForRequest(): Promise<void> {
    const preparation = this.prepare();
    return new Promise(resolve => {
      const timer = globalThis.setTimeout(resolve, this.network.preparationBudgetMs());
      void preparation.then(() => { globalThis.clearTimeout(timer); resolve(); }, () => { globalThis.clearTimeout(timer); resolve(); });
    });
  }

  reportSuccess(url: string): void {
    const origin = this.originOf(url);
    if (origin !== this.current() || !this.verified.has(origin)) return;
    this.lastSuccessfulOrigin = origin;
    this.lastSuccessfulAt = this.runtime.now();
  }

  private async prepareOnce(): Promise<void> {
    // Once recovered, validate the serving node instead of repeatedly contacting a
    // suspended primary. Keep the same cluster verification for every health check.
    const active = this.current();
    if (active !== this.primary) {
      if (this.compatible(await this.probe(active, this.network.probeTimeoutMs()))) return;
      await this.recover(`${active}/health/ready`);
      return;
    }
    const health = await this.probe(this.primary, this.network.probeTimeoutMs());
    if (health) this.rememberPrimary(health);
    // Never interrupt a healthy node just because a background readiness check failed.
    const preferred = apiOrigin(this.runtime.preferred || '');
    if (preferred && preferred !== this.primary && this.origins.includes(preferred) && this.clusterFingerprint()) {
      if (this.compatible(await this.probe(preferred))) this.activate(preferred);
    }
    // Select a usable node before login/refresh/write requests, including a first install
    // while the primary is suspended. A compiled pin is independent of primary uptime.
    if (this.current() === this.primary && !this.compatible(health) && this.clusterFingerprint()) {
      await this.recover(`${this.primary}/health/ready`);
    }
  }

  recover(failedUrl: string): Promise<boolean> {
    const origin = this.originOf(failedUrl);
    if (!origin) return Promise.resolve(false);
    if (origin !== this.current()) return Promise.resolve(true);
    if (this.recovery) return this.recovery;
    if (this.runtime.now() < this.recoveryNotBefore) return Promise.resolve(false);
    this.recovery = this.recoverOnce(origin).then(changed => {
      if (changed) { this.recoveryFailures = 0; this.recoveryNotBefore = 0; }
      else this.recoveryNotBefore = this.runtime.now() + this.network.retryDelayMs(this.recoveryFailures++, 2000, 30_000);
      return changed;
    }).finally(() => { this.recovery = null; });
    return this.recovery;
  }

  private async recoverOnce(failed: string): Promise<boolean> {
    this.failedUntil.set(failed, this.runtime.now() + 60000);
    if (!this.clusterFingerprint()) {
      const health = await this.probe(this.primary, this.network.probeTimeoutMs());
      if (health) this.rememberPrimary(health);
    }
    if (!this.clusterFingerprint()) return false;
    const candidates = this.origins.filter(origin => origin !== failed);
    const ordered = [...candidates.slice(this.candidateCursor), ...candidates.slice(0, this.candidateCursor)];
    let probes = 0;
    for (const origin of ordered) {
      if (origin === failed || (this.failedUntil.get(origin) || 0) > this.runtime.now()) continue;
      if (probes++ >= 3) break;
      this.candidateCursor = candidates.length ? (candidates.indexOf(origin) + 1) % candidates.length : 0;
      const health = await this.probe(origin);
      if (origin === this.primary && health) this.rememberPrimary(health);
      if (this.compatible(health)) { this.activate(origin); return true; }
      this.failedUntil.set(origin, this.runtime.now() + 60000);
    }
    return false;
  }

  private rememberPrimary(health: Readiness): void {
    if (health.failoverProtocol !== 1 || !fingerprintPattern.test(health.clusterFingerprint || '')) {
      if (fingerprintPattern.test(this.runtime.expectedFingerprint || '')) return;
      // A reachable primary with disabled/old shared infrastructure invalidates historical backup approval.
      this.clusterFingerprint.set(''); this.verified.clear(); this.verified.add(this.primary);
      try { this.runtime.storage.setItem(this.pinKey, ''); } catch { /* Optional cache. */ }
      if (this.current() !== this.primary) this.activate(this.primary);
      return;
    }
    if (!this.validReady(health)) return;
    const configured = this.runtime.expectedFingerprint || '';
    if (configured && configured !== health.clusterFingerprint) return;
    this.failedUntil.delete(this.primary);
    // A changed configuration invalidates every previous backup before adopting the new primary pin.
    if (this.clusterFingerprint() !== health.clusterFingerprint) {
      this.verified.clear(); this.verified.add(this.primary);
      if (this.current() !== this.primary) this.activate(this.primary);
    }
    this.clusterFingerprint.set(health.clusterFingerprint);
    try { this.runtime.storage.setItem(this.pinKey, health.clusterFingerprint); } catch { /* Non-secret compatibility cache. */ }
  }
  private validReady(value: Readiness | null): value is Readiness {
    return Boolean(value && value.status === 'ok' && value.failoverProtocol === 1
      && Number.isInteger(value.callProtocol) && value.callProtocol >= NIVRA_CALL_PROTOCOL
      && Number.isInteger(value.minimumCallProtocol) && value.minimumCallProtocol >= 1 && value.minimumCallProtocol <= NIVRA_CALL_PROTOCOL
      && fingerprintPattern.test(value.clusterFingerprint)
      && (value.apiFailoverReady === true || (value.apiFailoverReady === undefined
        && value.sharedStorageReady === true && value.realtimeSharedReady === true && value.durableSigningKeyReady === true)));
  }
  private compatible(value: Readiness | null): boolean {
    return this.validReady(value) && value.clusterFingerprint === this.clusterFingerprint();
  }
  private activate(origin: string): void {
    this.verified.add(origin);
    if (this.current() === origin) return;
    this.current.set(origin); this.changes$.next(origin);
  }
  private originOf(value: string): string | null {
    try {
      const url = new URL(value);
      return !url.username && !url.password && this.origins.includes(url.origin) ? url.origin : null;
    } catch { return null; }
  }
  private async probe(origin: string, deadline = this.network.probeTimeoutMs()): Promise<Readiness | null> {
    try {
      const response = await this.runtime.fetch(`${origin}/health/ready`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(deadline),
      });
      if (!response.ok) return null;
      if (Number(response.headers.get('Age') || '0') > 0) return null;
      if (!response.body) return null;
      const length = response.headers.get('Content-Length');
      if (length && Number(length) > 16384) { await response.body.cancel(); return null; }
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > 16384) return null;
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      return value && typeof value === 'object' ? value as Readiness : null;
    } catch { return null; }
  }

  /** Mutations change the selected origin after a failure, but are never replayed ambiguously. */
  async fetch(path: string, options: RequestInit = {}, replaySafe = false, isCurrent = () => true): Promise<Response> {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    await this.prepareForRequest();
    const url = `${this.current()}${path.startsWith('/') ? path : `/${path}`}`;
    const send = (target: string) => {
      if (!isCurrent()) throw new Error('Session changed');
      const ownDeadline = AbortSignal.timeout(this.network.readTimeoutMs());
      const signal = options.signal ? AbortSignal.any([options.signal, ownDeadline]) : ownDeadline;
      const startedAt = this.runtime.now();
      return this.runtime.fetch(target, { ...options, credentials: 'omit', redirect: 'error', signal }).then(response => {
        this.network.recordResponse(this.runtime.now() - startedAt);
        if (response.ok) this.reportSuccess(target);
        return response;
      }).catch(error => {
        if (ownDeadline.aborted && !options.signal?.aborted) this.network.recordTimeout();
        throw error;
      });
    };
    try {
      const response = await send(url);
      if (![502, 503, 504].includes(response.status)) return response;
      const changed = await this.recover(url);
      return replaySafe && changed && isCurrent() ? send(this.rewrite(url)) : response;
    } catch (error) {
      if (options.signal?.aborted || !isCurrent()) throw error;
      const changed = await this.recover(url);
      if (replaySafe && changed && isCurrent()) return send(this.rewrite(url));
      throw error;
    }
  }
}
