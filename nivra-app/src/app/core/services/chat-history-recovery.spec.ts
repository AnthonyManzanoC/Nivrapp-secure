import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
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
      messagesByConversation: signal<any>({}), pendingHistoryEnvelopes: new Map(), removedHistoryMessageIds: new Set(),
      conversationHistoryGenerations: new Map(),
      conversations: signal<any[]>([]), conversationPaging: signal({}),
      deviceHistory: { markHistoryReadable: jasmine.createSpy('readable'),
        markHistoryRecoveryIncomplete: jasmine.createSpy('incomplete'), requestHistory: jasmine.createSpy('requestHistory') },
      api: { post: jasmine.createSpy('post').and.returnValue(of({ messages: [], deletedMessages: [] })) },
      bootstrap: jasmine.createSpy('bootstrap').and.resolveTo(),
      loadMessages: jasmine.createSpy('loadMessages').and.resolveTo(),
      ingestMessageBatch: jasmine.createSpy('ingest').and.callFake(async () => service.pendingHistoryEnvelopes.clear()),
      applyPendingReactions: (value: unknown) => value,
      persistLocalMessage: jasmine.createSpy('persist'), touchConversationFromMessage: jasmine.createSpy('touch'),
      scheduleMessageExpiry: jasmine.createSpy('expiry'),
    });
    return service;
  }
  const envelope = (id: string, conversationId = 'chat', header = 'approved') => ({ id, conversationId,
    senderUserId: 'peer', senderDeviceId: 'peer-phone', serverReceivedAt: '2026-09-01T12:00:00Z', receipts: [],
    recipients: [{ userId: 'alice', deviceId: 'alice-browser', header, ciphertext: `Recovered ${id}` }] });
  function useRealIngestion(service: any) {
    service.ingestMessageBatch = (ChatService.prototype as any).ingestMessageBatch.bind(service);
    service.decryptOwnRecipientPayload = async (_user: string, _alias: string, _device: string, recipients: any[]) => ({ type: 'text', text: recipients[0].ciphertext });
    service.cachedReadableMessage = async () => null;
    service.stripMessagePadding = (payload: unknown) => payload;
    service.viewOnceOpenedReceipt = () => null;
    service.yieldToMainThread = async () => undefined;
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
    service.pendingHistoryEnvelopes.set(readable.id, envelope(readable.id));
    service.upsertMessage(readable, { persist: false });
    expect(service.messagesByConversation().chat[0]).toBe(readable);
    expect(service.persistLocalMessage).not.toHaveBeenCalled();
    expect(service.pendingHistoryEnvelopes.has(readable.id)).toBeFalse();
    expect(service.hasUnreadableHistory()).toBeFalse();
  });

  it('replays known envelopes immediately while an unrelated older bootstrap is stalled', async () => {
    const service = harness(); const initial = deferred();
    service.bootstrapInFlight = initial.promise;
    service.pendingHistoryEnvelopes.set('one', { id: 'one', conversationId: 'first' });
    const recovery = service.retryRecoveredHistory();
    await recovery;
    expect(service.ingestMessageBatch.calls.first().args[0].map((item: any) => item.id)).toEqual(['one']);
    expect(service.bootstrap).not.toHaveBeenCalled();
    expect(service.loadMessages).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
    initial.resolve();
  });

  it('keeps history pending when retrieving an exact protected ID fails', async () => {
    const service = harness(); service.messagesByConversation.set({ chat: [{ ...message(), decryptError: true }] });
    service.api.post.and.returnValue(throwError(() => new Error('Offline')));
    await expectAsync(service.retryRecoveredHistory()).toBeResolved();
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).toHaveBeenCalledTimes(1);
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).toHaveBeenCalledWith({ retryable: true });
  });

  it('does not acknowledge a readable global bootstrap while another cached conversation is still protected', async () => {
    const service = harness();
    service.messagesByConversation.set({ older: [{ ...message('old', 'older'), decryptError: true }] });
    await service.retryRecoveredHistory();
    expect(service.api.post).toHaveBeenCalledWith('/messages/history-recovery', { messageIds: ['old'] });
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).toHaveBeenCalled();
  });

  it('recovers an old cache-only placeholder by its exact ID after recent pages no longer contain its envelope', async () => {
    const service = harness(); useRealIngestion(service);
    const recent = message('recent');
    service.messagesByConversation.set({ chat: [{ ...message('old-cache'), decryptError: true }, recent] });
    service.api.post.and.returnValue(of({ messages: [envelope('old-cache'), envelope('not-requested')], deletedMessages: [] }));
    await service.retryRecoveredHistory();
    expect(service.api.post).toHaveBeenCalledOnceWith('/messages/history-recovery', { messageIds: ['old-cache'] });
    const recovered = service.messagesByConversation().chat.find((item: any) => item.id === 'old-cache');
    expect(recovered.decryptError).toBeFalse(); expect(recovered.payload.text).toBe('Recovered old-cache');
    expect(service.messagesByConversation().chat).toContain(recent);
    expect(service.messagesByConversation().chat.some((item: any) => item.id === 'not-requested')).toBeFalse();
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  });

  it('finishes pending history when a normal HTTP batch resolves the final protected row after reopening', async () => {
    const service = harness(); useRealIngestion(service);
    service.messagesByConversation.set({ chat: [{ ...message('old'), decryptError: true }] });
    service.pendingHistoryEnvelopes.set('old', envelope('old'));
    await service.ingestMessageBatch([envelope('old')], false);
    expect(service.messagesByConversation().chat[0].decryptError).toBeFalse();
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  });

  it('does not declare completion when a normal batch recovers one conversation while another stays protected', async () => {
    const service = harness(); useRealIngestion(service);
    service.messagesByConversation.set({ chat: [{ ...message('old'), decryptError: true }],
      other: [{ ...message('missing', 'other'), decryptError: true }] });
    await service.ingestMessageBatch([envelope('old')], false);
    expect(service.messagesByConversation().chat[0].decryptError).toBeFalse();
    expect(service.messagesByConversation().other[0].decryptError).toBeTrue();
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
  });

  it('releases an exact-ID recovery on timeout and permits a later retry to complete', fakeAsync(() => {
    const service = harness(); useRealIngestion(service);
    service.network = { readTimeoutMs: () => 90_000 };
    service.messagesByConversation.set({ chat: [{ ...message('old'), decryptError: true }] });
    const stalled = new Subject<any>(); service.api.post.and.returnValue(stalled);
    void service.retryRecoveredHistory(); flushMicrotasks();
    expect(service.historyRecoveryInFlight).not.toBeNull();
    tick(45_000); flushMicrotasks();
    expect(service.historyRecoveryInFlight).not.toBeNull(); // Preserve the slow-link policy's budget.
    tick(45_000); flushMicrotasks();
    expect(service.historyRecoveryInFlight).toBeNull();
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).toHaveBeenCalledWith({ retryable: true });
    expect(stalled.observers.length).toBe(0);
    service.api.post.and.returnValue(of({ messages: [envelope('old')], deletedMessages: [] }));
    void service.retryRecoveredHistory(); flushMicrotasks();
    expect(service.historyRecoveryInFlight).toBeNull();
    expect(service.messagesByConversation().chat[0].decryptError).toBeFalse();
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  }));

  it('releases selected-page loading after a stalled read rather than keeping message skeletons forever', fakeAsync(() => {
    const service = harness(); const stalled = new Subject<any>();
    service.api.get = jasmine.createSpy('get').and.returnValue(stalled);
    service.loadMessages = ChatService.prototype.loadMessages.bind(service);
    let failed = false;
    void service.loadMessages('chat').catch(() => failed = true);
    expect(service.messageLoadCounts().chat).toBe(1);
    tick(45_000); flushMicrotasks();
    expect(failed).toBeTrue(); expect(stalled.observers.length).toBe(0);
    expect(service.messageLoadCounts()).toEqual({});
    service.api.get.and.returnValue(of([]));
    void service.loadMessages('chat'); flushMicrotasks();
    expect(service.messageLoadCounts()).toEqual({});
  }));

  it('recovers cached placeholders in chunks of at most 100 without losing any requested ID', async () => {
    const service = harness(); useRealIngestion(service);
    service.messagesByConversation.set({ chat: Array.from({ length: 201 }, (_value, index) => ({ ...message(`old-${index}`), decryptError: true })) });
    service.api.post.and.callFake((_url: string, body: { messageIds: string[] }) => of({ messages: body.messageIds.map(id => envelope(id)), deletedMessages: [] }));
    await service.retryRecoveredHistory();
    const requests = service.api.post.calls.allArgs().map((args: any[]) => args[1].messageIds as string[]);
    expect(requests.map((ids: string[]) => ids.length)).toEqual([100, 100, 1]);
    expect(new Set(requests.flat()).size).toBe(201);
    expect(service.messagesByConversation().chat.every((item: any) => !item.decryptError)).toBeTrue();
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  });

  it('includes unresolved live envelopes and cache-only IDs after replaying the newly approved keyring', async () => {
    const service = harness(); useRealIngestion(service);
    service.decryptOwnRecipientPayload = async (_user: string, _alias: string, _device: string, recipients: any[]) => recipients[0].header === 'approved'
      ? { type: 'text', text: recipients[0].ciphertext } : null;
    service.pendingHistoryEnvelopes.set('live-pending', envelope('live-pending', 'chat', 'old-envelope'));
    service.messagesByConversation.set({ chat: [{ ...message('cache-only'), decryptError: true }] });
    service.api.post.and.callFake((_url: string, body: { messageIds: string[] }) => of({ messages: body.messageIds.map(id => envelope(id)), deletedMessages: [] }));
    await service.retryRecoveredHistory();
    expect(service.api.post.calls.first().args[1].messageIds.sort()).toEqual(['cache-only', 'live-pending']);
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  });

  it('applies confirmed deletion tombstones but keeps unknown or omitted history IDs pending', async () => {
    const service = harness(); useRealIngestion(service); service.localAccountKey = () => null;
    service.messagesByConversation.set({ chat: [{ ...message('deleted'), decryptError: true }, { ...message('unknown'), decryptError: true }] });
    service.api.post.and.returnValue(of({ messages: [], deletedMessages: [
      { messageId: 'deleted', conversationId: 'chat' },
      { messageId: 'unknown', conversationId: 'foreign-conversation' },
      { messageId: 'not-requested', conversationId: 'chat' },
    ] }));
    await service.retryRecoveredHistory();
    expect(service.messagesByConversation().chat.map((item: any) => item.id)).toEqual(['unknown']);
    expect(service.removedHistoryMessageIds.has('unknown')).toBeFalse();
    expect(service.removedHistoryMessageIds.has('not-requested')).toBeFalse();
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).toHaveBeenCalled();
  });

  it('discards a targeted recovery response after the authenticated account changes', async () => {
    const service = harness(); useRealIngestion(service);
    service.messagesByConversation.set({ chat: [{ ...message('old'), decryptError: true }] });
    const response = new Subject<any>(); service.api.post.and.returnValue(response);
    const recovery = service.retryRecoveredHistory();
    for (let index = 0; index < 20 && !service.api.post.calls.count(); index++) await Promise.resolve();
    expect(service.api.post).toHaveBeenCalledTimes(1);
    service.auth.session.set(session('bob'));
    response.next({ messages: [envelope('old')], deletedMessages: [] }); response.complete(); await recovery;
    expect(service.messagesByConversation().chat[0].decryptError).toBeTrue();
    expect(service.deviceHistory.markHistoryReadable).not.toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).not.toHaveBeenCalled();
  });

  it('cannot reinsert targeted envelopes when a conversation was cleared while the request was in flight', async () => {
    const service = harness(); useRealIngestion(service); service.localAccountKey = () => null;
    service.messagesByConversation.set({ chat: [{ ...message('old'), decryptError: true }] });
    const response = new Subject<any>(); service.api.post.and.returnValue(response);
    const recovery = service.retryRecoveredHistory();
    for (let index = 0; index < 20 && !service.api.post.calls.count(); index++) await Promise.resolve();
    service.applyChatCleared({ conversationId: 'chat' });
    response.next({ messages: [envelope('old')], deletedMessages: [] }); response.complete(); await recovery;
    expect(service.messagesByConversation().chat).toEqual([]);
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
  });

  it('queues another imported keyring during recovery and acknowledges only the final pass', async () => {
    const service = harness(); const first = deferred();
    service.ingestMessageBatch.and.returnValues(first.promise, Promise.resolve());
    const recovery = service.retryRecoveredHistory();
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(service.retryRecoveredHistory()).toBe(recovery);
    first.resolve(); await recovery;
    expect(service.ingestMessageBatch).toHaveBeenCalledTimes(2);
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
  });

  it('does not let an older failed refresh override the next approved keyring recovery', async () => {
    const service = harness();
    let reject!: (reason?: unknown) => void;
    service.ingestMessageBatch.and.returnValues(new Promise<void>((_resolve, fail) => reject = fail), Promise.resolve());
    const recovery = service.retryRecoveredHistory();
    for (let index = 0; index < 5; index++) await Promise.resolve();
    service.retryRecoveredHistory();
    reject(new Error('An older refresh failed')); await recovery;
    expect(service.ingestMessageBatch).toHaveBeenCalledTimes(2);
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalledTimes(1);
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).not.toHaveBeenCalled();
  });

  it('forgets a deleted protected message and rejects a recovery snapshot taken before deletion', async () => {
    const service = harness(); const protectedMessage = { ...message(), decryptError: true };
    service.messagesByConversation.set({ chat: [protectedMessage] });
    const envelope = { id: protectedMessage.id, conversationId: 'chat' };
    service.pendingHistoryEnvelopes.set(protectedMessage.id, envelope);
    service.localAccountKey = () => null;
    service.applyMessageDeleted({ messageId: protectedMessage.id, conversationId: 'chat' });
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
    expect(service.messagesByConversation().chat).toEqual([]);
    expect(await service.ingestMessage(envelope, false)).toBeTrue();
    service.upsertMessage(protectedMessage, { persist: false });
    expect(service.messagesByConversation().chat).toEqual([]);
    await service.retryRecoveredHistory();
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalled();
  });

  it('discards a protected message that expires while its decryption is in progress', async () => {
    const service = harness(); const decrypting = deferred<any>();
    const envelope = { id: 'expiring', conversationId: 'chat', expiresAt: new Date(Date.now() + 30_000).toISOString(),
      senderUserId: 'peer', recipients: [{ userId: 'alice', deviceId: 'alice-browser', ciphertext: 'opaque' }] };
    service.decryptOwnRecipientPayload = () => decrypting.promise;
    service.pendingHistoryEnvelopes.set(envelope.id, envelope);
    const ingest = service.ingestMessage(envelope, false);
    envelope.expiresAt = new Date(0).toISOString();
    decrypting.resolve({ type: 'text', text: 'Expired while decrypting' });
    expect(await ingest).toBeTrue();
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
    expect(service.messagesByConversation()).toEqual({});
  });

  it('forgets pending envelopes when a conversation is cleared without affecting another conversation', () => {
    const service = harness(); service.localAccountKey = () => null;
    const first = { id: 'one', conversationId: 'chat' }; const other = { id: 'two', conversationId: 'other' };
    service.pendingHistoryEnvelopes.set(first.id, first); service.pendingHistoryEnvelopes.set(other.id, other);
    service.messagesByConversation.set({ chat: [{ ...message(first.id), decryptError: true }] });
    service.applyChatCleared({ conversationId: 'chat' });
    expect([...service.pendingHistoryEnvelopes.keys()]).toEqual(['two']);
    expect(service.discardHistoryEnvelope(first)).toBeTrue();
    expect(service.discardHistoryEnvelope(other)).toBeFalse();
  });

  for (const action of ['clearConversation', 'deleteConversation']) {
    it(`forgets protected envelopes after ${action} succeeds over HTTP without any realtime event`, async () => {
      const service = harness(); service.localAccountKey = () => null;
      service.selectedConversationId.set(null);
      service.api = { post: () => of(null), delete: () => of(null) };
      service.conversations.set([{ id: 'chat' }, { id: 'other' }]);
      service.pendingHistoryEnvelopes.set('one', { id: 'one', conversationId: 'chat' });
      service.pendingHistoryEnvelopes.set('two', { id: 'two', conversationId: 'other' });
      await service[action]({ id: 'chat' }, 'me');
      expect([...service.pendingHistoryEnvelopes.keys()]).toEqual(['two']);
      expect(service.historyGeneration('chat')).toBe(1);
    });
  }

  it('does not return or persist a tombstoned message from a late cache read', async () => {
    const service = harness(); const deleted = message('deleted'); const readable = message('current');
    const cache = deferred<any[]>();
    service.localAccountKeys = async () => ['alice']; service.localAccountKey = () => 'alice';
    service.history = { conversationMessagesPage: () => cache.promise, putMessages: jasmine.createSpy('putMessages').and.resolveTo() };
    service.purgeExpiredLocalMessages = async () => undefined;
    const loading = service.loadCachedMessages('chat');
    for (let index = 0; index < 3; index++) await Promise.resolve();
    service.forgetHistoryMessage(deleted.id);
    cache.resolve([deleted, readable]);
    expect(await loading).toEqual([readable]);
    expect(service.history.putMessages).toHaveBeenCalledWith('alice', [readable]);
    expect(service.messagesByConversation().chat).toEqual([readable]);
  });

  for (const action of ['applyChatCleared', 'removeConversationLocally']) {
    it(`rejects unknown IDs from a decrypting batch when ${action} removes its conversation`, async () => {
      const service = harness(); const decrypting = deferred<any>();
      const envelope = (id: string) => ({ id, conversationId: 'chat', senderUserId: 'peer',
        recipients: [{ userId: 'alice', deviceId: 'alice-browser', ciphertext: 'opaque' }] });
      service.localAccountKey = () => null; service.selectedConversationId.set(null);
      service.decryptOwnRecipientPayload = jasmine.createSpy('decrypt').and.returnValue(decrypting.promise);
      service.ingestMessageBatch = ChatService.prototype['ingestMessageBatch'].bind(service);
      const batch = service.ingestMessageBatch([envelope('one'), envelope('two')], false);
      expect(service.pendingHistoryEnvelopes.size).toBe(0);
      if (action === 'applyChatCleared') service.applyChatCleared({ conversationId: 'chat' });
      else await service.removeConversationLocally('chat');
      decrypting.resolve({ type: 'text', text: 'Obsolete payload' });
      expect(await batch).toBeTrue();
      expect(service.decryptOwnRecipientPayload).toHaveBeenCalledTimes(1);
      expect(service.pendingHistoryEnvelopes.size).toBe(0);
      expect(service.messagesByConversation().chat ?? []).toEqual([]);
    });
  }

  it('does not persist a conversation cache page that completes after that conversation was cleared', async () => {
    const service = harness(); const cache = deferred<any[]>();
    service.localAccountKeys = async () => ['alice']; service.localAccountKey = () => 'alice';
    service.history = { conversationMessagesPage: () => cache.promise, putMessages: jasmine.createSpy('putMessages').and.resolveTo(),
      removeConversationMessages: async () => undefined };
    const loading = service.loadCachedMessages('chat');
    for (let index = 0; index < 3; index++) await Promise.resolve();
    service.applyChatCleared({ conversationId: 'chat' });
    cache.resolve([message('previously-unknown')]);
    expect(await loading).toEqual([]);
    expect(service.history.putMessages).not.toHaveBeenCalled();
    expect(service.messagesByConversation().chat).toEqual([]);
  });

  it('does not keep an expired protected cache placeholder pending after the active history is readable', async () => {
    const service = harness();
    service.messagesByConversation.set({ older: [{ ...message(), decryptError: true, expiresAt: new Date(0).toISOString() }] });
    await service.retryRecoveredHistory();
    expect(service.deviceHistory.markHistoryReadable).toHaveBeenCalled();
    expect(service.deviceHistory.markHistoryRecoveryIncomplete).not.toHaveBeenCalled();
  });

  it('cannot acknowledge or load pages for an account switched during recovery', async () => {
    const service = harness(); const initial = deferred();
    service.ingestMessageBatch.and.returnValue(initial.promise);
    const recovery = service.retryRecoveredHistory();
    service.auth.session.set(session('bob'));
    initial.resolve(); await recovery;
    expect(service.ingestMessageBatch).toHaveBeenCalledTimes(1);
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
