import { signal } from '@angular/core';
import { of } from 'rxjs';
import { ChatService } from './chat.service';

describe('encrypted call summaries', () => {
  const conversation: any = { id: 'group', type: 'Group', participants: [{ userId: 'alice' }, { userId: 'bob' }] };
  const call: any = { id: 'cal_test', conversationId: 'group', initiatorUserId: 'alice', type: 'Video', startedAt: '2026-10-09T10:00:00Z', endedAt: '2026-10-09T10:01:00Z' };

  function harness() {
    const service: any = Object.create(ChatService.prototype);
    service.auth = { session: signal({ user: { id: 'bob', alias: 'bob' }, device: { id: 'phone-b' } }) };
    service.conversations = signal([conversation]);
    service.isConversationBlocked = () => false;
    service.canSendToConversation = () => false;
    service.normalizeOutgoingPayload = (_conversation: unknown, payload: unknown) => payload;
    service.withUniformMessagePadding = (payload: unknown) => payload;
    service.encryptedRecipients = jasmine.createSpy().and.resolveTo([{ userId: 'bob', deviceId: 'phone-b', ciphertext: 'authenticated-ciphertext' }]);
    service.ingestLocalSent = jasmine.createSpy().and.resolveTo();
    service.ingestMessage = jasmine.createSpy().and.resolveTo();
    service.api = { post: jasmine.createSpy().and.returnValue(of({ id: 'summary', senderUserId: 'alice', conversationId: 'group', recipients: [] })) };
    return service;
  }

  it('uses one stable identifier for an observed call event while encrypting its description', async () => {
    const service = harness();
    await service.recordCallSystemMessage(call, 'call-ended', 60_000);
    await service.recordCallSystemMessage(call, 'call-ended', 60_000);
    const first = service.api.post.calls.argsFor(0)[1];
    const second = service.api.post.calls.argsFor(1)[1];
    expect(first.clientMessageId).toBe('call-summary:cal_test:call-ended');
    expect(first.clientMessageId).toBe(second.clientMessageId);
    expect(first.kind).toBe('System');
    expect(first.title).toBeUndefined();
    expect(first.durationMs).toBeUndefined();
    expect(service.encryptedRecipients.calls.argsFor(0)[1].callId).toBe(call.id);
  });

  it('decrypts the persisted winner instead of ingesting a losing writer payload as its own', async () => {
    const service = harness();
    await service.recordCallSystemMessage(call, 'call-ended', 60_000);
    expect(service.ingestMessage).toHaveBeenCalledWith(jasmine.objectContaining({ senderUserId: 'alice' }), false);
    expect(service.ingestLocalSent).not.toHaveBeenCalled();
  });

  it('retains normal group message permissions while allowing a call summary from a remaining participant', async () => {
    const service = harness();
    await expectAsync(service.sendPayload(conversation, { type: 'text', text: 'hello' })).toBeRejectedWithError(/Solo los admins/);
    expect(service.api.post).not.toHaveBeenCalled();
    await expectAsync(service.recordCallSystemMessage(call, 'call-ended', 60_000)).toBeResolved();
  });
});
