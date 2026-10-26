import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { AuthSession, Contact, PublicKeyDirectory, Story, StoryPayload } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { MediaOptimizerService } from './media-optimizer.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { SocialService } from './social.service';
import { EncryptedDownloadService } from './encrypted-download.service';
import { encodeStoryMusicFragment } from './story-music';

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
      path === '/stories/feed' ? feed : path === '/stories/world' ? world : path === '/stories/capabilities' ? { musicFragments: 1 } : [],
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
      { provide: EncryptedDownloadService, useValue: { download: (_access: string, fallback: string) => firstValueFrom(api.getArrayBuffer(fallback)) } },
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

  const fragment = () => encodeStoryMusicFragment({ duration: 2, sampleRate: 22050, numberOfChannels: 1, length: 44100,
    getChannelData: () => new Float32Array(44100) } as unknown as AudioBuffer, 0, 2);

  it('uploads separate encrypted photo and actual music fragment with the same audience and TTL, keeping private metadata inside E2EE', async () => {
    let files = 0;
    published.musicFileObjectId = 'asset-2';
    api.post.and.callFake((path: string) => of(path === '/keys/batch' ? keys : path === '/files' ? { id: `asset-${++files}` } : published) as never);
    await service.publishStory({ text: 'Foto privada', file: new File(['image'], 'photo.jpg', { type: 'image/jpeg' }), visibility: 'Contacts', durationSeconds: 3600,
      music: { file: fragment(), title: 'Canción secreta', durationSeconds: 2, sourceStartSeconds: 38 } });
    const reservations = api.post.calls.allArgs().filter(([path]) => path === '/files').map(args => args[1] as any);
    expect(reservations.length).toBe(2);
    expect(reservations[1].allowedUserIds).toEqual(reservations[0].allowedUserIds);
    expect(reservations[1].expiresAt).toBe(reservations[0].expiresAt);
    const request = api.post.calls.allArgs().find(([path]) => path === '/stories')![1] as any;
    expect(request.mediaFileObjectId).toBe('asset-1'); expect(request.musicFileObjectId).toBe('asset-2');
    expect(JSON.stringify(request)).not.toContain('Canción secreta');
    expect(JSON.stringify(request)).not.toContain('file-key');
    expect(seal.calls.mostRecent().args[2].music).toEqual(jasmine.objectContaining({ title: 'Canción secreta', durationSeconds: 2, sourceStartSeconds: 38 }));
    expect(service.storyMusic(published)?.url).toMatch(/^blob:/);
  });

  it('refuses a fabricated or untrimmed soundtrack before reserving any upload', async () => {
    await expectAsync(service.publishStory({ text: '', file: new File(['image'], 'photo.jpg', { type: 'image/jpeg' }), visibility: 'Contacts',
      music: { file: fragment(), title: '', durationSeconds: 15, sourceStartSeconds: 0 } })).toBeRejected();
    expect(api.post).not.toHaveBeenCalled(); expect(api.putRaw).not.toHaveBeenCalled();
    expect(service.publishing()).toBeFalse();
  });

  it('preserves the draft without uploading or publishing music against an older API', async () => {
    api.get.and.returnValue(throwError(() => ({ status: 404 })) as never);
    await expectAsync(service.publishStory({ text: '', file: new File(['image'], 'photo.jpg', { type: 'image/jpeg' }), visibility: 'Contacts',
      music: { file: fragment(), title: 'Música', durationSeconds: 2, sourceStartSeconds: 0 } })).toBeRejectedWithError(/servidor aún no permite/);
    expect(api.post).not.toHaveBeenCalled(); expect(api.putRaw).not.toHaveBeenCalled(); expect(service.publishing()).toBeFalse();
  });

  it('downloads and decrypts both story assets before committing a one-view consumption', async () => {
    const oneView = { ...published, viewOnce: true, musicFileObjectId: 'music' };
    const music = fragment();
    service.decodedPayloads.set({ [oneView.id]: { type: 'media', media: { fileId: 'photo', fileName: 'photo.jpg', mime: 'image/jpeg', size: 1, fileKey: 'key', fileIv: 'iv' },
      music: { fileId: 'music', fileName: 'fragment.wav', mime: 'audio/wav', size: music.size, fileKey: 'key', fileIv: 'iv', title: 'Música', durationSeconds: 2, sourceStartSeconds: 0 } } });
    const order: string[] = [];
    api.getArrayBuffer.and.callFake((path: string) => { order.push(path); return of(new ArrayBuffer(16)); });
    decryptAttachment.and.returnValues(Promise.resolve(new ArrayBuffer(1)), music.arrayBuffer());
    api.post.and.callFake((path: string) => { order.push(path); return of(oneView) as never; });
    await service.viewStory(oneView);
    expect(order).toEqual([`/stories/${oneView.id}/media`, `/stories/${oneView.id}/media?track=music`, `/stories/${oneView.id}/view`]);
    expect(service.storyReadyId()).toBe(oneView.id);
  });

  it('does not consume a one-view photo if its music cannot be downloaded, and clears opening state for retry', async () => {
    const oneView = { ...published, viewOnce: true, musicFileObjectId: 'music' };
    service.decodedPayloads.set({ [oneView.id]: { type: 'media', media: { fileId: 'photo', fileName: 'photo.jpg', mime: 'image/jpeg', size: 1, fileKey: 'key', fileIv: 'iv' },
      music: { fileId: 'music', fileName: 'fragment.wav', mime: 'audio/wav', size: fragment().size, fileKey: 'key', fileIv: 'iv', title: 'Música', durationSeconds: 2, sourceStartSeconds: 0 } } });
    api.getArrayBuffer.and.callFake((path: string) => path.includes('track=music') ? throwError(() => ({ status: 503 })) : of(new ArrayBuffer(16)));
    await expectAsync(service.viewStory(oneView)).toBeRejected();
    expect(api.post).not.toHaveBeenCalled(); expect(service.storyReadyId()).toBe(''); expect(service.storyOpening()).toBeFalse();
  });

  it('keeps an already committed photo confirmed if a server omits the music acknowledgement, without inviting a duplicate publication', async () => {
    let files = 0;
    api.post.and.callFake((path: string) => of(path === '/keys/batch' ? keys : path === '/files' ? { id: `asset-${++files}` } : published) as never);
    spyOn(service, 'load').and.rejectWith(new Error('feed unavailable after commit'));
    await expectAsync(service.publishStory({ text: 'Mi foto', file: new File(['image'], 'photo.jpg', { type: 'image/jpeg' }), visibility: 'Contacts',
      music: { file: fragment(), title: 'Canción', durationSeconds: 2, sourceStartSeconds: 0 } })).toBeResolved();
    expect(api.post.calls.allArgs().filter(([path]) => path === '/stories').length).toBe(1);
    expect(service.stories()[0].id).toBe(published.id); expect(service.storyPayload(published).media).toBeTruthy();
    expect(service.storyPayload(published).music).toBeNull(); expect(service.storyMusic(published)).toBeNull();
    expect(service.storyDeliveryWarning()).toContain('no confirmó la música'); expect(service.publishing()).toBeFalse();
  });

  it('resumes one interrupted media upload with the same reservation and ciphertext, without duplicate creation', async () => {
    api.putRaw.and.returnValues(throwError(() => ({ status: 503 })) as never, of({ id: 'encrypted-file' }) as never);
    const file = new File(['image-fixture'], 'photo.png', { type: 'image/png' });
    await service.publishStory({ text: 'Ready', visibility: 'PublicWorld', file });
    expect(api.putRaw).toHaveBeenCalledTimes(2);
    expect(api.putRaw.calls.argsFor(1)).toEqual(api.putRaw.calls.argsFor(0));
    const reservations = api.post.calls.allArgs().filter(([path]) => path === '/files');
    expect(reservations.length).toBe(1);
    expect((reservations[0][1] as { clientSha256: string }).clientSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(api.post.calls.allArgs().filter(([path]) => path === '/stories').length).toBe(1);
  });

  it('does not replay media after an integrity refusal or an ambiguous story POST failure', async () => {
    api.putRaw.and.returnValue(throwError(() => ({ status: 400 })) as never);
    await expectAsync(service.publishStory({ text: 'Ready', visibility: 'PublicWorld', file: new File(['fixture'], 'photo.png', { type: 'image/png' }) })).toBeRejected();
    expect(api.putRaw).toHaveBeenCalledTimes(1);
    expect(api.post.calls.allArgs().filter(([path]) => path === '/stories')).toEqual([]);
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
    published.owner = user('friend');
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
  it('downloads and decrypts a one-view story before committing its consumed view', async () => {
    const incoming = { ...published, owner: user('friend'), viewOnce: true, viewedByMe: false };
    service.decodedPayloads.set({ [incoming.id]: { type: 'media', media: {
      fileId: 'single-view', fileName: 'moment.jpg', mime: 'image/jpeg', size: 1, fileKey: 'key', fileIv: 'iv',
    } } });
    const bytes = new Subject<ArrayBuffer>();
    api.getArrayBuffer.and.returnValue(bytes);
    api.post.calls.reset();
    const opening = service.viewStory(incoming, 'chats');
    await Promise.resolve(); await Promise.resolve();
    expect(api.post).not.toHaveBeenCalled();
    expect(service.storyReadyId()).toBe('');
    bytes.next(new Uint8Array([1]).buffer); bytes.complete();
    api.post.and.returnValue(of({ ...incoming, viewedByMe: true }) as never);
    await opening;
    expect(decryptAttachment).toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledOnceWith('/stories/published-story/view', {});
    expect(service.storyReadyId()).toBe(incoming.id);
    expect(service.storyViewerOwner()).toBe('chats');
    expect(service.contactStories()).toEqual([]);
  });

  it('does not consume a one-view story when media fails, and closing preserves its retry', async () => {
    const incoming = { ...published, owner: user('friend'), viewOnce: true, viewedByMe: false };
    service.stories.set([incoming]);
    service.decodedPayloads.set({ [incoming.id]: { type: 'media', media: {
      fileId: 'one', fileName: 'one.jpg', mime: 'image/jpeg', size: 1, fileKey: 'key', fileIv: 'iv',
    } } });
    api.getArrayBuffer.and.returnValue(throwError(() => new Error('offline')));
    api.post.calls.reset();
    await expectAsync(service.viewStory(incoming)).toBeRejected();
    expect(api.post).not.toHaveBeenCalled();
    expect(service.storyReadyId()).toBe('');
    service.closeStory();
    expect(service.contactStories().length).toBe(1);
  });

  it('does not consume or reopen a story if the user closes it during download', async () => {
    const incoming = { ...published, owner: user('friend'), viewOnce: true, viewedByMe: false };
    service.decodedPayloads.set({ [incoming.id]: { type: 'media', media: {
      fileId: 'one', fileName: 'one.jpg', mime: 'image/jpeg', size: 1, fileKey: 'key', fileIv: 'iv',
    } } });
    const bytes = new Subject<ArrayBuffer>(); api.getArrayBuffer.and.returnValue(bytes);
    api.post.calls.reset();
    const opening = service.viewStory(incoming, 'chats');
    await Promise.resolve(); await Promise.resolve();
    service.closeStory('chats');
    bytes.next(new Uint8Array([1]).buffer); bytes.complete();
    await opening;
    expect(api.post).not.toHaveBeenCalled();
    expect(service.activeStory()).toBeNull();
    expect(service.storyReadyId()).toBe('');
  });

  it('keeps a late view response from replacing the more recent story', async () => {
    const first = { ...published, id: 'first' };
    const second = { ...published, id: 'second' };
    service.decodedPayloads.set({ first: { type: 'text', text: 'First' }, second: { type: 'text', text: 'Second' } });
    const old = new Subject<Story>();
    api.post.and.callFake((path) => path.includes('/first/') ? old as never : of(second) as never);
    const opening = service.viewStory(first, 'chats');
    await Promise.resolve(); await Promise.resolve();
    await service.viewStory(second, 'chat-detail');
    old.next(first); old.complete(); await opening;
    expect(service.activeStory()?.id).toBe('second');
    expect(service.storyReadyId()).toBe('second');
    service.closeStory('chats');
    expect(service.activeStory()?.id).toBe('second');
  });

  it('coalesces concurrent requests for the same encrypted media into one download/decryption', async () => {
    service.decodedPayloads.set({ [published.id]: { type: 'media', media: {
      fileId: 'same', fileName: 'same.jpg', mime: 'image/jpeg', size: 1, fileKey: 'key', fileIv: 'iv',
    } } });
    const bytes = new Subject<ArrayBuffer>(); api.getArrayBuffer.and.returnValue(bytes);
    const one = service.ensureStoryMedia(published);
    const two = service.ensureStoryMedia(published);
    expect(api.getArrayBuffer).toHaveBeenCalledTimes(1);
    bytes.next(new Uint8Array([1]).buffer); bytes.complete();
    const [first, second] = await Promise.all([one, two]);
    expect(first?.url).toBe(second?.url);
    expect(decryptAttachment).toHaveBeenCalledTimes(1);
  });

  it('clears consumed one-view plaintext on close but never preloads its media', async () => {
    const incoming = { ...published, owner: user('friend'), viewOnce: true, viewedByMe: false };
    service.decodedPayloads.set({ [incoming.id]: { type: 'text', text: 'Only once' } });
    api.post.and.returnValue(of({ ...incoming, viewedByMe: true }) as never);
    await service.preloadStory(incoming);
    expect(api.getArrayBuffer).not.toHaveBeenCalled();
    await service.viewStory(incoming);
    service.closeStory();
    expect(service.decodedPayloads()[incoming.id]).toBeUndefined();
    expect(service.contactStories()).toEqual([]);
  });

  it('refreshes only the creator’s server statistics, without inventing viewer events', async () => {
    api.post.calls.reset();
    await service.refreshStoryActivity({ ...published, owner: user('friend') });
    expect(api.post).not.toHaveBeenCalled();
    service.activeStory.set(published);
    api.post.and.returnValue(of({ ...published, viewCount: 7 }) as never);
    await service.refreshStoryActivity(published);
    expect(service.activeStory()?.viewCount).toBe(7);
    expect(service.activeStory()?.views).toEqual([]);
  });

  it('rejects sharing one-view or author-disabled stories before decrypting or publishing', async () => {
    api.post.calls.reset();
    await expectAsync(service.repostStory({ ...published, owner: user('friend'), viewOnce: true })).toBeRejected();
    await expectAsync(service.repostStory({ ...published, owner: user('friend'), allowReposts: false })).toBeRejected();
    expect(api.post).not.toHaveBeenCalled();
    expect(decryptEnvelope).not.toHaveBeenCalled();
  });

  it('does not inflate view counts for repeated legacy activity events', async () => {
    service.stories.set([{ ...published, viewCount: 4 }]);
    spyOn(service, 'load').and.resolveTo();
    realtime.next({ type: 'story.viewed', payload: { storyId: published.id } });
    realtime.next({ type: 'story.viewed', payload: { storyId: published.id } });
    expect(service.stories()[0].viewCount).toBe(4);
  });

  it('bounds retained decrypted media while preserving the currently visible story', () => {
    const revoke = spyOn(URL, 'revokeObjectURL');
    service.activeStory.set({ ...published, id: 'visible' });
    const large = new Blob([new Uint8Array([1])]);
    Object.defineProperty(large, 'size', { value: 40 * 1024 * 1024 });
    (service as any).rememberMediaPreview('visible', large, 'video/mp4', 'visible.mp4');
    for (let i = 0; i < 12; i++) (service as any).rememberMediaPreview(`past-${i}`, large, 'video/mp4', 'past.mp4');
    expect(service.storyMedia(service.activeStory())?.name).toBe('visible.mp4');
    expect(Object.keys(service.mediaPreviews()).length).toBe(2);
    expect(revoke).toHaveBeenCalledTimes(11);
  });

  it('does not prefetch adjacent large videos or consume their views', async () => {
    service.decodedPayloads.set({ [published.id]: { type: 'media', media: {
      fileId: 'large', fileName: 'large.mp4', mime: 'video/mp4', size: 9 * 1024 * 1024,
      fileKey: 'key', fileIv: 'iv',
    } } });
    api.post.calls.reset();
    await service.preloadStory(published);
    expect(api.getArrayBuffer).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(service.mediaPreviews()).toEqual({});
  });

});
