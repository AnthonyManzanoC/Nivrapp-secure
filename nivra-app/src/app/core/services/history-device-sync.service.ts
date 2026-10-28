import { DestroyRef, Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, fromEvent, Subject, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { CryptoService, HistoricalDeviceKeyMaterial } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { MessageResponse, NivraDevice, StoredDeviceKeys } from '../models/nivra.models';
import { NetworkPolicyService } from './network-policy.service';
import { IdentityTrustService, IdentityTrustTransfer } from './identity-trust.service';

interface TransferRequest { id: string; userId: string; targetDeviceId: string; targetIdentityKey: string; targetDeviceName?: string; expiresAt: string; }
export interface PendingHistoryApproval extends TransferRequest { fingerprint: string; }
export interface PreferredHistorySource {
  deviceId: string;
  deviceName: string;
  kind: 'android' | 'other';
  basis: 'message-recipient' | 'active-device';
}
interface TransferResponse { sourceDeviceId: string; sourceIdentityKey: string; header: string; ciphertext: string; }
interface TransferStatus extends TransferRequest { responses: TransferResponse[]; }
interface KeyringPayload { v: 1; purpose: 'history-keyring'; requestId: string; userId: string; targetDeviceId: string; sourceDeviceId: string; targetPublicJwk: JsonWebKey; expiresAt: string; keys: HistoricalDeviceKeyMaterial[]; identityTrust?: IdentityTrustTransfer; }
interface SessionScope { userId: string; deviceId: string; alias: string; epoch: number; }
export interface HistoryRecoveryEvidence {
  userId: string;
  deviceId: string;
  reason: 'undecryptable-ciphertext';
  message: Pick<MessageResponse, 'id' | 'conversationId' | 'recipients' | 'expiresAt' | 'encryptedPolicy'>;
}
const TRANSFER_HTTP_TIMEOUT_MS = 15_000;
const RECOVERY_RETRY_DELAYS_MS = [2500, 5000, 10_000];
const SOURCE_DIRECTORY_CACHE_MS = 60_000;
const LOCAL_RECOVERY_CHECK_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class HistoryDeviceSyncService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly api = inject(NivraApiService);
  private readonly network = inject(NetworkPolicyService);
  private readonly realtime = inject(SignalrService);
  private readonly identityTrust = inject(IdentityTrustService);
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
  private requestRevision = 0;
  private requestEvidence: HistoryRecoveryEvidence | null = null;
  private evidenceCheck: { epoch: number; promise: Promise<void>; evidence: HistoryRecoveryEvidence } | null = null;
  private requestId: string | null = null;
  private requestExpiresAt = 0;
  private requestedAt = 0;
  private readonly importedResponses = new Set<string>();
  private readonly dismissedRequests = new Set<string>();
  private sourceDirectory: { epoch: number; expiresAt: number; devices: NivraDevice[] } | null = null;
  private sourceDirectoryCheck: { epoch: number; promise: Promise<void> } | null = null;
  private sourceDirectoryRevision = 0;
  private localRecoveryCheckAt = 0;
  private localRecoveryStamp = '';
  private localReplayAwaitingAck = false;
  private localRecoveryProved = false;
  // This is an actionable candidate, never a claim that a remote installation
  // still possesses private keys. The current API intentionally exposes none.
  readonly preferredSource = signal<PreferredHistorySource | null>(null);
  readonly sourceCapability = signal<'unknown' | 'persisted-keys' | 'unavailable'>('unknown');
  readonly sourceAvailability = signal<'unknown' | 'available' | 'local-only'>('unknown');
  readonly pendingRequests = signal<PendingHistoryApproval[]>([]);
  readonly targetFingerprint = signal('');
  readonly approvingRequestId = signal<string | null>(null);
  readonly approvalError = signal('');
  readonly approvalEpoch = signal(0);
  readonly state = signal<'idle' | 'waiting' | 'syncing' | 'unavailable'>('idle');
  readonly recoveryStatus = signal<'approval' | 'partial' | 'retryable'>('approval');
  private readonly checkingState = signal(false);
  readonly checking = this.checkingState.asReadonly();
  readonly recovered$ = new Subject<void>();

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const next = session ? `${session.user.id}:${session.device.id}` : '';
      if (next !== this.scopeId) untracked(() => {
        const continueEvidence = this.requested && this.requestEvidence && session && this.scopeId.startsWith(`${session.user.id}:`)
          ? { ...this.requestEvidence, deviceId: session.device.id } : null;
        this.reset(next);
        if (next) { if (continueEvidence) void this.requestHistory(continueEvidence); else void this.pump(); }
      });
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (event.type === 'device.listChanged') {
        this.invalidateSourcePreference();
      }
      if (['connected', 'reconnected', 'history.requested', 'history.available', 'device.listChanged'].includes(event.type)) void this.pump();
    });
    fromEvent(window, 'online').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.pump());
    fromEvent(document, 'visibilitychange').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (document.visibilityState === 'visible') void this.pump();
    });
  }

  ngOnDestroy(): void { this.reset(''); this.recovered$.complete(); }

  requestHistory(evidence: HistoryRecoveryEvidence): Promise<void> {
    const scope = this.scope();
    if (!scope || !this.validEvidence(evidence, scope)) return Promise.resolve();
    if (this.requested) {
      this.requestEvidence = evidence;
      this.updatePreferredSource(scope);
      return Promise.resolve();
    }
    if (this.evidenceCheck?.epoch === scope.epoch) { this.evidenceCheck.evidence = evidence; return this.evidenceCheck.promise; }
    const revision = this.requestRevision;
    const promise = (async () => {
      // Failure to open the local key store is not evidence that another device
      // must send history. Never generate or rotate an identity from this path.
      const own = await this.crypto.recoverDeviceIdentity(scope.userId, scope.alias, scope.deviceId, null, () => this.isCurrent(scope));
      const materials = await this.crypto.deviceKeyMaterialsForUser(scope.userId, scope.alias, { requireReadable: true });
      this.assertCurrent(scope);
      if (revision !== this.requestRevision) return;
      const candidate = this.evidenceCheck?.epoch === scope.epoch ? this.evidenceCheck.evidence : evidence;
      if (!own || own.userId !== scope.userId || own.deviceId !== scope.deviceId || !this.validEvidence(candidate, scope)) return;
      const recipient = candidate.message.recipients.find(item => item.userId === scope.userId && this.evidenceSenderKey(item.header, item.ciphertext));
      const sender = recipient ? this.evidenceSenderKey(recipient.header, recipient.ciphertext) : null;
      if (!sender) return;
      await crypto.subtle.importKey('jwk', sender, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      this.assertCurrent(scope);
      if (revision !== this.requestRevision) return;
      if (!this.validEvidence(candidate, scope)) return;
      this.requestEvidence = candidate;
      if (await this.tryRecoverLocally(scope, candidate, materials)) return;
      this.assertCurrent(scope);
      if (revision !== this.requestRevision) return;
      this.beginRequest(false);
    })().catch(() => { /* The caller keeps local storage/key errors separate. */ }).finally(() => {
      if (this.evidenceCheck?.promise === promise) this.evidenceCheck = null;
    });
    this.evidenceCheck = { epoch: scope.epoch, promise, evidence };
    return promise;
  }

  private beginRequest(force: boolean): void {
    const scope = this.scope();
    if (!scope || !this.requestEvidence || !this.validEvidence(this.requestEvidence, scope) || (this.requested && !force)) return;
    this.requested = true;
    this.requestedAt ||= Date.now();
    if (this.state() !== 'syncing') this.state.set('waiting');
    void this.pump();
  }

  retry(): void {
    if (!this.requested || !this.requestEvidence) return;
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.requestedAt = Date.now(); this.replayRequested = true; this.beginRequest(true);
    const scope = this.scope();
    if (scope && this.scopeId === `${scope.userId}:${scope.deviceId}` && this.requested) {
      // Imported keys survive a reload; importedResponses intentionally does not.
      // Always try saved local keys first, even if a former transfer is offline
      // or no approval has arrived yet. The consumer must acknowledge readability.
      this.replayRequested = false;
      this.state.set('syncing'); this.recovered$.next();
    }
  }
  markHistoryReadable(): void {
    this.requestRevision = (this.requestRevision ?? 0) + 1;
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.requested = false; this.replayRequested = this.recoveryIncomplete = false; this.state.set('idle');
    this.localReplayAwaitingAck = false;
    this.localRecoveryProved = false;
    this.requestEvidence = null;
    this.evidenceCheck = null;
    this.recoveryStatus.set('approval');
    this.preferredSource.set(null);
    this.sourceAvailability.set('unknown');
  }
  markHistoryRecoveryIncomplete(options: { retryable?: boolean } = {}): void {
    if (!this.scope() || !this.requested || !this.requestEvidence) return;
    this.requested = true; this.requestedAt ||= Date.now();
    // The consumer checks its own recovery revision before acknowledging. Once
    // that work has settled, an unrelated approval-list poll must not keep the
    // chat list in its loading state. A later import starts a fresh recovery.
    this.recoveryIncomplete = true;
    this.recoveryStatus.set(options.retryable ? 'retryable' : this.importedResponses.size ? 'partial' : 'approval');
    // A transient refresh failure after approval can recover with the keys we
    // already own. Missing historical keys require a new approval, not a loop.
    this.recoveryRetryAt = options.retryable && (this.importedResponses.size || this.localRecoveryProved)
      && this.recoveryRetryAttempts < RECOVERY_RETRY_DELAYS_MS.length
      ? Date.now() + RECOVERY_RETRY_DELAYS_MS[this.recoveryRetryAttempts++] : 0;
    this.state.set('waiting');
    if (!this.checking()) this.recoveryIncomplete = false;
    if (this.localReplayAwaitingAck) {
      this.localReplayAwaitingAck = false;
      // A readable probe is only a reason to retry known messages. The chat
      // consumer alone can acknowledge that the complete history is readable.
      void this.pump();
    }
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
      const pending = await firstValueFrom(this.api.get<TransferRequest[]>('/devices/history-transfer/pending').pipe(timeout(this.transferTimeoutMs())));
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
    this.requestRevision = (this.requestRevision ?? 0) + 1;
    this.requestEvidence = null; this.evidenceCheck = null;
    this.pumpAgain = this.replayRequested = this.recoveryIncomplete = false;
    this.requestId = null;
    this.requestExpiresAt = this.requestedAt = 0;
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.importedResponses.clear();
    this.dismissedRequests.clear();
    this.sourceDirectory = this.sourceDirectoryCheck = null;
    this.sourceDirectoryRevision = (this.sourceDirectoryRevision ?? 0) + 1;
    this.localRecoveryCheckAt = 0; this.localRecoveryStamp = ''; this.localReplayAwaitingAck = false; this.localRecoveryProved = false;
    this.preferredSource.set(null); this.sourceCapability.set('unknown');
    this.sourceAvailability.set('unknown');
    this.pendingRequests.set([]); this.targetFingerprint.set(''); this.approvingRequestId.set(null); this.approvalError.set('');
    this.state.set('idle');
    this.recoveryStatus.set('approval');
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

  private async persistedIdentity(scope: SessionScope) {
    const own = await this.crypto.recoverDeviceIdentity(scope.userId, scope.alias, scope.deviceId, null, () => this.isCurrent(scope));
    this.assertCurrent(scope);
    if (!own || own.userId !== scope.userId || own.deviceId !== scope.deviceId) throw new Error('No se pudo abrir la identidad guardada de este dispositivo.');
    return own;
  }

  private transferTimeoutMs(): number {
    return Math.max(TRANSFER_HTTP_TIMEOUT_MS, this.network?.readTimeoutMs() ?? 0);
  }

  private validEvidence(evidence: HistoryRecoveryEvidence | null | undefined, scope: SessionScope): boolean {
    const message = evidence?.message;
    if (evidence?.reason !== 'undecryptable-ciphertext' || evidence.userId !== scope.userId || evidence.deviceId !== scope.deviceId
      || !message || typeof message.id !== 'string' || !message.id.trim() || typeof message.conversationId !== 'string' || !message.conversationId.trim()
      || message.encryptedPolicy?.startsWith('system:') || !Array.isArray(message.recipients)) return false;
    if (message.expiresAt && (!Number.isFinite(Date.parse(message.expiresAt)) || Date.parse(message.expiresAt) <= Date.now())) return false;
    return message.recipients.some(recipient => recipient.userId === scope.userId && Boolean(this.evidenceSenderKey(recipient.header, recipient.ciphertext)));
  }

  private evidenceSenderKey(header: string | null | undefined, ciphertext: string | null | undefined): JsonWebKey | null {
    try {
      const bytes = (value: unknown) => typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? atob(value).length : 0;
      if (typeof header !== 'string' || header.length > 2 * 1024 * 1024 || bytes(ciphertext) < 16) return null;
      let value = JSON.parse(header) as { v?: number; alg?: string; senderPublicKey?: JsonWebKey; iv?: string; keyHeader?: string; payloadIv?: string; payloadCiphertext?: string };
      if (value.v === 2 && value.alg === 'NIVRA-GROUP-A256GCM') {
        if (bytes(value.payloadIv) !== 12 || bytes(value.payloadCiphertext) < 16 || typeof value.keyHeader !== 'string') return null;
        value = JSON.parse(value.keyHeader);
      }
      return value.v === 1 && value.alg === 'ECDH-P256-A256GCM' && bytes(value.iv) === 12
        ? this.crypto.parsePublicJwk(value.senderPublicKey) : null;
    } catch { return null; }
  }

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
        let delay = this.pumpAgain ? 0 : this.requested && this.sourceAvailability() === 'local-only' ? 30_000 : this.requested
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
    // Directory availability must never delay creating a request or importing
    // an already approved package from any capable platform.
    if (this.requested && this.requestEvidence) void this.refreshSourcePreference(scope);
    try {
      if (this.requested && this.recoveryRetryAt && this.recoveryRetryAt <= Date.now()) {
        this.recoveryRetryAt = 0;
        this.state.set('syncing'); this.recovered$.next();
      }
      this.assertCurrent(scope);
      if (this.requested) {
        if (this.requestEvidence && Date.now() >= this.localRecoveryCheckAt
          && await this.tryRecoverLocally(scope, this.requestEvidence)) return;
        this.assertCurrent(scope);
        if (!this.requested) return;
        const own = await this.persistedIdentity(scope);
        this.assertCurrent(scope);
        const fingerprint = await this.publicFingerprint(own.publicJwk);
        this.assertCurrent(scope); this.targetFingerprint.set(fingerprint);
        if (!this.requested) return;
        // A directory-confirmed sole installation has no device to approve a
        // fresh request. Keep existing approved packages eligible until expiry,
        // but do not create a new impossible approval on every expiration.
        if (this.sourceAvailability() === 'local-only' && (!this.requestId || this.requestExpiresAt <= Date.now())) return;
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

  private async tryRecoverLocally(scope: SessionScope, evidence: HistoryRecoveryEvidence, saved?: StoredDeviceKeys[]): Promise<boolean> {
    this.localRecoveryCheckAt = Date.now() + LOCAL_RECOVERY_CHECK_MS;
    if (!this.validEvidence(evidence, scope)) return false;
    const materials = saved ?? await this.crypto.deviceKeyMaterialsForUser(scope.userId, scope.alias, { requireReadable: true });
    this.assertCurrent(scope);
    // Alias-only legacy records are not authority to automate recovery. This
    // path never generates, publishes, imports, replaces or exports any key.
    const keys = materials.filter(key => key.userId === scope.userId);
    const stamp = JSON.stringify([evidence.message.id, keys.map(key => [key.id, key.publicJwk.x, key.publicJwk.y, key.updatedAt])]);
    if (stamp === this.localRecoveryStamp) return false;
    const revision = this.requestRevision;
    for (const recipient of evidence.message.recipients) {
      if (recipient.userId !== scope.userId || !this.evidenceSenderKey(recipient.header, recipient.ciphertext)) continue;
      for (const key of keys) {
        let readable = false;
        try {
          await this.crypto.decryptEnvelope(key, recipient.header, recipient.ciphertext);
          readable = true;
        } catch { /* A different retained identity may open this envelope. */ }
        this.assertCurrent(scope);
        if (revision !== this.requestRevision || !this.validEvidence(evidence, scope)) return false;
        if (!readable) continue;
        this.localRecoveryStamp = stamp;
        this.requested = true; this.requestedAt ||= Date.now();
        this.localRecoveryProved = true;
        this.localReplayAwaitingAck = true;
        this.state.set('syncing'); this.recovered$.next();
        return true;
      }
    }
    if (revision === this.requestRevision) this.localRecoveryStamp = stamp;
    return false;
  }

  private async refreshPendingRequests(scope: SessionScope): Promise<void> {
    try {
      const pending = await firstValueFrom(this.api.get<TransferRequest[]>('/devices/history-transfer/pending').pipe(timeout(this.transferTimeoutMs())));
      this.assertCurrent(scope);
      if (pending?.length) {
        try {
          await this.persistedIdentity(scope);
          this.assertCurrent(scope);
          this.sourceCapability.set('persisted-keys');
        } catch {
          this.assertCurrent(scope);
          this.sourceCapability.set('unavailable');
          this.pendingRequests.set([]);
          return;
        }
      }
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

  private refreshSourcePreference(scope: SessionScope): Promise<void> {
    if (!this.requested || !this.requestEvidence || !this.isCurrent(scope)) return Promise.resolve();
    if (this.sourceDirectory?.epoch === scope.epoch && this.sourceDirectory.expiresAt > Date.now()) {
      this.updatePreferredSource(scope);
      return Promise.resolve();
    }
    if (this.sourceDirectoryCheck?.epoch === scope.epoch) return this.sourceDirectoryCheck.promise;
    const revision = this.sourceDirectoryRevision;
    const promise = (async () => {
      const devices = await firstValueFrom(this.api.get<NivraDevice[]>('/devices').pipe(timeout(this.transferTimeoutMs())));
      this.assertCurrent(scope);
      if (revision !== this.sourceDirectoryRevision) return;
      this.sourceDirectory = { epoch: scope.epoch, expiresAt: Date.now() + SOURCE_DIRECTORY_CACHE_MS,
        devices: Array.isArray(devices) ? devices : [] };
      this.updatePreferredSource(scope);
    })().catch(() => {
      // Back off a missing/offline directory too; optional advice must not add
      // an HTTP request for every message or every short transfer status poll.
      if (this.isCurrent(scope) && revision === this.sourceDirectoryRevision) {
        this.sourceDirectory = { epoch: scope.epoch, expiresAt: Date.now() + SOURCE_DIRECTORY_CACHE_MS, devices: [] };
        this.preferredSource.set(null);
        this.sourceAvailability.set('unknown');
      }
    }).finally(() => {
      if (this.sourceDirectoryCheck?.promise === promise) this.sourceDirectoryCheck = null;
    });
    this.sourceDirectoryCheck = { epoch: scope.epoch, promise };
    return promise;
  }

  private invalidateSourcePreference(): void {
    this.sourceDirectory = null; this.sourceDirectoryRevision++;
    this.preferredSource.set(null);
    this.sourceAvailability.set('unknown');
  }

  private updatePreferredSource(scope: SessionScope): void {
    if (!this.isCurrent(scope) || !this.requested || !this.requestEvidence || this.sourceDirectory?.epoch !== scope.epoch) return;
    const addressed = new Set(this.requestEvidence.message.recipients.filter(recipient => recipient.userId === scope.userId).map(recipient => recipient.deviceId));
    const trusted = this.sourceDirectory.devices.filter(device => device.userId === scope.userId && device.isTrusted && !device.revokedAt);
    this.sourceAvailability.set(trusted.some(device => device.id !== scope.deviceId) ? 'available'
      : trusted.some(device => device.id === scope.deviceId) ? 'local-only' : 'unknown');
    const candidates = this.sourceDirectory.devices.filter(device => device.userId === scope.userId && device.id !== scope.deviceId
      && device.isTrusted && !device.revokedAt && typeof device.name === 'string' && device.name.trim());
    const android = (device: NivraDevice) => /^Android\s+Nivra Mobile$/i.test(device.name.trim());
    const recent = (device: NivraDevice) => Number.isFinite(Date.parse(device.lastSeenAt || ''))
      && Date.parse(device.lastSeenAt!) > Date.now() - 7 * 24 * 60 * 60_000;
    const rank = (device: NivraDevice) => addressed.has(device.id) ? (android(device) ? 0 : 1)
      : recent(device) ? (android(device) ? 2 : 3) : (android(device) ? 4 : 5);
    candidates.sort((left, right) => rank(left) - rank(right)
      || (Date.parse(right.lastSeenAt || '') || 0) - (Date.parse(left.lastSeenAt || '') || 0)
      || left.id.localeCompare(right.id));
    const selected = candidates[0];
    this.preferredSource.set(selected ? { deviceId: selected.id, deviceName: selected.name,
      kind: android(selected) ? 'android' : 'other', basis: addressed.has(selected.id) ? 'message-recipient' : 'active-device' } : null);
  }

  private async requestStatus(scope: SessionScope): Promise<TransferStatus> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.requestId || this.requestExpiresAt <= Date.now()) {
        const request = await firstValueFrom(this.api.post<TransferRequest>('/devices/history-transfer/', {}).pipe(timeout(this.transferTimeoutMs())));
        this.assertCurrent(scope);
        if (!request.id || request.userId !== scope.userId || request.targetDeviceId !== scope.deviceId
          || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('Solicitud de historial inválida.');
        this.requestId = request.id; this.requestExpiresAt = Date.parse(request.expiresAt);
      }
      try {
        return await firstValueFrom(this.api.get<TransferStatus>(`/devices/history-transfer/${encodeURIComponent(this.requestId)}`).pipe(timeout(this.transferTimeoutMs())));
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
    const own = await this.persistedIdentity(scope);
    this.assertCurrent(scope);
    const materials = await this.crypto.exportDeviceKeyMaterialsForUser(scope.userId, scope.alias);
    this.assertCurrent(scope);
    if (materials.length > 256) throw new Error('El historial requiere vinculación mediante QR.');
    const keys = materials.map(key => ({ publicJwk: key.publicJwk, privateJwk: key.privateJwk, createdAt: key.createdAt }));
    if (!keys.length) throw new Error('Este dispositivo no conserva llaves de historial vinculadas a tu cuenta.');
    const payload: KeyringPayload = { v: 1, purpose: 'history-keyring', requestId: request.id, userId: scope.userId, targetDeviceId: request.targetDeviceId, sourceDeviceId: scope.deviceId, targetPublicJwk: target, expiresAt: request.expiresAt, keys };
    try { payload.identityTrust = await this.identityTrust.exportForLinkedDevice(scope.userId, scope.deviceId); }
    catch { /* Optional contact continuity must not prevent approved history transfer. */ }
    this.assertCurrent(scope);
    const sealed = await this.crypto.encryptForPublicKey(own, target, payload);
    this.assertCurrent(scope);
    await firstValueFrom(this.api.post(`/devices/history-transfer/${encodeURIComponent(request.id)}/response`, sealed).pipe(timeout(this.transferTimeoutMs())));
    this.assertCurrent(scope);
  }

  private async importResponse(request: TransferStatus, response: TransferResponse, scope: SessionScope, notify = true): Promise<void> {
    const responseId = `${request.id}:${response.sourceDeviceId}`;
    this.assertCurrent(scope);
    if (this.importedResponses.has(responseId)) return;
    if (request.id !== this.requestId || request.userId !== scope.userId || request.targetDeviceId !== scope.deviceId || response.sourceDeviceId === scope.deviceId || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('El paquete de historial no corresponde a esta sesión.');
    const own = await this.persistedIdentity(scope);
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
    if (payload.identityTrust) {
      try { await this.identityTrust.importFromLinkedDevice(`${scope.userId}:${scope.deviceId}`, response.sourceDeviceId, payload.identityTrust, () => this.isCurrent(scope)); }
      catch { /* Keep valid history keys even if optional continuity is unsupported. */ }
      this.assertCurrent(scope);
    }
    this.state.set('syncing');
    this.recoveryIncomplete = false;
    this.recoveryRetryAt = this.recoveryRetryAttempts = 0;
    this.importedResponses.add(responseId);
    if (notify) this.recovered$.next();
  }
}
