import { DestroyRef, Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, Subject } from 'rxjs';
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
  readonly recovered$ = new Subject<void>();

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const next = session ? `${session.user.id}:${session.device.id}` : '';
      if (next !== this.scopeId) untracked(() => { this.reset(next); if (next) void this.pump(); });
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (['connected', 'reconnected', 'history.requested', 'history.available', 'device.listChanged'].includes(event.type)) void this.pump();
    });
  }

  ngOnDestroy(): void { this.reset(''); this.recovered$.complete(); }

  requestHistory(): void {
    if (!this.auth.session()) return;
    this.requested = true;
    this.requestedAt ||= Date.now();
    this.state.set('waiting');
    void this.pump();
  }

  retry(): void { this.requestedAt = Date.now(); this.requestHistory(); }
  markHistoryReadable(): void { this.requested = false; this.state.set('idle'); }

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
      const pending = await firstValueFrom(this.api.get<TransferRequest[]>('/devices/history-transfer/pending'));
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
    this.requestId = null;
    this.requestExpiresAt = this.requestedAt = 0;
    this.importedResponses.clear();
    this.dismissedRequests.clear();
    this.pendingRequests.set([]); this.targetFingerprint.set(''); this.approvingRequestId.set(null); this.approvalError.set('');
    this.state.set('idle');
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

  private async pump(): Promise<void> {
    const scope = this.scope();
    if (!scope || this.pumping === scope.epoch) return;
    this.pumping = scope.epoch;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    try {
      const pending = await firstValueFrom(this.api.get<TransferRequest[]>('/devices/history-transfer/pending'));
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
      this.assertCurrent(scope);
      if (this.requested) {
        const own = await this.crypto.currentKeyMaterial(scope.alias, scope.deviceId);
        this.assertCurrent(scope);
        const fingerprint = await this.publicFingerprint(own.publicJwk);
        this.assertCurrent(scope); this.targetFingerprint.set(fingerprint);
        if (!this.requestId || this.requestExpiresAt <= Date.now()) {
          const request = await firstValueFrom(this.api.post<TransferRequest>('/devices/history-transfer/', {}));
          this.assertCurrent(scope);
          if (!request.id || request.userId !== scope.userId || request.targetDeviceId !== scope.deviceId || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('Solicitud de historial inválida.');
          this.requestId = request.id; this.requestExpiresAt = Date.parse(request.expiresAt);
        }
        const status = await firstValueFrom(this.api.get<TransferStatus>(`/devices/history-transfer/${encodeURIComponent(this.requestId)}`));
        this.assertCurrent(scope);
        for (const response of status.responses ?? []) {
          try { await this.importResponse(status, response, scope); }
          catch { this.assertCurrent(scope); this.state.set('unavailable'); }
        }
      }
    } catch {
      if (this.isCurrent(scope) && this.requested) this.state.set('unavailable');
    } finally {
      if (this.pumping === scope.epoch) this.pumping = null;
      if (this.isCurrent(scope)) {
        const delay = this.requested ? (Date.now() - this.requestedAt < 60_000 ? 2500 : 15_000) : 30_000;
        this.timer = window.setTimeout(() => { this.timer = null; void this.pump(); }, delay);
      }
    }
  }

  private async respond(request: TransferRequest, scope: SessionScope): Promise<void> {
    const target = this.crypto.parsePublicJwk(request.targetIdentityKey);
    if (!target || target.d || target.kty !== 'EC' || target.crv !== 'P-256') throw new Error('Identidad de dispositivo inválida.');
    const own = await this.crypto.currentKeyMaterial(scope.alias, scope.deviceId);
    this.assertCurrent(scope);
    const materials = await this.crypto.exportDeviceKeyMaterialsForUser(scope.userId, scope.alias);
    this.assertCurrent(scope);
    if (materials.length > 256) throw new Error('El historial requiere vinculación mediante QR.');
    const keys = materials.map(key => ({ publicJwk: key.publicJwk, privateJwk: key.privateJwk, createdAt: key.createdAt }));
    if (!keys.length) throw new Error('Este dispositivo no conserva llaves de historial vinculadas a tu cuenta.');
    const payload: KeyringPayload = { v: 1, purpose: 'history-keyring', requestId: request.id, userId: scope.userId, targetDeviceId: request.targetDeviceId, sourceDeviceId: scope.deviceId, targetPublicJwk: target, expiresAt: request.expiresAt, keys };
    const sealed = await this.crypto.encryptForPublicKey(own, target, payload);
    this.assertCurrent(scope);
    await firstValueFrom(this.api.post(`/devices/history-transfer/${encodeURIComponent(request.id)}/response`, sealed));
    this.assertCurrent(scope);
  }

  private async importResponse(request: TransferStatus, response: TransferResponse, scope: SessionScope): Promise<void> {
    const responseId = `${request.id}:${response.sourceDeviceId}`;
    if (this.importedResponses.has(responseId)) return;
    this.assertCurrent(scope);
    if (request.id !== this.requestId || request.userId !== scope.userId || request.targetDeviceId !== scope.deviceId || response.sourceDeviceId === scope.deviceId || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('El paquete de historial no corresponde a esta sesión.');
    const own = await this.crypto.currentKeyMaterial(scope.alias, scope.deviceId);
    this.assertCurrent(scope);
    const target = this.crypto.parsePublicJwk(request.targetIdentityKey);
    const source = this.crypto.parsePublicJwk(response.sourceIdentityKey);
    const header = JSON.parse(response.header) as { alg?: string; senderPublicKey?: JsonWebKey };
    if (header.alg !== 'ECDH-P256-A256GCM' || source?.d || target?.d || !this.crypto.samePublicKey(own.publicJwk, target) || !this.crypto.samePublicKey(source, header.senderPublicKey)) throw new Error('No se pudo comprobar el dispositivo de origen del historial.');
    const payload = await this.crypto.decryptEnvelope<KeyringPayload>(own, response.header, response.ciphertext);
    this.assertCurrent(scope);
    if (payload.v !== 1 || payload.purpose !== 'history-keyring' || payload.requestId !== request.id || payload.userId !== scope.userId || payload.targetDeviceId !== scope.deviceId || payload.sourceDeviceId !== response.sourceDeviceId || payload.expiresAt !== request.expiresAt || !this.crypto.samePublicKey(payload.targetPublicJwk, own.publicJwk) || !Array.isArray(payload.keys) || !payload.keys.length) throw new Error('El historial cifrado no corresponde a esta solicitud.');
    this.state.set('syncing');
    await this.crypto.importHistoricalDeviceKeys(scope.userId, scope.alias, payload.keys, () => this.isCurrent(scope));
    this.assertCurrent(scope);
    this.importedResponses.add(responseId);
    this.recovered$.next();
  }
}
