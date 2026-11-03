import { Injectable, OnDestroy, inject } from '@angular/core';
import { firstValueFrom, Subject, timeout } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ChatMessageVm, ChatPayload, MessageHistoryRecoveryResponse, MessageResponse } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NivraApiService } from './nivra-api.service';
import { RatchetMessagingService } from './ratchet-messaging.service';
import { ratchetArchiveContext } from './ratchet-runtime';

export interface ArchiveTransfer { id: string; userId: string; targetDeviceId: string; targetIdentityKey: string; expiresAt: string; }
interface Cursor { chat: number; before?: string; beforeId?: string; }
interface ArchivePage { sequence: number; header: string; ciphertext: string; final: boolean; }
interface ArchiveStatus { nextSequence: number; acknowledgedSequence: number; finished: boolean; pages: ArchivePage[]; leaseExpiresAt?: string; }
interface Progress {
  v: 1; transfer: ArchiveTransfer; sourceDeviceId: string; sourceIdentityKey: string; direction: 'send' | 'receive'; sequence: number;
  conversations: string[]; cursor: Cursor; batch?: { id: string; text: string; parts: number; part: number; after: Cursor; final: boolean };
  pending?: ArchivePage; incoming?: { id: string; text: string; nextPart: number; parts: number }; complete?: boolean;
  ackPending?: number;
  leaseExpiresAt?: string; accounts?: string[];
}
const CHUNK_CHARS = 24000;

/** Approved, paged history transfer. Only history is copied; each device keeps its own ratchet keys. */
@Injectable({ providedIn: 'root' })
export class HistoryArchiveService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly lock = inject(AppLockService);
  private readonly crypto = inject(CryptoService);
  private readonly history = inject(LocalHistoryService);
  private readonly api = inject(NivraApiService);
  private readonly ratchet = inject(RatchetMessagingService);
  readonly imported$ = new Subject<void>();
  private running = false;
  private readonly receiving = new Map<string, number>();
  private readonly timer = window.setInterval(() => { void this.pump().catch(() => undefined); }, 2500);
  ngOnDestroy(): void { window.clearInterval(this.timer); this.imported$.complete(); }
  private owner() {
    const session = this.auth.session();
    if (!session || this.lock.isContentLocked()) throw Error('Desbloquea Nivra para transferir el historial.');
    const userId = session.user.id, deviceId = session.device.id;
    const generation = this.auth.sessionGeneration?.();
    return { userId, deviceId, assert: () => { const now = this.auth.session(); if (generation !== this.auth.sessionGeneration?.() || this.lock.isContentLocked() || now?.user.id !== userId || now.device.id !== deviceId) throw Error('La cuenta o el dispositivo cambió.'); } };
  }
  private conversation(deviceId: string): string { return `history-archive-progress:${deviceId}`; }
  private id(progress: Progress): string { return `${progress.transfer.id}:${progress.sourceDeviceId}:${progress.direction}`; }
  private path(progress: Progress): string { return `/devices/history-transfer/${encodeURIComponent(progress.transfer.id)}/archive/${encodeURIComponent(progress.sourceDeviceId)}/`; }
  private messageId(progress: Progress, sequence: number): string { return `archive_${progress.transfer.id}_${progress.sourceDeviceId}_${sequence}`; }
  private async save(progress: Progress): Promise<void> {
    const owner = this.owner();
    await this.history.putMessages(owner.userId, [{ id: this.id(progress), conversationId: this.conversation(owner.deviceId), mine: true, senderUserId: owner.userId,
      at: new Date().toISOString(), expiresAt: progress.leaseExpiresAt ?? progress.transfer.expiresAt, payload: { type: 'history-archive-progress', progress } }]); owner.assert();
    if (!await this.history.messageById(owner.userId, this.conversation(owner.deviceId), this.id(progress))) throw Error('No se pudo guardar el avance del historial.');
  }
  async beginSend(transfer: ArchiveTransfer): Promise<boolean> {
    if (!environment.ratchetEnabled) return false;
    const owner = this.owner();
    const configuration = await firstValueFrom(this.api.get<{ enabled: boolean }>('/ratchet/olm/config').pipe(timeout(15000))).catch(() => null); owner.assert();
    if (!configuration?.enabled) return false;
    if (transfer.userId !== owner.userId || transfer.targetDeviceId === owner.deviceId || Date.parse(transfer.expiresAt) <= Date.now()) throw Error('Solicitud de historial inválida.');
    const existing = await this.history.messageById(owner.userId, this.conversation(owner.deviceId), `${transfer.id}:${owner.deviceId}:send`);
    if (existing) return true;
    const own = await this.auth.ensureDeviceIdentity(); owner.assert();
    const accounts = [...new Set([owner.userId, ...await this.history.accountKeysForUser(owner.userId)])].filter(key => key === owner.userId || key.startsWith(`${owner.userId}:`)); owner.assert();
    const conversations = [...new Set((await Promise.all(accounts.map(account => this.history.conversations(account)))).flat().map(chat => chat.id))].filter(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id)).sort(); owner.assert();
    await this.save({ v: 1, transfer, sourceDeviceId: owner.deviceId, sourceIdentityKey: JSON.stringify(own.publicJwk), direction: 'send', sequence: 0, conversations, accounts, cursor: { chat: 0 } });
    return true;
  }
  async beginReceive(transfer: ArchiveTransfer, sourceDeviceId: string, sourceIdentityKey: string): Promise<void> {
    const owner = this.owner();
    if (transfer.userId !== owner.userId || transfer.targetDeviceId !== owner.deviceId || sourceDeviceId === owner.deviceId) throw Error('Destino del historial inválido.');
    const id = `${transfer.id}:${sourceDeviceId}:receive`;
    if (!await this.history.messageById(owner.userId, this.conversation(owner.deviceId), id)) await this.save({ v: 1, transfer, sourceDeviceId, sourceIdentityKey, direction: 'receive', sequence: 0, conversations: [], cursor: { chat: 0 } });
  }
  hasActiveIncoming(requestId: string): boolean {
    const owner = this.owner();
    return (this.receiving.get(JSON.stringify([owner.userId, owner.deviceId, requestId])) ?? 0) > Date.now();
  }
  async pump(): Promise<void> {
    if (this.running || !this.auth.session() || this.lock.isContentLocked() || document.visibilityState === 'hidden') return;
    this.running = true;
    try {
      const owner = this.owner();
      if (!navigator.locks) throw Error('Este cliente necesita bloqueo de almacenamiento para transferir historial.');
      await navigator.locks.request(`nivra-history-archive:${owner.userId}:${owner.deviceId}`, async () => {
      const records = await this.history.conversationMessagesPage(owner.userId, this.conversation(owner.deviceId), { limit: 100 }); owner.assert();
      for (const record of records) {
        const progress = record.payload['progress'] as Progress;
        if (progress?.v !== 1 || progress.transfer.userId !== owner.userId || (progress.complete && progress.ackPending === undefined) || Date.parse(progress.leaseExpiresAt ?? progress.transfer.expiresAt) <= Date.now()) continue;
        if (progress.direction === 'receive') this.receiving.set(JSON.stringify([owner.userId, owner.deviceId, progress.transfer.id]), Date.parse(progress.leaseExpiresAt ?? progress.transfer.expiresAt));
        try { if (progress.direction === 'send') await this.send(progress); else await this.receive(progress); } catch { owner.assert(); }
      }
      });
    } finally { this.running = false; }
  }
  private async nextBatch(progress: Progress): Promise<void> {
    const owner = this.owner(); let cursor = { ...progress.cursor };
    while (cursor.chat < progress.conversations.length) {
      const conversationId = progress.conversations[cursor.chat];
      const groups = await Promise.all((progress.accounts ?? [owner.userId]).map(async account => {
        const page = { before: cursor.before, beforeId: cursor.beforeId, limit: 8 };
        const [primary, deliveries] = await Promise.all([this.history.conversationMessagesPage(account, conversationId, page), this.history.conversationMessagesPage(account, `ratchet-receipt:${conversationId}`, page)]);
        const recovered = deliveries.filter(message => ['ratchet-delivery', 'ratchet-archive-delivery'].includes(message.payload?.type) && message.payload['content'] && typeof message.payload['content'] === 'object')
          .map(message => ({ ...message, conversationId, payload: message.payload['content'] as ChatPayload }));
        return [...recovered, ...primary];
      })); owner.assert();
      const byId = new Map<string, ChatMessageVm>();
      for (const group of groups.reverse()) for (const message of group) if (!message.decryptError || !byId.get(message.id)?.payload) byId.set(message.id, message);
      const order = (a: ChatMessageVm, b: ChatMessageVm) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
      const records = [...byId.values()].sort(order).slice(-8);
      if (!records.length) { cursor = { chat: cursor.chat + 1 }; continue; }
      const first = records[0], after = { chat: cursor.chat, before: first.at, beforeId: first.id };
      const messages = records.filter(message => !message.decryptError && !message.deleteAfterRead && (!message.expiresAt || Date.parse(message.expiresAt) > Date.now()) &&
        message.payload && message.payload.type !== 'view-once-opened' && /^[a-zA-Z0-9_-]{1,64}$/.test(message.id));
      const text = JSON.stringify(messages);
      if (text.length > 16 * 1024 * 1024) throw Error('El bloque de historial excede el límite local.');
      progress.batch = { id: crypto.randomUUID(), text, parts: Math.max(1, Math.ceil(text.length / CHUNK_CHARS)), part: 0, after, final: false };
      await this.save(progress); return;
    }
    progress.batch = { id: crypto.randomUUID(), text: '[]', parts: 1, part: 0, after: cursor, final: true }; await this.save(progress);
  }
  private async send(progress: Progress): Promise<void> {
    const owner = this.owner();
    if (progress.sourceDeviceId !== owner.deviceId) throw Error('Origen del historial inválido.');
    const status = await firstValueFrom(this.api.get<ArchiveStatus>(this.path(progress)).pipe(timeout(15000))); owner.assert();
    if (status.leaseExpiresAt && Date.parse(status.leaseExpiresAt) > Date.now()) { progress.leaseExpiresAt = status.leaseExpiresAt; await this.save(progress); }
    if (status.finished && status.acknowledgedSequence === status.nextSequence - 1) { progress.complete = true; progress.batch = undefined; progress.pending = undefined; await this.save(progress); return; }
    if (status.nextSequence - status.acknowledgedSequence > 8) return;
    for (let turn = 0; turn < 8; turn++) {
      if (!progress.batch) await this.nextBatch(progress);
      const batch = progress.batch!;
      if (batch.part >= batch.parts) { progress.cursor = batch.after; progress.batch = undefined; await this.save(progress); continue; }
      const final = batch.final && batch.part === batch.parts - 1;
      const payload: ChatPayload = { type: 'history-archive-chunk', purpose: 'nivra-history-archive-v1', requestId: progress.transfer.id,
        sourceDeviceId: owner.deviceId, targetDeviceId: progress.transfer.targetDeviceId, sequence: progress.sequence, final,
        batchId: batch.id, part: batch.part, parts: batch.parts, chunk: batch.text.slice(batch.part * CHUNK_CHARS, (batch.part + 1) * CHUNK_CHARS) };
      if (!progress.pending) {
        const targetKey = this.crypto.parsePublicJwk(progress.transfer.targetIdentityKey); if (!targetKey) throw Error('Identidad del destino inválida.');
        const packets = await this.ratchet.encrypt(`history_${progress.transfer.id}`, this.messageId(progress, progress.sequence), payload,
          [{ userId: owner.userId, deviceId: progress.transfer.targetDeviceId, publicJwk: targetKey }], null); owner.assert();
        if (!packets?.[0]?.header) throw Error('El destino necesita activar el cifrado avanzado para importar el historial.');
        progress.pending = { sequence: progress.sequence, header: packets[0].header, ciphertext: packets[0].ciphertext, final }; await this.save(progress);
      }
      const pending = progress.pending;
      await firstValueFrom(this.api.post(this.path(progress), pending).pipe(timeout(15000))); owner.assert();
      // Acknowledge the ratchet outbox only after the server stored this exact page.
      await this.ratchet.confirmSent(this.envelope(progress, pending), payload); owner.assert();
      progress.sequence++; batch.part++; progress.pending = undefined; await this.save(progress);
      if (final) return;
    }
  }
  private envelope(progress: Progress, page: ArchivePage): MessageResponse {
    return { id: this.messageId(progress, page.sequence), clientMessageId: this.messageId(progress, page.sequence), conversationId: `history_${progress.transfer.id}`,
      senderUserId: progress.transfer.userId, senderDeviceId: progress.sourceDeviceId, kind: 'Text', serverReceivedAt: new Date().toISOString(),
      expiresAt: progress.leaseExpiresAt ?? progress.transfer.expiresAt, deleteAfterRead: false, receipts: [], recipients: [{ userId: progress.transfer.userId, deviceId: progress.transfer.targetDeviceId, ciphertext: page.ciphertext, header: page.header }] };
  }
  private async receive(progress: Progress): Promise<void> {
    const owner = this.owner();
    if (progress.transfer.targetDeviceId !== owner.deviceId) throw Error('Destino del historial inválido.');
    if (progress.ackPending !== undefined) { await this.ack(progress, progress.ackPending); progress.ackPending = undefined; await this.save(progress); if (progress.complete) return; }
    const status = await firstValueFrom(this.api.get<ArchiveStatus>(this.path(progress)).pipe(timeout(15000))); owner.assert();
    if (status.leaseExpiresAt && Date.parse(status.leaseExpiresAt) > Date.now()) { progress.leaseExpiresAt = status.leaseExpiresAt; await this.save(progress); }
    if (!Array.isArray(status.pages) || status.pages.length > 8) throw Error('Bloque de historial inválido.');
    for (const page of status.pages) {
      if (page.sequence < progress.sequence) { await this.ack(progress, page.sequence); continue; }
      if (page.sequence !== progress.sequence) throw Error('Falta un bloque del historial.');
      const header = JSON.parse(page.header), binding = JSON.parse(header.binding?.header || '{}');
      if (!this.crypto.samePublicKey(binding.senderPublicKey, this.crypto.parsePublicJwk(progress.sourceIdentityKey))) throw Error('La identidad del origen cambió durante la transferencia.');
      const message = this.envelope(progress, page), payload = await this.ratchet.decrypt(message, message.recipients[0]); owner.assert();
      if (payload.type !== 'history-archive-chunk' || payload['purpose'] !== 'nivra-history-archive-v1' || payload['requestId'] !== progress.transfer.id || payload['sourceDeviceId'] !== progress.sourceDeviceId ||
        payload['targetDeviceId'] !== owner.deviceId || payload['sequence'] !== page.sequence || payload['final'] !== page.final || typeof payload['batchId'] !== 'string' || typeof payload['chunk'] !== 'string' || payload['chunk'].length > CHUNK_CHARS ||
        !Number.isInteger(payload['part']) || !Number.isInteger(payload['parts']) || Number(payload['parts']) < 1 || Number(payload['parts']) > 700) throw Error('El bloque no corresponde a esta transferencia.');
      const part = Number(payload['part']), parts = Number(payload['parts']);
      if (!progress.incoming) { if (part !== 0) throw Error('Falta el inicio del historial.'); progress.incoming = { id: payload['batchId'], text: '', nextPart: 0, parts }; }
      const incoming = progress.incoming;
      if (incoming.id !== payload['batchId'] || incoming.nextPart !== part || incoming.parts !== parts || incoming.text.length + payload['chunk'].length > 16 * 1024 * 1024) throw Error('Orden del historial inválido.');
      incoming.text += payload['chunk']; incoming.nextPart++;
      if (incoming.nextPart === incoming.parts) { await this.importMessages(JSON.parse(incoming.text)); owner.assert(); progress.incoming = undefined; }
      else if (page.final) throw Error('El último bloque está incompleto.');
      progress.sequence++; progress.complete = page.final; progress.ackPending = page.sequence; await this.save(progress); owner.assert();
      await this.ack(progress, page.sequence);
      progress.ackPending = undefined; await this.save(progress);
      if (page.final) { this.receiving.delete(JSON.stringify([owner.userId, owner.deviceId, progress.transfer.id])); this.imported$.next(); }
    }
  }
  private async ack(progress: Progress, sequence: number): Promise<void> {
    const response = await firstValueFrom(this.api.post<{ leaseExpiresAt?: string }>(this.path(progress) + 'ack', { sequence }).pipe(timeout(15000)));
    if (response?.leaseExpiresAt && Date.parse(response.leaseExpiresAt) > Date.now()) progress.leaseExpiresAt = response.leaseExpiresAt;
  }
  private async importMessages(values: unknown): Promise<void> {
    const owner = this.owner();
    if (!Array.isArray(values) || values.length > 8) throw Error('Historial recibido inválido.');
    const candidates = values as ChatMessageVm[];
    if (candidates.some(message => !message || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.id) || typeof message.conversationId !== 'string' || !message.payload || typeof message.payload !== 'object')) throw Error('Mensaje del historial inválido.');
    if (!candidates.length) return;
    const guards = new Map(candidates.map(message => [message.id, this.history.messageWriteGuard(owner.userId, message.conversationId, message.id)]));
    const authoritative = await firstValueFrom(this.api.post<MessageHistoryRecoveryResponse>('/messages/history-recovery', { messageIds: candidates.map(message => message.id) }).pipe(timeout(15000))); owner.assert();
    const allowed = new Map(authoritative.messages.map(message => [message.id, message]));
    for (const candidate of candidates) {
      const server = allowed.get(candidate.id);
      if (!server || server.conversationId !== candidate.conversationId || server.senderUserId !== candidate.senderUserId || server.senderDeviceId !== candidate.senderDeviceId || Date.parse(server.serverReceivedAt) !== Date.parse(candidate.at) || server.deleteAfterRead || server.expiresAt && Date.parse(server.expiresAt) <= Date.now()) continue;
      const message: ChatMessageVm = { ...candidate, at: server.serverReceivedAt, mine: server.senderUserId === owner.userId, clientMessageId: server.clientMessageId, receipts: server.receipts, expiresAt: server.expiresAt, deleteAfterRead: server.deleteAfterRead, decryptError: false };
      const guard = guards.get(message.id)!;
      if (!guard()) continue;
      const delivery: ChatMessageVm = { ...message, conversationId: `ratchet-receipt:${message.conversationId}`, payload: { type: 'ratchet-archive-delivery', archiveContext: ratchetArchiveContext(server), content: message.payload } };
      const records = ['reaction', 'edit', 'delete'].includes(message.payload.type) ? [delivery] : [delivery, message];
      await this.history.mergeArchiveMessages(owner.userId, records, () => { owner.assert(); return guard(); }); owner.assert();
      for (const record of records) {
        if (!await this.history.messageById(owner.userId, record.conversationId, record.id)) throw Error('No se pudo guardar el historial recibido.');
      }
    }
    this.imported$.next();
  }
}
