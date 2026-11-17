import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { LocalHistoryService } from './local-history.service';
import { TextOutboxService } from './text-outbox.service';
import { NetworkPolicyService } from './network-policy.service';

describe('durable text outbox', () => {
  let disk: Map<string, any>, session: ReturnType<typeof signal<any>>, locked: ReturnType<typeof signal<boolean>>;
  let generation: ReturnType<typeof signal<number>>;
  let online:jasmine.Spy;
  const key = (scope: string, id: string) => scope + '/' + id;
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  function open() {
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session, sessionGeneration: generation } },
      { provide: AppLockService, useValue: { isContentLocked: locked } },
      { provide: LocalHistoryService, useValue: {
        outboxMessages: async (scope: string) => [...disk].filter(([id]) => id.startsWith(scope + '/')).map(([, row]) => structuredClone(row)),
        putMessages: async (scope: string, rows: any[]) => rows.forEach(row => disk.set(key(scope, row.id), structuredClone(row))),
        messageById: async (scope: string, _chat: string, id: string) => structuredClone(disk.get(key(scope, id))),
        removeMessage: async (scope: string, _chat: string, id: string) => { disk.delete(key(scope, id)); },
        removeConversationMessages: async (scope: string, chat: string) => {
          for (const [id, row] of disk) if (id.startsWith(scope + '/') && row.conversationId === chat) disk.delete(id);
        },
      } },
    ] });
    const service = TestBed.inject(TextOutboxService); TestBed.flushEffects(); return service;
  }
  beforeEach(() => {
    disk = new Map(); session = signal<any>({ user: { id: 'alice' }, device: { id: 'phone' } }); locked = signal(false);
    generation = signal(1);
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    online=spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
  });
  afterEach(() => TestBed.resetTestingModule());

  it('keeps a future text durable without blocking an immediate text in the same chat', async () => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    const service = open(), send = jasmine.createSpy().and.resolveTo({});
    service.configure(send, () => true); await settle();
    const scheduled = await service.enqueue({ id: 'chat' } as any, 'Después', { ttlSeconds: 3600 }, now + 60000);
    expect(scheduled.expiresAt).toBeNull();
    await service.enqueue({ id: 'chat' } as any, 'Ahora'); await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.calls.first().args[0].payload.text).toBe('Ahora');
    expect(service.entries().map(row => row.id)).toEqual([scheduled.id]);
    now += 61000; service.wake(); await settle();
    expect(send.calls.mostRecent().args[0].clientMessageId).toBe(scheduled.clientMessageId);
    expect(service.entries()).toEqual([]);
  });

  it('starts scheduled expiry only when encryption is ready and freezes it across HTTP retries and restart', async () => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    let service = open();
    const send = jasmine.createSpy().and.rejectWith({ retryable: true, code: 'recipient_keys_unavailable' });
    service.configure(send, () => true); await settle();
    const scheduled = await service.enqueue({ id: 'chat' } as any, 'Texto temporal', { ttlSeconds: 3600, deleteAfterRead: true }, now + 60000);
    now += 61000; service.wake(); await settle();
    expect(service.entries()[0].expiresAt).toBeNull();
    expect(service.entries()[0].scheduleStartedAt).toBeUndefined();
    now += 10000;
    send.and.callFake(async (entry: any) => { await service.startScheduledDelivery(entry.id); throw { status: 503 }; });
    service.wake(); await settle();
    const expiry = service.entries()[0].expiresAt ?? null;
    expect(expiry).toBe(new Date(now + 3600000).toISOString());
    expect(service.entries()[0].deleteAfterRead).toBeTrue();
    TestBed.resetTestingModule(); service = open(); await settle();
    now += 10000;
    send.and.callFake(async (entry: any) => { expect(await service.startScheduledDelivery(entry.id)).toBe(expiry); return {}; });
    service.configure(send, () => true); await settle();
    expect(send.calls.mostRecent().args[0].clientMessageId).toBe(scheduled.clientMessageId);
    expect(service.entries()).toEqual([]);
  });

  it('restores an overdue scheduled text after restart and lets the owner cancel it before sending', async () => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    let service = open(); service.configure(jasmine.createSpy(), () => true); await settle();
    const scheduled = await service.enqueue({ id: 'chat' } as any, 'No enviar', {}, now + 60000);
    TestBed.resetTestingModule(); now += 3600000; service = open(); await settle();
    expect(service.entries()[0].clientMessageId).toBe(scheduled.clientMessageId);
    await service.discard(scheduled.id);
    const send = jasmine.createSpy().and.resolveTo({}); service.configure(send, () => true); await settle();
    expect(send).not.toHaveBeenCalled(); expect(disk.size).toBe(0);
  });

  it('does not run due schedules while locked, denied, or switched into another account', async () => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    const service = open(), send = jasmine.createSpy().and.resolveTo({}); let allowed = true;
    service.configure(send, () => allowed); await settle();
    await service.enqueue({ id: 'chat' } as any, 'Solo su cuenta', {}, now + 60000);
    now += 61000; locked.set(true); service.wake(); await settle(); expect(send).not.toHaveBeenCalled();
    locked.set(false); allowed = false; service.wake(); await settle(); expect(send).not.toHaveBeenCalled();
    session.set({ user: { id: 'bob' }, device: { id: 'phone' } }); generation.update(value => value + 1); TestBed.flushEffects();
    allowed = true; service.wake(); await settle(); expect(send).not.toHaveBeenCalled(); expect(disk.size).toBe(1);
  });

  it('rejects modified scheduled metadata instead of sending early after restart', async () => {
    const now = Date.now(); let service = open(); service.configure(jasmine.createSpy(), () => true); await settle();
    await service.enqueue({ id: 'chat' } as any, 'Original', {}, now + 3600000);
    for (const row of disk.values()) row.scheduledFor = new Date(now + 60000).toISOString();
    TestBed.resetTestingModule(); service = open(); await settle();
    expect(service.storageError()).not.toBe(''); expect(service.entries()).toEqual([]); expect(disk.size).toBe(1);
  });

  it('rejects invalid schedule windows without touching the durable queue or preparing a ratchet', async () => {
    const service = open(); service.configure(jasmine.createSpy(), () => true); await settle();
    await expectAsync(service.enqueue({ id: 'chat' } as any, 'Pasado', {}, Date.now() - 1000)).toBeRejected();
    await expectAsync(service.enqueue({ id: 'chat' } as any, 'Demasiado lejos', {}, Date.now() + 31 * 86400000)).toBeRejected();
    expect(service.entries()).toEqual([]); expect(disk.size).toBe(0);
  });

  it('explains unavailable recipient keys and retries with the same message identity', async () => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    const service = open();
    const send = jasmine.createSpy().and.rejectWith({ retryable: true, code: 'recipient_keys_unavailable' });
    service.configure(send, () => true); await settle();
    const entry = await service.enqueue({ id: 'chat' } as any, 'Conservar'); await settle();
    expect(service.entries()[0].blocked).toBeFalse();
    expect(service.failureMessage(entry)).toContain('contacto abra o actualice');
    send.and.resolveTo({}); now += 3000; service.wake(); await settle();
    expect(send.calls.mostRecent().args[0].clientMessageId).toBe(entry.clientMessageId);
    expect(service.entries()).toEqual([]);
  });

  it('rechecks legacy unknown failures once while leaving denied sends blocked after restart', async () => {
    let service = open(); const send = jasmine.createSpy().and.rejectWith(new Error('Old key lookup failure'));
    service.configure(send, () => true); await settle();
    const first = await service.enqueue({ id: 'chat' } as any, 'Anterior'); await settle();
    send.and.rejectWith({ status: 403 });
    const denied = await service.enqueue({ id: 'denied' } as any, 'Sin permiso'); await settle();
    for (const row of disk.values()) { delete row.lastFailure; delete row.failureSchema; }
    TestBed.resetTestingModule(); service = open(); await settle();
    expect(service.entries().find(row => row.id === first.id)?.blocked).toBeFalse();
    expect(service.entries().find(row => row.id === denied.id)?.blocked).toBeTrue();
    send.and.rejectWith(new Error('Still invalid'));
    service.configure(send, () => true); await settle();
    expect(service.entries().find(row => row.id === first.id)?.blocked).toBeTrue();
    TestBed.resetTestingModule(); service = open(); await settle();
    expect(service.entries().find(row => row.id === first.id)?.blocked).toBeTrue();
    expect(service.entries().find(row => row.id === first.id)?.clientMessageId).toBe(first.clientMessageId);
  });

  it('distinguishes local conversation preparation from a server rejection and preserves the queued text', async () => {
    const service=open();const send=jasmine.createSpy().and.rejectWith({retryable:true,code:'ratchet_preparing'});
    service.configure(send,()=>true);await settle();
    const entry=await service.enqueue({id:'chat'} as any,'Keep the text');await settle();
    expect(service.entries()[0].blocked).toBeFalse();
    expect(service.entries()[0].lastFailure).toBe('encryption');
    expect(service.failureMessage(entry)).toContain('Preparando la conversación');
    expect(service.failureMessage(entry)).not.toContain('servidor');
    expect(service.entries()[0].payload.text).toBe('Keep the text');
  });

  it('automatically rechecks an unknown preparation failure saved by version9.3.1 only once', async () => {
    let service=open();const send=jasmine.createSpy().and.rejectWith(new Error('An old stale proof'));
    service.configure(send,()=>true);await settle();
    const entry=await service.enqueue({id:'chat'} as any,'Retain the original text');await settle();
    for(const row of disk.values())delete row.failureSchema;
    TestBed.resetTestingModule();service=open();await settle();
    expect(service.entries()[0].blocked).toBeFalse();
    service.configure(send,()=>true);await settle();
    expect(service.entries()[0].blocked).toBeTrue();
    TestBed.resetTestingModule();service=open();await settle();
    expect(service.entries()[0].blocked).toBeTrue();
    expect(service.entries()[0].clientMessageId).toBe(entry.clientMessageId);
  });

  it('does not let an old session failure block the restored queue after signing into the same account again', async () => {
    const service=open();let fail!:(error:unknown)=>void;
    const send=jasmine.createSpy().and.returnValue(new Promise((_resolve,reject)=>fail=reject));
    service.configure(send,()=>true);await settle();
    const entry=await service.enqueue({id:'chat'} as any,'Same durable identity');
    generation.update(value=>value+2);TestBed.flushEffects();await settle();
    send.and.resolveTo({});fail(new Error('ACCOUNT_SESSION_CHANGED'));await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.calls.mostRecent().args[0].clientMessageId).toBe(entry.clientMessageId);
    expect(service.entries()).toEqual([]);
  });

  it('explains rate limiting and keeps the original server wait rather than waking on online hints', async () => {
    const service = open();
    const send = jasmine.createSpy().and.rejectWith({ status: 429, headers: { get: () => '120' } });
    service.configure(send, () => true); await settle();
    const entry = await service.enqueue({ id: 'chat' } as any, 'Esperar'); await settle();
    expect(service.failureMessage(entry)).toContain('pidió esperar');
    window.dispatchEvent(new Event('online')); await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('limits simultaneous chats and continues queued conversations as bandwidth becomes available', async () => {
    const service = open();
    const network = TestBed.inject(NetworkPolicyService);
    spyOn(network, 'deliveryConcurrency').and.returnValue(1);
    const completions: Array<() => void> = [];
    const send = jasmine.createSpy().and.callFake(() => new Promise<void>(resolve => completions.push(resolve)));
    service.configure(send, () => true); await settle();
    for (const id of ['a', 'b', 'c']) await service.enqueue({ id } as any, 'Pendiente');
    expect(send).toHaveBeenCalledTimes(1); expect(disk.size).toBe(3);
    completions[0](); await settle();
    expect(send).toHaveBeenCalledTimes(2); expect(send.calls.mostRecent().args[0].conversationId).toBe('b');
    completions[1](); await settle(); completions[2](); await settle();
    expect(disk.size).toBe(0);
  });

  it('respects server throttling when a mobile network reports online repeatedly', async () => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    const service = open();
    const send = jasmine.createSpy().and.rejectWith({ status: 429, headers: { get: () => '120' } });
    service.configure(send, () => true); await settle();
    const entry = await service.enqueue({ id: 'a' } as any, 'Conservar'); await settle();
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('online'));
    await settle(); expect(send).toHaveBeenCalledTimes(1); expect(disk.size).toBe(1);
    send.and.resolveTo({}); now += 120001; service.wake(); await settle();
    expect(send.calls.mostRecent().args[0].clientMessageId).toBe(entry.clientMessageId);
    expect(disk.size).toBe(0);
  });

  it('does not start another queued message when an in-flight request finishes after service destruction', async () => {
    const service = open(); let finish!: () => void;
    const send = jasmine.createSpy().and.returnValue(new Promise<void>(resolve => finish = resolve));
    service.configure(send, () => true); await settle();
    await service.enqueue({ id: 'chat' } as any, 'Uno'); await service.enqueue({ id: 'chat' } as any, 'Dos');
    TestBed.resetTestingModule(); finish(); await settle();
    expect(send).toHaveBeenCalledTimes(1); expect(disk.size).toBe(1);
  });

  it('accepts multiple durable messages while one request remains pending and sends in order', async () => {
    const service = open(); const completions: Array<(value: unknown) => void> = [];
    const send = jasmine.createSpy().and.callFake(() => new Promise(resolve => completions.push(resolve)));
    service.configure(send, () => true); await settle();
    const first = await service.enqueue({ id: 'chat' } as any, 'Uno');
    const second = await service.enqueue({ id: 'chat' } as any, 'Dos');
    expect(service.entries().map(row => row.payload.text)).toEqual(['Uno', 'Dos']);
    expect(disk.size).toBe(2); expect(send).toHaveBeenCalledTimes(1);
    completions[0]({}); await settle();
    expect(send).toHaveBeenCalledTimes(2); expect(send.calls.mostRecent().args[0].clientMessageId).toBe(second.clientMessageId);
    expect(first.clientMessageId).not.toBe(second.clientMessageId);
    completions[1]({}); await settle(); expect(service.entries()).toEqual([]); expect(disk.size).toBe(0);
  });
  it('restores queued order and stable identities after service restart, without extending expiry', async () => {
    let service = open(); service.configure(() => new Promise(() => undefined), () => true,
      entry => { entry.payload.forwardingAllowed = false; }); await settle();
    const first = await service.enqueue({ id: 'chat' } as any, 'Uno', { ttlSeconds: 3600, replyTo: { messageId: 'reply' } });
    const second = await service.enqueue({ id: 'chat' } as any, 'Dos');
    TestBed.resetTestingModule(); service = open(); await settle();
    expect(service.entries().map(row => row.clientMessageId)).toEqual([first.clientMessageId, second.clientMessageId]);
    expect(service.entries()[0].expiresAt).toBe(first.expiresAt);
    expect(service.entries()[0].payload.replyTo).toEqual({ messageId: 'reply' });
    expect(service.entries()[0].payload.forwardingAllowed).toBeFalse();
  });
  it('automatically retries transient failures using the original message identity', async () => {
    let now = Date.now(); spyOn(Date, 'now').and.callFake(() => now);
    const service = open(); const send = jasmine.createSpy().and.rejectWith({ status: 503 });
    service.configure(send, () => true); await settle();
    const first = await service.enqueue({ id: 'chat' } as any, 'Persistente'); await settle();
    expect(service.entries()[0].attempts).toBe(1); expect(service.entries()[0].blocked).toBeFalse();
    send.and.resolveTo({}); now += 3000; service.wake(); await settle();
    expect(send.calls.mostRecent().args[0].clientMessageId).toBe(first.clientMessageId);
    expect(service.entries()).toEqual([]);
  });
  it('resumes temporary authentication/network failures immediately when connectivity returns', async () => {
    const service = open(); const send = jasmine.createSpy().and.rejectWith({ retryable: true });
    service.configure(send, () => true); await settle();
    const entry = await service.enqueue({ id: 'chat' } as any, 'Recuperable'); await settle();
    expect(service.entries()[0].blocked).toBeFalse();
    send.and.resolveTo({}); window.dispatchEvent(new Event('online')); await settle();
    expect(send.calls.mostRecent().args[0].clientMessageId).toBe(entry.clientMessageId);
    expect(service.entries()).toEqual([]);
  });
  it('keeps permanent failures for explicit retry and still accepts more text or another chat', async () => {
    const service = open(); const send = jasmine.createSpy().and.rejectWith({ status: 403 });
    service.configure(send, () => true); await settle();
    const first = await service.enqueue({ id: 'chat' } as any, 'Primero'); await settle();
    expect(service.entries()[0].blocked).toBeTrue();
    await service.enqueue({ id: 'chat' } as any, 'Siguiente');
    expect(service.entries().length).toBe(2); expect(send).toHaveBeenCalledTimes(1);
    send.and.resolveTo({}); await service.retry(first.id); await settle();
    expect(service.entries()).toEqual([]);
  });
  it('does not transmit while the app is locked and isolates account changes', async () => {
    const service = open(); const send = jasmine.createSpy().and.resolveTo({});
    service.configure(send, () => !locked()); await settle();
    locked.set(true); await expectAsync(service.enqueue({ id: 'chat' } as any, 'Bloqueado')).toBeRejected();
    locked.set(false); service.configure(() => new Promise(() => undefined), () => true);
    await service.enqueue({ id: 'chat' } as any, 'Cuenta A');
    session.set({ user: { id: 'bob' }, device: { id: 'phone-b' } }); TestBed.flushEffects(); await settle();
    expect(service.entries()).toEqual([]); expect(disk.size).toBe(1);
  });
  it('never reports local acceptance if storage silently failed to save the text', async () => {
    const service = open(); service.configure(() => new Promise(() => undefined), () => true); await settle();
    const history = TestBed.inject(LocalHistoryService); spyOn(history, 'putMessages').and.resolveTo();
    await expectAsync(service.enqueue({ id: 'chat' } as any, 'No perder')).toBeRejected();
    expect(service.entries()).toEqual([]);
  });
  it('rejects moved routing metadata instead of sending a stored message to another chat', async () => {
    let service = open(); service.configure(() => new Promise(() => undefined), () => true); await settle();
    await service.enqueue({ id: 'chat' } as any, 'Original');
    for (const row of disk.values()) row.conversationId = 'different-chat';
    TestBed.resetTestingModule(); service = open(); await settle();
    expect(service.storageError()).not.toBe(''); expect(service.entries()).toEqual([]); expect(disk.size).toBe(1);
  });
  it('waits for the active attempt before clearing and never sends the next queued message', async () => {
    const service = open(); let finish!: () => void;
    const send = jasmine.createSpy().and.returnValue(new Promise<void>(resolve => finish = resolve));
    service.configure(send, () => true); await settle();
    await service.enqueue({ id: 'chat' } as any, 'Uno'); await service.enqueue({ id: 'chat' } as any, 'Dos');
    const paused = service.pauseConversation('chat');
    await expectAsync(service.enqueue({ id: 'chat' } as any, 'Tres')).toBeRejected();
    finish(); const resume = await paused; await settle();
    expect(send).toHaveBeenCalledTimes(1); expect(service.entries()).toEqual([]); expect(disk.size).toBe(0); resume();
  });
  it('reconciles a realtime acknowledgement without retrying or deleting a different queued message', async () => {
    const service = open(); service.configure(() => new Promise(() => undefined), () => true); await settle();
    const first = await service.enqueue({ id: 'chat' } as any, 'Uno');
    const second = await service.enqueue({ id: 'chat' } as any, 'Dos');
    service.reconcile([{ ...first, id: 'server', status: 'enviado' }]); await settle();
    expect(service.entries().map(row => row.id)).toEqual([second.id]); expect(disk.size).toBe(1);
  });
  it('durably retains cancellation if ratchet cleanup fails and never sends it after restarting',async()=>{
    let service=open();const send=jasmine.createSpy().and.resolveTo({}),abandon=jasmine.createSpy().and.rejectWith(Error('disk unavailable'));
    online.and.returnValue(false);service.configure(send,()=>true,undefined,abandon);await settle();
    const entry=await service.enqueue({id:'chat'} as any,'Cancelar',{},Date.now()+60000);
    await expectAsync(service.discard(entry.id)).toBeRejected();
    expect(service.entries()[0].abandoning).toBeTrue();expect(disk.size).toBe(1);expect(send).not.toHaveBeenCalled();
    TestBed.resetTestingModule();service=open();abandon.and.resolveTo();service.configure(send,()=>true,undefined,abandon);await settle();online.and.returnValue(true);service.wake();await settle();
    expect(service.entries()).toEqual([]);expect(disk.size).toBe(0);expect(send).not.toHaveBeenCalled();expect(abandon).toHaveBeenCalledTimes(2);
  });
  it('retires expired encrypted retries before removing the local entry and preserves another queued chat',async()=>{
    let now=Date.now();spyOn(Date,'now').and.callFake(()=>now);
    const service=open(),send=jasmine.createSpy().and.resolveTo({}),abandon=jasmine.createSpy().and.resolveTo();
    online.and.returnValue(false);service.configure(send,()=>true,undefined,abandon);await settle();
    const expired=await service.enqueue({id:'chat'} as any,'Caduca',{ttlSeconds:1});
    const retained=await service.enqueue({id:'other-chat'} as any,'Conservar');now+=2000;
    service.configure(send,()=>false,undefined,abandon);online.and.returnValue(true);service.wake();await settle();
    expect(abandon.calls.mostRecent().args[0].clientMessageId).toBe(expired.clientMessageId);expect(send).not.toHaveBeenCalled();
    expect(service.entries().map(row=>row.id)).toEqual([retained.id]);
  });
});
