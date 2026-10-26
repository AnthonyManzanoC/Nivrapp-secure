import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ChatService } from './chat.service';

describe('continuous HTTP message synchronization', () => {
  const at = '2026-10-23T12:00:00.000Z';
  const envelope = (id: string) => ({ id, conversationId: 'chat', serverReceivedAt: at });
  const page = (id: string, hasMore = false) => ({ messages: [envelope(id)], syncedAt: at, cursorId: id, hasMore });
  const key = JSON.stringify(['message-sync-v2', 'alice', 'browser']);
  function harness(saved: unknown = null) {
    const records = new Map<string, string>();
    if (saved) records.set(key, JSON.stringify(saved));
    const service: any = Object.assign(Object.create(ChatService.prototype), {
      auth: { session: signal<any>({ user: { id: 'alice' }, device: { id: 'browser' } }), ensureFreshSession: async () => true },
      syncInFlight: false, conversationHistoryGenerations: new Map(),
      history: { getSyncWatermark: jasmine.createSpy('readCursor').and.callFake(async (name: string) => records.get(name) ?? null),
        setSyncWatermark: jasmine.createSpy('writeCursor').and.callFake(async (name: string, value: string) => { records.set(name, value); }) },
      messagesByConversation: signal({ chat: [{ id: 'recent-realtime', at: '2026-10-24T12:00:00Z', decryptError: true }] }),
      api: { get: jasmine.createSpy('get').and.returnValue(of(page('a'))) },
      ingestMessageBatch: jasmine.createSpy('ingest').and.resolveTo(true),
      ackDelivered: jasmine.createSpy('ack').and.resolveTo(),
      refreshPresenceForConversations: async () => undefined, purgeExpiredLocalMessages: async () => undefined,
    });
    const query = (index = 0) => new URL(service.api.get.calls.argsFor(index)[0], 'https://example.test').searchParams;
    return { service, records, query };
  }

  it('starts a full scan independently of newer realtime messages and old decryption errors', async () => {
    const h = harness();
    expect(await h.service.syncMissedMessagesCore(30)).toBeTrue();
    expect(h.query().get('since')).toBe('1970-01-01T00:00:00.000Z');
    expect(h.query().get('cursorVersion')).toBe('2');
    expect(h.service.history.getSyncWatermark).toHaveBeenCalledOnceWith(key);
    expect(JSON.parse(h.records.get(key)!)).toEqual({ at, id: 'a', caughtUp: true });
  });

  it('drains equal-timestamp pages using their IDs even when an older envelope is not yet readable', async () => {
    const h = harness({ at, id: 'a' });
    h.service.api.get.and.returnValues(of(page('b', true)), of(page('c')));
    h.service.ingestMessageBatch.and.resolveTo(false);
    expect(await h.service.syncMissedMessagesCore(1)).toBeTrue();
    expect(h.query().get('sinceId')).toBe('a');
    expect(h.query(1).get('sinceId')).toBe('b');
    expect(h.query(1).get('since')).toBe(at);
    expect(h.service.ingestMessageBatch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.records.get(key)!).id).toBe('c');
  });

  it('bounds a busy backlog and resumes the exact unfinished page on the next pass', async () => {
    const h = harness({ at, id: '00' }); let sequence = 0;
    h.service.api.get.and.callFake(() => of(page(String(++sequence).padStart(2, '0'), sequence <= 8)));
    expect(await h.service.syncMissedMessagesCore(1)).toBeTrue();
    expect(h.service.api.get).toHaveBeenCalledTimes(8);
    expect(h.service.syncCatchupPending).toBeTrue();
    expect(await h.service.syncMissedMessagesCore(1)).toBeTrue();
    expect(h.query(8).get('sinceId')).toBe('08');
    expect(h.query(8).get('since')).toBe(at);
    expect(h.service.syncCatchupPending).toBeFalse();
  });

  it('replays a completed window to collect a transaction committed behind a newer message', async () => {
    const h = harness({ at, id: 'z', caughtUp: true });
    await h.service.syncMissedMessagesCore(30);
    expect(h.query().get('since')).toBe('2026-10-23T11:55:00.000Z');
    expect(h.query().get('sinceId')).toBe('');
  });

  it('does not adopt an old server response as a certified composite cursor', async () => {
    const h = harness({ at, id: 'a' });
    h.service.api.get.and.returnValue(of({ messages: [envelope('b')], syncedAt: at }));
    expect(await h.service.syncMissedMessagesCore(30)).toBeFalse();
    expect(h.service.history.setSyncWatermark).not.toHaveBeenCalled();
  });

  it('keeps a completed checkpoint when its replay window contains only deleted messages', async () => {
    const h = harness({ at, id: 'z', caughtUp: true });
    h.service.api.get.and.returnValue(of({ messages: [], syncedAt: at, cursorId: null, hasMore: false }));
    expect(await h.service.syncMissedMessagesCore(30)).toBeTrue();
    expect(JSON.parse(h.records.get(key)!)).toEqual({ at, id: 'z', caughtUp: true });
  });

  it('does not advance an empty scan to the server clock', async () => {
    const h = harness({ at, id: 'a' });
    h.service.api.get.and.returnValue(of({ messages: [], syncedAt: '2099-01-01T00:00:00Z', cursorId: 'a', hasMore: false }));
    expect(await h.service.syncMissedMessagesCore(30)).toBeTrue();
    expect(JSON.parse(h.records.get(key)!).at).toBe(at);
  });

  it('rejects an in-flight page after switching accounts without writing its cursor', async () => {
    const h = harness(); const response = new Subject<any>();
    h.service.api.get.and.returnValue(response);
    const pending = h.service.syncMissedMessagesCore(30);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    h.service.auth.session.set({ user: { id: 'bob' }, device: { id: 'other' } });
    response.next(page('a')); response.complete();
    expect(await pending).toBeFalse();
    expect(h.service.ingestMessageBatch).not.toHaveBeenCalled();
    expect(h.service.history.setSyncWatermark).not.toHaveBeenCalled();
  });

  it('rejects the previous account generation even when its account and device return', async () => {
    const h = harness(); const response = new Subject<any>();
    h.service.messageLoadGeneration = 0;
    h.service.api.get.and.returnValue(response);
    const pending = h.service.syncMissedMessagesCore(30);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    h.service.messageLoadGeneration = 2;
    response.next(page('a')); response.complete();
    expect(await pending).toBeFalse();
    expect(h.service.ingestMessageBatch).not.toHaveBeenCalled();
    expect(h.service.history.setSyncWatermark).not.toHaveBeenCalled();
  });

  it('preserves a transient transport error for reconnect backoff without classifying invalid cursors as network loss', async () => {
    const h = harness(); const failure = new HttpErrorResponse({ status: 0 });
    h.service.api.get.and.returnValue(throwError(() => failure));
    expect(await h.service.syncMissedMessagesCore(30)).toBeFalse();
    expect(h.service.lastMessageSyncError).toBe(failure);
    h.service.api.get.and.returnValue(of({ messages: [envelope('a')], syncedAt: at }));
    expect(await h.service.syncMissedMessagesCore(30)).toBeFalse();
    expect(h.service.lastMessageSyncError).toBeNull();
    expect(h.service.history.setSyncWatermark).not.toHaveBeenCalled();
  });

  it('continues the network scan in memory when local storage is temporarily unavailable', async () => {
    const h = harness({ at, id: 'a' });
    h.service.history.setSyncWatermark.and.rejectWith(new Error('Legacy database is being migrated'));
    h.service.api.get.and.returnValues(of(page('b', true)), of(page('c')));
    expect(await h.service.syncMissedMessagesCore(1)).toBeTrue();
    expect(h.query(1).get('sinceId')).toBe('b');
    h.service.api.get.and.returnValue(of(page('d')));
    expect(await h.service.syncMissedMessagesCore(1)).toBeTrue();
    expect(h.query(2).get('since')).toBe('2026-10-23T11:55:00.000Z');
    expect(h.service.history.getSyncWatermark).toHaveBeenCalledTimes(1);
  });
});
