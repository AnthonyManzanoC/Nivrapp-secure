import { of, throwError } from 'rxjs';
import { ChatMessageVm, Conversation } from '../models/nivra.models';
import { ChatService } from './chat.service';

describe('Optional group history at admission', () => {
  const joined = '2026-11-24T10:00:00Z';
  const owner = { userId: 'author', role: 'Owner', canInvite: true, canChangePrivacy: true, joinedAt: '2026-11-01T10:00:00Z' };
  const member = { userId: 'new', role: 'Member', canInvite: false, canChangePrivacy: false, joinedAt: joined };
  const conversation = { id: 'group', type: 'Group', participants: [owner] } as Conversation;
  const approved = { ...conversation, groupManagementVersion: 1, participants: [owner, member] };

  function wire() {
    const source: ChatMessageVm = { id: 'm-1', conversationId: 'group', mine: true, senderUserId: 'author',
      at: '2026-11-23T10:00:00Z', payload: { type: 'text', text: 'Texto del autor' } };
    const api = jasmine.createSpy('api').and.returnValue(of(approved));
    const save = jasmine.createSpy('save').and.resolveTo();
    const send = jasmine.createSpy('send').and.resolveTo({ id: 'sent-summary' });
    const chat: ChatService = Object.assign(Object.create(ChatService.prototype), {
      api: { post: api }, setGroupConversationLocal: save, sendPayload: send,
      canAddGroupMembers: () => true, captureSendContext: () => ({ userId: 'author', deviceId: 'author-device' }),
      assertSendContext: () => undefined, assertPrivateChatUnlocked: () => undefined, isGroupAdmin: () => true,
      mergeGroupConversationConfirmation: (_local: Conversation, confirmed: Conversation) => confirmed,
      messagesByConversation: () => ({ group: [source, { ...source, id: 'once', deleteAfterRead: true },
        { ...source, id: 'soon', expiresAt: '2026-11-25T10:00:00Z' }, { ...source, id: 'other', mine: false },
        { ...source, id: 'reply', payload: { ...source.payload, replyTo: { messageId: 'quoted' } } }] }),
    });
    return { chat, api, save, send };
  }

  it('adds a member without sending history by default', async () => {
    const { chat, send } = wire();
    expect(await chat.addGroupParticipants(conversation, ['new'])).toBe('added');
    expect(send).not.toHaveBeenCalled();
  });

  it('admits a member on an older server without attempting to share prior messages', async () => {
    const { chat, api, send } = wire();
    api.and.returnValue(of({ ...approved, groupManagementVersion: undefined }));
    expect(await chat.addGroupParticipants(conversation, ['new'], true)).toBe('history-unavailable');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends only eligible authored text to the explicitly selected member after admission', async () => {
    const { chat, save, send } = wire();
    expect(await chat.addGroupParticipants(conversation, ['new'], true)).toBe('shared');
    expect(save).toHaveBeenCalledBefore(send);
    expect(send.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ groupHistorySummary: true, forwardingAllowed: false }));
    expect(send.calls.mostRecent().args[4]).toEqual(jasmine.objectContaining({
      clientMessageId: jasmine.stringMatching(/^group-history:[a-f0-9]{64}$/),
      groupHistory: { recipientUserId: 'new', sourceMessageIds: ['m-1'] },
    }));
  });

  it('separates a failed encrypted delivery from confirmed membership', async () => {
    const { chat, api, save, send } = wire();
    send.and.rejectWith(new Error('device unavailable'));
    expect(await chat.addGroupParticipants(conversation, ['new'], true)).toBe('history-unavailable');
    expect(save).toHaveBeenCalledTimes(1);
    api.and.returnValue(throwError(() => new Error('forbidden')));
    await expectAsync(chat.addGroupParticipants(conversation, ['new'], true)).toBeRejectedWithError('forbidden');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
