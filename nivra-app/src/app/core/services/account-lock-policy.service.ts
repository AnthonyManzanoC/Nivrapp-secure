import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, fromEvent, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { NetworkPolicyService } from './network-policy.service';

export interface SharedPinEnvelope {
  v: 1; alg: 'PBKDF2-SHA256+A256GCM'; iterations: number; salt: string; iv: string; ciphertext: string;
}
export interface AccountLockPolicy {
  userId: string; revision: number; enabled: boolean; pinEnvelope: SharedPinEnvelope | null; updatedAt: string | null;
}
const PREFIX = 'nivra.accountLock.v1.';

export function validSharedPin(value: unknown): value is SharedPinEnvelope {
  const pin = value as SharedPinEnvelope | null;
  if (!pin || pin.v !== 1 || pin.alg !== 'PBKDF2-SHA256+A256GCM'
    || !Number.isInteger(pin.iterations) || pin.iterations < 240000 || pin.iterations > 1000000) return false;
  try {
    return typeof pin.salt === 'string' && pin.salt.length <= 32 && atob(pin.salt).length === 16
      && typeof pin.iv === 'string' && pin.iv.length <= 24 && atob(pin.iv).length === 12
      && typeof pin.ciphertext === 'string' && pin.ciphertext.length <= 2048
      && atob(pin.ciphertext).length >= 48 && atob(pin.ciphertext).length <= 1536;
  } catch { return false; }
}

@Injectable({ providedIn: 'root' })
export class AccountLockPolicyService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(NivraApiService);
  private readonly realtime = inject(SignalrService);
  private readonly network = inject(NetworkPolicyService);
  private readonly destroyRef = inject(DestroyRef);
  private scope = '';
  private epoch = 0;
  private destroyed = false;
  private inFlight: { scope: string; promise: Promise<void> } | null = null;
  private lastRead = 0;
  private readonly legacyServerAccount = signal('');
  readonly policy = signal<AccountLockPolicy | null>(this.readCache(this.auth.session()?.user.id || ''));
  readonly unresolved = computed(() => {
    const account = this.auth.session()?.user.id || '';
    return !!account && this.policy()?.userId !== account && this.legacyServerAccount() !== account;
  });
  readonly syncError = signal('');
  readonly syncing = signal(false);

  constructor() {
    effect(() => {
      const userId = this.auth.session()?.user.id || '';
      const deviceId = this.auth.session()?.device?.id || '';
      untracked(() => {
        const scope = userId && deviceId ? `${userId}:${deviceId}` : '';
        if (scope === this.scope) return;
        this.scope = scope; this.epoch++; this.lastRead = 0; this.inFlight = null;
        this.syncing.set(false); this.syncError.set(''); this.legacyServerAccount.set(''); this.policy.set(this.readCache(userId));
        if (scope) void this.refresh().catch(() => undefined);
      });
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (['account.app-lock.updated', 'connected', 'reconnected'].includes(event.type)) void this.refresh(true).catch(() => undefined);
    });
    fromEvent(window, 'online').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.refresh(true).catch(() => undefined));
    fromEvent(document, 'visibilitychange').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (document.visibilityState !== 'hidden') void this.refresh().catch(() => undefined);
    });
    fromEvent<StorageEvent>(window, 'storage').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      const userId = this.auth.session()?.user.id || '';
      if (event.key !== PREFIX + userId) return;
      const cached = this.readCache(userId);
      if (cached && cached.revision > (this.policy()?.revision ?? -1)) this.policy.set(cached);
    });
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.refresh().catch(() => undefined);
    }, 90000);
    this.destroyRef.onDestroy(() => { this.destroyed = true; this.epoch++; clearInterval(timer); });
  }

  refresh(force = false): Promise<void> {
    if (!this.scope || this.destroyed || navigator.onLine === false) return Promise.resolve();
    if (this.inFlight?.scope === this.scope) return this.inFlight.promise;
    if (!force && Date.now() - this.lastRead < 60000) return Promise.resolve();
    const scope = this.scope, epoch = this.epoch, userId = this.auth.session()!.user.id;
    this.lastRead = Date.now(); this.syncing.set(true);
    const promise = firstValueFrom(this.api.get<AccountLockPolicy>('/account/app-lock').pipe(timeout(Math.max(45000, this.network.readTimeoutMs()))))
      .then(policy => {
        if (!this.current(scope, epoch)) return;
        if (!this.validPolicy(policy, userId)) throw new Error('INVALID_ACCOUNT_LOCK_POLICY');
        this.accept(policy); this.syncError.set('');
      }).catch(error => {
        // Older compatible APIs have no account-wide policy. Keep the existing
        // installation lock until the server is upgraded; never erase it.
        if (this.current(scope, epoch) && error?.status === 404) this.legacyServerAccount.set(userId);
        if (this.current(scope, epoch)) this.syncError.set(error?.status === 404
          ? 'La sincronización de Modo Seguro requiere actualizar el servidor.'
          : 'La configuración guardada sigue activa. Se sincronizará cuando vuelva la conexión.');
        throw error;
      }).finally(() => {
        if (this.current(scope, epoch)) this.syncing.set(false);
        if (this.inFlight?.promise === promise) this.inFlight = null;
      });
    this.inFlight = { scope, promise }; return promise;
  }

  async save(enabled: boolean, pinEnvelope: SharedPinEnvelope | null): Promise<AccountLockPolicy> {
    if (!this.scope || this.destroyed) throw new Error('Inicia sesión antes de configurar Modo Seguro.');
    if (navigator.onLine === false) throw new Error('Conéctate para cambiar Modo Seguro en todos tus dispositivos. El bloqueo actual sigue activo.');
    if (enabled && !validSharedPin(pinEnvelope)) throw new Error('El PIN protegido no es válido.');
    const scope = this.scope, epoch = this.epoch, userId = this.auth.session()!.user.id;
    const observedRevision = this.policy()?.revision ?? 0;
    await this.refresh(true);
    if (!this.current(scope, epoch)) throw new Error('La cuenta cambió.');
    const revision = this.policy()?.revision ?? 0;
    if (revision !== observedRevision) throw new Error('Modo Seguro cambió en otro dispositivo. Revisa la configuración y vuelve a intentar.');
    try {
      const policy = await firstValueFrom(this.api.put<AccountLockPolicy>('/account/app-lock', { revision, enabled, pinEnvelope }).pipe(timeout(Math.max(45000, this.network.readTimeoutMs()))));
      if (!this.current(scope, epoch)) throw new Error('La cuenta cambió.');
      if (!this.validPolicy(policy, userId) || policy.revision <= revision || policy.enabled !== enabled) throw new Error('La configuración recibida no es válida.');
      this.accept(policy); this.syncError.set(''); return policy;
    } catch (error: any) {
      if (this.current(scope, epoch) && error?.status === 409) {
        await this.refresh(true).catch(() => undefined);
        throw new Error('Modo Seguro cambió en otro dispositivo. Revisa la configuración y vuelve a intentar.');
      }
      throw error;
    }
  }

  private current(scope: string, epoch: number): boolean {
    const session = this.auth.session();
    return !this.destroyed && epoch === this.epoch && scope === this.scope
      && scope === `${session?.user.id}:${session?.device?.id}`;
  }
  private accept(policy: AccountLockPolicy): void {
    if (policy.revision < (this.policy()?.revision ?? -1)) return;
    this.policy.set(policy);
    try { localStorage.setItem(PREFIX + policy.userId, JSON.stringify(policy)); } catch { /* Retain memory protection when storage is unavailable. */ }
  }
  private validPolicy(value: AccountLockPolicy, userId: string): boolean {
    return !!value && value.userId === userId && Number.isSafeInteger(value.revision) && value.revision >= 0
      && typeof value.enabled === 'boolean' && (!value.enabled || value.revision > 0 && validSharedPin(value.pinEnvelope));
  }
  private readCache(userId: string): AccountLockPolicy | null {
    if (!userId) return null;
    try { const value = JSON.parse(localStorage.getItem(PREFIX + userId) || 'null'); return this.validPolicy(value, userId) ? value : null; }
    catch { return null; }
  }
}
