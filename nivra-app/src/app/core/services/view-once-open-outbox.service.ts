import { DestroyRef, Injectable, NgZone, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, firstValueFrom, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { LocalHistoryService } from './local-history.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { ChatMessageVm, MessageResponse } from '../models/nivra.models';

export interface ViewOnceOpenRecord { messageId: string; conversationId: string; openedAt: string; completed: boolean; }
interface OpenState { v: 1; userId: string; deviceId: string; records: Record<string, ViewOnceOpenRecord>; }
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const ownRecord=(records:OpenState['records'],id:string)=>Object.prototype.hasOwnProperty.call(records,id)?records[id]:undefined;

/** Consumption is durable before plaintext is shown. Network receipts can follow later. */
@Injectable({ providedIn: 'root' })
export class ViewOnceOpenOutboxService {
  private readonly auth = inject(AuthService);
  private readonly lock = inject(AppLockService);
  private readonly history = inject(LocalHistoryService);
  private readonly api = inject(NivraApiService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private serial: Promise<unknown> = Promise.resolve();
  private running = false;
  private destroyed = false;
  private retryAt = 0;
  private pendingKnown:boolean|null = null;
  private pendingVersion=0;
  readonly acknowledged$ = new Subject<{ userId: string; deviceId: string; generation: number | undefined; message: MessageResponse }>();

  constructor() {
    effect(() => { const session = this.auth.session(), locked = this.lock.isContentLocked(); this.auth.sessionGeneration?.();
      if (session && !locked) untracked(() => { this.retryAt = 0; this.pendingKnown=null; void this.flush(); });
    });
    this.realtime.events$?.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (['connected', 'reconnected'].includes(event.type)) { this.retryAt = 0; this.pendingKnown=null; void this.flush(); }
    });
    const wake = () => { if (document.visibilityState !== 'hidden') { this.retryAt = 0; this.pendingKnown=null; void this.flush(); } };
    window.addEventListener('online', wake); window.addEventListener('focus',wake); document.addEventListener('visibilitychange', wake);
    const timer = inject(NgZone).runOutsideAngular(() => window.setInterval(() => void this.flush(), 5000));
    this.destroyRef.onDestroy(() => { this.destroyed = true; clearInterval(timer); window.removeEventListener('online', wake); window.removeEventListener('focus',wake); document.removeEventListener('visibilitychange', wake); this.acknowledged$.complete(); });
  }
  private owner() {
    const session = this.auth.session();
    if (this.destroyed || !session || this.lock.isContentLocked()) throw Error('Desbloquea esta cuenta para abrir el mensaje.');
    const userId = session.user.id, deviceId = session.device.id, generation = this.auth.sessionGeneration?.();
    const assert = () => { const now = this.auth.session(); if (this.destroyed || this.lock.isContentLocked() || now?.user.id !== userId || now.device.id !== deviceId || this.auth.sessionGeneration?.() !== generation) throw Error('La cuenta cambió durante la apertura.'); };
    return { userId, deviceId, generation, key: 'view-once-open-v1:' + deviceId, assert };
  }
  private async read(owner: ReturnType<ViewOnceOpenOutboxService['owner']>) {
    owner.assert();
    const saved = await this.history.readRatchetState(owner.userId, owner.key); owner.assert();
    const state: OpenState = saved ? saved.state as OpenState : { v: 1, userId: owner.userId, deviceId: owner.deviceId, records: {} };
    if (state?.v !== 1 || state.userId !== owner.userId || state.deviceId !== owner.deviceId || !state.records || typeof state.records !== 'object' || Array.isArray(state.records) || Object.keys(state.records).length > 20000 || Object.entries(state.records).some(([id, row]) =>
      !validId(id) || row?.messageId !== id || !validId(row.conversationId) || typeof row.openedAt!=='string'||!Number.isFinite(Date.parse(row.openedAt)) || new Date(row.openedAt).toISOString()!==row.openedAt||typeof row.completed !== 'boolean')) throw Error('No se pudo verificar el registro de mensajes abiertos.');
    return { state, revision: saved?.revision ?? 0 };
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> { const task = this.serial.then(operation); this.serial = task.catch(() => undefined); return task; }
  async consumed(messageId: string, conversationId: string): Promise<ViewOnceOpenRecord | null> {
    const owner = this.owner(), saved = await this.read(owner); owner.assert();
    const record = ownRecord(saved.state.records,messageId);
    return record?.conversationId === conversationId ? record : null;
  }
  async claim(message: ChatMessageVm): Promise<{ first: boolean; record: ViewOnceOpenRecord }> {
    const owner = this.owner();
    if (message.mine || !message.deleteAfterRead || message.decryptError || !validId(message.id) || !validId(message.conversationId) || message.expiresAt && (!Number.isFinite(Date.parse(message.expiresAt))||Date.parse(message.expiresAt) <= Date.now())) throw Error('Este mensaje ya no puede abrirse.');
    return this.mutate(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        owner.assert(); const saved = await this.read(owner), previous = ownRecord(saved.state.records,message.id);
        if (previous) { if (previous.conversationId !== message.conversationId) throw Error('El mensaje no corresponde a este chat.'); this.pendingKnown=Object.values(saved.state.records).some(row=>!row.completed); return { first: false, record: previous }; }
        if (Object.keys(saved.state.records).length >= 20000) throw Error('No hay espacio para confirmar otra apertura segura.');
        const record = { messageId: message.id, conversationId: message.conversationId, openedAt: new Date().toISOString(), completed: false };
        const next = { ...saved.state, records: { ...saved.state.records, [message.id]: record } };
        try { await this.history.commitRatchetState(owner.userId, owner.key, saved.revision, next); owner.assert(); this.pendingVersion=(this.pendingVersion??0)+1;this.pendingKnown=true; return { first: true, record }; }
        catch (error) { owner.assert(); if (!(error as { retryable?: boolean }).retryable || attempt === 2) throw error; }
      }
      throw Error('No se pudo guardar la apertura.');
    });
  }
  async flush(): Promise<void> {
    if (this.destroyed || this.running || this.pendingKnown===false || !this.auth.session() || this.lock.isContentLocked() || navigator.onLine === false || document.visibilityState === 'hidden' || Date.now() < this.retryAt) return;
    this.running = true;
    try {
      const owner = this.owner(), saved = await this.read(owner);
      for (const record of Object.values(saved.state.records).filter(row => !row.completed).slice(0, 16)) {
        owner.assert();
        let message: MessageResponse | undefined;
        try { message = await firstValueFrom(this.api.post<MessageResponse>(`/messages/${encodeURIComponent(record.messageId)}/receipt`, { kind: 'Read', opened: true }).pipe(timeout(15000))); owner.assert(); }
        catch (error) { owner.assert(); if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
        await this.mutate(async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.read(owner), row = ownRecord(current.state.records,record.messageId); owner.assert();
            if (!row || row.openedAt !== record.openedAt || row.completed) return;
            const next = { ...current.state, records: { ...current.state.records, [record.messageId]: { ...row, completed: true } } };
            try { await this.history.commitRatchetState(owner.userId, owner.key, current.revision, next); owner.assert(); return; }
            catch (error) { owner.assert(); if (!(error as { retryable?: boolean }).retryable || attempt === 2) throw error; }
          }
        });
        owner.assert();
        if (message?.id === record.messageId) this.acknowledged$.next({ userId: owner.userId, deviceId: owner.deviceId, generation: owner.generation, message });
        // HTTP persistence is authoritative; SignalR is only an optional quick hint.
        void this.realtime.syncReadReceipts(record.conversationId, [record.messageId], { openedMessageIds: [record.messageId] }).catch(() => undefined);
      }
      const version=this.pendingVersion;const current=await this.read(owner);
      this.pendingKnown=version!==this.pendingVersion||Object.values(current.state.records).some(row=>!row.completed);
    } catch { this.retryAt = Date.now() + 15000; }
    finally { this.running = false; }
  }
}
