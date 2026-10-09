import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { ChatService } from './chat.service';

describe('chat profile continuity during recovery', () => {
  const cachedAt = '2026-10-04T12:00:00Z';
  const rich = { userId: 'peer', alias: 'alias', displayName: 'Nombre completo', profilePhotoDataUrl: 'data:image/png;base64,PHOTO', cachedAt };

  function harness() {
    const service: any = Object.create(ChatService.prototype);
    service.profilesByUserId = signal({ peer: { ...rich } });
    service.contacts = signal([{ ...rich }]);
    service.directoryResults = signal([]);
    service.profileFetchInFlight = new Set();
    service.profileSources = new Map();
    service.launchCacheEpoch = 0;
    service.auth = { session: signal({ user: { id: 'self', alias: 'self' }, device: { id: 'browser' } }) };
    service.history = { putProfiles: jasmine.createSpy('putProfiles').and.resolveTo() };
    service.api = { get: jasmine.createSpy('get').and.returnValue(of({ id: 'peer', alias: 'alias', displayName: 'Nombre completo', profilePhotoDataUrl: null })) };
    return service;
  }

  it('keeps names and photos when a bootstrap participant only supplies an alias and empty fields', () => {
    const service = harness();
    service.rememberConversationParticipants([{ participants: [{ userId: 'peer', alias: 'alias', displayName: null, profilePhotoDataUrl: null }] }]);

    expect(service.profilesByUserId().peer.displayName).toBe(rich.displayName);
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
    expect(service.profilesByUserId().peer.cachedAt).toBe(cachedAt);
    expect(service.contacts()[0].profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
    expect(service.history.putProfiles.calls.mostRecent().args[0][0].profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
  });

  it('does not overwrite a hydrated profile when a delayed cache read supplies older fields', () => {
    const service = harness();
    service.rememberProfiles([{ userId: 'peer', displayName: 'Nombre antiguo', profilePhotoDataUrl: 'old-photo' }], false, 'cache');
    expect(service.profilesByUserId().peer.displayName).toBe(rich.displayName);
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
    service.rememberProfiles([{ userId: 'peer', displayName: null, profilePhotoDataUrl: null, cachedAt: '2026-10-05T12:00:00Z' }], false, 'cache');
    expect(service.profilesByUserId().peer.displayName).toBe(rich.displayName);
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
  });

  it('treats bootstrap contacts as authoritative while preserving fields a payload actually omits', async () => {
    const service = harness();
    service.loading = signal(false);
    service.conversations = signal([]);
    service.remoteIndexRevision = 0;
    service.auth.isAuthenticated = () => true;
    service.auth.ensureFreshSession = async () => true;
    service.applyLocalConversationState = (items: unknown[]) => items;
    service.history.clearStorageError = () => undefined;
    for (const method of ['restoreSelectedConversationId', 'ensureSelectedConversation']) service[method] = () => undefined;
    for (const method of ['loadLaunchCache', 'loadCachedChatIndex', 'loadCachedSelectedMessages', 'purgeExpiredLocalMessages',
      'persistChatIndex', 'hydrateConversationProfiles', 'ackDelivered', 'rememberSyncWatermark', 'refreshPresenceForConversations']) {
      service[method] = async () => undefined;
    }
    service.ingestMessageBatch = async () => true;
    service.api.get.and.returnValue(of({ contacts: [{ userId: 'peer', alias: 'alias' }], conversations: [], messages: [] }));
    await service.bootstrapCore();
    expect(service.profilesByUserId().peer.displayName).toBe(rich.displayName);
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);

    service.api.get.and.returnValue(of({
      contacts: [{ userId: 'peer', alias: 'alias', displayName: 'Nombre completo', profilePhotoDataUrl: null }],
      conversations: [], messages: [],
    }));
    await service.bootstrapCore();
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBeNull();
    expect(service.participantPhoto('peer', rich)).toBe('');
  });

  it('honors an authoritative photo removal and prevents stale cache/fallback photos from returning', async () => {
    const service = harness();
    await service.refreshProfile('peer');
    service.rememberProfiles([rich], false, 'cache');
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBeNull();
    expect(service.participantPhoto('peer', rich)).toBe('');
    expect(service.contacts()[0].profilePhotoDataUrl).toBeNull();
  });

  it('does not revive an authoritative removal from a stale nonempty participant summary', () => {
    const service = harness();
    service.rememberProfiles([{ userId: 'peer', profilePhotoDataUrl: null }]);
    service.rememberConversationParticipants([{ participants: [{ ...rich }] }]);
    expect(service.participantPhoto('peer', rich)).toBe('');
    expect(service.history.putProfiles.calls.mostRecent().args[0][0].profilePhotoDataUrl).toBeNull();
  });

  it('allows a newer SQL profile to enrich a sparse launch snapshot but rejects a later stale cache read', () => {
    const service = harness();
    service.profilesByUserId.set({});
    service.rememberConversationParticipants([{ participants: [{ userId: 'peer', alias: 'alias', displayName: null, profilePhotoDataUrl: null }] }], 'cache');
    service.rememberProfiles([{ ...rich, cachedAt: '2026-10-05T12:00:00Z' }], false, 'cache');
    expect(service.profilesByUserId().peer.displayName).toBe(rich.displayName);
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
    service.rememberProfiles([{ userId: 'peer', displayName: null, profilePhotoDataUrl: null, cachedAt }], false, 'cache');
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
    expect(service.profilesByUserId().peer.cachedAt).toBe('2026-10-05T12:00:00Z');
  });

  it('stores profile removals in launch participants so the next cold start cannot revive an old photo', fakeAsync(() => {
    const service = harness();
    service.rememberProfiles([{ userId: 'peer', profilePhotoDataUrl: null }]);
    service.conversations = signal([{ id: 'room', participants: [{ ...rich }] }]);
    service.messagesByConversation = signal({});
    service.launchCacheSaveTask = Promise.resolve();
    service.launchCache = { save: jasmine.createSpy('save').and.resolveTo() };
    service.conversationSubtitle = () => 'Preview';
    service.scheduleLaunchCacheSave('self');
    tick(350);
    flushMicrotasks();
    const snapshot = service.launchCache.save.calls.mostRecent().args[1];
    expect(snapshot.conversations[0].participants[0].profilePhotoDataUrl).toBeNull();
    expect(snapshot.conversations[0].participants[0].displayName).toBe(rich.displayName);
  }));

  it('keeps the current photo after a transient directory failure, but clears it when the user is no longer accessible', async () => {
    const service = harness();
    service.api.get.and.returnValue(throwError(() => ({ status: 0 })));
    await service.refreshProfile('peer');
    expect(service.profilesByUserId().peer.profilePhotoDataUrl).toBe(rich.profilePhotoDataUrl);
    service.api.get.and.returnValue(throwError(() => ({ status: 404 })));
    await service.refreshProfile('peer');
    expect(service.participantPhoto('peer', rich)).toBe('');
  });

  it('ignores a directory response from a previous account', async () => {
    const service = harness();
    const response = new Subject();
    service.api.get.and.returnValue(response);
    const pending = service.refreshProfile('peer');
    service.auth.session.set({ user: { id: 'second-user', alias: 'second-user' }, device: { id: 'second-browser' } });
    service.profilesByUserId.set({});
    response.next({ id: 'peer', alias: 'alias', profilePhotoDataUrl: 'old-account-photo' });
    await pending;
    expect(service.profilesByUserId()).toEqual({});
    expect(service.history.putProfiles).not.toHaveBeenCalled();
  });
});
