import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { BroadcastListVm, BroadcastService } from './broadcast.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

describe('encrypted broadcast lists and individual delivery', () => {
  const ownerId = 'broadcast-test-owner';
  const targets = ['broadcast-test-peer-first', 'broadcast-test-peer-second'];
  let service: BroadcastService;
  let session: ReturnType<typeof signal<any>>;
  let cryptography: any;
  let api: { get: jasmine.Spy; post: jasmine.Spy; put: jasmine.Spy; delete: jasmine.Spy };
  let chat: { conversationForBroadcast: jasmine.Spy; sendPayload: jasmine.Spy };
  let records: any[];
  let keys: any[];
  let events: Subject<any>;

  beforeEach(async () => {
    localStorage.removeItem('nivra.broadcasts.v1.' + ownerId);
    records = [];
    cryptography = Object.create(CryptoService.prototype);
    cryptography.yieldToMainThread = async () => undefined;
    keys = await Promise.all(['phone', 'browser'].map(async deviceId => ({
      ...await cryptography.createDeviceKeys(), id: deviceId, userId: ownerId, alias: 'owner', deviceId,
    })));
    cryptography.currentKeyMaterial = async () => keys[0];
    cryptography.exportDeviceKeyMaterialsForUser = async () => keys;
    session = signal<any>({ user: { id: ownerId, alias: 'owner' }, device: { id: 'phone' } });
    api = {
      get: jasmine.createSpy('get').and.callFake((path: string) => path === '/contacts'
        ? of(targets.map(userId => ({ userId }))) : of({ lists: records.map(item => ({ ...item })) })),
      post: jasmine.createSpy('post').and.callFake(() => of([{ userId: ownerId, devices: keys.map(key => ({ deviceId: key.deviceId, keyBundle: key.keyBundle })) }])),
      put: jasmine.createSpy('put').and.callFake((path: string, body: any) => {
        const id = path.split('/').pop();
        const previous = records.find(record => record.id === id);
        if (body.expectedRevision !== (previous?.revision ?? 0)) return throwError(() => ({ status: 409 }));
        const now = new Date().toISOString();
        const record = { id, encryptedPayload: body.encryptedPayload, recipientCount: body.recipientCount,
          revision: body.expectedRevision + 1, createdAt: now, updatedAt: now };
        records = [record, ...records.filter(item => item.id !== id)];
        return of(record);
      }),
      delete: jasmine.createSpy('delete').and.returnValue(of(null)),
    };
    chat = {
      conversationForBroadcast: jasmine.createSpy('conversationForBroadcast').and.callFake(async (userId: string) => ({ id: `direct-${userId}`, type: 'Direct', participants: [{ userId: ownerId }, { userId }] })),
      sendPayload: jasmine.createSpy('sendPayload').and.callFake(async () => ({ id: crypto.randomUUID() })),
    };
    events = new Subject();
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session, ensureDeviceIdentity: async () => ({ userId: ownerId, deviceId: 'phone' }) } },
      { provide: CryptoService, useValue: cryptography }, { provide: NivraApiService, useValue: api },
      { provide: ChatService, useValue: chat }, { provide: SignalrService, useValue: { events$: events } },
    ] });
    service = TestBed.inject(BroadcastService);
    TestBed.flushEffects();
  });
  afterEach(() => localStorage.removeItem('nivra.broadcasts.v1.' + ownerId));

  async function list(): Promise<BroadcastListVm> { return service.save('Mi equipo secreto', targets); }

  it('encrypts the name and recipient membership for every own device using actual WebCrypto', async () => {
    const saved = await list();
    const wire = api.put.calls.mostRecent().args[1];
    expect(wire.encryptedPayload).not.toContain('Mi equipo secreto');
    targets.forEach(target => expect(wire.encryptedPayload).not.toContain(target));
    const envelope = JSON.parse(wire.encryptedPayload);
    expect(envelope.recipients.length).toBe(2);
    for (const key of keys) {
      const sealed = envelope.recipients.find((item: any) => item.deviceId === key.deviceId);
      const decoded = await cryptography.decryptEnvelope(key, sealed.header, sealed.ciphertext);
      expect(decoded.id).toBe(saved.id);
      expect(decoded.ownerUserId).toBe(ownerId);
      expect(decoded.recipientUserIds).toEqual(targets);
    }
    const stranger = { ...await cryptography.createDeviceKeys(), userId: 'stranger', deviceId: 'other' };
    await expectAsync(cryptography.decryptEnvelope(stranger, envelope.recipients[0].header, envelope.recipients[0].ciphertext)).toBeRejected();
    expect(localStorage.getItem('nivra.broadcasts.v1.' + ownerId)).not.toContain('Mi equipo secreto');
  });

  it('recovers a synchronized list using an approved historical owner key', async () => {
    const saved = await list();
    session.set({ user: { id: ownerId, alias: 'owner' }, device: { id: 'newly-linked' } });
    TestBed.flushEffects();
    await service.load();
    expect(service.lists()[0].id).toBe(saved.id);
    expect(service.lists()[0].name).toBe('Mi equipo secreto');
    expect(service.lists()[0].locked).toBeFalse();
  });

  it('keeps an explicit locked row when no approved key is available, without treating ciphertext as a name', async () => {
    await list();
    cryptography.exportDeviceKeyMaterialsForUser = async () => [];
    await service.load();
    expect(service.lists()[0].locked).toBeTrue();
    expect(service.lists()[0].recipientUserIds).toEqual([]);
    await expectAsync(service.sendText(service.lists()[0], 'Hola')).toBeRejected();
    expect(chat.sendPayload).not.toHaveBeenCalled();
  });

  it('rejects ciphertext copied to another list ID even when a device could decrypt it', async () => {
    await list();
    records = [{ ...records[0], id: `bcl_${crypto.randomUUID()}` }];
    await service.load();
    expect(service.lists()[0].locked).toBeTrue();
  });

  it('does not send automatically when restoring an interrupted encrypted operation', async () => {
    const saved = await list();
    chat.sendPayload.and.rejectWith(new Error('offline'));
    const dispatched = await service.sendText(saved, 'Un mensaje privado');
    expect(dispatched.results.every(result => result.status === 'failed')).toBeTrue();
    chat.sendPayload.calls.reset();
    await service.load();
    expect(service.lastDispatch()?.operationId).toBe(dispatched.operationId);
    expect(service.lastDispatch()?.text).toBe('Un mensaje privado');
    expect(chat.sendPayload).not.toHaveBeenCalled();
  });

  it('sends separate direct messages and persists a recoverable encrypted operation before delivery', async () => {
    const saved = await list();
    chat.sendPayload.and.callFake(async (_conversation: any, payload: any) => {
      const envelope = JSON.parse(records[0].encryptedPayload);
      const decoded = await cryptography.decryptEnvelope(keys[0], envelope.recipients[0].header, envelope.recipients[0].ciphertext);
      expect(decoded.lastDispatch.text).toBe('Hola equipo');
      expect(decoded.lastDispatch.results.length).toBe(2);
      expect(payload).toEqual({ type: 'text', text: 'Hola equipo' });
      return { id: crypto.randomUUID() };
    });
    const dispatch = await service.sendText(saved, 'Hola equipo');
    expect(dispatch.results.every(result => result.status === 'sent')).toBeTrue();
    expect(chat.sendPayload).toHaveBeenCalledTimes(2);
    for (const call of chat.sendPayload.calls.all()) {
      expect(call.args[0].participants.length).toBe(2);
      expect(call.args[4].clientMessageId).toContain(dispatch.operationId);
    }
    expect(service.progress()).toEqual({ completed: 2, total: 2 });
  });

  it('retries only failed recipients with exactly the same per-recipient idempotency key', async () => {
    const saved = await list();
    let fail = true;
    chat.sendPayload.and.callFake(async (conversation: any) => {
      if (fail && conversation.id.endsWith(targets[1])) throw new Error('offline');
      return { id: 'accepted' };
    });
    const first = await service.sendText(saved, 'Mensaje');
    const originalRetryKey = chat.sendPayload.calls.mostRecent().args[4].clientMessageId;
    expect(first.results.map(result => result.status)).toEqual(['sent', 'failed']);
    fail = false; chat.sendPayload.calls.reset();
    const retried = await service.retryFailed();
    expect(retried?.operationId).toBe(first.operationId);
    expect(chat.sendPayload).toHaveBeenCalledTimes(1);
    expect(chat.sendPayload.calls.mostRecent().args[4].clientMessageId).toBe(originalRetryKey);
  });

  it('does not accept a selected user outside the owner’s saved contacts', async () => {
    await expectAsync(service.save('Lista', ['not-a-contact'])).toBeRejectedWithError(/contactos/);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('honors temporary message expiry without retaining its body or operation in list metadata', async () => {
    const saved = await list();
    await service.sendText(saved, 'Anterior permanente');
    session.update(value => ({ ...value, user: { ...value.user, privacySettings: { defaultMessageTtlSeconds: 3600 } } }));
    chat.sendPayload.calls.reset();
    const started = Date.now();
    const result = await service.sendText(service.lists()[0], 'Temporal confidencial');
    expect(Date.parse(result.expiresAt!)).toBeGreaterThanOrEqual(started + 3_600_000);
    for (const call of chat.sendPayload.calls.all()) expect(call.args[4].expiresAt).toBe(result.expiresAt);
    for (const sealed of JSON.parse(records[0].encryptedPayload).recipients) {
      const key = keys.find(key => key.deviceId === sealed.deviceId);
      const decoded = await cryptography.decryptEnvelope(key, sealed.header, sealed.ciphertext);
      expect(decoded.lastDispatch).toBeUndefined();
      expect(JSON.stringify(decoded)).not.toContain('Temporal confidencial');
    }
    await service.load();
    expect(service.lastDispatch()?.operationId).toBe(result.operationId);
    service.clearEphemeralDispatch();
    await service.load();
    expect(service.lastDispatch()).toBeNull();
  });

  it('keeps the original temporary deadline and stable IDs when retrying a partial send', async () => {
    const saved = await list();
    session.update(value => ({ ...value, user: { ...value.user, privacySettings: { defaultMessageTtlSeconds: 3600 } } }));
    const now = Date.now();
    const clock = spyOn(Date, 'now').and.returnValue(now);
    chat.sendPayload.and.callFake(async (conversation: any) => {
      if (conversation.id.endsWith(targets[1])) throw new Error('offline');
      return { id: 'accepted' };
    });
    const first = await service.sendText(saved, 'Temporal');
    const retryId = chat.sendPayload.calls.mostRecent().args[4].clientMessageId;
    clock.and.returnValue(now + 60_000);
    chat.sendPayload.calls.reset(); chat.sendPayload.and.resolveTo({ id: 'accepted' });
    const retried = await service.retryFailed();
    expect(retried?.expiresAt).toBe(first.expiresAt);
    expect(chat.sendPayload).toHaveBeenCalledTimes(1);
    expect(chat.sendPayload.calls.mostRecent().args[4]).toEqual({ clientMessageId: retryId, expiresAt: first.expiresAt });
  });

  it('refuses expired temporary retries before network or conversation work', async () => {
    const saved = await list();
    session.update(value => ({ ...value, user: { ...value.user, privacySettings: { defaultMessageTtlSeconds: 60 } } }));
    chat.sendPayload.and.rejectWith(new Error('offline'));
    const result = await service.sendText(saved, 'Temporal');
    spyOn(Date, 'now').and.returnValue(Date.parse(result.expiresAt!) + 1);
    api.get.calls.reset(); chat.conversationForBroadcast.calls.reset(); chat.sendPayload.calls.reset();
    await expectAsync(service.retryFailed()).toBeRejectedWithError(/venció/);
    expect(api.get).not.toHaveBeenCalled();
    expect(chat.conversationForBroadcast).not.toHaveBeenCalled();
    expect(chat.sendPayload).not.toHaveBeenCalled();
  });

  it('cancels a stale save before writing or exposing data in another account', async () => {
    const delayed = new Subject();
    api.post.and.returnValue(delayed);
    const pending = service.save('Lista A', targets);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    session.set({ user: { id: 'second-account', alias: 'second' }, device: { id: 'other' } });
    TestBed.flushEffects();
    delayed.next([]);
    await expectAsync(pending).toBeRejected();
    expect(api.put).not.toHaveBeenCalled();
    expect(service.lists()).toEqual([]);
    expect(service.saving()).toBeFalse();
  });

  it('replaces omitted rows instead of reviving a deleted list from cache', async () => {
    await list(); records = [];
    await service.load();
    expect(service.lists()).toEqual([]);
  });
});
