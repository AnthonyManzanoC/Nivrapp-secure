import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, fromEvent } from 'rxjs';
import { Contact, PublicKeyDirectory, RecipientCipherRequest, StoredDeviceKeys } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

export interface BroadcastListVm {
  id: string;
  name: string;
  recipientUserIds: string[];
  recipientCount: number;
  revision: number;
  updatedAt: string;
  locked: boolean;
}
export interface BroadcastRecipientResult {
  userId: string;
  status: 'pending' | 'sent' | 'failed';
  error?: string;
}
export interface BroadcastDispatch {
  operationId: string;
  listId: string;
  text: string;
  createdAt?: string;
  readonly expiresAt?: string | null;
  results: BroadcastRecipientResult[];
}
interface BroadcastRecord {
  id: string;
  encryptedPayload: string | null;
  recipientCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}
interface BroadcastPayload {
  v: 1;
  type: 'nivra-broadcast-list';
  id: string;
  ownerUserId: string;
  name: string;
  recipientUserIds: string[];
  lastDispatch?: BroadcastDispatch;
}
interface BroadcastEnvelope {
  v: 1;
  purpose: 'nivra-broadcast-list';
  recipients: Array<Pick<RecipientCipherRequest, 'userId' | 'deviceId' | 'ciphertext' | 'header'>>;
}

export const MAX_BROADCAST_RECIPIENTS = 256;
const MAX_BROADCAST_TEXT = 10_000;
const MAX_ENCRYPTED_BYTES = 1024 * 1024;
const CACHE_PREFIX = 'nivra.broadcasts.v1.';
const LIST_ID = /^bcl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPIRED_DISPATCH = 'Este envío temporal ya venció. Escribe un mensaje nuevo para volver a enviarlo.';

@Injectable({ providedIn: 'root' })
export class BroadcastService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly chat = inject(ChatService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  readonly lists = signal<BroadcastListVm[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly sending = signal(false);
  readonly error = signal('');
  readonly progress = signal<{ completed: number; total: number } | null>(null);
  readonly lastDispatch = signal<BroadcastDispatch | null>(null);
  private accountScope = '';
  private epoch = 0;
  private requestRevision = 0;
  private loadInFlight: { scope: string; promise: Promise<void> } | null = null;
  private records: BroadcastRecord[] = [];
  private restoredScope = '';
  private dispatchScope = '';
  private ephemeralEpoch = 0;
  private ephemeralTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchesByList = new Map<string, BroadcastDispatch>();

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelEphemeralTimer());
    effect(() => {
      const scope = this.scope();
      untracked(() => this.observeScope(scope));
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (['broadcast.updated', 'reconnected', 'connected', 'history.available'].includes(event.type) && this.scope()) {
        void this.load().catch(() => undefined);
      }
    });
    fromEvent(window, 'online').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.scope()) void this.load().catch(() => undefined);
    });
    fromEvent(document, 'visibilitychange').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (document.visibilityState === 'visible' && this.restoredScope && this.scope()) void this.load().catch(() => undefined);
    });
  }

  load(): Promise<void> {
    const scope = this.scope();
    this.observeScope(scope);
    if (!scope) return Promise.resolve();
    this.requestRevision++;
    if (this.loadInFlight?.scope === scope) return this.loadInFlight.promise;
    const epoch = this.epoch;
    const current = () => this.scope() === scope && this.epoch === epoch;
    const promise = this.loadCore(scope, current).finally(() => {
      if (this.loadInFlight?.promise === promise) this.loadInFlight = null;
      if (current()) this.loading.set(false);
    });
    this.loadInFlight = { scope, promise };
    return promise;
  }

  private async loadCore(scope: string, current: () => boolean): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      if (this.restoredScope !== scope) {
        this.restoredScope = scope;
        const cached = this.readCache();
        if (cached.length) {
          const decoded = await this.decodeRecords(cached, current);
          if (!current()) return;
          this.records = cached; this.lists.set(decoded);
        }
      }
      let revision: number;
      do {
        revision = this.requestRevision;
        const response = await firstValueFrom(this.api.get<{ lists: BroadcastRecord[] }>('/broadcast-lists'));
        if (!current()) return;
        if (revision !== this.requestRevision) continue;
        const records = this.validRecords(response?.lists);
        const decoded = await this.decodeRecords(records, current);
        if (!current()) return;
        if (revision !== this.requestRevision) continue;
        // The server returns a complete owner snapshot. Missing/deleted rows
        // must disappear rather than resurrecting from another device's cache.
        this.records = records; this.lists.set(decoded); this.writeCache(records);
      } while (current() && revision !== this.requestRevision);
    } catch (error) {
      if (current()) this.error.set(this.requestError(error, 'No se pudieron actualizar tus listas. Conservamos la copia cifrada de este dispositivo.'));
    }
  }

  async save(name: string, recipientUserIds: string[], existing?: BroadcastListVm): Promise<BroadcastListVm> {
    this.observeScope(this.scope());
    if (this.saving() || this.sending()) throw new Error('Espera a que termine la operación actual.');
    const current = this.guard();
    const scope = this.scope(); const epoch = this.epoch;
    const user = this.auth.session()!.user;
    const id = existing?.id ?? `bcl_${crypto.randomUUID()}`;
    if (existing && (existing.locked || !this.lists().some(list => list.id === id && list.revision === existing.revision))) {
      throw new Error('Actualiza la lista antes de editarla.');
    }
    const payload: BroadcastPayload = { v: 1, type: 'nivra-broadcast-list', id, ownerUserId: user.id,
      name: name.trim(), recipientUserIds: [...new Set(recipientUserIds)] };
    this.validatePayload(payload, id, user.id);
    this.saving.set(true); this.error.set('');
    try {
      await this.assertSavedContacts(payload.recipientUserIds, current);
      const encryptedPayload = await this.encryptPayload(payload, current);
      current();
      const response = await firstValueFrom(this.api.put<BroadcastRecord>(`/broadcast-lists/${encodeURIComponent(id)}`, {
        encryptedPayload, recipientCount: payload.recipientUserIds.length, expectedRevision: existing?.revision ?? 0,
      }));
      current();
      const record = this.validRecords([response])[0];
      if (!record || record.id !== id || record.deletedAt || record.encryptedPayload !== encryptedPayload) throw new Error('No se pudo confirmar la lista guardada.');
      this.requestRevision++;
      this.records = [record, ...this.records.filter(item => item.id !== id)];
      const list = this.toVm(record, payload);
      this.dispatchesByList.delete(id);
      if (this.lastDispatch()?.listId === id) this.lastDispatch.set(null);
      this.lists.update(items => [list, ...items.filter(item => item.id !== id)]);
      this.writeCache(this.records);
      return list;
    } catch (error) {
      current();
      const message = this.requestError(error, 'No se pudo guardar la lista.');
      this.error.set(message);
      if ((error as { status?: number })?.status === 409) void this.load();
      throw new Error(message);
    } finally { if (this.scope() === scope && this.epoch === epoch) this.saving.set(false); }
  }

  async remove(list: BroadcastListVm): Promise<void> {
    this.observeScope(this.scope());
    if (this.saving() || this.sending()) throw new Error('Espera a que termine la operación actual.');
    const current = this.guard();
    const scope = this.scope(); const epoch = this.epoch;
    if (!this.lists().some(item => item.id === list.id && item.revision === list.revision)) throw new Error('Actualiza la lista antes de eliminarla.');
    this.saving.set(true); this.error.set('');
    try {
      await firstValueFrom(this.api.delete(`/broadcast-lists/${encodeURIComponent(list.id)}?expectedRevision=${list.revision}`));
      current();
      this.requestRevision++;
      this.records = this.records.filter(item => item.id !== list.id);
      this.dispatchesByList.delete(list.id);
      if (this.lastDispatch()?.listId === list.id) this.lastDispatch.set(null);
      this.lists.update(items => items.filter(item => item.id !== list.id));
      this.writeCache(this.records);
    } catch (error) {
      current();
      const message = this.requestError(error, 'No se pudo eliminar la lista.');
      this.error.set(message);
      if ((error as { status?: number })?.status === 409) void this.load();
      throw new Error(message);
    } finally { if (this.scope() === scope && this.epoch === epoch) this.saving.set(false); }
  }

  async sendText(list: BroadcastListVm, text: string): Promise<BroadcastDispatch> {
    this.observeScope(this.scope());
    if (this.sending() || this.saving()) throw new Error('Ya hay una operación en curso.');
    const current = this.guard();
    const known = this.lists().find(item => item.id === list.id && item.revision === list.revision);
    if (!known || known.locked) throw new Error('Abre y sincroniza la lista antes de enviar.');
    const body = text.trim();
    if (!body || body.length > MAX_BROADCAST_TEXT) throw new Error(`Escribe un mensaje de hasta ${MAX_BROADCAST_TEXT} caracteres.`);
    const now = Date.now();
    const configuredTtl = Number(this.auth.session()?.user.privacySettings?.defaultMessageTtlSeconds || 0);
    const ttlSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 0;
    const dispatch: BroadcastDispatch = { operationId: crypto.randomUUID(), listId: list.id, text: body, createdAt: new Date(now).toISOString(),
      expiresAt: ttlSeconds > 0 ? new Date(now + ttlSeconds * 1000).toISOString() : null,
      results: known.recipientUserIds.map(userId => ({ userId, status: 'pending' })) };
    this.dispatchScope = this.scope();
    this.lastDispatch.set(dispatch);
    this.scheduleEphemeralExpiry(dispatch);
    return this.deliver(dispatch, this.dispatchGuard(dispatch, current));
  }

  async retryFailed(): Promise<BroadcastDispatch | null> {
    this.observeScope(this.scope());
    if (this.sending() || this.saving()) throw new Error('Ya hay una operación en curso.');
    const current = this.guard();
    const dispatch = this.lastDispatch();
    if (!dispatch || this.dispatchScope !== this.scope()) return null;
    const assertDispatch = this.dispatchGuard(dispatch, current);
    assertDispatch();
    return this.deliver({ ...dispatch, results: dispatch.results.map(result => result.status === 'sent' ? result : { userId: result.userId, status: 'pending' }) }, assertDispatch);
  }

  clearEphemeralDispatch(): void {
    if (!this.lastDispatch()?.expiresAt) return;
    this.cancelEphemeralTimer();
    ++this.ephemeralEpoch;
    this.lastDispatch.set(null); this.dispatchScope = ''; this.progress.set(null);
  }

  private cancelEphemeralTimer(): void {
    if (this.ephemeralTimer !== null) clearTimeout(this.ephemeralTimer);
    this.ephemeralTimer = null;
  }

  private scheduleEphemeralExpiry(dispatch: BroadcastDispatch): void {
    this.cancelEphemeralTimer();
    if (!dispatch.expiresAt) return;
    const remaining = Date.parse(dispatch.expiresAt) - Date.now();
    if (remaining <= 0) { this.clearEphemeralDispatch(); return; }
    this.ephemeralTimer = setTimeout(() => {
      this.ephemeralTimer = null;
      if (this.lastDispatch()?.operationId === dispatch.operationId) this.scheduleEphemeralExpiry(dispatch);
    }, Math.min(remaining, 2_147_000_000));
  }

  private dispatchGuard(dispatch: BroadcastDispatch, current: () => void): () => void {
    const epoch = this.ephemeralEpoch;
    return () => {
      current();
      if (dispatch.expiresAt && epoch !== this.ephemeralEpoch) throw new Error('El envío temporal se cerró. Vuelve a escribirlo desde tus listas.');
      if (dispatch.expiresAt && Date.parse(dispatch.expiresAt) <= Date.now()) throw new Error(EXPIRED_DISPATCH);
    };
  }

  private async deliver(dispatch: BroadcastDispatch, current: () => void): Promise<BroadcastDispatch> {
    const scope = this.scope();
    const epoch = this.epoch;
    const ephemeralEpoch = this.ephemeralEpoch;
    current();
    this.sending.set(true); this.error.set('');
    this.lastDispatch.set(dispatch);
    this.updateProgress(dispatch);
    try {
      const contacts = await firstValueFrom(this.api.get<Contact[]>('/contacts'));
      current();
      const saved = new Set(contacts.map(contact => contact.userId));
      // Durable messages store a resumable operation. Temporal messages first
      // CAS-replace any old operation with the encrypted list definition only.
      await this.persistDispatch(dispatch, current);
      current();
      for (const result of dispatch.results) {
        if (result.status === 'sent') continue;
        current();
        try {
          if (!saved.has(result.userId)) throw new Error('Este destinatario ya no está en tus contactos.');
          const conversation = await this.chat.conversationForBroadcast(result.userId);
          current();
          const response = await this.chat.sendPayload(conversation, { type: 'text', text: dispatch.text }, 'Text', null, {
            clientMessageId: `broadcast:${dispatch.operationId}:${result.userId}`,
            expiresAt: dispatch.expiresAt ?? null,
          });
          current();
          if (!response?.id) throw new Error('No se pudo confirmar el envío.');
          result.status = 'sent'; delete result.error;
        } catch (error) {
          current();
          result.status = 'failed';
          result.error = this.requestError(error, 'No se pudo confirmar el envío. Reintenta sin duplicar los mensajes aceptados.').slice(0, 500);
        }
        this.lastDispatch.set({ ...dispatch, results: dispatch.results.map(item => ({ ...item })) });
        this.updateProgress(dispatch);
      }
      try { if (!dispatch.expiresAt) await this.persistDispatch(dispatch, current); }
      catch (error) {
        current();
        this.error.set('Los estados de envío no se pudieron sincronizar. Conservamos el resultado aquí; reintentar la misma difusión no duplica los mensajes aceptados.');
      }
    } catch (error) {
      current();
      for (const result of dispatch.results) if (result.status === 'pending') {
        result.status = 'failed'; result.error = this.requestError(error, 'No hay conexión para enviar.').slice(0, 500);
      }
      this.error.set(this.requestError(error, 'No se pudo completar la difusión.'));
    } finally {
      if (this.scope() === scope && this.epoch === epoch) {
        this.sending.set(false);
        if (!dispatch.expiresAt || ephemeralEpoch === this.ephemeralEpoch) {
          this.lastDispatch.set({ ...dispatch, results: dispatch.results.map(item => ({ ...item })) });
          this.updateProgress(dispatch);
        }
      }
    }
    return this.lastDispatch() ?? dispatch;
  }

  private updateProgress(dispatch: BroadcastDispatch): void {
    this.progress.set({ completed: dispatch.results.filter(result => result.status !== 'pending').length, total: dispatch.results.length });
  }

  private async persistDispatch(dispatch: BroadcastDispatch, current: () => void): Promise<void> {
    const list = this.lists().find(item => item.id === dispatch.listId && !item.locked);
    if (!list) throw new Error('La lista ya no está disponible. Actualízala antes de enviar.');
    const payload: BroadcastPayload = { v: 1, type: 'nivra-broadcast-list', id: list.id, ownerUserId: this.auth.session()!.user.id,
      name: list.name, recipientUserIds: [...list.recipientUserIds],
      ...(!dispatch.expiresAt ? { lastDispatch: this.cloneDispatch(dispatch) } : {}) };
    this.validatePayload(payload, list.id, payload.ownerUserId);
    const encryptedPayload = await this.encryptPayload(payload, current);
    current();
    const response = await firstValueFrom(this.api.put<BroadcastRecord>(`/broadcast-lists/${encodeURIComponent(list.id)}`, {
      expectedRevision: list.revision, encryptedPayload, recipientCount: payload.recipientUserIds.length,
    }));
    current();
    const record = this.validRecords([response])[0];
    if (!record || record.id !== list.id || record.deletedAt || record.encryptedPayload !== encryptedPayload) throw new Error('No se pudo confirmar el estado cifrado de la difusión.');
    this.requestRevision++;
    this.records = [record, ...this.records.filter(item => item.id !== record.id)];
    this.lists.update(items => items.map(item => item.id === list.id ? this.toVm(record, payload) : item));
    if (dispatch.expiresAt) this.dispatchesByList.delete(list.id);
    else this.dispatchesByList.set(list.id, this.cloneDispatch(dispatch));
    this.writeCache(this.records);
  }

  private cloneDispatch(dispatch: BroadcastDispatch): BroadcastDispatch {
    return { ...dispatch, results: dispatch.results.map(result => ({ ...result })) };
  }

  private async assertSavedContacts(ids: string[], current: () => void): Promise<void> {
    const contacts = await firstValueFrom(this.api.get<Contact[]>('/contacts'));
    current();
    const allowed = new Set(contacts.map(contact => contact.userId));
    if (ids.some(id => !allowed.has(id))) throw new Error('Selecciona destinatarios que estén guardados en tus contactos.');
  }

  private async encryptPayload(payload: BroadcastPayload, current: () => void): Promise<string> {
    const session = this.auth.session()!;
    await this.auth.ensureDeviceIdentity(); current();
    const own = await this.crypto.currentKeyMaterial(session.user.alias, session.device.id); current();
    const directories = await firstValueFrom(this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: [session.user.id], aliases: [] }));
    current();
    const targets = new Map<string, JsonWebKey>();
    for (const directory of directories) if (directory.userId === session.user.id) {
      for (const device of directory.devices ?? []) {
        const key = this.crypto.parsePublicJwk(device.keyBundle.identityKey);
        if (key) targets.set(device.deviceId, key);
      }
    }
    targets.set(session.device.id, own.publicJwk);
    if (targets.size > 64) throw new Error('Revisa tus dispositivos vinculados antes de guardar la lista.');
    const recipients: BroadcastEnvelope['recipients'] = [];
    for (const [deviceId, key] of targets) {
      const sealed = await this.crypto.encryptForPublicKey(own, key, payload);
      current();
      recipients.push({ userId: session.user.id, deviceId, header: sealed.header, ciphertext: sealed.ciphertext });
    }
    const encrypted = JSON.stringify({ v: 1, purpose: 'nivra-broadcast-list', recipients } satisfies BroadcastEnvelope);
    if (new TextEncoder().encode(encrypted).byteLength > MAX_ENCRYPTED_BYTES) throw new Error('La lista cifrada supera el tamaño permitido.');
    return encrypted;
  }

  private async decodeRecords(records: BroadcastRecord[], current: () => boolean): Promise<BroadcastListVm[]> {
    const session = this.auth.session();
    if (!session) return [];
    // Imported history keys allow an approved new device to read a list created
    // before that device existed. The next edit wraps it for all active devices.
    const keys = await this.crypto.exportDeviceKeyMaterialsForUser(session.user.id, session.user.alias).catch(() => []);
    if (!current()) return [];
    const result: BroadcastListVm[] = [];
    const dispatches = new Map<string, BroadcastDispatch>();
    for (const record of records.filter(item => !item.deletedAt)) {
      let payload: BroadcastPayload | null = null;
      try { payload = await this.decryptRecord(record, session.user.id, keys, current); } catch { /* keep an explicit locked row */ }
      if (!current()) return [];
      result.push(payload ? this.toVm(record, payload) : { id: record.id, name: 'Lista cifrada', recipientUserIds: [],
        recipientCount: record.recipientCount, revision: record.revision, updatedAt: record.updatedAt, locked: true });
      if (payload?.lastDispatch) dispatches.set(record.id, payload.lastDispatch);
    }
    if (current() && !this.sending()) {
      this.dispatchesByList = dispatches;
      const ephemeral = this.lastDispatch();
      if (ephemeral?.expiresAt && result.some(list => list.id === ephemeral.listId && !list.locked)) {
        return result.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      }
      this.clearEphemeralDispatch();
      const latest = [...dispatches.values()].sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))[0];
      this.lastDispatch.set(latest ? this.cloneDispatch(latest) : null);
      this.dispatchScope = latest ? this.scope() : '';
      if (latest) this.updateProgress(latest); else this.progress.set(null);
    }
    return result.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private async decryptRecord(record: BroadcastRecord, ownerUserId: string, keys: StoredDeviceKeys[], current: () => boolean): Promise<BroadcastPayload | null> {
    const envelope = JSON.parse(record.encryptedPayload || '{}') as BroadcastEnvelope;
    if (envelope.v !== 1 || envelope.purpose !== 'nivra-broadcast-list' || !Array.isArray(envelope.recipients) || envelope.recipients.length > 64) return null;
    for (const recipient of envelope.recipients) {
      if (recipient.userId !== ownerUserId || !recipient.header || !recipient.ciphertext) continue;
      for (const own of keys.filter(key => key.userId === ownerUserId && key.deviceId === recipient.deviceId)) {
        try {
          const payload = await this.crypto.decryptEnvelope<BroadcastPayload>(own, recipient.header, recipient.ciphertext);
          if (!current()) return null;
          this.validatePayload(payload, record.id, ownerUserId);
          if (payload.recipientUserIds.length !== record.recipientCount) return null;
          return payload;
        } catch { if (!current()) return null; }
      }
    }
    return null;
  }

  private validatePayload(payload: BroadcastPayload, id: string, owner: string): void {
    if (!payload || payload.v !== 1 || payload.type !== 'nivra-broadcast-list' || payload.id !== id || !LIST_ID.test(id)
      || payload.ownerUserId !== owner || typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 80
      || !Array.isArray(payload.recipientUserIds) || !payload.recipientUserIds.length || payload.recipientUserIds.length > MAX_BROADCAST_RECIPIENTS
      || new Set(payload.recipientUserIds).size !== payload.recipientUserIds.length
      || payload.recipientUserIds.some(userId => typeof userId !== 'string' || !userId || userId === owner || userId.length > 64)) {
      throw new Error('Elige un nombre de hasta 80 caracteres y entre 1 y 256 contactos distintos.');
    }
    const dispatch = payload.lastDispatch;
    if (dispatch && (typeof dispatch.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(dispatch.operationId)
      || dispatch.listId !== id || typeof dispatch.text !== 'string' || !dispatch.text.trim() || dispatch.text.length > MAX_BROADCAST_TEXT
      || dispatch.expiresAt != null || !Number.isFinite(Date.parse(dispatch.createdAt || '')) || !Array.isArray(dispatch.results)
      || dispatch.results.length !== payload.recipientUserIds.length
      || new Set(dispatch.results.map(result => result?.userId)).size !== dispatch.results.length
      || dispatch.results.some(result => !payload.recipientUserIds.includes(result?.userId) || !['pending', 'sent', 'failed'].includes(result?.status)
        || (result.error !== undefined && (typeof result.error !== 'string' || result.error.length > 500))))) {
      throw new Error('El estado cifrado de la difusión no es válido.');
    }
  }

  private validRecords(value: unknown): BroadcastRecord[] {
    if (!Array.isArray(value) || value.length > 200) throw new Error('La respuesta de listas no es válida.');
    const ids = new Set<string>();
    return value.map(item => {
      if (!item || !LIST_ID.test(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1
        || !Number.isInteger(item.recipientCount) || item.recipientCount < 0 || item.recipientCount > MAX_BROADCAST_RECIPIENTS
        || !Number.isFinite(Date.parse(item.updatedAt)) || (!item.deletedAt && (typeof item.encryptedPayload !== 'string' || item.encryptedPayload.length > MAX_ENCRYPTED_BYTES))) {
        throw new Error('La respuesta de listas no es válida.');
      }
      ids.add(item.id); return item as BroadcastRecord;
    });
  }

  private toVm(record: BroadcastRecord, payload: BroadcastPayload): BroadcastListVm {
    return { id: record.id, name: payload.name, recipientUserIds: [...payload.recipientUserIds], recipientCount: payload.recipientUserIds.length,
      revision: record.revision, updatedAt: record.updatedAt, locked: false };
  }
  private scope(): string { const session = this.auth.session(); return session ? `${session.user.id}:${session.device.id}` : ''; }
  private observeScope(scope: string): void {
    if (scope === this.accountScope) return;
    this.cancelEphemeralTimer();
    this.accountScope = scope;
    this.epoch++;
    this.ephemeralEpoch++;
    this.requestRevision++;
    this.records = [];
    this.dispatchesByList.clear();
    this.restoredScope = '';
    this.loadInFlight = null;
    this.dispatchScope = '';
    this.lists.set([]); this.lastDispatch.set(null);
    this.loading.set(false); this.saving.set(false); this.sending.set(false);
    this.progress.set(null); this.error.set('');
  }
  private guard(): () => void {
    this.observeScope(this.scope());
    const scope = this.scope(); const epoch = this.epoch;
    if (!scope) throw new Error('Inicia sesión para usar tus listas.');
    return () => { if (this.scope() !== scope || this.epoch !== epoch) throw new Error('La cuenta cambió. Vuelve a abrir tus listas.'); };
  }
  private readCache(): BroadcastRecord[] {
    try {
      const text = localStorage.getItem(CACHE_PREFIX + this.auth.session()!.user.id);
      if (!text || text.length > 3 * MAX_ENCRYPTED_BYTES) return [];
      return this.validRecords(JSON.parse(text));
    } catch { return []; }
  }
  private writeCache(records: BroadcastRecord[]): void {
    try {
      const text = JSON.stringify(records);
      const key = CACHE_PREFIX + this.auth.session()!.user.id;
      if (text.length <= 3 * MAX_ENCRYPTED_BYTES) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch { /* Already encrypted server data remains authoritative. */ }
  }
  private requestError(error: unknown, fallback: string): string {
    const status = (error as { status?: number })?.status;
    if (status === 409) return 'La lista cambió en otro dispositivo. Se actualizará antes de que vuelvas a editarla.';
    if (status === 404 || status === 503) return 'Las listas aún no están disponibles en el servidor. Actualiza la app y vuelve a intentarlo.';
    return error instanceof Error && !('status' in error) ? error.message : fallback;
  }
}
