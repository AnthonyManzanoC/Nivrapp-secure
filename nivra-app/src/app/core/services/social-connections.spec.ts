import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AuthSession, Contact, FriendRequest, Story, UserSummary } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { EncryptedDownloadService } from './encrypted-download.service';
import { LocalHistoryService } from './local-history.service';
import { MediaOptimizerService } from './media-optimizer.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { SocialService } from './social.service';
import { normalizeFriendRequests } from './social-connections.helpers';

const user = (id: string, extra: Partial<UserSummary> = {}): UserSummary => ({ id, alias: id, displayName: id, isDiscoverable: true, allowStoryReposts: true, isContact: false, isMutualContact: false, isFavorite: false, friendshipState: 'none', ...extra });
const request = (id: string, from: string, to: string, status = 'Pending', date = '2026-10-25T10:00:00Z'): FriendRequest => ({ id, from: user(from), to: user(to), status, createdAt: date, updatedAt: date });
const contact = (id: string, extra: Partial<Contact> = {}): Contact => ({ userId: id, alias: id, isFavorite: false, isMutualContact: false, createdAt: '2026-10-25T10:00:00Z', ...extra });

describe('friend request relationship normalization', () => {
  it('collapses reverse-direction duplicates and keeps a genuinely newer request after removal', () => {
    const accepted = request('accepted', 'alice', 'bob', 'Accepted', '2026-10-24T10:00:00Z');
    const newer = request('new', 'bob', 'alice');
    expect(normalizeFriendRequests([accepted, newer, { ...newer }], 'alice')).toEqual([newer]);
  });
  it('does not resurrect a pending snapshot for a request already closed at the same revision', () => {
    const pending = request('one', 'bob', 'alice');
    const accepted = { ...pending, status: 'Accepted' };
    expect(normalizeFriendRequests([pending, accepted], 'alice')).toEqual([accepted]);
    expect(normalizeFriendRequests([accepted, pending], 'alice')).toEqual([accepted]);
  });
  it('retains the current pending relationship described by a newer legacy-duplicate closure', () => {
    const pending = request('current', 'bob', 'alice');
    const historical = request('duplicate', 'bob', 'alice', 'Cancelled', '2026-10-25T10:00:01Z');
    historical.from.friendshipState = 'incoming';
    expect(normalizeFriendRequests([pending, historical], 'alice')).toEqual([pending]);
  });
  it('ignores unrelated accounts and malformed requests', () => {
    expect(normalizeFriendRequests([request('foreign', 'other', 'another'), {} as FriendRequest], 'alice')).toEqual([]);
  });
});

describe('social contacts, requests and profile privacy', () => {
  let service: SocialService;
  let api: jasmine.SpyObj<NivraApiService>;
  let session: ReturnType<typeof signal<AuthSession | null>>;
  let events: Subject<{ type: string; payload: unknown }>;
  let contacts: Contact[];
  let requests: FriendRequest[];
  const account = (id = 'alice', device = 'phone') => ({ user: user(id), device: { id: device }, tokens: {} }) as unknown as AuthSession;
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
  beforeEach(() => {
    contacts = []; requests = []; session = signal<AuthSession | null>(account()); events = new Subject();
    api = jasmine.createSpyObj<NivraApiService>('api', ['get', 'post', 'patch', 'delete']);
    api.get.and.callFake((path: string) => of(path === '/contacts' ? contacts : path === '/friends/requests' ? requests : []) as never);
    TestBed.configureTestingModule({ providers: [
      SocialService, { provide: NivraApiService, useValue: api }, { provide: AuthService, useValue: { session, isAuthenticated: () => !!session() } },
      { provide: SignalrService, useValue: { events$: events } }, { provide: CryptoService, useValue: {} },
      { provide: LocalHistoryService, useValue: { stories: async () => [], putStories: async () => undefined } },
      { provide: MediaOptimizerService, useValue: {} }, { provide: EncryptedDownloadService, useValue: {} },
    ] });
    service = TestBed.inject(SocialService);
  });
  afterEach(() => TestBed.resetTestingModule());

  it('separates actionable incoming and outgoing requests from closed history', async () => {
    requests = [request('in', 'bob', 'alice'), request('out', 'alice', 'carol'), request('closed', 'dana', 'alice', 'Accepted')];
    await service.loadConnections();
    expect(service.incomingRequests().map(item => item.id)).toEqual(['in']);
    expect(service.outgoingRequests().map(item => item.id)).toEqual(['out']);
    expect(service.requestHistory().map(item => item.id)).toEqual(['closed']);
  });

  it('coalesces a double accept and refuses a conflicting action while the first POST is pending', async () => {
    const incoming = request('in', 'bob', 'alice');
    service.friendRequests.set([incoming]);
    const response = new Subject<FriendRequest>(); api.post.and.returnValue(response as never);
    const first = service.accept('in'); const duplicate = service.accept('in');
    expect(first).toBe(duplicate);
    await expectAsync(service.reject('in')).toBeRejectedWithError(/acción en curso/);
    expect(api.post).toHaveBeenCalledTimes(1);
    const accepted = { ...incoming, status: 'Accepted', updatedAt: '2026-10-25T11:00:00Z', from: user('bob', { isMutualContact: true, friendshipState: 'friends' }) };
    requests = [accepted]; contacts = [contact('bob', { isMutualContact: true })];
    response.next(accepted); response.complete(); await first; await settle();
    expect(service.incomingRequests()).toEqual([]);
    expect(service.requestHistory()[0].status).toBe('Accepted');
    expect(service.connectionActions()).toEqual([]);
  });

  it('does not revive legacy pending rows for a currently mutual contact', async () => {
    requests = [{ ...request('old-pending', 'bob', 'alice'), from: user('bob', { isMutualContact: true, friendshipState: 'friends' }) }];
    await service.loadConnections();
    expect(service.incomingRequests()).toEqual([]);
    expect(service.outgoingRequests()).toEqual([]);
  });

  it('does not accept an outgoing request or cancel an incoming one', async () => {
    service.friendRequests.set([request('in', 'bob', 'alice'), request('out', 'alice', 'carol')]);
    await service.accept('out'); await service.cancel('in');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps a committed acceptance when an older HTTP snapshot finishes later', async () => {
    const incoming = request('in', 'bob', 'alice'); service.friendRequests.set([incoming]);
    const oldRequests = new Subject<FriendRequest[]>(); let firstRead = true;
    api.get.and.callFake((path: string) => {
      if (path === '/friends/requests' && firstRead) { firstRead = false; return oldRequests as never; }
      return of(path === '/friends/requests' ? requests : contacts) as never;
    });
    const loading = service.loadConnections();
    const accepted = { ...incoming, status: 'Accepted', updatedAt: '2026-10-25T11:00:00Z' };
    requests = [accepted]; api.post.and.returnValue(of(accepted) as never);
    await service.accept('in');
    oldRequests.next([incoming]); oldRequests.complete(); await loading; await settle();
    expect(service.incomingRequests()).toEqual([]);
    expect(service.requestHistory()[0].id).toBe('in');
    expect(service.requestHistory()[0].status).toBe('Accepted');
  });

  it('does not revive an accepted request after a delayed pending realtime event', async () => {
    const accepted = request('in', 'bob', 'alice', 'Accepted', '2026-10-25T11:00:00Z');
    service.friendRequests.set([accepted]); requests = [accepted];
    events.next({ type: 'friend.requested', payload: request('in', 'bob', 'alice') });
    expect(service.incomingRequests()).toEqual([]);
    await service.loadConnections();
    expect(service.incomingRequests()).toEqual([]);
  });

  it('ignores out-of-order search results and invalidates a query when input is cleared', async () => {
    const older = new Subject<{ people: UserSummary[] }>(); const newer = new Subject<{ people: UserSummary[] }>();
    api.get.and.returnValues(older as never, newer as never);
    const first = service.search('old'); const second = service.search('new');
    newer.next({ people: [user('new')] }); newer.complete(); await second;
    older.next({ people: [user('old')] }); older.complete(); await first;
    expect(service.people().map(item => item.id)).toEqual(['new']);
    const late = new Subject<{ people: UserSummary[] }>(); api.get.and.returnValue(late as never);
    const pending = service.search('late'); await service.search('');
    late.next({ people: [user('late')] }); late.complete(); await pending;
    expect(service.people()).toEqual([]);
  });

  it('clears photo and phone immediately everywhere and prevents an older search from restoring them', async () => {
    const person = user('bob', { profilePhotoDataUrl: 'data:image/png;base64,old', phone: '+5700000000' });
    service.people.set([person]); service.radarMatches.set([person]); service.contacts.set([contact('bob', person)]);
    service.friendRequests.set([{ ...request('in', 'bob', 'alice'), from: person }]);
    const story = { id: 'story', owner: person, visibility: 'Contacts', encryptedPayload: '', allowedUserIds: [], viewOnce: false, allowReposts: false, viewedByMe: false, viewCount: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } as Story;
    service.stories.set([story]); service.worldStories.set([story]); service.activeStory.set(story);
    const oldSearch = new Subject<{ people: UserSummary[] }>();
    api.get.and.callFake((path: string) => path.startsWith('/directory') ? oldSearch as never : of(path === '/contacts' ? [contact('bob', { profilePhotoDataUrl: null, phone: null })] : []) as never);
    const searching = service.search('bob');
    events.next({ type: 'profile.updated', payload: { userId: 'bob', profilePhotoDataUrl: null, phone: null } });
    expect(service.people()[0].profilePhotoDataUrl).toBeNull(); expect(service.radarMatches()[0].phone).toBeNull();
    expect(service.contacts()[0].profilePhotoDataUrl).toBeNull(); expect(service.friendRequests()[0].from.phone).toBeNull();
    expect(service.stories()[0].owner.profilePhotoDataUrl).toBeNull(); expect(service.worldStories()[0].owner.phone).toBeNull(); expect(service.activeStory()?.owner.profilePhotoDataUrl).toBeNull();
    oldSearch.next({ people: [person] }); oldSearch.complete(); await searching; await settle();
    expect(service.people()[0].profilePhotoDataUrl).toBeNull(); expect(service.people()[0].phone).toBeNull();
  });

  it('discards a social action after account switching, including switching back to the original account', async () => {
    const incoming = request('in', 'bob', 'alice'); service.friendRequests.set([incoming]);
    const response = new Subject<FriendRequest>(); api.post.and.returnValue(response as never);
    const pending = service.accept('in');
    session.set(account('other')); TestBed.flushEffects(); session.set(account()); TestBed.flushEffects();
    response.next({ ...incoming, status: 'Accepted' }); response.complete();
    await expectAsync(pending).toBeRejectedWithError(/sesión cambió/);
    expect(service.friendRequests()).toEqual([]); expect(service.connectionActions()).toEqual([]); expect(api.get).not.toHaveBeenCalled();
  });

  it('retains existing contacts on refresh failure and exposes a retry state', async () => {
    service.contacts.set([contact('bob')]);
    api.get.and.returnValue(throwError(() => new Error('offline')) as never);
    await service.loadConnections();
    expect(service.contacts().map(item => item.userId)).toEqual(['bob']);
    expect(service.connectionsError()).toBeTruthy(); expect(service.contactsLoading()).toBeFalse(); expect(service.requestsLoading()).toBeFalse();
  });

  it('coalesces friendship events without loading all story feeds', async () => {
    requests = [request('in', 'bob', 'alice')];
    for (let index = 0; index < 30; index++) events.next({ type: 'friend.updated', payload: requests[0] });
    await service.loadConnections(); await settle();
    expect(api.get.calls.allArgs().every(([path]) => path === '/contacts' || path === '/friends/requests')).toBeTrue();
    expect(api.get.calls.count()).toBeLessThanOrEqual(4);
  });
});
