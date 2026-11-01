import { Injectable, InjectionToken, OnDestroy, effect, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { ChatPayload, MessageHistoryRecoveryResponse, MessageResponse, PublicKeyDirectory, RecipientCipherRequest } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { IdentityTrustService } from './identity-trust.service';
import { LocalHistoryService } from './local-history.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { AppLockService } from './app-lock.service';
import { RatchetBundle, RatchetDeviceRuntime, RatchetEnvelope, RatchetRuntimeFactory, openRatchetRuntime, ratchetBase64, ratchetBinary, ratchetHash, ratchetMessageId } from './ratchet-runtime';

export const RATCHET_RUNTIME = new InjectionToken<RatchetRuntimeFactory>('Nivra ratchet runtime', { providedIn: 'root', factory: () => openRatchetRuntime });
const ALGORITHM = 'NIVRA-LIBSIGNAL-MESSAGE-1';
export interface RatchetTarget { userId: string; deviceId: string; publicJwk: JsonWebKey; }
interface DirectoryEntry { userId: string; deviceId: string; signalDeviceNumber: number; registrationId: number; identityKey: string; bindingHeader?: string; bindingCiphertext?: string; }
interface Binding { header: string; ciphertext: string; }
interface Peer { userId: string; identityKey: string; registrationId: number; legacy: string; }
interface ContentFrame { key: string; iv: string; ciphertext: string; }
interface PendingSend { conversationId: string; payloadHash: string; payload: ChatPayload; body: ContentFrame; targetsHash?: string; recipients?: RecipientCipherRequest[]; }
interface ApplicationState { v: 1; registrationId: number; peers: Record<string, Peer>; outgoing: Record<string, PendingSend>; confirmed: Record<string, { conversationId: string; serverId: string }>; reservations?: Record<string, { conversationId: string; requestId: string }>; }
interface MessageHeader { v: 4; alg: typeof ALGORITHM; senderDeviceId: string; recipientDeviceId: string; identityKey: string; registrationId: number; binding?: Binding; local?: boolean; payloadIv?: string; payloadCiphertext?: string; }
const pendingRatchet = (message: string): Error => Object.assign(new Error(message), { retryable: true, status: 503 });

/** One independently persisted Signal session per actual device. Legacy keys remain read-only for old history. */
@Injectable({ providedIn: 'root' })
export class RatchetMessagingService implements OnDestroy {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly history = inject(LocalHistoryService);
  private readonly trust = inject(IdentityTrustService);
  private readonly signalr = inject(SignalrService);
  private readonly factory = inject(RATCHET_RUNTIME);
  private readonly appLock = inject(AppLockService);
  private runtime: RatchetDeviceRuntime | null = null;
  private runtimeScope = '';
  private opening: Promise<RatchetDeviceRuntime> | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private enabledCache: { scope: string; at: number; enabled: boolean } | null = null;
  private readonly events = this.signalr.events$.subscribe(event => {
    if (['connected', 'reconnected', 'ratchet.binding.requested'].includes(event.type)) void this.pump().catch(() => undefined);
  });
  private readonly timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void this.pump().catch(() => undefined); }, 60000);

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const scope = session && !this.appLock.isContentLocked() ? JSON.stringify([session.user.id, session.device.id]) : '';
      if (this.runtimeScope && scope !== this.runtimeScope) {
        this.generation++; const previous = this.runtime; this.runtime = null; this.runtimeScope = ''; this.opening = null;
        void previous?.close().catch(() => undefined);
      }
    });
  }
  ngOnDestroy(): void { this.generation++; this.events.unsubscribe(); window.clearInterval(this.timer); void this.runtime?.close().catch(() => undefined); }

  isEnvelope(header: string | null | undefined): boolean {
    try { const value = JSON.parse(header || '{}'); return value.v === 4 && value.alg === ALGORITHM; } catch { return false; }
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.serial.then(work).catch(async error => {
      // A failed disk commit can be ambiguous. Reopen from the last durable
      // revision before another operation; never continue a poisoned engine.
      const previous = this.runtime; this.runtime = null;
      await previous?.close().catch(() => undefined);
      throw error;
    });
    this.serial = operation.catch(() => undefined); return operation;
  }
  private owner() {
    const session = this.auth.session();
    if (!session || this.appLock.isContentLocked()) throw Error('Desbloquea Nivra para abrir el cifrado del dispositivo.');
    const generation = this.generation;
    const sessionGeneration = this.auth.sessionGeneration?.();
    const scope = JSON.stringify([session.user.id, session.device.id]);
    const assert = () => { const now = this.auth.session(); if (sessionGeneration !== this.auth.sessionGeneration?.() || generation !== this.generation || this.appLock.isContentLocked() || now?.user.id !== session.user.id || now.device.id !== session.device.id) throw Error('La cuenta o el dispositivo cambió.'); };
    return { userId: session.user.id, deviceId: session.device.id, alias: session.user.alias, scope, assert };
  }
  private async enabled(): Promise<boolean> {
    const owner = this.owner();
    if (this.enabledCache?.scope === owner.scope && Date.now() - this.enabledCache.at < 30000) return this.enabledCache.enabled;
    let enabled: boolean;
    try { const value = await firstValueFrom(this.api.get<{ enabled: boolean; protocol: number }>('/ratchet/config').pipe(timeout(15000))); enabled = value.enabled === true && value.protocol === 3; }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; enabled = false; }
    owner.assert(); this.enabledCache = { scope: owner.scope, at: Date.now(), enabled }; return enabled;
  }
  private async open(create: boolean): Promise<RatchetDeviceRuntime> {
    const owner = this.owner();
    if (this.runtime && this.runtimeScope === owner.scope) return this.runtime;
    if (this.opening && this.runtimeScope === owner.scope) return this.opening;
    this.runtimeScope = owner.scope;
    const operation = (async () => {
      const saved = await this.history.readRatchetState(owner.userId, owner.deviceId); owner.assert();
      if (!saved && create) {
        const registered = await this.directory([owner.deviceId]); owner.assert();
        // Missing private state must never silently replace a published identity.
        if (registered.length) throw Error('Falta la sesión cifrada de este dispositivo. Vincúlalo de nuevo desde un equipo autorizado.');
      }
      const expected = JSON.stringify([owner.deviceId, 1]);
      const engine = await this.factory(owner.deviceId, {
        read: async scope => { owner.assert(); if (scope !== expected) throw Error('Ámbito de cifrado inválido.'); const value = await this.history.readRatchetState(owner.userId, owner.deviceId); owner.assert(); return value; },
        commit: async (scope, revision, state) => { owner.assert(); if (scope !== expected) throw Error('Ámbito de cifrado inválido.'); const result = await this.history.commitRatchetState(owner.userId, owner.deviceId, revision, state); owner.assert(); return result; },
      }, create);
      try { owner.assert(); this.runtime = engine; return engine; } catch (error) { await engine.close(); throw error; }
    })();
    this.opening = operation;
    try { return await operation; } finally { if (this.opening === operation) this.opening = null; }
  }
  private async state(engine: RatchetDeviceRuntime): Promise<ApplicationState> {
    const value = await engine.applicationState() as Partial<ApplicationState>;
    if (value.v === 1 && value.registrationId && value.peers && value.outgoing && value.confirmed) return value as ApplicationState;
    if (Object.keys(value).length) throw Error('Estado de mensajes cifrados incompatible.');
    const bundle = (await engine.pendingBundles())[0] ?? await engine.bundle();
    const result: ApplicationState = { v: 1, registrationId: bundle.registrationId, peers: {}, outgoing: {}, confirmed: {} };
    await engine.updateApplicationState(result); return result;
  }
  private async directory(ids: string[]): Promise<DirectoryEntry[]> {
    const result: DirectoryEntry[] = [];
    for (let index = 0; index < ids.length; index += 128) result.push(...await firstValueFrom(this.api.post<DirectoryEntry[]>('/ratchet/directory', { deviceIds: ids.slice(index, index + 128) }).pipe(timeout(15000))));
    if (result.some(entry => !ids.includes(entry.deviceId) || entry.signalDeviceNumber !== 1 || ratchetBinary(entry.identityKey, 33).length !== 33)) throw Error('Directorio de cifrado inválido.');
    return result;
  }
  private async publish(engine: RatchetDeviceRuntime): Promise<void> {
    await this.state(engine);
    let pending = await engine.pendingBundles();
    const status = await firstValueFrom(this.api.get<{ available: number }>('/ratchet/prekeys/status').pipe(timeout(15000)));
    if (!Number.isInteger(status.available) || status.available < 0 || status.available > 256) throw Error('Reserva de preclaves inválida.');
    if (status.available + pending.length < 8) {
      for (let index = status.available + pending.length; index < 24; index++) await engine.bundle();
      pending = await engine.pendingBundles();
    }
    for (let index = 0; index < pending.length; index += 32) {
      const batch = pending.slice(index, index + 32);
      await firstValueFrom(this.api.post('/ratchet/prekeys', { bundles: batch }).pipe(timeout(15000)));
      await engine.acknowledgeBundles(batch.map(bundle => bundle.preKeyId));
    }
  }
  async pump(): Promise<void> {
    return this.run(async () => {
      if (!this.auth.session() || !await this.enabled()) return;
      const owner = this.owner(), engine = await this.open(true); await this.publish(engine); owner.assert();
      const pending = await firstValueFrom(this.api.get<Array<{ userId: string; deviceId: string; identityKey: string }>>('/ratchet/bindings/pending').pipe(timeout(15000)));
      if (!Array.isArray(pending) || pending.length > 128) throw Error('Solicitud de dispositivos inválida.');
      const uploads = [];
      for (const target of pending) {
        const publicJwk = this.crypto.parsePublicJwk(target.identityKey); if (!publicJwk) throw Error('Identidad de destino inválida.');
        const binding = await this.makeBinding(engine, { ...target, publicJwk }); owner.assert();
        uploads.push({ targetDeviceId: target.deviceId, targetIdentity: this.coordinates(publicJwk), ...binding });
      }
      for (let index = 0; index < uploads.length; index += 64) await firstValueFrom(this.api.post('/ratchet/bindings', { bindings: uploads.slice(index, index + 64) }).pipe(timeout(15000)));
    });
  }
  private coordinates(key: JsonWebKey): string { if (!key.x || !key.y) throw Error('Identidad incompleta.'); return `${key.x}:${key.y}`; }
  private async makeBinding(engine: RatchetDeviceRuntime, target: RatchetTarget): Promise<Binding> {
    const owner = this.owner(), own = await this.auth.ensureDeviceIdentity(), state = await this.state(engine); owner.assert();
    const sealed = await this.crypto.encryptForPublicKey(own, target.publicJwk, { v: 1, purpose: 'nivra-ratchet-binding-v1',
      userId: owner.userId, deviceId: owner.deviceId, identityKey: ratchetBase64(engine.publicIdentity), registrationId: state.registrationId,
      sourceLegacy: this.coordinates(own.publicJwk), targetUserId: target.userId, targetDeviceId: target.deviceId, targetLegacy: this.coordinates(target.publicJwk) });
    if (!sealed.header) throw Error('Falta el encabezado de la vinculación.');
    return { header: sealed.header, ciphertext: sealed.ciphertext };
  }
  private async pin(engine: RatchetDeviceRuntime, target: RatchetTarget, entry: DirectoryEntry, binding?: Binding): Promise<void> {
    const owner = this.owner(), state = await this.state(engine), previous = state.peers[target.deviceId];
    if (entry.userId !== target.userId || entry.deviceId !== target.deviceId || entry.signalDeviceNumber !== 1) throw Error('El dispositivo cifrado no coincide.');
    if (previous) {
      if (previous.userId !== target.userId || previous.identityKey !== entry.identityKey || previous.registrationId !== entry.registrationId || previous.legacy !== this.coordinates(target.publicJwk)) throw Error('La identidad cifrada cambió. Verifica el dispositivo antes de continuar.');
      return;
    }
    if (!binding) {
      await firstValueFrom(this.api.post('/ratchet/bindings/request', { deviceIds: [target.deviceId] }).pipe(timeout(15000)));
      throw pendingRatchet('El otro dispositivo está preparando el cifrado seguro. El mensaje permanece pendiente y se reintentará.');
    }
    const header = JSON.parse(binding.header);
    if (header.v !== 1 || header.alg !== 'ECDH-P256-A256GCM' || this.coordinates(header.senderPublicKey) !== this.coordinates(target.publicJwk)) throw Error('La prueba de identidad no coincide.');
    const own = await this.crypto.currentKeyMaterial(owner.alias, owner.deviceId); owner.assert();
    if (!own) throw Error('Falta la llave local para comprobar el dispositivo.');
    const proof = await this.crypto.decryptEnvelope<Record<string, unknown>>(own, binding.header, binding.ciphertext); owner.assert();
    if (proof['v'] !== 1 || proof['purpose'] !== 'nivra-ratchet-binding-v1' || proof['userId'] !== target.userId || proof['deviceId'] !== target.deviceId
      || proof['identityKey'] !== entry.identityKey || proof['registrationId'] !== entry.registrationId || proof['sourceLegacy'] !== this.coordinates(target.publicJwk)
      || proof['targetUserId'] !== owner.userId || proof['targetDeviceId'] !== owner.deviceId || proof['targetLegacy'] !== this.coordinates(own.publicJwk)) throw Error('La vinculación cifrada no es válida para este dispositivo.');
    state.peers[target.deviceId] = { userId: target.userId, identityKey: entry.identityKey, registrationId: entry.registrationId, legacy: this.coordinates(target.publicJwk) };
    await engine.pinIdentity({ name: target.deviceId, device: 1 }, ratchetBinary(entry.identityKey, 33), state); owner.assert();
  }

  /** null means this deployment has never enabled this device. Pinned peers never downgrade. */
  async encrypt(conversationId: string, clientMessageId: string, payload: ChatPayload, targets: RatchetTarget[], fileObjectId: string | null): Promise<RecipientCipherRequest[] | null> {
    return this.run(async () => {
      const owner = this.owner();
      if (!await this.enabled()) {
        const saved = await this.history.readRatchetState(owner.userId, owner.deviceId); owner.assert();
        if (saved) throw pendingRatchet('El cifrado avanzado está temporalmente detenido. El mensaje queda pendiente.');
        return null;
      }
      const engine = await this.open(true); owner.assert();
      let state = await this.state(engine);
      if (state.confirmed[clientMessageId]) throw Error('Este mensaje ya se confirmó; recupera su confirmación antes de reintentar.');
      const clean = { ...payload }; delete clean['_padding'];
      const digest = await ratchetHash([conversationId, clean, fileObjectId]);
      const existing = state.outgoing[clientMessageId];
      const targetsHash = await ratchetHash(targets.map(target => [target.userId, target.deviceId, this.coordinates(target.publicJwk)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      if (existing && (existing.payloadHash !== digest || existing.conversationId !== conversationId)) throw Error('El identificador del mensaje ya contiene otro contenido.');
      if (existing?.recipients && existing.targetsHash === targetsHash) return this.hydrate(existing.recipients, existing.body);
      await this.publish(engine); owner.assert();
      if (!existing) {
        if (Object.keys(state.outgoing).length >= 200) throw pendingRatchet('La cola cifrada está llena. Espera a que se envíen los mensajes pendientes.');
        state.outgoing[clientMessageId] = { conversationId, payloadHash: digest, payload, body: await this.contentFrame(payload) };
        await engine.updateApplicationState(state);
      }
      // Padding is random; retries must reuse the originally persisted bytes.
      payload = existing?.payload ?? payload;
      const body = state.outgoing[clientMessageId].body;
      if (!body) throw Error('El estado cifrado pendiente necesita una versión compatible.');
      const keyPackage = { type: 'nivra-content-key', key: body.key, bodyHash: await ratchetHash([body.iv, body.ciphertext]) };
      const entries = new Map((await this.directory(targets.map(target => target.deviceId))).map(entry => [entry.deviceId, entry])); owner.assert();
      const missing = targets.filter(target => entries.has(target.deviceId) && target.deviceId !== owner.deviceId && !state.peers[target.deviceId] && !entries.get(target.deviceId)?.bindingHeader).map(target => target.deviceId);
      if (missing.length) {
        for (let index = 0; index < missing.length; index += 128) await firstValueFrom(this.api.post('/ratchet/bindings/request', { deviceIds: missing.slice(index, index + 128) }).pipe(timeout(15000)));
        throw pendingRatchet('El otro dispositivo está preparando el cifrado seguro. El mensaje permanece pendiente y se reintentará.');
      }
      const recipients: RecipientCipherRequest[] = [], messageId = await ratchetMessageId(clientMessageId), batched: Array<{ index: number; deviceId: string }> = [];
      for (const target of targets) {
        owner.assert();
        state = await this.state(engine);
        const entry = entries.get(target.deviceId);
        let ciphertext: string, header: string;
        if (target.deviceId === owner.deviceId && target.userId === owner.userId) {
          // A static-key self copy would remove forward secrecy for every message.
          ciphertext = 'local-history-v1';
          header = JSON.stringify({ v: 4, alg: ALGORITHM, senderDeviceId: owner.deviceId, recipientDeviceId: owner.deviceId,
            identityKey: ratchetBase64(engine.publicIdentity), registrationId: state.registrationId, local: true } satisfies MessageHeader);
        } else if (entry) {
          await this.pin(engine, target, entry, entry.bindingHeader && entry.bindingCiphertext ? { header: entry.bindingHeader, ciphertext: entry.bindingCiphertext } : undefined);
          const address = { name: target.deviceId, device: 1 };
          if (!await engine.hasSession(address)) {
            state = await this.state(engine); state.reservations ??= {};
            let claim = state.reservations[target.deviceId];
            if (!claim || claim.conversationId !== conversationId) { claim = { conversationId, requestId: crypto.randomUUID() }; state.reservations[target.deviceId] = claim; await engine.updateApplicationState(state); }
            const reservation = await firstValueFrom(this.api.post<{ bundle: RatchetBundle; deviceId: string }>(`/ratchet/devices/${encodeURIComponent(target.deviceId)}/prekey`, claim).pipe(timeout(15000))); owner.assert();
            if (reservation.deviceId !== target.deviceId || reservation.bundle.identityKey !== entry.identityKey || reservation.bundle.registrationId !== entry.registrationId) throw Error('Las preclaves no corresponden al dispositivo verificado.');
            await engine.establish(address, reservation.bundle);
          }
          const binding = await this.makeBinding(engine, target);
          batched.push({ index: recipients.length, deviceId: target.deviceId }); ciphertext = '';
          header = JSON.stringify({ v: 4, alg: ALGORITHM, senderDeviceId: owner.deviceId, recipientDeviceId: target.deviceId,
            identityKey: ratchetBase64(engine.publicIdentity), registrationId: state.registrationId, binding } satisfies MessageHeader);
        } else {
          if (state.peers[target.deviceId]) throw Error('El dispositivo ya usa cifrado avanzado y no puede retroceder al formato anterior.');
          const own = await this.auth.ensureDeviceIdentity(), sealed = await this.crypto.encryptForPublicKey(own, target.publicJwk, { type: 'group-sender-key', alg: 'A256GCM', key: body.key });
          if (!sealed.header) throw Error('Falta el encabezado cifrado.');
          ciphertext = sealed.ciphertext; header = JSON.stringify({ v: 2, alg: 'NIVRA-GROUP-A256GCM', keyHeader: sealed.header });
        }
        recipients.push({ userId: target.userId, deviceId: target.deviceId, ciphertext, header, fileObjectId });
      }
      if (batched.length) {
        const packets = await engine.encryptMany(batched.map(target => ({ peer: { name: target.deviceId, device: 1 }, context: { conversationId, messageId }, payload: keyPackage })));
        batched.forEach((target, index) => { recipients[target.index].ciphertext = JSON.stringify(packets[index]); });
      }
      state = await this.state(engine); owner.assert();
      state.outgoing[clientMessageId].recipients = recipients; state.outgoing[clientMessageId].targetsHash = targetsHash;
      await engine.updateApplicationState(state); return this.hydrate(recipients, body);
    });
  }
  private async contentFrame(payload: ChatPayload): Promise<ContentFrame> {
    const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    if (plain.length > 1024 * 1024) { raw.fill(0); plain.fill(0); throw Error('El mensaje cifrado es demasiado grande.'); }
    try {
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
      return { key: ratchetBase64(raw), iv: ratchetBase64(iv), ciphertext: ratchetBase64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))) };
    } finally { raw.fill(0); plain.fill(0); }
  }
  private hydrate(recipients: RecipientCipherRequest[], body: ContentFrame): RecipientCipherRequest[] {
    return recipients.map(recipient => {
      const header = JSON.parse(recipient.header || '{}');
      return header.local ? { ...recipient } : { ...recipient, header: JSON.stringify({ ...header, payloadIv: body.iv, payloadCiphertext: body.ciphertext }) };
    });
  }

  async confirmed(conversationId: string, clientMessageId: string): Promise<MessageResponse | null> {
    return this.run(async () => {
      const owner = this.owner();
      if (!await this.history.readRatchetState(owner.userId, owner.deviceId)) return null;
      const engine = await this.open(false), entry = (await this.state(engine)).confirmed[clientMessageId]; owner.assert();
      if (!entry) return null;
      if (entry.conversationId !== conversationId) throw Error('Identificador de envío reutilizado.');
      const response = await firstValueFrom(this.api.post<MessageHistoryRecoveryResponse>('/messages/history-recovery', { messageIds: [entry.serverId] }).pipe(timeout(15000))); owner.assert();
      const message = response.messages.find(item => item.id === entry.serverId && item.clientMessageId === clientMessageId && item.conversationId === conversationId);
      if (!message) throw Error('El mensaje ya se envió y se retiró del historial. No se enviará otra vez.');
      return message;
    });
  }
  async confirmSent(message: MessageResponse, payload: ChatPayload, isCurrent: () => boolean = () => true): Promise<void> {
    if (!message.recipients.some(recipient => this.isEnvelope(recipient.header))) return;
    return this.run(async () => {
      const owner = this.owner(), engine = await this.open(false), state = await this.state(engine);
      // History must be durable before the only local self-copy is released.
      if (isCurrent() && message.recipients.some(recipient => recipient.deviceId === owner.deviceId && this.isEnvelope(recipient.header))) await this.persistDelivery(message, payload, 'sent', isCurrent);
      owner.assert();
      state.confirmed[message.clientMessageId] = { conversationId: message.conversationId, serverId: message.id };
      const ids = Object.keys(state.confirmed); for (const id of ids.slice(0, Math.max(0, ids.length - 8192))) delete state.confirmed[id];
      delete state.outgoing[message.clientMessageId];
      await engine.updateApplicationState(state);
      await engine.releaseOutgoing(message.conversationId, await ratchetMessageId(message.clientMessageId));
    });
  }

  async decrypt(message: MessageResponse, recipient: RecipientCipherRequest, isCurrent: () => boolean = () => true): Promise<ChatPayload> {
    const initialOwner = this.owner();
    const retained = this.history.messageWriteGuard(initialOwner.userId, message.conversationId, message.id);
    const current = () => { initialOwner.assert(); return isCurrent() && retained(); };
    return this.run(async () => {
      if (!current()) throw Error('El historial cambió durante la recepción.');
      const owner = this.owner(), header = JSON.parse(recipient.header || '{}') as MessageHeader;
      if (!this.isEnvelope(recipient.header) || header.senderDeviceId !== message.senderDeviceId || header.recipientDeviceId !== owner.deviceId || recipient.deviceId !== owner.deviceId || recipient.userId !== owner.userId) throw Error('Sobre cifrado destinado a otro dispositivo.');
      const digest = await ratchetHash([recipient.header, recipient.ciphertext]);
      const cached = await this.history.messageById(owner.userId, this.receiptConversation(message.conversationId), message.id); owner.assert();
      if (cached?.senderUserId === message.senderUserId && cached.senderDeviceId === message.senderDeviceId && cached.clientMessageId === message.clientMessageId && cached.payload['content'] && (cached.payload['envelopeHash'] === digest ||
        (cached.payload['envelopeHash'] === 'sent' && header.local && message.senderUserId === owner.userId && message.senderDeviceId === owner.deviceId && cached.clientMessageId === message.clientMessageId))) return cached.payload['content'] as ChatPayload;
      const engine = await this.open(false), state = await this.state(engine);
      let payload: ChatPayload, incomingId: string | undefined;
      if (header.local) {
        if (message.senderUserId !== owner.userId || message.senderDeviceId !== owner.deviceId || recipient.ciphertext !== 'local-history-v1') throw Error('Copia local de otro dispositivo.');
        const pending = state.outgoing[message.clientMessageId];
        if (!pending || pending.conversationId !== message.conversationId) throw Error('Este mensaje necesita el historial local o una transferencia aprobada.');
        payload = pending.payload;
      } else {
        const known = state.peers[message.senderDeviceId];
        if (known && (known.userId !== message.senderUserId || known.identityKey !== header.identityKey || known.registrationId !== header.registrationId)) throw Error('La identidad cifrada del mensaje cambió.');
        if (!known) {
        const directories = await firstValueFrom(this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: [message.senderUserId], aliases: [] }).pipe(timeout(15000))); owner.assert();
        const directory = directories.find(item => item.userId === message.senderUserId), device = directory?.devices.find(item => item.deviceId === message.senderDeviceId);
        const publicJwk = this.crypto.parsePublicJwk(device?.keyBundle?.identityKey);
        if (!directory || !device || !publicJwk) throw Error('El dispositivo de origen ya no está autorizado.');
        if (message.senderUserId !== owner.userId) await this.trust.check(owner.scope, directory, () => { try { owner.assert(); return true; } catch { return false; } });
        await this.pin(engine, { userId: message.senderUserId, deviceId: message.senderDeviceId, publicJwk },
          { userId: message.senderUserId, deviceId: message.senderDeviceId, signalDeviceNumber: 1, identityKey: header.identityKey, registrationId: header.registrationId }, header.binding);
        }
        const envelope = JSON.parse(recipient.ciphertext) as RatchetEnvelope, context = { conversationId: message.conversationId, messageId: await ratchetMessageId(message.clientMessageId) };
        const pending = (await engine.pendingReceived()).find(item => item.context.conversationId === context.conversationId && item.context.messageId === context.messageId && item.peer.name === message.senderDeviceId);
        if (pending) {
          if (pending.envelopeHash !== await ratchetHash(envelope)) throw Error('El mensaje pendiente cambió.');
          payload = pending.payload as ChatPayload; incomingId = pending.id;
        } else {
          payload = await engine.decrypt({ name: message.senderDeviceId, device: 1 }, context, envelope) as ChatPayload;
          incomingId = (await engine.pendingReceived()).find(item => item.context.conversationId === context.conversationId && item.context.messageId === context.messageId && item.peer.name === message.senderDeviceId)?.id;
        }
        if (payload.type !== 'nivra-content-key' || typeof payload['key'] !== 'string' || payload['bodyHash'] !== await ratchetHash([header.payloadIv, header.payloadCiphertext])) throw Error('El cuerpo cifrado no corresponde al mensaje.');
        const raw = ratchetBinary(payload['key'], 32), iv = ratchetBinary(header.payloadIv!, 12), ciphertext = ratchetBinary(header.payloadCiphertext!, 1024 * 1024 + 16);
        if (raw.length !== 32 || iv.length !== 12) throw Error('Llave del mensaje inválida.');
        let plain: Uint8Array | undefined;
        try {
          const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
          plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
          payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
        } finally { raw.fill(0); plain?.fill(0); }
      }
      await this.persistDelivery(message, payload, digest, current); owner.assert();
      if (incomingId) await engine.acknowledgeReceived(incomingId);
      return payload;
    });
  }
  private receiptConversation(id: string): string { return `ratchet-receipt:${id}`; }
  private async persistDelivery(message: MessageResponse, payload: ChatPayload, envelopeHash: string, isCurrent: () => boolean = () => true): Promise<void> {
    const owner = this.owner(), conversationId = this.receiptConversation(message.conversationId);
    await this.history.putMessages(owner.userId, [{ id: message.id, conversationId, clientMessageId: message.clientMessageId, mine: message.senderUserId === owner.userId,
      senderUserId: message.senderUserId, senderDeviceId: message.senderDeviceId, at: message.serverReceivedAt,
      expiresAt: message.expiresAt, deleteAfterRead: message.deleteAfterRead, payload: { type: 'ratchet-delivery', envelopeHash, content: payload } }], isCurrent);
    owner.assert();
    const saved = await this.history.messageById(owner.userId, conversationId, message.id);
    if (saved?.payload['envelopeHash'] !== envelopeHash) throw Error('No se pudo guardar el historial cifrado.');
  }
  forgetConversation(conversationId: string): Promise<void> {
    return this.run(async () => {
      const owner = this.owner();
      if (!await this.history.readRatchetState(owner.userId, owner.deviceId)) return;
      const engine = await this.open(false), state = await this.state(engine);
      const outgoing = Object.entries(state.outgoing).filter(([, pending]) => pending.conversationId === conversationId);
      for (const [id] of outgoing) delete state.outgoing[id];
      await engine.updateApplicationState(state);
      for (const [id] of outgoing) await engine.releaseOutgoing(conversationId, await ratchetMessageId(id));
      for (const pending of await engine.pendingReceived()) if (pending.context.conversationId === conversationId) await engine.acknowledgeReceived(pending.id);
    });
  }
}
