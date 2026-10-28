import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ChatService } from './chat.service';

describe('protected chats guard central message actions', () => {
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => resolve = done);
    return { promise, resolve };
  }
  function harness() {
    const service: any = Object.create(ChatService.prototype);
    const session = signal<any>({ user: { id: 'alice', alias: 'alice' }, device: { id: 'phone' } });
    const generation = signal(1), grant = signal<string | null>(null);
    const protectedIds = new Map<string, string[]>([['alice', ['private']]]);
    const conversation: any = { id: 'private', type: 'Direct', participants: [{ userId: 'alice' }, { userId: 'peer' }] };
    const publicChat: any = { ...conversation, id: 'public' };
    const message: any = { id: 'first', conversationId: 'private', mine: false, senderUserId: 'peer', at: '2026-10-27T13:00:00Z', payload: { type: 'text', text: 'Private text' }, receipts: [] };
    service.auth = { session, sessionGeneration: generation,
      ensureDeviceIdentity: jasmine.createSpy('identity').and.callFake(async () => ({ userId: session().user.id, deviceId: session().device.id })) };
    service.privateChats = {
      isProtected: (id: string) => (protectedIds.get(session()?.user.id) ?? []).includes(id),
      isLocked: (id: string) => (protectedIds.get(session()?.user.id) ?? []).includes(id) && grant() !== id,
    };
    service.conversations = signal([conversation, publicChat]); service.visibleConversations = service.conversations;
    service.contacts = signal([]); service.selectedConversation = signal(conversation);
    service.messagesByConversation = signal({ private: [message, { ...message, id: 'second' }] });
    service.launchPreviews = signal({ private: 'Cached private text' }); service.launchPreviewAt = signal({});
    service.readReceiptSentIds = new Set();
    service.signalr = { syncReadReceipts: jasmine.createSpy('readSync').and.resolveTo() };
    service.sendReceipt = jasmine.createSpy('receipt').and.resolveTo();
    service.applyOptimisticReadState = jasmine.createSpy('optimistic');
    service.applyViewOnceTombstones = jasmine.createSpy('tombstones');
    service.isConversationBlocked = () => false; service.isConversationArchived = () => false;
    service.canSendToConversation = () => true;
    service.conversationTitle = (item: any) => item.id;
    service.normalizeOutgoingPayload = (_conversation: unknown, payload: unknown) => payload;
    service.withUniformMessagePadding = (payload: unknown) => payload;
    service.encryptedRecipients = jasmine.createSpy('encryptRecipients').and.resolveTo([{ userId: 'peer', deviceId: 'peer-phone', header: 'sealed-header', ciphertext: 'sealed' }]);
    service.api = { post: jasmine.createSpy('post').and.returnValue(of({ id: 'sent', senderUserId: 'alice' })), delete: jasmine.createSpy('delete').and.returnValue(of({})) };
    service.ingestLocalSent = jasmine.createSpy('ingestSent').and.resolveTo();
    service.ingestMessage = jasmine.createSpy('ingest').and.resolveTo();
    service.localAccountKeys = jasmine.createSpy('accountKeys').and.resolveTo(['alice']);
    service.history = { messageById: jasmine.createSpy('messageById').and.resolveTo(message) };
    service.yieldToMainThread = async () => undefined;
    return { service, session, generation, grant, protectedIds, conversation, publicChat, message };
  }
  beforeEach(() => { spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible'); });

  it('never exposes a protected conversation preview in the list or launch cache, even while it is unlocked', () => {
    const h = harness();
    expect(h.service.conversationSubtitle(h.conversation)).toBe('Chat protegido');
    h.grant.set('private');
    expect(h.service.conversationSubtitle(h.conversation)).toBe('Chat protegido');
    h.service.messagesByConversation.set({});
    expect(h.service.conversationSubtitle(h.conversation)).toBe('Chat protegido');
  });

  it('does not optimistically mark a locked chat as read or send any read synchronization or receipt', async () => {
    const h = harness();
    await h.service.markConversationRead('private');
    expect(h.service.applyOptimisticReadState).not.toHaveBeenCalled();
    expect(h.service.signalr.syncReadReceipts).not.toHaveBeenCalled(); expect(h.service.sendReceipt).not.toHaveBeenCalled();
    h.grant.set('private'); await h.service.markConversationRead('private');
    expect(h.service.signalr.syncReadReceipts).toHaveBeenCalledTimes(1);
    expect(h.service.sendReceipt).toHaveBeenCalledTimes(2);
  });

  it('stops read receipts if protection relocks while the read synchronization is in flight', async () => {
    const h = harness(); h.grant.set('private');
    const sync = deferred(); h.service.signalr.syncReadReceipts.and.returnValue(sync.promise);
    const pending = h.service.markConversationRead('private');
    h.grant.set(null); sync.resolve(); await pending;
    expect(h.service.sendReceipt).not.toHaveBeenCalled();
  });

  it('does not continue an old account read operation under a new account with the same group id', async () => {
    const h = harness(); h.grant.set('private');
    const sync = deferred(); h.service.signalr.syncReadReceipts.and.returnValue(sync.promise);
    const pending = h.service.markConversationRead('private');
    h.session.set({ user: { id: 'bob' }, device: { id: 'bob-phone' } }); h.generation.update(value => value + 1);
    sync.resolve(); await pending;
    expect(h.service.sendReceipt).not.toHaveBeenCalled();
  });

  it('rechecks protection between individual read receipts', async () => {
    const h = harness(); h.grant.set('private');
    const firstReceipt = deferred(); const started = deferred();
    h.service.sendReceipt.and.callFake(() => { started.resolve(); return firstReceipt.promise; });
    const pending = h.service.markConversationRead('private'); await started.promise;
    h.grant.set(null); firstReceipt.resolve(); await pending;
    expect(h.service.sendReceipt).toHaveBeenCalledOnceWith('first', 'Read');
  });

  it('never opens view-once content in a locked chat or syncs a late open after it relocks', async () => {
    const h = harness(); const once = { ...h.message, deleteAfterRead: true };
    await h.service.markMessageOpened(once);
    expect(h.service.sendReceipt).not.toHaveBeenCalled(); expect(h.service.applyViewOnceTombstones).not.toHaveBeenCalled();
    h.grant.set('private'); const receipt = deferred(); h.service.sendReceipt.and.returnValue(receipt.promise);
    const pending = h.service.markMessageOpened(once); h.grant.set(null); receipt.resolve(); await pending;
    expect(h.service.signalr.syncReadReceipts).not.toHaveBeenCalled(); expect(h.service.applyViewOnceTombstones).not.toHaveBeenCalled();
  });

  it('rejects sends, attachments, reactions, edits and deletion before any side effect when the chat is locked', async () => {
    const h = harness(); const failure = /Desbloquea el chat protegido/;
    await expectAsync(h.service.sendPayload(h.conversation, h.message.payload)).toBeRejectedWithError(failure);
    await expectAsync(h.service.sendFile(h.conversation, new File(['file'], 'secret.txt'))).toBeRejectedWithError(failure);
    await expectAsync(h.service.sendReaction(h.conversation, h.message, '👍')).toBeRejectedWithError(failure);
    await expectAsync(h.service.editMessage(h.conversation, { ...h.message, mine: true }, 'new text')).toBeRejectedWithError(failure);
    await expectAsync(h.service.deleteMessage(h.message, true)).toBeRejectedWithError(failure);
    expect(h.service.auth.ensureDeviceIdentity).not.toHaveBeenCalled(); expect(h.service.api.post).not.toHaveBeenCalled();
    expect(h.service.api.delete).not.toHaveBeenCalled(); expect(h.service.encryptedRecipients).not.toHaveBeenCalled();
  });

  it('stops a send if protection relocks while recipient encryption is in flight', async () => {
    const h = harness(); h.grant.set('private');
    const sealed = deferred<any[]>(); const started = deferred();
    h.service.encryptedRecipients.and.callFake(() => { started.resolve(); return sealed.promise; });
    const pending = h.service.sendPayload(h.conversation, h.message.payload);
    const rejected = expectAsync(pending).toBeRejectedWithError(/Desbloquea el chat protegido/);
    await started.promise; h.grant.set(null); sealed.resolve([{ ciphertext: 'sealed' }]); await rejected;
    expect(h.service.api.post).not.toHaveBeenCalled();
  });

  it('does not retry a message HTTP request after the chat relocks during backoff', fakeAsync(() => {
    const h = harness(); h.grant.set('private'); h.service.api.post.and.returnValue(throwError(() => ({ status: 503 })));
    let failure: Error | undefined;
    void h.service.sendPayload(h.conversation, h.message.payload).catch((error: Error) => failure = error);
    flushMicrotasks(); expect(h.service.api.post).toHaveBeenCalledTimes(1);
    h.grant.set(null); tick(350); flushMicrotasks();
    expect(failure?.message).toMatch(/Desbloquea el chat protegido/); expect(h.service.api.post).toHaveBeenCalledTimes(1);
  }));

  it('does not upload a file when protection relocks during optimization', async () => {
    const h = harness(); h.grant.set('private');
    const prepared = deferred<any>(); const started = deferred(); const file = new File(['file'], 'secret.txt');
    h.service.uploading = signal(false); h.service.uploadStatus = signal(''); h.service.fileSendSequence = 0;
    h.service.mediaOptimizer = { prepareForEncryptedUpload: () => { started.resolve(); return prepared.promise; } };
    const pending = h.service.sendFile(h.conversation, file);
    const rejected = expectAsync(pending).toBeRejectedWithError(/Desbloquea el chat protegido/);
    await started.promise; h.grant.set(null); prepared.resolve({ file }); await rejected;
    expect(h.service.api.post).not.toHaveBeenCalled(); expect(h.service.uploading()).toBeFalse();
  });

  it('excludes locked destinations and refuses to forward content from a locked source', async () => {
    const h = harness();
    expect(h.service.forwardAvailability(h.message).ok).toBeFalse();
    expect(h.service.forwardTargets('elsewhere').map((item: any) => item.id)).toEqual(['public']);
    expect(await h.service.forwardMessageToConversations(h.message, ['public'])).toBe(0);
    await expectAsync(h.service.forwardMessageToConversation({ ...h.message, conversationId: 'public' }, h.conversation)).toBeRejectedWithError(/Desbloquea el chat protegido/);
    expect(h.service.api.post).not.toHaveBeenCalled();
  });

  it('rechecks the source after an asynchronous forwarded file download before sending to another chat', async () => {
    const h = harness(); h.grant.set('private');
    const file = deferred<File>(); const started = deferred();
    h.service.fileFromForwardPayload = () => { started.resolve(); return file.promise; };
    h.service.sendFile = jasmine.createSpy('sendFile').and.resolveTo({});
    const source = { ...h.message, payload: { type: 'file', fileId: 'attachment' } };
    const pending = h.service.forwardMessageToConversation(source, h.publicChat);
    const rejected = expectAsync(pending).toBeRejectedWithError(/acceso al chat cambió/);
    await started.promise; h.grant.set(null); file.resolve(new File(['file'], 'secret.txt')); await rejected;
    expect(h.service.sendFile).not.toHaveBeenCalled();
  });

  it('does not return private cached message content after the grant or account changes while reading storage', async () => {
    const h = harness();
    expect(await h.service.localMessageById('private', 'first')).toBeNull();
    expect(h.service.history.messageById).not.toHaveBeenCalled();
    h.grant.set('private'); h.service.messagesByConversation.set({});
    const read = deferred<any>(); const started = deferred();
    h.service.history.messageById.and.callFake(() => { started.resolve(); return read.promise; });
    const pending = h.service.localMessageById('private', 'first'); await started.promise;
    h.session.set({ user: { id: 'bob' }, device: { id: 'bob-phone' } }); h.generation.update(value => value + 1);
    read.resolve(h.message); expect(await pending).toBeNull();
  });

  it('allows only the internal validated call log path while keeping its preview private and rejecting prefix spoofing', async () => {
    const h = harness();
    const call = { id: 'cal_test', conversationId: 'private', type: 'Voice', startedAt: '2026-10-27T13:00:00Z', endedAt: '2026-10-27T13:01:00Z', initiatorUserId: 'alice' };
    await expectAsync(h.service.sendPayload(h.conversation, { type: 'text', text: 'Spoofed private text' }, 'System', null, {
      clientMessageId: 'call-summary:cal_test:call-ended', internalCallSummary: Symbol('authenticated-call-summary-path'),
    })).toBeRejectedWithError(/Desbloquea el chat protegido/);
    expect(h.service.api.post).not.toHaveBeenCalled();
    await h.service.recordCallSystemMessage(call, 'call-ended', 60_000);
    expect(h.service.api.post).toHaveBeenCalledTimes(1);
    const payload = h.service.encryptedRecipients.calls.mostRecent().args[1];
    expect(payload.type).toBe('call_log'); expect(payload.text).toBe('Duracion 1:00');
    expect(h.service.api.post.calls.mostRecent().args[1].internalCallSummary).toBeUndefined();
    expect(h.service.conversationSubtitle(h.conversation)).toBe('Chat protegido');
    expect(h.service.sendReceipt).not.toHaveBeenCalled();
  });
});
