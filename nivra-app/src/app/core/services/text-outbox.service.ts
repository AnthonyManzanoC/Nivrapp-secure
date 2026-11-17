import { DestroyRef, Injectable, NgZone, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from './auth.service';
import { LocalHistoryService } from './local-history.service';
import { AppLockService } from './app-lock.service';
import { NetworkPolicyService } from './network-policy.service';
import type { ChatMessageVm, Conversation } from '../models/nivra.models';
import type { MessagePolicyOptions } from './chat.service';
import { MAX_MESSAGE_SCHEDULE_DELAY_MS, scheduledMessageTime } from '../utils/message-schedule';

export interface QueuedText extends ChatMessageVm {
  abandoning?:boolean;
  scheduledFor?: string;
  scheduledTtlSeconds?: number | null;
  scheduleStartedAt?: string;
  attempts: number;
  retryAt: number;
  blocked: boolean;
  queueOrder: number;
  lastStatus?: number;
  failureSchema?: number;
  lastFailure?: 'recipient-keys' | 'encryption' | 'protocol' | 'queue-full' | 'identity' | 'network' | 'server' | 'rate-limit' | 'authorization' | 'unknown';
}
@Injectable({ providedIn: 'root' })
export class TextOutboxService {
  private readonly auth = inject(AuthService);
  private readonly history = inject(LocalHistoryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly appLock = inject(AppLockService);
  private readonly network = inject(NetworkPolicyService);
  private readonly zone = inject(NgZone);
  readonly entries = signal<QueuedText[]>([]);
  readonly storageError = signal('');
  private scope = '';
  private sessionGeneration: number | undefined;
  private epoch = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private restoring: Promise<void> = Promise.resolve();
  private sender?: (entry: QueuedText) => Promise<unknown>;
  private allowed: (entry: QueuedText) => boolean = () => false;
  private prepareEntry?: (entry: QueuedText) => void;
  private abandonEntry?: (entry: QueuedText) => Promise<void>;
  private readonly running = new Map<string, string>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly paused = new Map<string, number>();

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const generation = this.auth.sessionGeneration?.();
      const scope = session ? `${session.user.id}:text-outbox:v1:${session.device.id}` : '';
      untracked(() => {
        if (scope === this.scope && generation === this.sessionGeneration) return;
        this.sessionGeneration = generation;
        this.scope = scope; const epoch = ++this.epoch;
        this.entries.set([]); this.storageError.set('');
        this.restoring = scope ? this.restore(scope, epoch) : Promise.resolve();
      });
    });
    const wake = () => this.wake();
    const resume = () => this.resumeNetwork();
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    connection?.addEventListener?.('change', resume);
    const timer = this.zone.runOutsideAngular(() => window.setInterval(() => {
      if (this.entries().length) this.zone.run(wake);
    }, 2000));
    this.destroyRef.onDestroy(() => {
      this.sender = undefined;
      ++this.epoch; window.clearInterval(timer);
      window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume);
      connection?.removeEventListener?.('change', resume);
    });
  }
  configure(sender: (entry: QueuedText) => Promise<unknown>, allowed: (entry: QueuedText) => boolean, prepareEntry?: (entry: QueuedText) => void, abandonEntry?: (entry:QueuedText)=>Promise<void>): void {
    this.sender = sender; this.allowed = allowed; this.prepareEntry = prepareEntry; this.abandonEntry=abandonEntry; this.wake();
  }
  async enqueue(conversation: Conversation, text: string, policy: MessagePolicyOptions = {}, scheduleAt?: number): Promise<QueuedText> {
    const session = this.auth.session();
    if (!session || !text.trim() || text.length > 64000) throw new Error('No se pudo preparar el mensaje.');
    const generation = this.auth.sessionGeneration?.();
    const scheduledFor = scheduleAt === undefined ? undefined : scheduledMessageTime(scheduleAt);
    if (scheduledFor && policy.ttlSeconds != null && (!Number.isSafeInteger(policy.ttlSeconds) || policy.ttlSeconds < 0 || policy.ttlSeconds > 30 * 86400)) throw Error('La duración del mensaje no es válida.');
    // Capture ownership before waiting for IndexedDB/SQLCipher or another local write.
    const scope = `${session.user.id}:text-outbox:v1:${session.device.id}`;
    const clientMessageId = `web-${crypto.randomUUID()}`;
    const entry: QueuedText = {
      id: `local-${clientMessageId}`, clientMessageId, conversationId: conversation.id,
      senderUserId: session.user.id, senderDeviceId: session.device.id, mine: true,
      at: new Date().toISOString(), status: 'sending', attempts: 0, retryAt: 0, blocked: false, queueOrder: 0,
      expiresAt: !scheduledFor && policy.ttlSeconds ? new Date(Date.now() + policy.ttlSeconds * 1000).toISOString() : null,
      ...(scheduledFor ? { scheduledFor, scheduledTtlSeconds: policy.ttlSeconds || null } : {}),
      deleteAfterRead: Boolean(policy.deleteAfterRead),
      payload: { type: 'text', text: text.trim(), ...(policy.replyTo ? { replyTo: structuredClone(policy.replyTo) } : {}) },
    };
    return this.mutate(async () => {
      await this.restoring;
      if (scope !== this.scope || generation !== this.auth.sessionGeneration?.()) throw new Error('La cuenta cambió antes de guardar el mensaje.');
      if (this.paused.has(`${scope}:${conversation.id}`)) throw new Error('Espera a que termine la acción del chat.');
      if (this.storageError()) throw new Error(this.storageError());
      if (this.entries().length >= 200) throw new Error('La cola tiene 200 mensajes pendientes. Espera o elimina uno antes de continuar.');
      if (!this.allowed(entry)) throw new Error('Desbloquea el chat y comprueba los permisos antes de enviar.');
      this.prepareEntry?.(entry);
      entry.queueOrder = Math.max(Date.now() * 1000, ...this.entries().map(row => row.queueOrder + 1));
      // Bind routing and privacy metadata inside the already encrypted payload,
      // so moving a database row cannot silently redirect a queued message.
      entry.payload['__nivraOutbox'] = this.binding(entry);
      const epoch = this.epoch;
      await this.persist(scope, entry);
      if (epoch !== this.epoch) throw new Error('La cuenta cambió. El mensaje quedó guardado en su cuenta original.');
      this.entries.update(rows => [...rows, entry]); this.wake(); return entry;
    });
  }
  forConversation(id: string): QueuedText[] { return this.entries().filter(entry => entry.conversationId === id); }
  /** Freeze the relative TTL only after encryption is ready, immediately before its first HTTP send. */
  startScheduledDelivery(id: string): Promise<string | null> {
    const scope = this.scope, epoch = this.epoch, generation = this.auth.sessionGeneration?.();
    return this.mutate(async () => {
      const entry = this.entries().find(row => row.id === id);
      if (!entry?.scheduledFor || scope !== this.scope || epoch !== this.epoch || generation !== this.sessionGeneration || this.appLock.isContentLocked()
        || Date.parse(entry.scheduledFor) > Date.now() || !this.allowed(entry)
        || this.running.get(`${scope}:${entry.conversationId}`) !== id) throw Error('El envío programado ya no está disponible.');
      if (entry.scheduleStartedAt) return entry.expiresAt ?? null;
      const startedAt = Date.now();
      const next = { ...entry, payload: { ...entry.payload }, scheduleStartedAt: new Date(startedAt).toISOString(),
        expiresAt: entry.scheduledTtlSeconds ? new Date(startedAt + entry.scheduledTtlSeconds * 1000).toISOString() : null };
      next.payload['__nivraOutbox'] = this.binding(next);
      await this.persist(scope, next);
      if (scope !== this.scope || epoch !== this.epoch || generation !== this.auth.sessionGeneration?.() || this.appLock.isContentLocked() || !this.allowed(next)) throw Error('La sesión cambió antes del envío programado.');
      this.entries.update(rows => rows.map(row => row.id === id ? next : row));
      return next.expiresAt;
    });
  }
  async pauseConversation(id: string): Promise<() => void> {
    const scope = this.scope, epoch = this.epoch, key = `${scope}:${id}`;
    this.paused.set(key, (this.paused.get(key) ?? 0) + 1);
    let released = false;
    const resume = () => {
      if (released) return; released = true;
      const count = (this.paused.get(key) ?? 1) - 1;
      if (count) this.paused.set(key, count); else this.paused.delete(key);
      this.wake();
    };
    try {
      await this.tasks.get(key);
      await this.mutate(async () => {
        await this.history.removeConversationMessages(scope, id);
        const retained = await this.history.outboxMessages(scope);
        if (retained.some(row => row.conversationId === id)) throw new Error('No se pudo vaciar la cola del chat.');
        if (epoch === this.epoch) this.entries.update(rows => rows.filter(row => row.conversationId !== id));
      });
      return resume;
    } catch (error) {
      if (epoch === this.epoch) {
        this.storageError.set('No se pudo cancelar la cola del chat. Los mensajes se conservaron para revisión.');
        this.entries.update(rows => rows.map(row => row.conversationId === id ? { ...row, blocked: true } : row));
      }
      resume(); throw error;
    }
  }
  async retry(id: string): Promise<void> {
    await this.mutate(async () => {
      const entry = this.entries().find(row => row.id === id); if (!entry) return;
      const epoch = this.epoch;
      const next = { ...entry, blocked: false, retryAt: 0, lastFailure: undefined };
      await this.persist(this.scope, next);
      if (epoch === this.epoch) this.entries.update(rows => rows.map(row => row.id === id ? next : row));
    });
    this.wake();
  }
  async discard(id: string): Promise<void> {
    const scope=this.scope,epoch=this.epoch;
    await this.mutate(async () => {
      this.assertScope(scope,epoch);
      const entry = this.entries().find(row => row.id === id); if (!entry) return;
      if (this.running.get(`${this.scope}:${entry.conversationId}`) === entry.id) throw new Error('Espera a que termine el intento activo.');
      const key=`${scope}:${entry.conversationId}`;
      this.paused.set(key,(this.paused.get(key)??0)+1);
      try{await this.retire(entry,scope,epoch);}
      finally{const count=(this.paused.get(key)??1)-1;if(count)this.paused.set(key,count);else this.paused.delete(key);}
    });
    this.wake();
  }
  reconcile(messages: ChatMessageVm[]): void {
    const confirmed = new Set(messages.filter(row => row.mine && row.status !== 'sending').map(row => row.clientMessageId));
    for (const entry of this.entries()) if (confirmed.has(entry.clientMessageId)) {
      void this.removeConfirmed(entry, this.scope, this.epoch).catch(() => undefined);
    }
  }
  failureMessage(entry: ChatMessageVm): string {
    const queued = this.entries().find(row => row.id === entry.id);
    if (!queued) return '';
    if(queued.abandoning)return 'Cancelando este mensaje en el almacenamiento cifrado. No se volverá a enviar desde esta cola.';
    if (queued.scheduledFor && !queued.scheduleStartedAt) return Date.parse(queued.scheduledFor) > Date.now()
      ? 'Programado en este dispositivo. Se enviará con esta cuenta abierta, desbloqueada y con conexión.'
      : 'Hora programada alcanzada. Esperando que esta cuenta y el chat estén abiertos y desbloqueados, con conexión y el cifrado preparado.';
    if (!queued.attempts) return navigator.onLine === false ? 'Sin conexión. El texto quedó guardado en este equipo y se enviará al recuperar la conexión.' : '';
    switch (queued.lastFailure) {
      case 'recipient-keys': return 'Esperando a que tu contacto abra o actualice Nivra. El texto sigue guardado y se reintentará automáticamente.';
      case 'encryption': return 'Preparando la conversación con tu contacto. El texto está guardado y el envío se reintentará automáticamente.';
      case 'protocol': return 'El servicio necesita una actualización para completar este envío. Tu texto sigue guardado.';
      case 'queue-full': return 'Hay mensajes pendientes. Nivra continuará enviándolos en orden cuando estén preparados.';
      case 'identity': return 'El código de seguridad cambió. Revisa la identidad de tu contacto para continuar.';
      case 'network': return 'Esperando conexión. Nivra volverá a intentar el envío automáticamente.';
      case 'server': return 'El servidor aún no pudo aceptar el mensaje. Nivra volverá a intentarlo automáticamente.';
      case 'rate-limit': return 'El servidor pidió esperar. El envío continuará automáticamente.';
      case 'authorization': return 'No se autorizó el envío. Comprueba la sesión y los permisos de este chat.';
      default: return queued.blocked ? 'No se pudo completar el envío. Revisa el mensaje y vuelve a intentarlo.' : 'El mensaje sigue guardado en este equipo y se volverá a intentar.';
    }
  }
  wake(): void {
    if (!this.sender || !this.scope || this.sessionGeneration !== this.auth.sessionGeneration?.() || this.appLock.isContentLocked() || navigator.onLine === false || document.visibilityState === 'hidden') return;
    const heads = new Map<string, QueuedText>();
    for (const entry of this.entries()) {
      // A future message must not hold up a text the user is sending now.
      if (!entry.abandoning&&entry.scheduledFor && Date.parse(entry.scheduledFor) > Date.now()) continue;
      if (!heads.has(entry.conversationId)) heads.set(entry.conversationId, entry);
    }
    for (const entry of heads.values()) {
      if ([...this.running.keys()].filter(key => key.startsWith(`${this.scope}:`)).length >= this.network.deliveryConcurrency()) break;
      const key = `${this.scope}:${entry.conversationId}`;
      const retiring=entry.abandoning||!!entry.expiresAt&&Date.parse(entry.expiresAt)<=Date.now();
      if (this.running.has(key) || this.paused.has(key) || entry.retryAt > Date.now() || !retiring&&(entry.blocked||!this.allowed(entry))) continue;
      this.running.set(key, entry.id);
      const task = this.deliver(entry, this.scope, this.epoch).finally(() => { this.running.delete(key); this.tasks.delete(key); this.wake(); });
      this.tasks.set(key, task);
    }
  }
  private async deliver(entry: QueuedText, scope: string, epoch: number): Promise<void> {
    try {
      if (entry.abandoning||entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
        await this.mutate(()=>this.retire(entry,scope,epoch)); return;
      }
      await this.sender!(structuredClone(entry));
      await this.removeConfirmed(entry, scope, epoch);
    } catch (error) {
      if (epoch !== this.epoch || !this.entries().some(row => row.id === entry.id)) return;
      // The sender may have durably frozen a scheduled TTL before a failed HTTP attempt.
      entry = this.entries().find(row => row.id === entry.id)!;
      const status = Number((error as { status?: number })?.status);
      const transient = status === 0 || [408, 425, 429, 500, 502, 503, 504].includes(status)
        || (error as Error)?.name === 'TimeoutError' || (error as { retryable?: boolean })?.retryable === true;
      const retryAfter = (error as { headers?: { get?(name: string): string | null } })?.headers?.get?.('Retry-After');
      const hintedDelay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      const next = { ...entry, attempts: entry.attempts + 1, blocked: !transient,
        failureSchema: 1,
        lastFailure: this.failureKind(error, status),
        lastStatus: Number.isFinite(status) ? status : 0,
        retryAt: Date.now() + Math.max(Math.min(300000, Number.isFinite(hintedDelay) ? hintedDelay : 0),
          this.network.retryDelayMs(entry.attempts, 2000, 60000)) };
      try {
        await this.persist(scope, next);
        if (epoch === this.epoch) this.entries.update(rows => rows.map(row => row.id === entry.id ? next : row));
      } catch {
        if (epoch === this.epoch) {
          this.storageError.set('No se pudo guardar el estado de la cola. Los mensajes originales se conservaron.');
          this.entries.update(rows => rows.map(row => row.id === entry.id ? { ...row, blocked: true } : row));
        }
      }
    }
  }
  private async restore(scope: string, epoch: number): Promise<void> {
    try {
      const rows = await this.history.outboxMessages(scope);
      if (rows.some(row => row.decryptError || row.status !== 'sending' || row.payload.type !== 'text' || typeof row.payload.text !== 'string' || !row.clientMessageId || !row.mine
        || !Number.isSafeInteger((row as QueuedText).queueOrder) || !Number.isSafeInteger((row as QueuedText).attempts)
        || !Number.isFinite((row as QueuedText).retryAt) || typeof (row as QueuedText).blocked !== 'boolean' || (row as QueuedText).abandoning!==undefined&&typeof(row as QueuedText).abandoning!=='boolean'
        || `${row.senderUserId}:text-outbox:v1:${row.senderDeviceId}` !== scope
        || !this.validSchedule(row as QueuedText) || row.payload['__nivraOutbox'] !== this.binding(row as QueuedText))) throw new Error('Invalid queue ownership');
      if (epoch !== this.epoch) return;
      // Earlier clients permanently blocked key/binding preparation errors as
      // unknown status 0. Recheck those once with the current classifier,
      // preserving the message ID and every identity/permission check.
      for (const row of rows as QueuedText[]) {
        if (row.blocked && row.lastStatus === 0 && row.failureSchema !== 1
          && (row.lastFailure === undefined || row.lastFailure === 'unknown')) {
          row.blocked = false;
          row.retryAt = 0;
          row.lastFailure = 'unknown';
          row.failureSchema = 1;
          await this.persist(scope, row);
          if (epoch !== this.epoch) return;
        }
      }
      this.entries.set((rows as QueuedText[]).sort((a, b) => a.queueOrder - b.queueOrder));
      this.resumeNetwork();
    } catch {
      if (epoch === this.epoch) this.storageError.set('No se pudo abrir la cola cifrada. Reabre la cuenta; los datos locales se conservaron.');
    }
  }
  private failureKind(error: unknown, status: number): QueuedText['lastFailure'] {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'recipient_keys_unavailable') return 'recipient-keys';
    if (code === 'ratchet_preparing') return 'encryption';
    if (code === 'ratchet_protocol_unavailable') return 'protocol';
    if (code === 'ratchet_queue_full') return 'queue-full';
    if (code === 'identity_changed') return 'identity';
    if (status === 429) return 'rate-limit';
    if ([401, 403].includes(status)) return 'authorization';
    if ([500, 502, 503, 504].includes(status)) return 'server';
    if (status === 0 || [408, 425].includes(status) || (error as Error)?.name === 'TimeoutError') return 'network';
    return 'unknown';
  }
  private async persist(scope: string, entry: QueuedText): Promise<void> {
    await this.history.putMessages(scope, [entry]);
    const saved = await this.history.messageById(scope, entry.conversationId, entry.id);
    if (!saved || saved.decryptError || JSON.stringify(saved.payload) !== JSON.stringify(entry.payload)) throw new Error('No se pudo confirmar el guardado local cifrado.');
  }
  private binding(entry: QueuedText): string {
    const fields = [entry.scheduledFor ? 2 : 1, entry.senderUserId, entry.senderDeviceId, entry.id, entry.clientMessageId,
      entry.conversationId, entry.at, entry.expiresAt ?? null, Boolean(entry.deleteAfterRead), entry.queueOrder];
    if (entry.scheduledFor) fields.push(entry.scheduledFor, entry.scheduledTtlSeconds ?? null, entry.scheduleStartedAt ?? null);
    return JSON.stringify(fields);
  }
  private validSchedule(entry: QueuedText): boolean {
    if (entry.scheduledFor === undefined) return entry.scheduledTtlSeconds === undefined && entry.scheduleStartedAt === undefined;
    const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!iso(entry.scheduledFor) || !iso(entry.at) || Date.parse(entry.scheduledFor) < Date.parse(entry.at)
      || Date.parse(entry.scheduledFor) - Date.parse(entry.at) > MAX_MESSAGE_SCHEDULE_DELAY_MS
      || entry.scheduledTtlSeconds !== null && (!Number.isSafeInteger(entry.scheduledTtlSeconds) || entry.scheduledTtlSeconds! <= 0 || entry.scheduledTtlSeconds! > 30 * 86400)) return false;
    if (!entry.scheduleStartedAt) return entry.expiresAt == null;
    return iso(entry.scheduleStartedAt) && Date.parse(entry.scheduleStartedAt) >= Date.parse(entry.scheduledFor)
      && entry.expiresAt === (entry.scheduledTtlSeconds ? new Date(Date.parse(entry.scheduleStartedAt) + entry.scheduledTtlSeconds * 1000).toISOString() : null);
  }
  private resumeNetwork(): void {
    if (navigator.onLine === false || document.visibilityState === 'hidden') return;
    this.entries.update(rows => rows.map(row => !row.blocked && row.lastStatus === 0 ? { ...row, retryAt: 0 } : row));
    this.wake();
  }
  private async removeConfirmed(entry: QueuedText, scope: string, epoch: number): Promise<void> {
    await this.history.removeMessage(scope, entry.conversationId, entry.id);
    if (epoch === this.epoch) this.entries.update(rows => rows.filter(row => row.id !== entry.id));
  }
  private assertScope(scope:string,epoch:number):void{
    if(scope!==this.scope||epoch!==this.epoch||this.sessionGeneration!==this.auth.sessionGeneration?.()||this.appLock.isContentLocked())throw Error('La cuenta cambió durante la cancelación.');
  }
  private async retire(entry:QueuedText,scope:string,epoch:number):Promise<void>{
    this.assertScope(scope,epoch);
    if(!this.entries().some(row=>row.id===entry.id))return;
    const next=entry.abandoning?entry:{...entry,abandoning:true,blocked:true};
    if(!entry.abandoning){await this.persist(scope,next);this.assertScope(scope,epoch);this.entries.update(rows=>rows.map(row=>row.id===entry.id?next:row));}
    await this.abandonEntry?.(structuredClone(next));this.assertScope(scope,epoch);
    await this.removeConfirmed(next,scope,epoch);
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.serial.then(action); this.serial = operation.catch(() => undefined); return operation;
  }
}
