import { TestBed } from '@angular/core/testing';
import { ChatLaunchCacheService, ChatLaunchSnapshot } from './chat-launch-cache.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

describe('encrypted cold-start chat list', () => {
  const firstUser = 'cache-test-first-user';
  const secondUser = 'cache-test-second-user';
  let cache: ChatLaunchCacheService;

  beforeEach(() => {
    const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(37)));
    TestBed.configureTestingModule({ providers: [{
      provide: NativeSecureVaultService,
      useValue: { requiresProtection: () => true, getOrCreateSecret: async () => secret },
    }] });
    cache = TestBed.inject(ChatLaunchCacheService);
    cache.clear(firstUser);
    cache.clear(secondUser);
  });

  afterEach(() => {
    cache.clear(firstUser);
    cache.clear(secondUser);
  });

  it('keeps chat titles and previews encrypted and binds ciphertext to the account', async () => {
    const snapshot: ChatLaunchSnapshot = {
      conversations: [{
        id: 'private-room', participants: [], type: 'Direct', privacySettings: {},
        createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z',
      }],
      contacts: [],
      previews: { 'private-room': 'mensaje privado de prueba' },
    };
    await cache.save(firstUser, snapshot);
    const key = `nivra.chatLaunchCache.v1.${firstUser}`;
    const stored = localStorage.getItem(key);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('mensaje privado de prueba');
    expect((await cache.load(firstUser))?.previews['private-room']).toBe('mensaje privado de prueba');

    localStorage.setItem(`nivra.chatLaunchCache.v1.${secondUser}`, stored!);
    expect(await cache.load(secondUser)).toBeNull();
    cache.clear(firstUser);
    expect(await cache.load(firstUser)).toBeNull();
  });
});
