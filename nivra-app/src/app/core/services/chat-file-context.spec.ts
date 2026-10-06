import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { ChatService } from './chat.service';

describe('chat sends stay with their original account and device', () => {
  const contextError = /La cuenta o el dispositivo cambió durante el envío/;
  const record = { id: 'file-original' };
  const sent = {
    id: 'message-original', conversationId: 'shared-group', senderUserId: 'account-a', senderDeviceId: 'phone-a',
    serverReceivedAt: '2026-10-06T12:00:00Z', receipts: [], expiresAt: null, deleteAfterRead: false,
  };
  const encrypted = { bytes: new ArrayBuffer(8), key: 'attachment-key', iv: 'attachment-iv' };

  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function harness(mime = 'image/png') {
    const service: any = Object.create(ChatService.prototype);
    const session = signal<any>({ user: { id: 'account-a', alias: 'alice' }, device: { id: 'phone-a' } });
    // Both accounts belong to this same group: conversation IDs cannot protect the send.
    const conversation: any = {
      id: 'shared-group', type: 'Group', settings: { sendMessages: 'all' },
      participants: [{ userId: 'account-a' }, { userId: 'account-b' }],
      createdAt: '2026-10-06T11:00:00Z',
    };
    const file = new File(['test'], mime.startsWith('audio/') ? 'voice.webm' : 'sticker.png', { type: mime });
    spyOn(file, 'arrayBuffer').and.resolveTo(new ArrayBuffer(4));
    const filePostStarted = deferred();
    const blobStarted = deferred();
    const keysStarted = deferred();
    const messageStarted = deferred();
    const routes: any = {
      file: of(record), blob: of(record), message: of(sent),
      keys: of([
        { userId: 'account-a', devices: [{ deviceId: 'phone-a', keyBundle: { identityKey: 'key-a' } }] },
        { userId: 'account-b', devices: [{ deviceId: 'phone-b', keyBundle: { identityKey: 'key-b' } }] },
      ]),
    };
    service.auth = { session };
    service.fileSendSequence = 0;
    service.uploading = signal(false);
    service.uploadStatus = signal('');
    service.mediaPreviews = signal({});
    service.messagesByConversation = signal({});
    service.conversations = signal([conversation]);
    service.pendingReactionsByMessageId = new Map();
    service.expiryTimers = new Map();
    service.history = { putMessage: jasmine.createSpy('putMessage').and.resolveTo() };
    service.mediaOptimizer = {
      prepareForEncryptedUpload: jasmine.createSpy('prepareForEncryptedUpload').and.resolveTo({ file }),
    };
    service.crypto = {
      b64: (value: ArrayBuffer | Uint8Array) => btoa(Array.from(new Uint8Array(value as ArrayBuffer), (byte) => String.fromCharCode(byte)).join('')),
      encryptAttachment: jasmine.createSpy('encryptAttachment').and.resolveTo(encrypted),
      encryptAttachmentFile: jasmine.createSpy('encryptAttachmentFile').and.resolveTo({ body: new Blob(['sealed']), encryptedSize: 6, key: 'large-key', iv: 'large-iv' }),
      currentKeyMaterial: jasmine.createSpy('currentKeyMaterial').and.resolveTo({ publicJwk: { kty: 'EC' } }),
      parsePublicJwk: () => ({ kty: 'EC' }),
      encryptForPublicKey: jasmine.createSpy('encryptForPublicKey').and.resolveTo({ ciphertext: 'sealed', header: {} }),
      encryptGroupPayloadForRecipients: jasmine.createSpy('encryptGroupPayloadForRecipients').and.resolveTo([
        { userId: 'account-a', deviceId: 'phone-a', ciphertext: 'sealed', header: {} },
        { userId: 'account-b', deviceId: 'phone-b', ciphertext: 'sealed', header: {} },
      ]),
    };
    service.api = {
      post: jasmine.createSpy('post').and.callFake((url: string) => {
        if (url === '/files') { filePostStarted.resolve(); return routes.file; }
        if (url === '/keys/batch') { keysStarted.resolve(); return routes.keys; }
        if (url === '/conversations/shared-group/messages') { messageStarted.resolve(); return routes.message; }
        throw new Error(`Unexpected request: ${url}`);
      }),
      putRaw: jasmine.createSpy('putRaw').and.callFake(() => { blobStarted.resolve(); return routes.blob; }),
    };
    return {
      service, session, conversation, file, routes, filePostStarted, blobStarted, keysStarted, messageStarted,
      switchAccount: () => session.set({ user: { id: 'account-b', alias: 'bob' }, device: { id: 'phone-b' } }),
      messagePosts: () => service.api.post.calls.allArgs().filter((args: any[]) => args[0].endsWith('/messages')),
      filePosts: () => service.api.post.calls.allArgs().filter((args: any[]) => args[0] === '/files'),
    };
  }

  it('stops a sticker after optimization if another account has opened the same group', async () => {
    const h = harness();
    const prepared = deferred<any>();
    h.service.mediaOptimizer.prepareForEncryptedUpload.and.returnValue(prepared.promise);
    const pending = h.service.sendFile(h.conversation, h.file, { sticker: true });
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    h.switchAccount();
    prepared.resolve({ file: h.file });
    await rejected;
    expect(h.service.crypto.encryptAttachment).not.toHaveBeenCalled();
    expect(h.filePosts().length).toBe(0);
    expect(h.messagePosts().length).toBe(0);
  });

  it('stops between reading the file and encrypting it when the device changes', async () => {
    const h = harness();
    const plain = deferred<ArrayBuffer>();
    const reading = deferred();
    (h.file.arrayBuffer as jasmine.Spy).and.callFake(() => { reading.resolve(); return plain.promise; });
    const pending = h.service.sendFile(h.conversation, h.file);
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    await reading.promise;
    h.session.set({ user: { id: 'account-a', alias: 'alice' }, device: { id: 'replacement-phone' } });
    plain.resolve(new ArrayBuffer(4));
    await rejected;
    expect(h.service.crypto.encryptAttachment).not.toHaveBeenCalled();
    expect(h.filePosts().length).toBe(0);
  });

  it('does not create a file record after old-account encryption finishes', async () => {
    const h = harness();
    const sealed = deferred<any>();
    const sealing = deferred();
    h.service.crypto.encryptAttachment.and.callFake(() => { sealing.resolve(); return sealed.promise; });
    const pending = h.service.sendFile(h.conversation, h.file);
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    await sealing.promise;
    h.switchAccount();
    sealed.resolve(encrypted);
    await rejected;
    expect(h.filePosts().length).toBe(0);
  });

  it('does not upload a blob using the new account after an old file POST response', async () => {
    const h = harness();
    const fileResponse = new Subject();
    h.routes.file = fileResponse;
    const pending = h.service.sendFile(h.conversation, h.file, { sticker: true });
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    await h.filePostStarted.promise;
    h.switchAccount();
    fileResponse.next(record);
    await rejected;
    expect(h.service.api.putRaw).not.toHaveBeenCalled();
    expect(h.service.mediaPreviews()).toEqual({});
    expect(h.messagePosts().length).toBe(0);
  });

  it('does not cache a preview or start recipient encryption after an old upload response', async () => {
    const h = harness();
    const uploaded = new Subject();
    h.routes.blob = uploaded;
    const pending = h.service.sendFile(h.conversation, h.file, { sticker: true });
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    await h.blobStarted.promise;
    h.switchAccount();
    uploaded.next(record);
    await rejected;
    expect(h.service.mediaPreviews()).toEqual({});
    expect(h.service.crypto.currentKeyMaterial).not.toHaveBeenCalled();
    expect(h.messagePosts().length).toBe(0);
  });

  it('does not fetch recipient keys under a replacement device after loading sender keys', async () => {
    const h = harness();
    const own = deferred<any>();
    h.service.crypto.currentKeyMaterial.and.returnValue(own.promise);
    const pending = h.service.sendPayload(h.conversation, { type: 'text', text: 'private' });
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    h.session.set({ user: { id: 'account-a', alias: 'alice' }, device: { id: 'replacement-phone' } });
    own.resolve({ publicJwk: {} });
    await rejected;
    expect(h.service.api.post).not.toHaveBeenCalled();
  });

  it('does not send a message after an old-account recipient directory returns', async () => {
    const h = harness();
    const directory = new Subject();
    h.routes.keys = directory;
    const pending = h.service.sendPayload(h.conversation, { type: 'text', text: 'private' });
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    await h.keysStarted.promise;
    h.switchAccount();
    directory.next([]);
    await rejected;
    expect(h.service.crypto.encryptGroupPayloadForRecipients).not.toHaveBeenCalled();
    expect(h.messagePosts().length).toBe(0);
  });

  it('does not send a message after group recipient encryption crosses account contexts', async () => {
    const h = harness();
    const sealed = deferred<any>();
    const sealing = deferred();
    h.service.crypto.encryptGroupPayloadForRecipients.and.callFake(() => { sealing.resolve(); return sealed.promise; });
    const pending = h.service.sendPayload(h.conversation, { type: 'text', text: 'private' });
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    await sealing.promise;
    h.switchAccount();
    sealed.resolve([{ ciphertext: 'sealed', header: {} }]);
    await rejected;
    expect(h.messagePosts().length).toBe(0);
  });

  it('ignores an old message response before inserting into signals or another account history', async () => {
    const h = harness();
    const response = new Subject();
    h.routes.message = response;
    const pending = h.service.sendPayload(h.conversation, { type: 'text', text: 'private' });
    const rejected = expectAsync(pending).toBeRejectedWithError(contextError);
    await h.messageStarted.promise;
    h.switchAccount();
    const newAccountMessages = { 'shared-group': [{ id: 'already-in-account-b' }] };
    h.service.messagesByConversation.set(newAccountMessages);
    response.next(sent);
    await rejected;
    expect(h.service.messagesByConversation()).toBe(newAccountMessages);
    expect(h.service.history.putMessage).not.toHaveBeenCalled();
  });

  it('does not retry a transient POST after the account changes during the retry delay', fakeAsync(() => {
    const h = harness();
    h.routes.message = throwError(() => ({ status: 503 }));
    let failure: Error | undefined;
    void h.service.sendPayload(h.conversation, { type: 'text', text: 'private' }).catch((error: Error) => { failure = error; });
    flushMicrotasks();
    expect(h.messagePosts().length).toBe(1);
    h.switchAccount();
    tick(350);
    flushMicrotasks();
    expect(failure?.message).toMatch(contextError);
    expect(h.messagePosts().length).toBe(1);
    expect(h.service.history.putMessage).not.toHaveBeenCalled();
  }));

  it('keeps a successful PNG sticker inside E2EE and persists it for its original account', async () => {
    const h = harness();
    await h.service.sendFile(h.conversation, h.file, { sticker: true, caption: '  Sticker  ' });
    const payload = h.service.crypto.encryptGroupPayloadForRecipients.calls.mostRecent().args[2];
    expect(payload.sticker).toBeTrue();
    expect(payload.voiceNote).toBeFalse();
    expect(payload.text).toBe('Sticker');
    expect(payload.fileKey).toBe('attachment-key');
    expect(h.messagePosts()[0][1].kind).toBe('Text');
    expect(h.messagePosts()[0][1].sticker).toBeUndefined();
    const saved = h.service.history.putMessage.calls.mostRecent().args;
    expect(saved[0]).toBe('account-a');
    expect(saved[1].senderUserId).toBe('account-a');
    expect(saved[1].payload.sticker).toBeTrue();
    expect(h.service.uploading()).toBeFalse();
    URL.revokeObjectURL(h.service.mediaPreviews()[record.id].url);
  });

  it('does not mark audio as a sticker even if a caller supplies the sticker option', async () => {
    const h = harness('audio/webm');
    await h.service.sendFile(h.conversation, h.file, { sticker: true, voiceNote: true });
    const payload = h.service.crypto.encryptGroupPayloadForRecipients.calls.mostRecent().args[2];
    expect(payload.sticker).toBeUndefined();
    expect(payload.voiceNote).toBeTrue();
    expect(h.service.history.putMessage.calls.mostRecent().args[1].payload.sticker).toBeUndefined();
    URL.revokeObjectURL(h.service.mediaPreviews()[record.id].url);
  });

  it('includes a sticker reply reference only inside its encrypted payload and local message', async () => {
    const h = harness();
    const replyTo = { messageId: 'quoted-message', senderUserId: 'account-b', text: 'Mensaje citado' };
    await h.service.sendFile(h.conversation, h.file, { sticker: true, policy: { replyTo } });
    const payload = h.service.crypto.encryptGroupPayloadForRecipients.calls.mostRecent().args[2];
    expect(payload.replyTo).toEqual(replyTo);
    expect(payload.sticker).toBeTrue();
    expect(payload.voiceNote).toBeFalse();
    expect(h.messagePosts()[0][1].replyTo).toBeUndefined();
    expect(h.service.history.putMessage.calls.mostRecent().args[1].payload.replyTo).toEqual(replyTo);
    URL.revokeObjectURL(h.service.mediaPreviews()[record.id].url);
  });

  it('includes a voice-note reply reference without adding a sticker flag', async () => {
    const h = harness('audio/webm');
    const replyTo = { messageId: 'quoted-message', senderUserId: 'account-b', text: 'Mensaje citado' };
    await h.service.sendFile(h.conversation, h.file, { voiceNote: true, policy: { replyTo } });
    const payload = h.service.crypto.encryptGroupPayloadForRecipients.calls.mostRecent().args[2];
    expect(payload.replyTo).toEqual(replyTo);
    expect(payload.voiceNote).toBeTrue();
    expect(payload.sticker).toBeUndefined();
    expect(h.messagePosts()[0][1].replyTo).toBeUndefined();
    expect(h.service.history.putMessage.calls.mostRecent().args[1].payload.replyTo).toEqual(replyTo);
    URL.revokeObjectURL(h.service.mediaPreviews()[record.id].url);
  });

  it('permits token/profile refresh while the account and device are unchanged', async () => {
    const h = harness();
    const response = new Subject();
    h.routes.message = response;
    const pending = h.service.sendPayload(h.conversation, { type: 'text', text: 'private' });
    await h.messageStarted.promise;
    h.session.set({ user: { id: 'account-a', alias: 'alice-new' }, device: { id: 'phone-a' }, tokens: { accessToken: 'new-token' } });
    response.next(sent);
    await pending;
    expect(h.service.history.putMessage.calls.mostRecent().args[0]).toBe('account-a');
    expect(h.service.messagesByConversation()['shared-group'][0].id).toBe(sent.id);
  });

  it('does not let a canceled upload clear the progress of the next account upload', async () => {
    const h = harness();
    const oldPrepared = deferred<any>();
    const newPrepared = deferred<any>();
    h.service.mediaOptimizer.prepareForEncryptedUpload.and.returnValues(oldPrepared.promise, newPrepared.promise);
    const oldPending = h.service.sendFile(h.conversation, h.file);
    const oldRejected = expectAsync(oldPending).toBeRejectedWithError(contextError);
    h.switchAccount();
    const newPending = h.service.sendFile(h.conversation, h.file);
    const newRejected = expectAsync(newPending).toBeRejectedWithError(contextError);
    oldPrepared.resolve({ file: h.file });
    await oldRejected;
    expect(h.service.uploading()).toBeTrue();
    expect(h.service.uploadStatus()).toBe('Optimizando y sellando (E2EE)...');
    h.session.set(null);
    newPrepared.resolve({ file: h.file });
    await newRejected;
    expect(h.service.uploading()).toBeFalse();
  });
});
