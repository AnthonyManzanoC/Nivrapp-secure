import { signal } from '@angular/core';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';

describe('local key availability and remote history requests', () => {
  const key = { publicJwk: { kty: 'EC' }, privateJwk: { kty: 'EC', d: 'local-private' } };
  function harness() {
    return Object.assign(Object.create(ChatService.prototype), {
      auth: { session: signal({ user: { id: 'alice', alias: 'alice' }, device: { id: 'phone' } }) },
      crypto: { currentKeyMaterial: jasmine.createSpy('currentKey').and.resolveTo(key),
        deviceKeyMaterialsForUser: jasmine.createSpy('historicalKeys').and.resolveTo([]),
        decryptEnvelope: jasmine.createSpy('decrypt').and.rejectWith(new Error('Cannot decrypt this envelope')) },
      removedHistoryMessageIds: new Set(), conversationHistoryGenerations: new Map(), pendingHistoryEnvelopes: new Map(),
      messagesByConversation: signal({}),
      deviceHistory: { requestHistory: jasmine.createSpy('requestHistory').and.resolveTo() },
      upsertMessage: jasmine.createSpy('upsert'),
    }) as any;
  }
  const envelope = { id: 'message', conversationId: 'chat', senderUserId: 'bob',
    recipients: [{ userId: 'alice', deviceId: 'phone', header: 'sealed-header', ciphertext: 'sealed' }] };

  it('does not turn a locked local Keystore into a remote approval request or a protected placeholder', async () => {
    const service = harness();
    service.crypto.currentKeyMaterial.and.rejectWith(new Error('Keystore is locked'));
    await expectAsync(service.ingestMessage(envelope, false)).toBeRejectedWithError('Keystore is locked');
    expect(service.deviceHistory.requestHistory).not.toHaveBeenCalled();
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
    expect(service.upsertMessage).not.toHaveBeenCalled();
  });

  it('does not interpret an unavailable historical-key store as an empty keyring', async () => {
    const service = harness();
    service.crypto.deviceKeyMaterialsForUser.and.rejectWith(new Error('Key database unavailable'));
    await expectAsync(service.ingestMessage(envelope, false)).toBeRejectedWithError('Key database unavailable');
    expect(service.deviceHistory.requestHistory).not.toHaveBeenCalled();
    expect(service.pendingHistoryEnvelopes.size).toBe(0);
  });

  it('reads a current phone envelope without opening the historical-key index', async () => {
    const service = harness(); const payload = { type: 'text', text: 'Available on my habitual device' };
    service.crypto.decryptEnvelope.and.resolveTo(payload);
    service.crypto.deviceKeyMaterialsForUser.and.rejectWith(new Error('Historical index unavailable'));
    expect(await service.decryptOwnRecipientPayload('alice', 'alice', 'phone', envelope.recipients)).toBe(payload);
    expect(service.crypto.deviceKeyMaterialsForUser).not.toHaveBeenCalled();
    expect(service.deviceHistory.requestHistory).not.toHaveBeenCalled();
  });

  it('does not request history for an empty new conversation', async () => {
    const service = harness();
    expect(await service.ingestMessageBatch([], false)).toBeTrue();
    expect(service.crypto.currentKeyMaterial).not.toHaveBeenCalled();
    expect(service.deviceHistory.requestHistory).not.toHaveBeenCalled();
  });

  it('tries each retained identity once with real authenticated encryption and keeps the original keys intact', async () => {
    const service = harness();
    const cryptography: any = Object.assign(Object.create(CryptoService.prototype), { yieldToMainThread: async () => undefined });
    const own = await cryptography.createDeviceKeys(), older = await cryptography.createDeviceKeys(), peer = await cryptography.createDeviceKeys();
    const before = JSON.stringify([own, older]);
    const sealed = await cryptography.encryptForPublicKey(peer, older.publicJwk, { type: 'text', text: 'Older readable history' });
    service.crypto.currentKeyMaterial.and.resolveTo(own);
    service.crypto.deviceKeyMaterialsForUser.and.resolveTo([own, older]);
    service.crypto.decryptEnvelope.and.callFake((key: any, header: string, ciphertext: string) => cryptography.decryptEnvelope(key, header, ciphertext));
    const recipients = [{ userId: 'alice', deviceId: 'old-phone', ...sealed }];
    expect(await service.decryptOwnRecipientPayload('alice', 'alice', 'phone', recipients)).toEqual({ type: 'text', text: 'Older readable history' });
    expect(service.crypto.decryptEnvelope).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([own, older])).toBe(before);
    service.crypto.decryptEnvelope.calls.reset(); service.crypto.deviceKeyMaterialsForUser.and.resolveTo([own]);
    expect(await service.decryptOwnRecipientPayload('alice', 'alice', 'phone', recipients)).toBeNull();
    expect(service.crypto.decryptEnvelope).toHaveBeenCalledTimes(1);
    expect(service.deviceHistory.requestHistory).not.toHaveBeenCalled();
  });
});
