import { signal } from '@angular/core';
import { ChatService } from './chat.service';

describe('chat history recovery and loading continuity', () => {
  const session = (id = 'alice') => ({ user: { id, alias: id }, device: { id: `${id}-browser` } });
  const message = (id = 'old', conversationId = 'chat') => ({ id, conversationId,
    at: '2026-10-01T12:00:00Z', payload: { type: 'text', text: 'Recovered text' }, decryptError: false });
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => resolve = done);
    return { promise, resolve };
  }
  function harness() {
    const service: any = Object.assign(Object.create(ChatService.prototype), {
      auth: { session: signal<any>(session()) }, loading: signal(false),
      messageLoadGeneration: 0, messageLoadCounts: signal({}), historyRecoveryRevision: 0,
      historyRecoveryInFlight: null, historyRecoveryScope: null, bootstrapInFlight: null,
      selectedConversationId: signal<string | null>('chat'), selectedConversationLoadId: 0,
      messagesByConversation: signal<any>({}), pendingHistoryEnvelopes: new Map(),
      deviceHistory: { markHistoryReadable: jasmine.createSpy('readable'),
        markHistoryRecoveryIncomplete: jasmine.createSpy('incomplete') },
      bootstrap: jasmine.createSpy('bootstrap').and.resolveTo(),
      loadMessages: jasmine.createSpy('loadMessages').and.resolveTo(),
      ingestMessageBatch: jasmine.createSpy('ingest').and.callFake(async () => service.pendingHistoryEnvelopes.clear()),
      applyPendingReactions: (value: unknown) => value,
      persistLocalMessage: jasmine.createSpy('persist'), touchConversationFromMessage: jasmine.createSpy('touch'),
      scheduleMessageExpiry: jasmine.createSpy('expiry'),
    });
    return service;
  }

  it('never replaces a readable message with a delayed failed decryption', () => {
    const service = harness(); const readable = message();
    service.messagesByConversation.set({ chat: [readable] });
    service.pendingHistoryEnvelopes.set(readable.id, {});
    service.upsertMessage({ ...readable, decryptError: true, payload: { type: 'system', text: 'Pending' } });
    expect(service.messagesByConversation().chat[0]).toBe(readable);
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
    expect(service.persistLocalMessage).not.toHaveBeenCalled();
  });

  it('does not let an old cache read undo a current message edit', () => {
    const service = harness(); const current = message();
    service.messagesByConversation.set({ chat: [current] });
    service.upsertMessage({ ...current, payload: { type: 'text', text: 'Older cached text' } }, { persist: false });
    expect(service.messagesByConversation().chat[0]).toBe(current);
    service.upsertMessage(message('other'), { persist: false });
    expect(service.messagesByConversation().chat.length).toBe(2);
  });

  it('accepts a now-readable local copy after the local vault recovers', () => {
    const service = harness(); const readable = message();
    service.messagesByConversation.set({ chat: [{ ...readable, decryptError: true,
      payload: { type: 'system', text: 'Local history pending' } }] });
    service.upsertMessage(readable, { persist: false });
    expect(service.messagesByConversation().chat[0]).toBe(readable);
    expect(service.persistLocalMessage).not.toHaveBeenCalled();
  });

  it('waits for an older bootstrap then replays all envelopes and affected conversations', async () => {
    const service = harness(); const initial = deferred();
    service.bootstrapInFlight = initial.promise;
    service.pendingHistoryEnvelopes.set('one', { id: 'one', conversationId: 'first' });
    const recovery = service.retryRecoveredHistory();
    expect(service.ingestMessageBatch).not.toHaveBeenCalled();
    service.pendingHistoryEnvelopes.set('two', { id: 'two', conversationId: 'second' });
    initial.resolve(); await recovery;
    expect(service.ingestMessageBatch.calls.first().args[0].map((item: any) => item.id)).toEqual(['one', 'two']);
    expect(service.loadMessages.calls.allArgs().flat().sort()).toEqual(['chat', 'first', 'second']);
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  });

  it('keeps history pending when a page refresh fails instead of reporting successful synchronization', async () => {
    const service = harness(); service.loadMessages.and.rejectWith(new Error('Offline'));
    await expectAsync(service.retryRecoveredHistory()).toBeResolved();
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a readable global bootstrap while another cached conversation is still protected', async () => {
    const service = harness();
    service.messagesByConversation.set({ older: [{ ...message('old', 'older'), decryptError: true }] });
    await service.retryRecoveredHistory();
    expect(service.loadMessages).toHaveBeenCalledWith('older');
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).toHaveBeenCalled();
  });

  it('queues another imported keyring during recovery and acknowledges only the final pass', async () => {
    const service = harness(); const first = deferred();
    service.bootstrap.and.returnValues(first.promise, Promise.resolve());
    const recovery = service.retryRecoveredHistory();
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(service.retryRecoveredHistory()).toBe(recovery);
    first.resolve(); await recovery;
    expect(service.bootstrap).toHaveBeenCalledTimes(2);
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  });

  it('cannot acknowledge or load pages for an account switched during recovery', async () => {
    const service = harness(); const initial = deferred();
    service.bootstrapInFlight = initial.promise;
    const recovery = service.retryRecoveredHistory();
    service.auth.session.set(session('bob'));
    initial.resolve(); await recovery;
    expect(service.ingestMessageBatch).not.toHaveBeenCalled();
    expect(service.loadMessages).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).not.toHaveBeenCalled();
  });

  it('keeps overlapping loads busy until both finish, including failure cleanup', async () => {
    const service = harness(); const first = deferred(); const second = deferred();
    const one = service.withMessageLoading('chat', () => first.promise);
    const two = service.withMessageLoading('chat', () => second.promise);
    expect(service.messageLoadCounts().chat).toBe(2);
    first.resolve(); await one;
    expect(service.messageLoadCounts().chat).toBe(1);
    second.resolve(); await two;
    expect(service.messageLoadCounts()).toEqual({});
    await expectAsync(service.withMessageLoading('chat', async () => { throw new Error('Offline'); })).toBeRejected();
    expect(service.messageLoadCounts()).toEqual({});
  });

  it('cannot clear a new session loading indicator when an old session operation finishes', async () => {
    const service = harness(); const old = deferred(); const fresh = deferred();
    const one = service.withMessageLoading('chat', () => old.promise);
    service.messageLoadGeneration += 1; service.messageLoadCounts.set({});
    const two = service.withMessageLoading('chat', () => fresh.promise);
    old.resolve(); await one;
    expect(service.messageLoadCounts().chat).toBe(1);
    fresh.resolve(); await two;
    expect(service.messageLoadCounts()).toEqual({});
  });

  it('opens cached and remote messages even while realtime connection is stalled', async () => {
    const service = harness(); const remote = deferred<any[]>();
    service.signalr = { joinConversation: () => new Promise<void>(() => {}) };
    service.persistSelectedConversationId = () => undefined;
    service.loadCachedMessages = jasmine.createSpy('cache').and.resolveTo([]);
    service.markConversationRead = async () => undefined;
    service.loadRemoteMessagesPage = jasmine.createSpy('remote').and.returnValue(remote.promise);
    service.loadMessages = ChatService.prototype.loadMessages.bind(service);
    service.rememberOpenScrollAnchor = () => undefined;
    service.refreshPresenceForConversations = async () => undefined;
    const selecting = service.selectConversation('chat');
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(service.loadCachedMessages).toHaveBeenCalledWith('chat');
    expect(service.loadRemoteMessagesPage).toHaveBeenCalledWith('chat');
    expect(service.messageLoadCounts().chat).toBeGreaterThan(0);
    remote.resolve([]); await selecting;
    expect(service.messageLoadCounts()).toEqual({});
  });

  it('does not mark protected unreadable messages as read while the history is pending', async () => {
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    const service = harness();
    service.readReceiptSentIds = new Set();
    service.messagesByConversation.set({ chat: [
      { ...message('protected'), mine: false, decryptError: true, receipts: [] },
      { ...message('readable'), mine: false, receipts: [] },
    ] });
    service.signalr = { syncReadReceipts: jasmine.createSpy('readSync').and.resolveTo() };
    service.applyOptimisticReadState = jasmine.createSpy('optimistic');
    service.sendReceipt = jasmine.createSpy('receipt').and.resolveTo();
    await service.markConversationRead('chat');
    expect(service.signalr.syncReadReceipts.calls.first().args[1]).toEqual(['readable']);
    expect(service.sendReceipt).toHaveBeenCalledOnceWith('readable', 'Read');
  });
});
