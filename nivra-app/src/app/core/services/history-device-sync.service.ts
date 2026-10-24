import { DestroyRef, Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, fromEvent, Subject, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { CryptoService, HistoricalDeviceKeyMaterial } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

interface TransferRequest { id: string; userId: string; targetDeviceId: string; targetIdentityKey: string; targetDeviceName?: string; expiresAt: string; }
export interface PendingHistoryApproval extends TransferRequest { fingerprint: string; }
interface TransferResponse { sourceDeviceId: string; sourceIdentityKey: string; header: string; ciphertext: string; }
interface TransferStatus extends TransferRequest { responses: TransferResponse[]; }
interface KeyringPayload { v: 1; purpose: 'history-keyring'; requestId: string; userId: string; targetDeviceId: string; sourceDeviceId: string; targetPublicJwk: JsonWebKey; expiresAt: string; keys: HistoricalDeviceKeyMaterial[]; }
interface SessionScope { userId: string; deviceId: string; alias: string; epoch: number; }
const TRANSFER_HTTP_TIMEOUT_MS = 15_000;
const RECOVERY_RETRY_DELAYS_MS = [2500, 5000, 10_000];

@Injectable({ providedIn: 'root' })
export class HistoryDeviceSyncService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly api = inject(NivraApiService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private epoch = 0;
  private scopeId = '';
  private timer: number | null = null;
  private pumping: number | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpAgain = false;
  private replayRequested = false;
  private recoveryIncomplete = false;
  private recoveryRetryAt = 0;
  private recoveryRetryAttempts = 0;
  private requested = false;
  private requestId: string | null = null;
  private requestExpiresAt = 0;
  private requestedAt = 0;
  private readonly importedResponses = new Set<string>();
  private readonly dismissedRequests = new Set<string>();
  readonly pendingRequests = signal<PendingHistoryApproval[]>([]);
  readonly targetFingerprint = signal('');
  readonly approvingRequestId = signal<string | null>(null);
  readonly approvalError = signal('');
  readonly approvalEpoch = signal(0);
  readonly state = signal<'idle' | 'waiting' | 'syncing' | 'unavailable'>('idle');
  private readonly checkingState = signal(false);
  readonly checking = this.checkingState.asReadonly();
  readonly recovered$ = new Subject<void>();

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const next = session ? `${session.user.id}:${session.device.id}` : '';
      if (next !== this.scopeId) untracked(() => {
        const continueRecovery = this.requested && Boolean(session && this.scopeId.startsWith(`${session.user.id}:`));
        this.reset(next);
        if (next) { if (continueRecovery) this.beginRequest(false); else void this.pump(); }
      });
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (['connected', 'reconnected', 'history.requested', 'history.available', 'device.listChanged'].includes(event.type)) void this.pump();
    });
    fromEvent(window, 'online').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.pump());
    fromEvent(document, 'visibilitychange').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (document.visibilityState === 'visible') void this.pump();
    });
  }

  ngOnDestroy(): void { this.reset(''); this.recovered$.complete(); }

  requestHistory(): void { this.beginRequest(false); }

  private beginRequest(force: boolean): void {
    if (!this.auth.session() || (this.requested && !force)) return;
    this.requested = true;
    this.requestedAt ||= Date.now();
    if (this.state() !== 'syncing') this.state.set('waiting');
    void this.pump();
  }

  retry(): void {
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.requestedAt = Date.now(); this.replayRequested = true; this.beginRequest(true);
    const scope = this.scope();
    if (scope && this.scopeId === `${scope.userId}:${scope.deviceId}` && this.requested && this.importedResponses.size) {
      // The keys were already approved and imported for this exact session scope.
      // An expired/offline transfer endpoint must not prevent a local message retry.
      this.replayRequested = false;
      this.state.set('syncing'); this.recovered$.next();
    }
  }
  markHistoryReadable(): void {
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.requested = false; this.replayRequested = this.recoveryIncomplete = false; this.state.set('idle');
  }
  markHistoryRecoveryIncomplete(options: { retryable?: boolean } = {}): void {
    if (!this.scope()) return;
    this.requested = true; this.requestedAt ||= Date.now();
    // The consumer acknowledges actual readable messages after its recovery queue.
    // Do not replace an active import's state with a stale consumer result.
    this.recoveryIncomplete = true;
    // A transient refresh failure after approval can recover with the keys we
    // already own. Missing historical keys require a new approval, not a loop.
    this.recoveryRetryAt = options.retryable && this.importedResponses.size
      && this.recoveryRetryAttempts < RECOVERY_RETRY_DELAYS_MS.length
      ? Date.now() + RECOVERY_RETRY_DELAYS_MS[this.recoveryRetryAttempts++] : 0;
    if (!this.checking()) { this.state.set('waiting'); this.recoveryIncomplete = false; }
  }

  dismissRequest(id: string): void { this.dismissedRequests.add(id); this.pendingRequests.update(items => items.filter(item => item.id !== id)); }

  async approveRequest(id: string): Promise<void> {
    if (this.approvingRequestId()) return;
    const scope = this.scope();
    const displayed = this.pendingRequests().find(request => request.id === id);
    if (!scope || !displayed) return;
    this.approvingRequestId.set(id); this.approvalError.set('');
    try {
      // Approval authorizes the exact public key shown locally, not a fresh
      // server-selected replacement. Both devices display its client-made hash.
      const pending = await firstValueFrom(this.api.get<TransferRequest[]>('/devices/history-transfer/pending').pipe(timeout(TRANSFER_HTTP_TIMEOUT_MS)));
      this.assertCurrent(scope);
      const current = pending.find(request => request.id === id && request.userId === scope.userId && request.targetDeviceId === displayed.targetDeviceId && request.targetIdentityKey === displayed.targetIdentityKey && Date.parse(request.expiresAt) > Date.now());
      if (!current || await this.publicFingerprint(this.crypto.parsePublicJwk(current.targetIdentityKey)) !== displayed.fingerprint) throw new Error('La solicitud cambió o venció. Comprueba de nuevo el código del dispositivo.');
      this.assertCurrent(scope);
      await this.respond(current, scope);
      this.assertCurrent(scope);
      this.pendingRequests.update(items => items.filter(item => item.id !== id));
    } catch {
      if (this.isCurrent(scope)) this.approvalError.set('No se pudo compartir el historial. Comprueba el código y vuelve a intentar.');
    } finally { if (this.isCurrent(scope)) this.approvingRequestId.set(null); }
  }

  async publicFingerprint(key: JsonWebKey | null): Promise<string> {
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.d) throw new Error('Identidad de dispositivo inválida.');
    const input = new TextEncoder().encode(JSON.stringify([key.kty, key.crv, key.x, key.y]));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return Array.from(digest.subarray(0, 12), byte => byte.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join(' ');
  }

  private reset(scopeId: string): void {
    this.epoch++;
    this.approvalEpoch.set(this.epoch);
    this.scopeId = scopeId;
    this.requested = false;
    this.pumpAgain = this.replayRequested = this.recoveryIncomplete = false;
    this.requestId = null;
    this.requestExpiresAt = this.requestedAt = 0;
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.importedResponses.clear();
    this.dismissedRequests.clear();
    this.pendingRequests.set([]); this.targetFingerprint.set(''); this.approvingRequestId.set(null); this.approvalError.set('');
    this.state.set('idle');
    this.checkingState.set(false);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private scope(): SessionScope | null {
    const session = this.auth.session();
    return session?.device.isTrusted && !session.device.revokedAt ? { userId: session.user.id, deviceId: session.device.id, alias: session.user.alias, epoch: this.epoch } : null;
  }
  private isCurrent(scope: SessionScope): boolean {
    const now = this.scope();
    return now?.userId === scope.userId && now.deviceId === scope.deviceId && now.epoch === scope.epoch;
  }
  private assertCurrent(scope: SessionScope): void { if (!this.isCurrent(scope)) throw new Error('La sesión cambió durante la recuperación del historial.'); }

  private pump(): Promise<void> {
    const scope = this.scope();
    if (!scope) return Promise.resolve();
    if (this.pumping === scope.epoch) {
      this.pumpAgain = true;
      return this.pumpPromise ?? Promise.resolve();
    }
    this.pumping = scope.epoch;
    this.pumpAgain = false;
    this.checkingState.set(true);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    const operation = this.runPump(scope).finally(() => {
      if (this.pumping === scope.epoch) {
        this.pumping = null; this.pumpPromise = null;
        this.checkingState.set(false);
      }
      if (this.isCurrent(scope)) {
        if (this.recoveryIncomplete && this.requested) {
          this.state.set('waiting'); this.recoveryIncomplete = false;
        }
        let delay = this.pumpAgain ? 0 : this.requested
          ? (Date.now() - this.requestedAt < 60_000 ? 2500 : 15_000) : 30_000;
        if (this.requested && this.recoveryRetryAt) delay = Math.min(delay, Math.max(0, this.recoveryRetryAt - Date.now()));
        this.pumpAgain = false;
        this.timer = window.setTimeout(() => { this.timer = null; void this.pump(); }, delay);
      }
    });
    this.pumpPromise = operation;
    return operation;
  }

  private async runPump(scope: SessionScope): Promise<void> {
    // Fetch our approved package independently. A stalled request list for
    // other devices must not hold up an approval that has already arrived.
    const approvals = this.refreshPendingRequests(scope);
    try {
      if (this.requested && this.recoveryRetryAt && this.recoveryRetryAt <= Date.now()) {
        this.recoveryRetryAt = 0;
        this.state.set('syncing'); this.recovered$.next();
      }
      this.assertCurrent(scope);
      if (this.requested) {
        const own = await this.auth.ensureDeviceIdentity();
        this.assertCurrent(scope);
        const fingerprint = await this.publicFingerprint(own.publicJwk);
        this.assertCurrent(scope); this.targetFingerprint.set(fingerprint);
        if (!this.requested) return;
        const status = await this.requestStatus(scope);
        this.assertCurrent(scope);
        if (!this.requested) return;
        const target = this.crypto.parsePublicJwk(status.targetIdentityKey);
        if (status.id !== this.requestId || status.userId !== scope.userId || status.targetDeviceId !== scope.deviceId
          || !Number.isFinite(Date.parse(status.expiresAt)) || Date.parse(status.expiresAt) <= Date.now()
          || !this.crypto.samePublicKey(own.publicJwk, target)) throw new Error('Solicitud de historial inválida.');
        let failed = false;
        let imported = false;
        for (const response of status.responses ?? []) {
          try {
            const previous = this.importedResponses.size;
            await this.importResponse(status, response, scope, false);
            imported ||= this.importedResponses.size > previous;
          } catch { this.assertCurrent(scope); failed = true; }
        }
        // Import the complete available batch before starting a message refresh.
        // Several approved sources can contribute different historical keys.
        if (imported) this.recovered$.next();
        if (this.replayRequested && this.requested) {
          const hasApprovedKeys = (status.responses ?? []).some(response => this.importedResponses.has(`${status.id}:${response.sourceDeviceId}`));
          if (imported || hasApprovedKeys) {
            this.replayRequested = false;
            // An explicit retry may follow a failed message refresh after key import.
            // Reuse that approval once; ordinary polling never starts replay loops.
            if (!imported) { this.state.set('syncing'); this.recovered$.next(); }
          }
        }
        if (failed && !imported && this.requested && this.state() !== 'syncing') this.state.set('unavailable');
        else if (!failed && this.requested && this.state() === 'unavailable') this.state.set('waiting');
      }
    } catch {
      if (this.isCurrent(scope) && this.requested && this.state() !== 'syncing') this.state.set('unavailable');
    } finally { await approvals; }
  }

  private async refreshPendingRequests(scope: SessionScope): Promise<void> {
    try {
      const pending = await firstValueFrom(this.api.get<TransferRequest[]>('/devices/history-transfer/pending').pipe(timeout(TRANSFER_HTTP_TIMEOUT_MS)));
      this.assertCurrent(scope);
      const approvals: PendingHistoryApproval[] = [];
      for (const request of pending ?? []) {
        if (this.dismissedRequests.has(request.id) || request.userId !== scope.userId || request.targetDeviceId === scope.deviceId || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) continue;
        const key = this.crypto.parsePublicJwk(request.targetIdentityKey);
        if (!key) continue;
        approvals.push({ ...request, fingerprint: await this.publicFingerprint(key) });
        this.assertCurrent(scope);
      }
      this.pendingRequests.set(approvals);
    } catch { /* Approval listing is best effort and independent of delivery. */ }
  }

  private async requestStatus(scope: SessionScope): Promise<TransferStatus> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.requestId || this.requestExpiresAt <= Date.now()) {
        const request = await firstValueFrom(this.api.post<TransferRequest>('/devices/history-transfer/', {}).pipe(timeout(TRANSFER_HTTP_TIMEOUT_MS)));
        this.assertCurrent(scope);
        if (!request.id || request.userId !== scope.userId || request.targetDeviceId !== scope.deviceId
          || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('Solicitud de historial inválida.');
        this.requestId = request.id; this.requestExpiresAt = Date.parse(request.expiresAt);
      }
      try {
        return await firstValueFrom(this.api.get<TransferStatus>(`/devices/history-transfer/${encodeURIComponent(this.requestId)}`).pipe(timeout(TRANSFER_HTTP_TIMEOUT_MS)));
      } catch (error) {
        this.assertCurrent(scope);
        const status = (error as { status?: unknown } | null)?.status;
        if (attempt || (status !== 404 && status !== 410)) throw error;
        this.requestId = null; this.requestExpiresAt = 0;
      }
    }
    throw new Error('La solicitud de historial ya no está disponible.');
  }

  private async respond(request: TransferRequest, scope: SessionScope): Promise<void> {
    const target = this.crypto.parsePublicJwk(request.targetIdentityKey);
    if (!target || target.d || target.kty !== 'EC' || target.crv !== 'P-256') throw new Error('Identidad de dispositivo inválida.');
    const own = await this.auth.ensureDeviceIdentity();
    this.assertCurrent(scope);
    const materials = await this.crypto.exportDeviceKeyMaterialsForUser(scope.userId, scope.alias);
    this.assertCurrent(scope);
    if (materials.length > 256) throw new Error('El historial requiere vinculación mediante QR.');
    const keys = materials.map(key => ({ publicJwk: key.publicJwk, privateJwk: key.privateJwk, createdAt: key.createdAt }));
    if (!keys.length) throw new Error('Este dispositivo no conserva llaves de historial vinculadas a tu cuenta.');
    const payload: KeyringPayload = { v: 1, purpose: 'history-keyring', requestId: request.id, userId: scope.userId, targetDeviceId: request.targetDeviceId, sourceDeviceId: scope.deviceId, targetPublicJwk: target, expiresAt: request.expiresAt, keys };
    const sealed = await this.crypto.encryptForPublicKey(own, target, payload);
    this.assertCurrent(scope);
    await firstValueFrom(this.api.post(`/devices/history-transfer/${encodeURIComponent(request.id)}/response`, sealed).pipe(timeout(TRANSFER_HTTP_TIMEOUT_MS)));
    this.assertCurrent(scope);
  }

  private async importResponse(request: TransferStatus, response: TransferResponse, scope: SessionScope, notify = true): Promise<void> {
    const responseId = `${request.id}:${response.sourceDeviceId}`;
    this.assertCurrent(scope);
    if (this.importedResponses.has(responseId)) return;
    if (request.id !== this.requestId || request.userId !== scope.userId || request.targetDeviceId !== scope.deviceId || response.sourceDeviceId === scope.deviceId || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('El paquete de historial no corresponde a esta sesión.');
    const own = await this.auth.ensureDeviceIdentity();
    this.assertCurrent(scope);
    const target = this.crypto.parsePublicJwk(request.targetIdentityKey);
    const source = this.crypto.parsePublicJwk(response.sourceIdentityKey);
    if (typeof response.header !== 'string' || response.header.length > 4096 || typeof response.ciphertext !== 'string'
      || response.ciphertext.length > 512 * 1024) throw new Error('El paquete de historial no es válido.');
    const header = JSON.parse(response.header) as { v?: number; alg?: string; senderPublicKey?: JsonWebKey };
    if (header.v !== 1 || header.alg !== 'ECDH-P256-A256GCM' || source?.d || target?.d
      || !this.crypto.parsePublicJwk(header.senderPublicKey) || !this.crypto.samePublicKey(own.publicJwk, target)
      || !this.crypto.samePublicKey(source, header.senderPublicKey)) throw new Error('No se pudo comprobar el dispositivo de origen del historial.');
    const payload = await this.crypto.decryptEnvelope<KeyringPayload>(own, response.header, response.ciphertext);
    this.assertCurrent(scope);
    if (payload.v !== 1 || payload.purpose !== 'history-keyring' || payload.requestId !== request.id || payload.userId !== scope.userId || payload.targetDeviceId !== scope.deviceId || payload.sourceDeviceId !== response.sourceDeviceId || payload.expiresAt !== request.expiresAt || !this.crypto.samePublicKey(payload.targetPublicJwk, own.publicJwk) || !Array.isArray(payload.keys) || !payload.keys.length) throw new Error('El historial cifrado no corresponde a esta solicitud.');
    await this.crypto.importHistoricalDeviceKeys(scope.userId, scope.alias, payload.keys, () => this.isCurrent(scope));
    this.assertCurrent(scope);
    this.state.set('syncing');
    this.recoveryIncomplete = false;
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.importedResponses.add(responseId);
    if (notify) this.recovered$.next();
  }
}
