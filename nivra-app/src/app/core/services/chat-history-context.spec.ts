import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ChatService } from './chat.service';

describe('history ingestion stays bound to the requesting session', () => {
  const session = (userId = 'alice', deviceId = 'new-browser') => ({ user: { id: userId, alias: userId }, device: { id: deviceId } });
  function harness() {
    const auth = { session: signal<any>(session()) };
    const service: any = Object.assign(Object.create(ChatService.prototype), {
      auth, pendingHistoryEnvelopes: new Map(), readReceiptSentIds: new Set(),
      deviceHistory: { requestHistory: jasmine.createSpy('requestHistory') },
      decryptOwnRecipientPayload: jasmine.createSpy('decrypt').and.resolveTo(null), cachedReadableMessage: async () => null,
      stripMessagePadding: (payload: any) => payload, viewOnceOpenedReceipt: () => null,
      upsertMessage: jasmine.createSpy('upsert'), conversationPaging: signal({}),
      refreshConversationPageState: jasmine.createSpy('refresh'),
    });
    return { service, auth };
  }
  const message = (id = 'old') => ({ id, conversationId: 'conversation', senderUserId: 'peer', senderDeviceId: 'peer-device', serverReceivedAt: '2026-01-01T00:00:00Z', recipients: [{ userId: 'alice', deviceId: 'previous-device', header: 'encrypted-header', ciphertext: 'opaque-ciphertext' }], receipts: [] });

  it('keeps an old encrypted envelope visible and requests authorized history instead of silently omitting it', async () => {
    const { service } = harness(); const old = message();
    expect(await service.ingestMessage(old, false)).toBeFalse();
    expect(service.pendingHistoryEnvelopes.get(old.id)).toBe(old);
    expect(service.deviceHistory.requestHistory).toHaveBeenCalledTimes(1);
    const vm = service.upsertMessage.calls.first().args[0];
    expect(vm.decryptError).toBeTrue(); expect(vm.payload.title).toBe('Historial protegido');
  });

  it('does not ingest another message from an old batch after account switches during decryption', async () => {
    const { service, auth } = harness();
    service.decryptOwnRecipientPayload.and.callFake(async () => { auth.session.set(session('bob', 'other-browser')); return null; });
    expect(await service.ingestMessageBatch([message('one'), message('two')], false)).toBeFalse();
    expect(service.decryptOwnRecipientPayload).toHaveBeenCalledTimes(1);
    expect(service.upsertMessage).not.toHaveBeenCalled(); expect(service.deviceHistory.requestHistory).not.toHaveBeenCalled();
  });

  it('discards a remote page whose response arrives after logout or account switch', async () => {
    const { service, auth } = harness(); const response = new Subject<any[]>();
    service.api = { get: () => response }; service.ingestMessageBatch = jasmine.createSpy('batch').and.resolveTo(true);
    const pending = service.loadRemoteMessagesPage('conversation'); auth.session.set(session('bob', 'other-browser'));
    response.next([message()]); response.complete();
    expect(await pending).toEqual([]); expect(service.ingestMessageBatch).not.toHaveBeenCalled(); expect(service.refreshConversationPageState).not.toHaveBeenCalled();
  });

  it('never adds metadata from an envelope belonging exclusively to a different account', async () => {
    const { service } = harness(); const foreign = { ...message(), recipients: [{ userId: 'bob', deviceId: 'other', ciphertext: 'foreign' }] };
    expect(await service.ingestMessage(foreign, false)).toBeFalse();
    expect(service.decryptOwnRecipientPayload).not.toHaveBeenCalled(); expect(service.upsertMessage).not.toHaveBeenCalled();
  });
});
