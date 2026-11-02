import { DestroyRef, Injectable, NgZone, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from './auth.service';
import { LocalHistoryService } from './local-history.service';
import { AppLockService } from './app-lock.service';
import { NetworkPolicyService } from './network-policy.service';
import type { ChatMessageVm, Conversation } from '../models/nivra.models';
import type { MessagePolicyOptions } from './chat.service';

export interface QueuedText extends ChatMessageVm {
  attempts: number;
  retryAt: number;
  blocked: boolean;
  queueOrder: number;
  lastStatus?: number;
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
  private epoch = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private restoring: Promise<void> = Promise.resolve();
  private sender?: (entry: QueuedText) => Promise<unknown>;
  private allowed: (entry: QueuedText) => boolean = () => false;
  private prepareEntry?: (entry: QueuedText) => void;
  private readonly running = new Map<string, string>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly paused = new Map<string, number>();

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const scope = session ? `${session.user.id}:text-outbox:v1:${session.device.id}` : '';
      untracked(() => {
        if (scope === this.scope) return;
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
  configure(sender: (entry: QueuedText) => Promise<unknown>, allowed: (entry: QueuedText) => boolean, prepareEntry?: (entry: QueuedText) => void): void {
    this.sender = sender; this.allowed = allowed; this.prepareEntry = prepareEntry; this.wake();
  }
  async enqueue(conversation: Conversation, text: string, policy: MessagePolicyOptions = {}): Promise<QueuedText> {
    const session = this.auth.session();
    if (!session || !text.trim() || text.length > 64000) throw new Error('No se pudo preparar el mensaje.');
    // Capture ownership before waiting for IndexedDB/SQLCipher or another local write.
    const scope = `${session.user.id}:text-outbox:v1:${session.device.id}`;
    const clientMessageId = `web-${crypto.randomUUID()}`;
    const entry: QueuedText = {
      id: `local-${clientMessageId}`, clientMessageId, conversationId: conversation.id,
      senderUserId: session.user.id, senderDeviceId: session.device.id, mine: true,
      at: new Date().toISOString(), status: 'sending', attempts: 0, retryAt: 0, blocked: false, queueOrder: 0,
      expiresAt: policy.ttlSeconds ? new Date(Date.now() + policy.ttlSeconds * 1000).toISOString() : null,
      deleteAfterRead: Boolean(policy.deleteAfterRead),
      payload: { type: 'text', text: text.trim(), ...(policy.replyTo ? { replyTo: structuredClone(policy.replyTo) } : {}) },
    };
    return this.mutate(async () => {
      await this.restoring;
      if (scope !== this.scope) throw new Error('La cuenta cambió antes de guardar el mensaje.');
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
      const next = { ...entry, blocked: false, retryAt: 0 };
      await this.persist(this.scope, next);
      if (epoch === this.epoch) this.entries.update(rows => rows.map(row => row.id === id ? next : row));
    });
    this.wake();
  }
  async discard(id: string): Promise<void> {
    await this.mutate(async () => {
      const entry = this.entries().find(row => row.id === id); if (!entry) return;
      if (this.running.get(`${this.scope}:${entry.conversationId}`) === entry.id) throw new Error('Espera a que termine el intento activo.');
      const epoch = this.epoch;
      await this.history.removeMessage(this.scope, entry.conversationId, entry.id);
      if (epoch === this.epoch) this.entries.update(rows => rows.filter(row => row.id !== id));
    });
    this.wake();
  }
  reconcile(messages: ChatMessageVm[]): void {
    const confirmed = new Set(messages.filter(row => row.mine && row.status !== 'sending').map(row => row.clientMessageId));
    for (const entry of this.entries()) if (confirmed.has(entry.clientMessageId)) {
      void this.removeConfirmed(entry, this.scope, this.epoch).catch(() => undefined);
    }
  }
  wake(): void {
    if (!this.sender || !this.scope || this.appLock.isContentLocked() || navigator.onLine === false || document.visibilityState === 'hidden') return;
    const heads = new Map<string, QueuedText>();
    for (const entry of this.entries()) if (!heads.has(entry.conversationId)) heads.set(entry.conversationId, entry);
    for (const entry of heads.values()) {
      if ([...this.running.keys()].filter(key => key.startsWith(`${this.scope}:`)).length >= this.network.deliveryConcurrency()) break;
      const key = `${this.scope}:${entry.conversationId}`;
      if (this.running.has(key) || this.paused.has(key) || entry.blocked || entry.retryAt > Date.now() || !this.allowed(entry)) continue;
      this.running.set(key, entry.id);
      const task = this.deliver(entry, this.scope, this.epoch).finally(() => { this.running.delete(key); this.tasks.delete(key); this.wake(); });
      this.tasks.set(key, task);
    }
  }
  private async deliver(entry: QueuedText, scope: string, epoch: number): Promise<void> {
    try {
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
        await this.removeConfirmed(entry, scope, epoch); return;
      }
      await this.sender!(structuredClone(entry));
      await this.removeConfirmed(entry, scope, epoch);
    } catch (error) {
      if (epoch !== this.epoch || !this.entries().some(row => row.id === entry.id)) return;
      const status = Number((error as { status?: number })?.status);
      const transient = status === 0 || [408, 425, 429, 500, 502, 503, 504].includes(status)
        || (error as Error)?.name === 'TimeoutError' || (error as { retryable?: boolean })?.retryable === true;
      const retryAfter = (error as { headers?: { get?(name: string): string | null } })?.headers?.get?.('Retry-After');
      const hintedDelay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      const next = { ...entry, attempts: entry.attempts + 1, blocked: !transient,
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
        || !Number.isFinite((row as QueuedText).retryAt) || typeof (row as QueuedText).blocked !== 'boolean'
        || `${row.senderUserId}:text-outbox:v1:${row.senderDeviceId}` !== scope
        || row.payload['__nivraOutbox'] !== this.binding(row as QueuedText))) throw new Error('Invalid queue ownership');
      if (epoch !== this.epoch) return;
      this.entries.set((rows as QueuedText[]).sort((a, b) => a.queueOrder - b.queueOrder));
      this.resumeNetwork();
    } catch {
      if (epoch === this.epoch) this.storageError.set('No se pudo abrir la cola cifrada. Reabre la cuenta; los datos locales se conservaron.');
    }
  }
  private async persist(scope: string, entry: QueuedText): Promise<void> {
    await this.history.putMessages(scope, [entry]);
    const saved = await this.history.messageById(scope, entry.conversationId, entry.id);
    if (!saved || saved.decryptError || JSON.stringify(saved.payload) !== JSON.stringify(entry.payload)) throw new Error('No se pudo confirmar el guardado local cifrado.');
  }
  private binding(entry: QueuedText): string {
    return JSON.stringify([1, entry.senderUserId, entry.senderDeviceId, entry.id, entry.clientMessageId,
      entry.conversationId, entry.at, entry.expiresAt ?? null, Boolean(entry.deleteAfterRead), entry.queueOrder]);
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
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.serial.then(action); this.serial = operation.catch(() => undefined); return operation;
  }
}
