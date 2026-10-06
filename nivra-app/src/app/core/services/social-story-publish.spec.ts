import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AuthSession, Contact, PublicKeyDirectory, Story, StoryPayload } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { MediaOptimizerService } from './media-optimizer.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { SocialService } from './social.service';

describe('confirmed story publication and feed recovery', () => {
  let service: SocialService;
  let api: jasmine.SpyObj<NivraApiService>;
  let history: jasmine.SpyObj<LocalHistoryService>;
  let session: ReturnType<typeof signal<AuthSession | null>>;
  let realtime: Subject<{ type: string; payload: unknown }>;
  let published: Story;
  let feed: Story[];
  let world: Story[];
  let keys: PublicKeyDirectory[];
  let seal: jasmine.Spy;
  let currentKeys: jasmine.Spy;
  let encryptAttachment: jasmine.Spy;
  let optimizer: jasmine.SpyObj<MediaOptimizerService>;
  let phoneHash: jasmine.Spy;
  let decryptEnvelope: jasmine.Spy;
  let decryptAttachment: jasmine.Spy;

  const user = (id = 'owner') => ({
    id, alias: id, displayName: id, isDiscoverable: true, allowStoryReposts: true,
    isContact: false, isMutualContact: false, isFavorite: false, friendshipState: 'none',
  });
  const account = (id = 'owner', deviceId = 'own-device') => ({
    user: user(id), device: { id: deviceId }, tokens: {},
  }) as unknown as AuthSession;
  const story = (visibility = 'Contacts', id = 'published-story'): Story => ({
    id, owner: user(), visibility, targetType: 'contacts', targetId: null,
    encryptedPayload: 'server-envelope', allowedUserIds: ['owner', 'friend'],
    viewOnce: false, allowReposts: true, viewedByMe: true, viewCount: 0,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const directory = (id: string): PublicKeyDirectory => ({
    userId: id, devices: [{ deviceId: `${id}-device`, keyBundle: { identityKey: 'valid-key' } }],
  }) as PublicKeyDirectory;

  beforeEach(() => {
    published = story();
    feed = [];
    world = [];
    keys = [directory('friend')];
    session = signal<AuthSession | null>(account());
    realtime = new Subject();
    api = jasmine.createSpyObj<NivraApiService>('api', ['get', 'post', 'putRaw', 'getArrayBuffer', 'patch', 'delete']);
    history = jasmine.createSpyObj<LocalHistoryService>('history', ['stories', 'putStories', 'removeStory']);
    history.stories.and.resolveTo([]);
    history.putStories.and.resolveTo();
    history.removeStory.and.resolveTo();
    api.get.and.callFake((path: string) => of(
      path === '/stories/feed' ? feed : path === '/stories/world' ? world : [],
    ) as never);
    api.post.and.callFake((path: string) => of(
      path === '/keys/batch' ? keys : path === '/files' ? { id: 'encrypted-file' } : published,
    ) as never);
    api.putRaw.and.returnValue(of({ id: 'encrypted-file' }) as never);
    currentKeys = jasmine.createSpy('currentKeys').and.resolveTo({ publicJwk: { kty: 'EC' } });
    encryptAttachment = jasmine.createSpy('encryptAttachment').and.resolveTo({
      bytes: new Uint8Array([1, 2, 3]).buffer, key: 'file-key', iv: 'file-iv',
    });
    optimizer = jasmine.createSpyObj<MediaOptimizerService>('optimizer', ['prepareForEncryptedUpload']);
    optimizer.prepareForEncryptedUpload.and.callFake(async (file: File) => ({ file }) as never);
    phoneHash = jasmine.createSpy('phoneHash').and.resolveTo('hashed-phone');
    decryptEnvelope = jasmine.createSpy('decryptEnvelope').and.resolveTo({ type: 'text', text: 'Private draft' });
    decryptAttachment = jasmine.createSpy('decryptAttachment').and.resolveTo(new Uint8Array([1]).buffer);
    seal = jasmine.createSpy('seal').and.callFake(async (_own, recipients) =>
      recipients.map((recipient: { userId: string; deviceId: string }) => ({
        userId: recipient.userId, deviceId: recipient.deviceId,
        ciphertext: 'ciphertext-only', header: 'sealed-header',
      })));
    TestBed.configureTestingModule({ providers: [
      SocialService,
      { provide: NivraApiService, useValue: api },
      { provide: AuthService, useValue: { session, isAuthenticated: () => Boolean(session()) } },
      { provide: LocalHistoryService, useValue: history },
      { provide: SignalrService, useValue: { events$: realtime } },
      { provide: MediaOptimizerService, useValue: optimizer },
      { provide: CryptoService, useValue: {
        currentKeyMaterial: currentKeys,
        encryptAttachment,
        phoneContactHash: phoneHash,
        decryptEnvelope,
        decryptAttachment,
        parsePublicJwk: (key: string) => key === 'valid-key' ? { kty: 'EC' } : null,
        encryptGroupPayloadForRecipients: seal,
        b64: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
        ub64: (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
      } },
    ] });
    service = TestBed.inject(SocialService);
    service.contacts.set([{
      userId: 'friend', alias: 'friend', isFavorite: false, isMutualContact: true,
      createdAt: new Date().toISOString(),
    }]);
  });

  it('resolves after a successful POST even if follow-up synchronization rejects, without another POST', async () => {
    spyOn(service, 'load').and.rejectWith(new Error('connection dropped after commit'));

    await expectAsync(service.publishStory({ text: 'A private moment', visibility: 'Contacts' })).toBeResolved();

    expect(api.post.calls.allArgs().filter(([path]) => path === '/stories').length).toBe(1);
    expect(service.stories().map((item) => item.id)).toEqual([published.id]);
    expect(service.storyPayload(published).text).toBe('A private moment');
    expect(history.putStories).toHaveBeenCalled();
    expect(service.publishing()).toBeFalse();
    expect(service.publishingStatus()).toBe('');
  });

  it('keeps a rejected creation rejected and does not insert or persist a story', async () => {
    api.post.and.callFake((path: string) => path === '/stories'
      ? throwError(() => new Error('creation refused')) as never : of(keys) as never);

    await expectAsync(service.publishStory({ text: 'Draft', visibility: 'Contacts' }))
      .toBeRejectedWithError('creation refused');

    expect(service.stories()).toEqual([]);
    expect(service.worldStories()).toEqual([]);
    expect(service.decodedPayloads()).toEqual({});
    expect(history.putStories).not.toHaveBeenCalled();
    expect(service.publishing()).toBeFalse();
  });

  it('preserves a confirmed creation against an older feed fetched after the POST until the feed acknowledges it', async () => {
    await service.publishStory({ text: 'Ready', visibility: 'Contacts' });
    expect(service.stories().map((item) => item.id)).toEqual([published.id]);

    await service.load();
    expect(service.stories().map((item) => item.id)).toEqual([published.id]);

    feed = [{ ...published, viewCount: 3 }];
    await service.load();
    expect(service.stories()[0].viewCount).toBe(3);

    feed = [];
    await service.load();
    expect(service.stories()).toEqual([]);
  });

  it('preserves a creation when an in-flight feed started before its POST returns an older snapshot', async () => {
    const delayedFeed = new Subject<Story[]>();
    let feedStarted!: () => void;
    const started = new Promise<void>((resolve) => { feedStarted = resolve; });
    api.get.and.callFake((path: string) => {
      if (path === '/stories/feed') {
        feedStarted();
        return delayedFeed as never;
      }
      return of([]) as never;
    });
    const loading = service.load();
    await started;
    let postCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { postCommitted = resolve; });
    api.post.and.callFake((path: string) => {
      if (path === '/stories') {
        postCommitted();
        return of(published) as never;
      }
      return of(keys) as never;
    });
    const publishing = service.publishStory({ text: 'Committed during loading', visibility: 'Contacts' });
    await committed;
    // Allow the awaited POST result to be applied before the older feed resolves.
    await Promise.resolve();
    delayedFeed.next([]);
    delayedFeed.complete();
    await Promise.all([loading, publishing]);

    expect(service.stories().map((item) => item.id)).toEqual([published.id]);
    expect(api.post.calls.allArgs().filter(([path]) => path === '/stories').length).toBe(1);
    // Drain the existing queued refresh without leaving a pending observable.
    await Promise.resolve();
  });

  it('preserves a public creation in both collections until each acknowledges it', async () => {
    published = story('PublicWorld');
    await service.publishStory({ text: 'A public moment', visibility: 'PublicWorld' });
    expect(service.stories().map((item) => item.id)).toEqual([published.id]);
    expect(service.worldStories().map((item) => item.id)).toEqual([published.id]);

    feed = [published];
    await service.load();
    expect(service.worldStories().map((item) => item.id)).toEqual([published.id]);
    world = [published];
    await service.load();

    feed = [];
    world = [];
    await service.load();
    expect(service.stories()).toEqual([]);
    expect(service.worldStories()).toEqual([]);
  });

  it('never revives a deleted or expired local publication from an older snapshot', async () => {
    await service.publishStory({ text: 'Ready', visibility: 'Contacts' });
    realtime.next({ type: 'story.deleted', payload: { storyId: published.id } });
    feed = [published];
    await service.load();
    expect(service.stories()).toEqual([]);

    published = { ...story('Contacts', 'expired-story'), expiresAt: new Date(Date.now() - 1).toISOString() };
    feed = [];
    await service.publishStory({ text: 'Expired', visibility: 'Contacts' });
    expect(service.stories()).toEqual([]);
  });

  for (const [label, changedSession] of [
    ['another account', account('another-account', 'another-device')],
    ['another device on the same account', account('owner', 'another-device')],
  ] as const) {
    it(`does not carry a pending publication to ${label}`, async () => {
      await service.publishStory({ text: 'Private', visibility: 'Contacts' });
      session.set(changedSession);
      await service.load();
      expect(service.stories()).toEqual([]);
      expect(service.worldStories()).toEqual([]);
      session.set(account());
      await service.load();
      expect(service.stories()).toEqual([]);
    });
  }

  it('does not display or cache a creation in a new account when its POST finishes after switching accounts', async () => {
    const creation = new Subject<Story>();
    let postStarted!: () => void;
    const started = new Promise<void>((resolve) => { postStarted = resolve; });
    api.post.and.callFake((path: string) => {
      if (path === '/stories') {
        postStarted();
        return creation as never;
      }
      return of(keys) as never;
    });
    const publishing = service.publishStory({ text: 'Private', visibility: 'Contacts' });
    await started;
    session.set(account('another-account', 'another-device'));
    creation.next(published);
    creation.complete();
    await expectAsync(publishing).toBeRejectedWithError(/sesion cambio/);
    expect(service.stories()).toEqual([]);
    expect(service.decodedPayloads()).toEqual({});
    expect(history.putStories).not.toHaveBeenCalled();
  });

  it('aborts before looking up audience keys if the account changes while unlocking its own keys', async () => {
    currentKeys.and.callFake(async () => {
      session.set(account('another-account', 'another-device'));
      return { publicJwk: { kty: 'EC' } };
    });
    await expectAsync(service.publishStory({ text: 'Private draft', visibility: 'Contacts' }))
      .toBeRejectedWithError(/sesion cambio/);
    expect(api.post).not.toHaveBeenCalled();
    expect(service.decodedPayloads()).toEqual({});
  });

  it('does not retry a key batch or send the draft after a device change during audience resolution', async () => {
    api.post.and.callFake((path: string) => {
      if (path === '/keys/batch') {
        session.set(account('owner', 'another-device'));
        return throwError(() => new Error('key request interrupted')) as never;
      }
      return of(published) as never;
    });
    await expectAsync(service.publishStory({ text: 'Private draft', visibility: 'Contacts' }))
      .toBeRejectedWithError(/sesion cambio/);
    expect(api.post.calls.allArgs().map(([path]) => path)).toEqual(['/keys/batch']);
    expect(seal).not.toHaveBeenCalled();
  });

  for (const phase of ['optimization', 'reading', 'encryption', 'file creation', 'blob upload'] as const) {
    it(`aborts without story creation or preview caching if the account changes during ${phase}`, async () => {
      const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
      const changeAccount = () => session.set(account('another-account', 'another-device'));
      published = story('PublicWorld');
      if (phase === 'optimization') {
        optimizer.prepareForEncryptedUpload.and.callFake(async () => {
          changeAccount();
          return { file } as never;
        });
      } else if (phase === 'reading') {
        spyOn(file, 'arrayBuffer').and.callFake(async () => {
          changeAccount();
          return new Uint8Array([1]).buffer;
        });
      } else if (phase === 'encryption') {
        encryptAttachment.and.callFake(async () => {
          changeAccount();
          return { bytes: new Uint8Array([1]).buffer, key: 'file-key', iv: 'file-iv' };
        });
      } else if (phase === 'file creation') {
        api.post.and.callFake((path: string) => {
          if (path === '/files') {
            changeAccount();
            return of({ id: 'encrypted-file' }) as never;
          }
          return of(published) as never;
        });
      } else {
        api.putRaw.and.callFake(() => {
          changeAccount();
          return of({ id: 'encrypted-file' }) as never;
        });
      }

      await expectAsync(service.publishStory({ text: 'Private draft', visibility: 'PublicWorld', file }))
        .toBeRejectedWithError(/sesion cambio/);
      expect(api.post.calls.allArgs().filter(([path]) => path === '/stories')).toEqual([]);
      expect(service.mediaPreviews()).toEqual({});
      expect(service.decodedPayloads()).toEqual({});
      expect(history.putStories).not.toHaveBeenCalled();
      expect(service.publishing()).toBeFalse();
      if (phase === 'optimization' || phase === 'reading' || phase === 'encryption') {
        expect(api.post).not.toHaveBeenCalled();
      }
      if (phase !== 'blob upload') {
        expect(api.putRaw).not.toHaveBeenCalled();
      }
    });
  }

  it('aborts before the story POST when the device changes while sealing the payload', async () => {
    seal.and.callFake(async () => {
      session.set(account('owner', 'another-device'));
      return [{ userId: 'owner', deviceId: 'own-device', ciphertext: 'sealed', header: 'header' }];
    });
    await expectAsync(service.publishStory({ text: 'Private draft', visibility: 'Contacts' }))
      .toBeRejectedWithError(/sesion cambio/);
    expect(api.post.calls.allArgs().filter(([path]) => path === '/stories')).toEqual([]);
    expect(service.decodedPayloads()).toEqual({});
  });

  it('discards an old SQL read after an account change without starting remote queries for the new account', async () => {
    let resolveCached!: (stories: Story[]) => void;
    history.stories.and.returnValue(new Promise<Story[]>((resolve) => { resolveCached = resolve; }));
    service.contacts.set([]);
    const loading = service.load();
    session.set(account('another-account', 'another-device'));
    resolveCached([published]);
    await loading;

    expect(history.stories).toHaveBeenCalledWith('owner');
    expect(api.get).not.toHaveBeenCalled();
    expect(service.stories()).toEqual([]);
    expect(service.worldStories()).toEqual([]);
    expect(service.contacts()).toEqual([]);
    expect(history.putStories).not.toHaveBeenCalled();
    expect(service.loading()).toBeFalse();
  });

  it('discards delayed feed and contact responses when the device changes before they finish', async () => {
    const delayed = new Subject<unknown[]>();
    let queriesStarted!: () => void;
    const started = new Promise<void>((resolve) => { queriesStarted = resolve; });
    service.contacts.set([]);
    api.get.and.callFake((path: string) => {
      if (path === '/stories/world') {
        queriesStarted();
      }
      return delayed as never;
    });
    const loading = service.load();
    await started;
    session.set(account('owner', 'another-device'));
    delayed.next([published]);
    delayed.complete();
    await loading;

    expect(api.get).toHaveBeenCalledTimes(4);
    expect(service.stories()).toEqual([]);
    expect(service.worldStories()).toEqual([]);
    expect(service.contacts()).toEqual([]);
    expect(service.friendRequests()).toEqual([]);
    expect(history.putStories).not.toHaveBeenCalled();
  });

  it('discards a delayed group feed after the account changes instead of inserting or caching it', async () => {
    const delayed = new Subject<Story[]>();
    api.get.and.returnValue(delayed as never);
    const loading = service.loadGroupStories('family');
    session.set(account('another-account', 'another-device'));
    delayed.next([{ ...published, targetType: 'group', targetId: 'family' }]);
    delayed.complete();

    await expectAsync(loading).toBeResolvedTo([]);
    expect(service.stories()).toEqual([]);
    expect(history.putStories).not.toHaveBeenCalled();
  });

  it('clears only in-memory social state and revokes previews when the account changes', () => {
    const previewUrl = URL.createObjectURL(new Blob(['private media']));
    const revoke = spyOn(URL, 'revokeObjectURL').and.callThrough();
    service.stories.set([published]);
    service.worldStories.set([{ ...published, visibility: 'PublicWorld' }]);
    service.people.set([user('friend')]);
    service.radarMatches.set([user('friend')]);
    service.radarNewCount.set(1);
    service.activeStory.set(published);
    service.decodedPayloads.set({ [published.id]: { type: 'text', text: 'Private draft' } });
    service.mediaPreviews.set({ [published.id]: { storyId: published.id, url: previewUrl, mime: 'image/jpeg', name: 'private.jpg' } });
    service.storyMediaErrors.set({ [published.id]: 'old failure' });
    session.set(account('another-account', 'another-device'));
    TestBed.flushEffects();

    expect(service.contacts()).toEqual([]);
    expect(service.stories()).toEqual([]);
    expect(service.worldStories()).toEqual([]);
    expect(service.people()).toEqual([]);
    expect(service.radarMatches()).toEqual([]);
    expect(service.radarNewCount()).toBe(0);
    expect(service.activeStory()).toBeNull();
    expect(service.decodedPayloads()).toEqual({});
    expect(service.mediaPreviews()).toEqual({});
    expect(service.storyMediaErrors()).toEqual({});
    expect(revoke).toHaveBeenCalledWith(previewUrl);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(history.removeStory).not.toHaveBeenCalled();
    expect(history.putStories).not.toHaveBeenCalled();
  });

  it('keeps the current social state when only the token or profile changes on the same account and device', () => {
    const previewUrl = URL.createObjectURL(new Blob(['private media']));
    const revoke = spyOn(URL, 'revokeObjectURL').and.callThrough();
    service.stories.set([published]);
    service.decodedPayloads.set({ [published.id]: { type: 'text', text: 'Private draft' } });
    service.mediaPreviews.set({ [published.id]: { storyId: published.id, url: previewUrl, mime: 'image/jpeg', name: 'private.jpg' } });
    session.update((current) => ({
      ...current!, user: { ...current!.user, displayName: 'New display name' },
      tokens: { accessToken: 'refreshed-token', refreshToken: 'refreshed-refresh-token' },
    }));
    TestBed.flushEffects();

    expect(service.stories()).toEqual([published]);
    expect(service.contacts().map((contact) => contact.userId)).toEqual(['friend']);
    expect(service.decodedPayloads()[published.id].text).toBe('Private draft');
    expect(service.mediaPreviews()[published.id].url).toBe(previewUrl);
    expect(revoke).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    URL.revokeObjectURL(previewUrl);
  });

  it('does not restore old search results after the account changes', async () => {
    const delayed = new Subject<{ people: ReturnType<typeof user>[] }>();
    api.get.and.returnValue(delayed as never);
    const searching = service.search('friend');
    session.set(account('another-account', 'another-device'));
    TestBed.flushEffects();
    delayed.next({ people: [user('old-match')] });
    delayed.complete();

    await expectAsync(searching).toBeResolvedTo([]);
    expect(service.people()).toEqual([]);
  });

  it('does not submit an old radar scan if the device changes while hashing its phone list', async () => {
    phoneHash.and.callFake(async () => {
      session.set(account('owner', 'another-device'));
      return 'hashed-phone';
    });
    const response = await service.scanPhoneRadar('+593991234567');

    expect(response.people).toEqual([]);
    expect(api.post).not.toHaveBeenCalled();
    expect(service.radarMatches()).toEqual([]);
    expect(service.radarLoading()).toBeFalse();
  });

  it('does not restore old radar matches or write their seen markers after an account change', async () => {
    const delayed = new Subject<unknown>();
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });
    api.post.and.callFake(() => {
      queryStarted();
      return delayed as never;
    });
    const setItem = spyOn(Storage.prototype, 'setItem');
    const scanning = service.scanPhoneRadar('+593991234567');
    await started;
    session.set(account('another-account', 'another-device'));
    TestBed.flushEffects();
    delayed.next({ submitted: 1, matched: 1, currentUserInRadar: true, people: [user('old-match')] });
    delayed.complete();

    const response = await scanning;
    expect(response.people).toEqual([]);
    expect(service.radarMatches()).toEqual([]);
    expect(service.radarNewCount()).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('does not restore the previous active story or payload from a delayed view response', async () => {
    published.encryptedPayload = btoa(JSON.stringify({ type: 'text', text: 'Private draft' }));
    const delayed = new Subject<Story>();
    api.post.and.returnValue(delayed as never);
    const viewing = service.viewStory(published);
    session.set(account('another-account', 'another-device'));
    TestBed.flushEffects();
    delayed.next(published);
    delayed.complete();

    await expectAsync(viewing).toBeRejectedWithError(/sesion cambio/);
    expect(service.activeStory()).toBeNull();
    expect(service.stories()).toEqual([]);
    expect(service.decodedPayloads()).toEqual({});
    expect(history.putStories).not.toHaveBeenCalled();
  });

  it('does not cache or repost a private payload whose decryption completes after changing accounts', async () => {
    published.encryptedPayload = btoa(JSON.stringify({ v: 3, type: 'nivra-story-e2ee', recipients: [{
      userId: 'owner', deviceId: 'own-device', ciphertext: 'private-ciphertext', header: 'sealed-header',
    }] }));
    let resolveDecoded!: (payload: StoryPayload) => void;
    let decodingStarted!: () => void;
    const started = new Promise<void>((resolve) => { decodingStarted = resolve; });
    decryptEnvelope.and.callFake(() => {
      decodingStarted();
      return new Promise<StoryPayload>((resolve) => { resolveDecoded = resolve; });
    });
    const reposting = service.repostStory(published);
    await started;
    session.set(account('another-account', 'another-device'));
    TestBed.flushEffects();
    resolveDecoded({ type: 'text', text: 'Private draft' });

    await expectAsync(reposting).toBeRejectedWithError(/sesion cambio/);
    expect(api.post).not.toHaveBeenCalled();
    expect(service.decodedPayloads()).toEqual({});
    expect(history.putStories).not.toHaveBeenCalled();
  });

  it('does not decrypt or cache media returned after the account changes', async () => {
    service.decodedPayloads.set({ [published.id]: { type: 'media', media: {
      fileId: 'private-file', fileName: 'private.jpg', mime: 'image/jpeg', size: 1,
      fileKey: 'private-key', fileIv: 'private-iv',
    } } });
    const delayed = new Subject<ArrayBuffer>();
    api.getArrayBuffer.and.returnValue(delayed as never);
    const preparing = service.ensureStoryMedia(published);
    session.set(account('another-account', 'another-device'));
    TestBed.flushEffects();
    delayed.next(new Uint8Array([1]).buffer);
    delayed.complete();

    await expectAsync(preparing).toBeRejectedWithError(/sesion cambio/);
    expect(decryptAttachment).not.toHaveBeenCalled();
    expect(service.mediaPreviews()).toEqual({});
    expect(service.storyMediaErrors()).toEqual({});
  });

  it('does not create a private media preview if decryption finishes after a device change', async () => {
    service.decodedPayloads.set({ [published.id]: { type: 'media', media: {
      fileId: 'private-file', fileName: 'private.jpg', mime: 'image/jpeg', size: 1,
      fileKey: 'private-key', fileIv: 'private-iv',
    } } });
    api.getArrayBuffer.and.returnValue(of(new Uint8Array([1]).buffer));
    let resolveMedia!: (payload: ArrayBuffer) => void;
    let decodingStarted!: () => void;
    const started = new Promise<void>((resolve) => { decodingStarted = resolve; });
    decryptAttachment.and.callFake(() => {
      decodingStarted();
      return new Promise<ArrayBuffer>((resolve) => { resolveMedia = resolve; });
    });
    const preparing = service.ensureStoryMedia(published);
    await started;
    session.set(account('owner', 'another-device'));
    TestBed.flushEffects();
    resolveMedia(new Uint8Array([1]).buffer);

    await expectAsync(preparing).toBeRejectedWithError(/sesion cambio/);
    expect(service.mediaPreviews()).toEqual({});
    expect(service.storyMediaErrors()).toEqual({});
  });

  it('preserves encrypted audience restrictions and the partial delivery warning after recovery', async () => {
    service.contacts.update((items) => [...items, {
      userId: 'offline-member', alias: 'offline-member', isFavorite: false, isMutualContact: true,
      createdAt: new Date().toISOString(),
    } as Contact]);
    spyOn(service, 'load').and.rejectWith(new Error('feed offline'));
    await service.publishStory({
      text: 'Private caption', visibility: 'SelectedUsers',
      allowedUserIds: ['friend', 'offline-member'], targetType: 'group', targetId: 'family',
      viewOnce: true, allowReposts: false, durationSeconds: 3600,
    });
    const creation = api.post.calls.allArgs().find(([path]) => path === '/stories')![1] as {
      allowedUserIds: string[]; encryptedPayload: string; caption: null; targetType: string;
      targetId: string; viewOnce: boolean; allowReposts: boolean; durationSeconds: number;
    };
    expect(creation.allowedUserIds).toEqual(['owner', 'friend']);
    expect(creation.caption).toBeNull();
    expect(creation.targetType).toBe('group');
    expect(creation.targetId).toBe('family');
    expect(creation.viewOnce).toBeTrue();
    expect(creation.allowReposts).toBeFalse();
    expect(creation.durationSeconds).toBe(3600);
    const envelope = JSON.parse(atob(creation.encryptedPayload));
    expect(envelope.type).toBe('nivra-story-e2ee');
    expect(envelope.recipients.map((item: { userId: string }) => item.userId).sort()).toEqual(['friend', 'owner']);
    expect(JSON.stringify(envelope)).not.toContain('Private caption');
    expect(seal).toHaveBeenCalled();
    expect(service.storyDeliveryWarning()).toContain('1 miembro no fue incluido');
  });
});
