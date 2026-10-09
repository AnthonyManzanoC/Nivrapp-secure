import { ChatMessageVm, Conversation, Participant } from '../../core/models/nivra.models';
import { ChatDetailPage } from './chat-detail.page';

describe('Chat profile interactions', () => {
  const member = (userId: string, displayName: string, extra: Partial<Participant> = {}): Participant => ({
    userId, displayName, role: 'member', canInvite: false, canChangePrivacy: false, joinedAt: '2026-10-06', ...extra,
  });
  const message = (id: string, fileMime: string, extra: Partial<ChatMessageVm> = {}): ChatMessageVm => ({
    id, conversationId: 'chat', mine: false, senderUserId: 'peer', at: '2026-10-06',
    payload: { type: 'file', fileId: id, fileMime }, ...extra,
  });

  function fixture() {
    const page = Object.create(ChatDetailPage.prototype) as ChatDetailPage;
    let session = { user: { id: 'me' }, device: { id: 'phone' } };
    let conversation: Conversation = {
      id: 'chat', type: 'Direct', privacySettings: {}, participants: [member('me', 'Yo'), member('peer', 'Lucía')], createdAt: 'now', updatedAt: 'now',
    };
    const navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    Object.assign(page, {
      conversation: () => conversation,
      auth: { session: () => session },
      router: { url: '/app/chats/chat?source=notification', navigate },
      verificationDraft: { save: jasmine.createSpy('save'), discard: jasmine.createSpy('discard') },
      draft: 'Borrador sin enviar',
      chat: {
        isGroup: (chat: Conversation) => chat.type === 'Group',
        isGroupAdmin: () => false,
        participantDisplayName: (_id: string, person: Participant) => person.displayName,
        participantAlias: (_id: string, person: Participant) => person.alias || '',
        asFile: (payload: any) => payload.type === 'file' ? payload : null,
        isImage: (file: any) => String(file.fileMime || '').startsWith('image/'),
        isVideo: (file: any) => String(file.fileMime || '').startsWith('video/'),
        isAudio: (file: any) => String(file.fileMime || '').startsWith('audio/'),
        isViewOnceOpened: () => false,
      },
      translate: { instant: (_key: string, fallback: string) => fallback },
      contactInfoOpen: true,
      contactInfoDismissTimer: null,
      contactInfoDismissPromise: null,
      profileParticipantQuery: '',
      profileMediaFilter: 'all',
      profileActionBusy: false,
    });
    return { page, navigate, setSession: (userId: string, deviceId = 'phone') => { session = { user: { id: userId }, device: { id: deviceId } }; }, setConversation: (value: Conversation) => { conversation = value; } };
  }

  it('finds active members by names, aliases and phone while ignoring accents', () => {
    const { page, setConversation } = fixture();
    setConversation({ id: 'chat', type: 'Group', privacySettings: {}, participants: [member('active', 'Lucía Gómez', { alias: '@luci', phone: '+593123' }), member('removed', 'Lucía', { removedAt: 'now' })], createdAt: 'now', updatedAt: 'now' });
    page.profileParticipantQuery = ' LUCIA ';
    expect(page.profileParticipants().map(person => person.userId)).toEqual(['active']);
    page.profileParticipantQuery = 'LUCI';
    expect(page.profileParticipants().map(person => person.userId)).toEqual(['active']);
    page.profileParticipantQuery = '593';
    expect(page.profileParticipants().map(person => person.userId)).toEqual(['active']);
    page.profileParticipantQuery = 'missing';
    expect(page.profileParticipants()).toEqual([]);
  });

  it('filters eligible media without opening pending view-once files', () => {
    const { page } = fixture();
    Object.assign(page, { messages: () => [message('image', 'image/png'), message('video', 'video/mp4'), message('audio', 'audio/mp4'), message('voice', 'application/octet-stream', { payload: { type: 'file', fileId: 'voice', voiceNote: true } }), message('once', 'image/png', { deleteAfterRead: true })] });
    page.profileMediaFilter = 'image';
    expect(page.profileMediaMessages().map(item => item.id)).toEqual(['image']);
    page.profileMediaFilter = 'video';
    expect(page.profileMediaMessages().map(item => item.id)).toEqual(['video']);
    page.profileMediaFilter = 'audio';
    expect(page.profileMediaMessages().map(item => item.id)).toEqual(['voice', 'audio']);
    page.profileMediaFilter = 'all';
    expect(page.profileMediaMessages().map(item => item.id)).toEqual(['voice', 'audio', 'video', 'image']);
  });

  it('waits for the modal to close before verification and preserves the exact chat route', async () => {
    const { page, navigate } = fixture();
    const action = page.verifyProfileIdentity();
    expect(page.contactInfoOpen).toBeFalse();
    expect(navigate).not.toHaveBeenCalled();
    page.onContactInfoDidDismiss();
    await action;
    expect(navigate).toHaveBeenCalledOnceWith(['/app/identity', 'peer'], { state: { identityReturnUrl: '/app/chats/chat?source=notification' } });
    expect((page as unknown as { verificationDraft: { save: jasmine.Spy } }).verificationDraft.save).toHaveBeenCalledOnceWith('chat', 'Borrador sin enviar');
    expect(page.profileActionBusy).toBeFalse();
  });

  it('does not verify a contact after the local account changes during dismissal', async () => {
    const { page, navigate, setSession } = fixture();
    const action = page.verifyProfileIdentity();
    setSession('other-account');
    page.onContactInfoDidDismiss();
    await action;
    expect(navigate).not.toHaveBeenCalled();
  });

  it('starts one call after dismissal and rejects a simultaneous double tap', async () => {
    const { page } = fixture();
    const start = spyOn(page, 'startCall').and.resolveTo();
    const first = page.startProfileCall('Video');
    const second = page.startProfileCall('Voice');
    expect(start).not.toHaveBeenCalled();
    page.onContactInfoDidDismiss();
    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledOnceWith('Video');
  });

  it('does not start a call after the device changes during modal dismissal', async () => {
    const { page, setSession } = fixture();
    const start = spyOn(page, 'startCall').and.resolveTo();
    const action = page.startProfileCall('Video');
    setSession('me', 'other-device');
    page.onContactInfoDidDismiss();
    await action;
    expect(start).not.toHaveBeenCalled();
  });

  it('cancels pending profile navigation when the chat page is destroyed', async () => {
    const { page, navigate } = fixture();
    const action = page.verifyProfileIdentity();
    Object.assign(page, { destroyed: true });
    page.onContactInfoDidDismiss();
    await action;
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cancels a pending profile call when the chat page is destroyed', async () => {
    const { page } = fixture();
    const start = spyOn(page, 'startCall').and.resolveTo();
    const action = page.startProfileCall('Video');
    Object.assign(page, { destroyed: true });
    page.onContactInfoDidDismiss();
    await action;
    expect(start).not.toHaveBeenCalled();
  });
});
