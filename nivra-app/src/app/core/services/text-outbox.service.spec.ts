import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { LocalHistoryService } from './local-history.service';
import { TextOutboxService } from './text-outbox.service';

describe('durable text outbox', () => {
  let disk: Map<string, any>, session: ReturnType<typeof signal<any>>, locked: ReturnType<typeof signal<boolean>>;
  const key = (scope: string, id: string) => scope + '/' + id;
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  function open() {
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } },
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
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
  });
  afterEach(() => TestBed.resetTestingModule());

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
});
