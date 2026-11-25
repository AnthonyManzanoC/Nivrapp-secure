import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { Conversation } from '../models/nivra.models';
import { ChatService } from './chat.service';

describe('group creation confirmation', () => {
  const draft = { name: 'Grupo de prueba', participantUserIds: ['peer'] };
  const account = (id: string) => ({ user: { id }, device: { id: `${id}-phone` } });
  const response = {
    id: 'server-group', type: 'Group', groupName: 'Nombre confirmado',
    participants: [{ userId: 'owner', role: 'Owner' }, { userId: 'peer', role: 'Member' }],
  } as Conversation;

  function fixture() {
    const session = signal(account('owner'));
    const post = jasmine.createSpy('post');
    const get = jasmine.createSpy('get');
    const put = jasmine.createSpy('put');
    const conversations = signal<Conversation[]>([]);
    const selectConversation = jasmine.createSpy('selectConversation').and.resolveTo();
    const putConversations = jasmine.createSpy('putConversations').and.resolveTo();
    const service: ChatService = Object.assign(Object.create(ChatService.prototype), {
      auth: { session }, api: { post, get, put }, conversations, selectConversation,
      history: { putConversations }, localAccountKey: () => 'test-account',
      applyLocalConversationState: (items: Conversation[]) => items,
      rememberConversationParticipants: jasmine.createSpy(), hydrateConversationProfiles: jasmine.createSpy(),
    });
    return { service, session, post, get, put, conversations, selectConversation, putConversations };
  }

  it('surfaces an unavailable server without creating or selecting a local group', async () => {
    const { service, post, conversations, selectConversation, putConversations } = fixture();
    const offline = new HttpErrorResponse({ status: 503 });
    post.and.returnValue(throwError(() => offline));
    await expectAsync(service.createGroupConversation(draft)).toBeRejectedWith(offline);
    expect(conversations()).toEqual([]);
    expect(selectConversation).not.toHaveBeenCalled();
    expect(putConversations).not.toHaveBeenCalled();
  });

  it('uses only the membership confirmed by the server', async () => {
    const { service, post, conversations, selectConversation } = fixture();
    post.and.returnValue(of(response));
    const group = await service.createGroupConversation({ ...draft, participantUserIds: ['owner', ' peer ', 'unconfirmed'] });
    expect(group.participants.map(participant => participant.userId)).toEqual(['owner', 'peer']);
    expect(conversations()).toEqual([response]);
    expect(selectConversation).toHaveBeenCalledOnceWith('server-group');
  });

  it('ignores confirmation arriving after a session switch', async () => {
    const { service, session, post, conversations, putConversations } = fixture();
    const pending = new Subject<Conversation>();
    post.and.returnValue(pending);
    const result = service.createGroupConversation(draft);
    session.set(account('different'));
    pending.next(response);
    await expectAsync(result).toBeRejectedWithError(/cuenta o el dispositivo/);
    expect(conversations()).toEqual([]);
    expect(putConversations).not.toHaveBeenCalled();
  });

  it('preserves other administrators when the legacy server requires the complete role list', async () => {
    const { service, get, put } = fixture();
    const existing = { ...response, participants: [...response.participants,
      { ...response.participants[1], userId: 'existing-moderator', role: 'Admin' }] };
    get.and.returnValue(of(existing));
    put.and.returnValue(of(existing));
    await service.setGroupParticipantAdmin(response, 'peer', true);
    expect(get).toHaveBeenCalledOnceWith('/conversations/server-group');
    expect(put).toHaveBeenCalledOnceWith('/conversations/server-group/roles', {
      adminUserIds: ['owner', 'existing-moderator', 'peer'],
    });
  });

  it('uses the new route for a single role so a legacy API cannot interpret it as an empty list', async () => {
    const { service, get, put } = fixture();
    const modern = { ...response, groupManagementVersion: 1 };
    put.and.returnValue(of(modern));
    await service.setGroupParticipantAdmin(modern, 'peer', true);
    expect(get).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnceWith('/conversations/server-group/roles/participant', { participantUserId: 'peer', admin: true });
  });
});
