import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, throwError } from 'rxjs';
import { AuthSession, Story, UserSummary } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { EncryptedDownloadService } from './encrypted-download.service';
import { LocalHistoryService } from './local-history.service';
import { MediaOptimizerService } from './media-optimizer.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { SocialService } from './social.service';

describe('persisted story profile privacy', () => {
  let service: SocialService;
  let session: ReturnType<typeof signal<AuthSession | null>>;
  let events: Subject<{ type: string; payload: unknown }>;
  let history: jasmine.SpyObj<LocalHistoryService>;
  let cached: Story[];
  const account = (id = 'alice') => ({ user: { id }, device: { id: 'phone' } }) as AuthSession;
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

  function configure(): void {
    TestBed.configureTestingModule({ providers: [
      SocialService,
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session() } },
      { provide: SignalrService, useValue: { events$: events } },
      { provide: NivraApiService, useValue: { get: () => throwError(() => new Error('offline')) } },
      { provide: LocalHistoryService, useValue: history },
      { provide: CryptoService, useValue: {} },
      { provide: MediaOptimizerService, useValue: {} },
      { provide: EncryptedDownloadService, useValue: {} },
    ] });
    service = TestBed.inject(SocialService);
    TestBed.flushEffects();
  }

  beforeEach(() => {
    session = signal<AuthSession | null>(account());
    events = new Subject();
    const owner = { id: 'bob', alias: 'bob', profilePhotoDataUrl: 'data:image/png;base64,old', phone: '+5700000000' } as UserSummary;
    cached = [{ id: 'cached-group-story', owner, visibility: 'Contacts', targetType: 'group', targetId: 'group', encryptedPayload: '',
      allowedUserIds: [], viewOnce: false, allowReposts: false, viewedByMe: false, viewCount: 0,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } as Story];
    history = jasmine.createSpyObj<LocalHistoryService>('history', ['stories', 'putStories']);
    history.stories.and.callFake(async () => structuredClone(cached));
    history.putStories.and.callFake(async (_accountKey, stories) => { cached = structuredClone(stories); });
    configure();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('keeps revoked fields cleared in unopened cached stories after an offline restart', async () => {
    expect(service.stories()).toEqual([]);
    events.next({ type: 'profile.updated', payload: { userId: 'bob', profilePhotoDataUrl: null, phone: null } });
    await settle();
    expect(history.putStories).toHaveBeenCalledWith('alice', jasmine.any(Array));
    expect(cached[0].owner.profilePhotoDataUrl).toBeNull();
    expect(cached[0].owner.phone).toBeNull();
    TestBed.resetTestingModule(); configure();
    await service.load();
    expect(service.stories()[0].owner.profilePhotoDataUrl).toBeNull();
    expect(service.stories()[0].owner.phone).toBeNull();
  });

  it('does not apply a delayed cache rewrite to a different account or a reopened session', async () => {
    let resolve!: (stories: Story[]) => void;
    history.stories.and.returnValue(new Promise<Story[]>(done => { resolve = done; }));
    events.next({ type: 'profile.updated', payload: { userId: 'bob', profilePhotoDataUrl: null, phone: null } });
    session.set(account('other')); TestBed.flushEffects();
    session.set(account()); TestBed.flushEffects();
    resolve(cached); await settle();
    expect(history.putStories).not.toHaveBeenCalled();
  });
});
