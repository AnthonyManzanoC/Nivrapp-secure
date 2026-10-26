import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ChatService } from './chat.service';

describe('live chat list refresh', () => {
  const session = (device = 'browser', user = 'alice') => ({ user: { id: user, alias: user }, device: { id: device } });
  const conversation = (id = 'chat') => ({ id, type: 'Direct', participants: [], updatedAt: '2026-10-23T12:00:00Z' });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => resolve = done);
    return { promise, resolve };
  }
  function harness() {
    const service: any = Object.assign(Object.create(ChatService.prototype), {
      auth: { session: signal<any>(session()), isAuthenticated: () => true,
        ensureDeviceIdentity: jasmine.createSpy('identity').and.resolveTo({}),
        ensureFreshSession: async () => true },
      history: { retryNativeStorage: jasmine.createSpy('localRetry').and.resolveTo(true), storageError: signal('') },
      deviceHistory: { state: signal('idle'), retry: jasmine.createSpy('historyRetry') },
      messageLoadGeneration: 0, listUpdateCount: 0, listUpdating: signal(false), loading: signal(false),
      syncError: signal(''), lastSyncedAt: signal<number | null>(null), automaticSyncTimer: null,
      refreshChatsInFlight: null, bootstrapInFlight: null, resumeSyncInFlight: null,
      networkRecovery: { recovered: jasmine.createSpy('recovered'), failed: jasmine.createSpy('failed') },
      conversations: signal<any[]>([conversation()]), contacts: signal([]), remoteIndexRevision: 0,
      selectedConversationId: signal('chat'), messagesByConversation: signal({ chat: [{ id: 'readable', payload: { text: 'Keep me' } }] }),
      bootstrap: jasmine.createSpy('bootstrap').and.resolveTo(), loadMessages: jasmine.createSpy('messages').and.resolveTo(),
      hasLoadedChatState: () => true, syncMissedMessages: jasmine.createSpy('sync').and.resolveTo(true),
      signalr: { connected: () => false, joinConversation: jasmine.createSpy('join').and.returnValue(new Promise(() => undefined)) },
      api: { get: jasmine.createSpy('get').and.returnValue(of([conversation()])) },
      applyLocalConversationState: (items: any[]) => items,
      rememberConversationParticipants: () => undefined, ensureSelectedConversation: () => undefined,
      persistChatIndex: jasmine.createSpy('persist').and.resolveTo(), hydrateConversationProfiles: async () => undefined,
      refreshPresenceForConversations: async () => undefined,
    });
    return service;
  }

  it('coalesces manual refreshes and stays busy until the open conversation really finishes', async () => {
    const service = harness(); const page = deferred<void>();
    service.loadMessages.and.returnValue(page.promise);
    const first = service.refreshChats();
    expect(service.refreshChats()).toBe(first);
    expect(service.listUpdating()).toBeTrue();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(service.loadMessages).toHaveBeenCalledOnceWith('chat');
    expect(service.listUpdating()).toBeTrue();
    expect(service.messagesByConversation().chat[0].payload.text).toBe('Keep me');
    page.resolve();
    expect(await first).toBeTrue();
    expect(service.listUpdating()).toBeFalse();
    expect(service.lastSyncedAt()).not.toBeNull();
    expect(service.history.retryNativeStorage).toHaveBeenCalledTimes(1);
  });

  it('never reports local recovery merely because the remote list refreshed', async () => {
    const service = harness(); service.history.retryNativeStorage.and.resolveTo(false);
    service.history.storageError.set('Local vault is still locked');
    expect(await service.refreshChats()).toBeFalse();
    expect(service.bootstrap).toHaveBeenCalled();
    expect(service.listUpdating()).toBeFalse();
    expect(service.history.storageError()).toBe('Local vault is still locked');
  });

  it('refreshes the HTTP list and messages even while realtime has a stalled handshake', async () => {
    const service = harness(); const response = new Subject<any[]>();
    service.api.get.and.returnValue(response);
    const refresh = service.resumeSoftSync();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(service.api.get).toHaveBeenCalledOnceWith('/conversations');
    expect(service.signalr.joinConversation).toHaveBeenCalledWith('chat');
    expect(service.listUpdating()).toBeFalse();
    response.next([conversation('new-chat'), conversation()]); response.complete();
    await refresh;
    expect(service.conversations().map((item: any) => item.id)).toContain('new-chat');
    expect(service.syncMissedMessages).toHaveBeenCalledTimes(1);
    expect(service.listUpdating()).toBeFalse();
    expect(service.syncError()).toBe('');
  });

  it('keeps readable chats visible and leaves a retryable status after an actual background failure', async () => {
    const service = harness(); service.syncMissedMessages.and.resolveTo(false);
    await expectAsync(service.resumeSoftSync()).toBeRejected();
    expect(service.listUpdating()).toBeFalse();
    expect(service.syncError()).toBe('refresh');
    expect(service.lastSyncedAt()).toBeNull();
    expect(service.messagesByConversation().chat.length).toBe(1);
  });

  it('reconciles after the offline refresh that was still pending when connectivity returned', async () => {
    const service = harness();
    let fail!: (reason: unknown) => void;
    service.refreshChatsInFlight = new Promise<void>((_resolve, reject) => fail = reject);
    service.syncError.set('refresh');
    const recovered = service.resumeSoftSync();
    expect(service.api.get).not.toHaveBeenCalled();
    fail(new HttpErrorResponse({ status: 0 }));
    await recovered;
    expect(service.api.get).toHaveBeenCalledOnceWith('/conversations');
    expect(service.syncMissedMessages).toHaveBeenCalledTimes(1);
    expect(service.syncError()).toBe('');
    expect(service.messagesByConversation().chat[0].payload.text).toBe('Keep me');
    expect(service.networkRecovery.recovered).toHaveBeenCalledTimes(1);
  });

  it('reconciles after a pending bootstrap fails instead of losing its connection wake', async () => {
    const service = harness();
    let fail!: (reason: unknown) => void;
    service.bootstrapInFlight = new Promise<void>((_resolve, reject) => fail = reject);
    const recovered = service.resumeSoftSync();
    fail(new HttpErrorResponse({ status: 503 }));
    await recovered;
    expect(service.api.get).toHaveBeenCalledOnceWith('/conversations');
    expect(service.syncError()).toBe('');
  });

  it('does not transfer a queued connection recovery to another account', async () => {
    const service = harness(); const previous = deferred<boolean>();
    service.refreshChatsInFlight = previous.promise;
    const recovery = service.resumeSoftSync();
    service.auth.session.set(session('other-device', 'bob'));
    service.messageLoadGeneration++;
    previous.resolve(false); await recovery;
    expect(service.api.get).not.toHaveBeenCalled();
    expect(service.auth.ensureDeviceIdentity).not.toHaveBeenCalled();
    expect(service.syncError()).toBe('');
  });

  it('discards a pre-switch response when the same account returns before it finishes', async () => {
    const service = harness(); const response = new Subject<any[]>();
    service.api.get.and.returnValue(response);
    const recovery = service.resumeSoftSync();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    service.messageLoadGeneration += 2;
    response.next([conversation('old-response')]); response.complete();
    await recovery;
    expect(service.conversations().map((item: any) => item.id)).toEqual(['chat']);
    expect(service.syncMissedMessages).not.toHaveBeenCalled();
    expect(service.networkRecovery.recovered).not.toHaveBeenCalled();
  });

  it('leaves the failure visible until an HTTP reconciliation actually succeeds', async () => {
    const service = harness(); const failure = new HttpErrorResponse({ status: 0 });
    service.syncError.set('refresh');
    service.api.get.and.returnValue(throwError(() => failure));
    await expectAsync(service.resumeSoftSync()).toBeRejectedWith(failure);
    expect(service.syncError()).toBe('refresh');
    expect(service.networkRecovery.failed).toHaveBeenCalledOnceWith(failure);
    expect(service.networkRecovery.recovered).not.toHaveBeenCalled();
    expect(service.messagesByConversation().chat[0].payload.text).toBe('Keep me');
  });

  it('captures the repaired destination instead of the old QR source when manually refreshing', async () => {
    const service = harness();
    service.auth.ensureDeviceIdentity.and.callFake(async () => { service.auth.session.set(session('repaired-browser')); return {}; });
    expect(await service.refreshChats()).toBeTrue();
    expect(service.loadMessages).toHaveBeenCalledWith('chat');
    expect(service.syncError()).toBe('');
  });

  it('does not finish an old account refresh in a new account', async () => {
    const service = harness(); const opening = deferred<boolean>();
    service.history.retryNativeStorage.and.returnValue(opening.promise);
    const refresh = service.refreshChats();
    service.auth.session.set(session('other-device', 'bob'));
    opening.resolve(true);
    expect(await refresh).toBeFalse();
    expect(service.auth.ensureDeviceIdentity).not.toHaveBeenCalled();
    expect(service.bootstrap).not.toHaveBeenCalled();
    expect(service.lastSyncedAt()).toBeNull();
  });

  it('polls active chats automatically, pauses while hidden or offline, and cancels its timer', fakeAsync(() => {
    const service = harness(); const refresh = spyOn(service, 'resumeSoftSync').and.resolveTo();
    const visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    const online = spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    service.startAutomaticSync(); service.startAutomaticSync();
    tick(30_000); flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility.and.returnValue('hidden'); tick(30_000);
    visibility.and.returnValue('visible'); online.and.returnValue(false); tick(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    online.and.returnValue(true); tick(30_000); flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(2);
    service.stopAutomaticSync(); tick(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  }));

  it('recovers an error without an online event even while realtime still appears connected', fakeAsync(() => {
    const service = harness(); const refresh = spyOn(service, 'resumeSoftSync').and.resolveTo();
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    const online = spyOnProperty(navigator, 'onLine', 'get').and.returnValue(false);
    service.signalr.connected = () => true;
    service.lastSyncedAt.set(Date.now());
    service.syncError.set('refresh');
    service.startAutomaticSync(); tick(1000);
    online.and.returnValue(true);
    tick(29_000); flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(1);
    service.stopAutomaticSync();
  }));

  it('lets the pending connection recovery own its backoff without a second polling request', fakeAsync(() => {
    const service = harness(); const refresh = spyOn(service, 'resumeSoftSync').and.resolveTo();
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    service.networkRecovery.pending = true;
    service.syncError.set('refresh');
    service.startAutomaticSync(); tick(30_000); flushMicrotasks();
    expect(refresh).not.toHaveBeenCalled();
    service.networkRecovery.pending = false; tick(30_000); flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(1);
    service.stopAutomaticSync();
  }));
});
