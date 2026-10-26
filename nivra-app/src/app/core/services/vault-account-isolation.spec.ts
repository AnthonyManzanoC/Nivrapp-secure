import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { EncryptedDownloadService } from './encrypted-download.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { VaultService } from './vault.service';

describe('vault account and activation isolation', () => {
  const a = { user: { id: 'vault-scope-A', alias: 'vault-A' }, device: { id: 'device-A' } };
  const b = { user: { id: 'vault-scope-B', alias: 'vault-B' }, device: { id: 'device-B' } };
  const keyA = { name: 'fixture-key-A' } as unknown as CryptoKey;
  const keyB = { name: 'fixture-key-B' } as unknown as CryptoKey;
  const itemA: any = { id: 'note-A', kind: 'Note', encryptedMetadata: '{"iv":"i","ciphertext":"c"}', decoded: { title: 'PRIVATE A', body: 'A only' } };
  const roomA: any = { id: 'room-A', name: 'PRIVATE ROOM A', owner: { id: a.user.id }, updatedAt: '2026-10-25T00:00:00Z',
    members: [{ userId: a.user.id, alias: a.user.alias, status: 'Active' }, { userId: 'peer', alias: 'peer', status: 'Invited' }] };
  let session: ReturnType<typeof signal<any>>;
  let generation: ReturnType<typeof signal<number>>;
  let vault: VaultService;
  let api: { get: jasmine.Spy; post: jasmine.Spy; delete: jasmine.Spy; putRaw: jasmine.Spy };
  let cryptography: Record<string, jasmine.Spy>;
  let realtime: { events$: Subject<any>; joinVaultRoom: jasmine.Spy; sendVaultRoomMessage: jasmine.Spy };
  let chat: { createDirectConversation: jasmine.Spy; sendText: jasmine.Spy };
  let downloads: { file: jasmine.Spy };
  let privacy: { enable: jasmine.Spy; disable: jasmine.Spy };
  const settle = async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); };
  const switchTo = (value: any) => { session.set(value); generation.update(value => value + 1); };
  const activeKey = (value: typeof a) => `nivra.activeVaultRoomId.v2.${encodeURIComponent(JSON.stringify([value.user.id, value.device.id]))}`;
  const prime = () => {
    (vault as any).key = keyA; vault.unlocked.set(true); vault.items.set([itemA]); vault.rooms.set([roomA]);
    vault.messagesByRoom.set({ 'room-A': [{ id: 'message-A', payload: { type: 'text', text: 'PRIVATE MESSAGE A' } } as any] });
    vault.people.set([{ id: 'person-A', displayName: 'PRIVATE PERSON A' } as any]); vault.activeRoomId.set('room-A');
  };

  beforeEach(async () => {
    for (const account of [a, b]) { localStorage.removeItem(`nivra.vault.${account.user.id}`); localStorage.removeItem(activeKey(account)); }
    session = signal<any>(a); generation = signal(1);
    api = { get: jasmine.createSpy().and.returnValue(of([])), post: jasmine.createSpy().and.returnValue(of({})),
      delete: jasmine.createSpy().and.returnValue(of({})), putRaw: jasmine.createSpy().and.returnValue(of({})) };
    cryptography = {
      deriveVaultKey: jasmine.createSpy().and.resolveTo(keyA), randomBytes: jasmine.createSpy().and.returnValue(new Uint8Array(16)),
      encryptWithKey: jasmine.createSpy().and.resolveTo({ iv: 'iv', ciphertext: 'encrypted' }),
      decryptWithKey: jasmine.createSpy().and.resolveTo({ title: 'DECRYPTED A' }),
      b64: jasmine.createSpy().and.returnValue('AA=='), ub64: jasmine.createSpy().and.returnValue(new Uint8Array(16)),
      encryptAttachment: jasmine.createSpy().and.resolveTo({ bytes: new ArrayBuffer(1), key: 'key', iv: 'iv' }),
      decryptAttachment: jasmine.createSpy().and.resolveTo(new ArrayBuffer(1)),
      currentKeyMaterial: jasmine.createSpy().and.resolveTo({ publicJwk: {} }),
      decryptEnvelope: jasmine.createSpy().and.resolveTo({ type: 'text', text: 'DECRYPTED MESSAGE A' }),
      encryptForPublicKey: jasmine.createSpy().and.resolveTo({ ciphertext: 'sealed', header: 'header' }),
      parsePublicJwk: jasmine.createSpy().and.returnValue({ kty: 'EC' }),
    };
    realtime = { events$: new Subject(), joinVaultRoom: jasmine.createSpy().and.resolveTo(), sendVaultRoomMessage: jasmine.createSpy().and.resolveTo() };
    chat = { createDirectConversation: jasmine.createSpy().and.resolveTo({ id: 'conversation-A' }), sendText: jasmine.createSpy().and.resolveTo() };
    downloads = { file: jasmine.createSpy().and.resolveTo(new ArrayBuffer(1)) };
    privacy = { enable: jasmine.createSpy().and.resolveTo(), disable: jasmine.createSpy().and.resolveTo() };
    TestBed.configureTestingModule({ providers: [VaultService,
      { provide: AuthService, useValue: { session, sessionGeneration: generation, isAuthenticated: () => !!session() } },
      { provide: NivraApiService, useValue: api }, { provide: CryptoService, useValue: cryptography },
      { provide: SignalrService, useValue: realtime }, { provide: ChatService, useValue: chat },
      { provide: EncryptedDownloadService, useValue: downloads },
    ] });
    vault = TestBed.inject(VaultService);
    spyOn<any>(vault, 'loadPrivacyScreen').and.resolveTo(privacy);
    TestBed.flushEffects(); await settle();
    api.get.calls.reset(); api.post.calls.reset();
  });
  afterEach(async () => {
    TestBed.resetTestingModule(); await settle();
    for (const account of [a, b]) { localStorage.removeItem(`nivra.vault.${account.user.id}`); localStorage.removeItem(activeKey(account)); }
  });

  it('conceals every old account value synchronously before any scope effect runs', () => {
    prime(); vault.loading.set(true); vault.sending.set(true); vault.uploading.set(true); vault.voicePhase.set('connected');
    vault.voiceRoomId.set('room-A'); vault.voiceError.set('A error'); vault.voiceActiveSpeakers.set(['A']);
    switchTo(b);
    expect(vault.unlocked()).toBeFalse(); expect(vault.items()).toEqual([]); expect(vault.rooms()).toEqual([]);
    expect(vault.messagesByRoom()).toEqual({}); expect(vault.mediaPreviews()).toEqual({}); expect(vault.people()).toEqual([]);
    expect(vault.activeRoomId()).toBeNull(); expect(vault.activeRoom()).toBeNull(); expect(vault.activeMessages()).toEqual([]);
    expect(vault.loading()).toBeFalse(); expect(vault.sending()).toBeFalse(); expect(vault.uploading()).toBeFalse();
    expect(vault.voicePhase()).toBe('idle'); expect(vault.voiceRoomId()).toBeNull(); expect(vault.voiceError()).toBe('');
    expect(vault.voiceActiveSpeakers()).toEqual([]); expect(vault.voiceConnected()).toBeFalse();
  });

  it('does not resurrect an unlocked key during A to B to A without intervening effects', async () => {
    prime(); switchTo(b); switchTo(a);
    expect(vault.unlocked()).toBeFalse(); expect(vault.items()).toEqual([]);
    await expectAsync(vault.createNote('late A', 'body')).toBeRejectedWithError(/Desbloquea/);
    expect((vault as any).key).toBeNull(); expect(cryptography['encryptWithKey']).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });

  it('releases old object URLs, tracks, directories and private key on scope reset', async () => {
    prime(); const revoke = spyOn(URL, 'revokeObjectURL'); const stop = jasmine.createSpy();
    vault.mediaPreviews.set({ media: { url: 'blob:private-A' } as any });
    vault.voiceRemoteStreams.set({ peer: { getTracks: () => [{ enabled: true, stop }] } as unknown as MediaStream });
    (vault as any).directories.set('A', { userId: 'A' });
    const disconnect = jasmine.createSpy().and.resolveTo();
    (vault as any).voiceRoom = { removeAllListeners: jasmine.createSpy(), disconnect };
    switchTo(b); TestBed.flushEffects(); await settle();
    expect(revoke).toHaveBeenCalledWith('blob:private-A'); expect(stop).toHaveBeenCalled(); expect(disconnect).toHaveBeenCalled();
    expect((vault as any).key).toBeNull(); expect((vault as any).directories.size).toBe(0);
  });

  it('does not store a verifier or unlock B when A key derivation completes late', async () => {
    let finish!: (key: CryptoKey) => void;
    cryptography['deriveVaultKey'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = vault.unlock('synthetic-pin'); switchTo(b); finish(keyA);
    await expectAsync(pending).toBeRejectedWithError(/cuenta cambió/);
    expect(vault.unlocked()).toBeFalse(); expect(localStorage.getItem(`nivra.vault.${a.user.id}`)).toBeNull();
    expect(localStorage.getItem(`nivra.vault.${b.user.id}`)).toBeNull(); expect(cryptography['encryptWithKey']).not.toHaveBeenCalled();
  });

  it('does not replace B key with a delayed successful verifier decryption from A', async () => {
    localStorage.setItem(`nivra.vault.${a.user.id}`, JSON.stringify({ salt: 'AA==', verifier: { iv: 'iv', ciphertext: 'cipher' } }));
    let finish!: (value: unknown) => void;
    cryptography['decryptWithKey'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = vault.unlock('synthetic-pin'); await settle(); switchTo(b);
    (vault as any).captureContext(); (vault as any).key = keyB; vault.unlocked.set(true);
    finish({ ok: true }); await expectAsync(pending).toBeRejectedWithError(/cuenta cambió/);
    expect((vault as any).key).toBe(keyB); expect(vault.items()).toEqual([]);
  });

  it('drops old HTTP items and rooms after B has started its own load', async () => {
    const items = new Subject<any[]>(); const rooms = new Subject<any[]>();
    api.get.and.callFake((path: string) => path === '/vault/items' ? items : rooms);
    const pending = vault.load(); switchTo(b); (vault as any).captureContext(); vault.loading.set(true);
    items.next([itemA]); rooms.next([roomA]); await pending;
    expect(vault.items()).toEqual([]); expect(vault.rooms()).toEqual([]); expect(vault.loading()).toBeTrue();
  });

  it('drops an in-flight item decryption without publishing A plaintext into B', async () => {
    prime(); let finish!: (value: unknown) => void;
    cryptography['decryptWithKey'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    api.get.and.callFake((path: string) => of(path === '/vault/items' ? [itemA] : [roomA]));
    const pending = vault.load(); await settle(); switchTo(b); (vault as any).captureContext();
    finish({ title: 'LATE PRIVATE A' }); await pending;
    expect(vault.items()).toEqual([]); expect(vault.rooms()).toEqual([]); expect(vault.unlocked()).toBeFalse();
  });

  it('does not POST a note under B after encryption started with A key', async () => {
    prime(); let finish!: (value: unknown) => void;
    cryptography['encryptWithKey'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = vault.createNote('PRIVATE A', 'body'); await settle(); switchTo(b);
    finish({ iv: 'iv', ciphertext: 'A envelope' }); await expectAsync(pending).toBeRejectedWithError(/cuenta cambió/);
    expect(api.post).not.toHaveBeenCalled(); expect(vault.items()).toEqual([]);
  });

  it('does not create a B file record when A attachment encryption finishes after switching', async () => {
    prime(); let finish!: (value: unknown) => void;
    cryptography['encryptAttachment'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = vault.sendRoomFile(new File(['private'], 'private-A.txt')); await settle(); switchTo(b);
    finish({ bytes: new ArrayBuffer(1), key: 'A-key', iv: 'A-iv' }); await expectAsync(pending).toBeRejectedWithError(/cuenta cambió/);
    expect(api.post).not.toHaveBeenCalled(); expect(api.putRaw).not.toHaveBeenCalled(); expect(vault.mediaPreviews()).toEqual({});
  });

  it('does not create a preview URL from an A file decryption completed under B', async () => {
    prime(); let finish!: (value: ArrayBuffer) => void;
    cryptography['decryptAttachment'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    const create = spyOn(URL, 'createObjectURL').and.returnValue('blob:should-not-exist');
    const pending = vault.ensureMediaPreview({ type: 'file', fileId: 'file-A', fileKey: 'A-key', fileIv: 'iv' });
    await settle(); switchTo(b); finish(new ArrayBuffer(1));
    expect(await pending).toBeNull(); expect(create).not.toHaveBeenCalled(); expect(vault.mediaPreviews()).toEqual({});
  });

  it('does not publish a realtime A envelope after decrypting during an account switch', async () => {
    let finish!: (value: unknown) => void;
    cryptography['decryptEnvelope'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = (vault as any).ingestRealtimeMessage({ id: 'message-A', vaultRoomId: 'room-A', senderDeviceId: 'peer-device',
      recipients: [{ userId: a.user.id, deviceId: a.device.id, ciphertext: 'cipher' }] });
    await settle(); switchTo(b); finish({ type: 'text', text: 'LATE PRIVATE A' }); await pending;
    expect(vault.messagesByRoom()).toEqual({});
  });

  it('does not send a vault payload with B transport after A recipient encryption resumes', async () => {
    prime(); let finish!: (value: unknown) => void;
    cryptography['encryptForPublicKey'].and.returnValue(new Promise(resolve => { finish = resolve; }));
    (vault as any).directories.set(a.user.id, { userId: a.user.id, devices: [{ deviceId: a.device.id, keyBundle: { identityKey: '{}' } }] });
    const pending = vault.sendRoomText('PRIVATE A'); await settle(); switchTo(b);
    finish({ ciphertext: 'A ciphertext', header: 'header' }); await expectAsync(pending).toBeRejectedWithError(/cuenta cambió/);
    expect(realtime.sendVaultRoomMessage).not.toHaveBeenCalled(); expect(vault.messagesByRoom()).toEqual({});
  });

  it('does not send an A room invitation through B chat after a direct conversation awaits', async () => {
    let finish!: (value: unknown) => void; chat.createDirectConversation.and.returnValue(new Promise(resolve => { finish = resolve; }));
    const context = (vault as any).captureContext();
    const pending = (vault as any).notifyVaultInvites(roomA, ['peer'], null, context); await settle(); switchTo(b);
    finish({ id: 'A-conversation' }); await pending; expect(chat.sendText).not.toHaveBeenCalled();
  });

  it('keeps selected room storage per user and device and ignores ownerless legacy selection', () => {
    const legacy = localStorage.getItem('nivra.activeVaultRoomId'); localStorage.setItem('nivra.activeVaultRoomId', 'legacy-A');
    try {
      (vault as any).setActiveRoom('selected-A'); switchTo(b); (vault as any).captureContext();
      expect(vault.activeRoomId()).toBeNull(); (vault as any).setActiveRoom('selected-B');
      switchTo(a); (vault as any).captureContext(); expect(vault.activeRoomId()).toBe('selected-A');
      expect(localStorage.getItem(activeKey(b))).toBe('selected-B'); expect(localStorage.getItem('nivra.activeVaultRoomId')).toBe('legacy-A');
    } finally { if (legacy === null) localStorage.removeItem('nivra.activeVaultRoomId'); else localStorage.setItem('nivra.activeVaultRoomId', legacy); }
  });

  it('serializes a delayed A shield disable before applying B latest enable', async () => {
    await vault.enablePrivacyShield(); let finish!: () => void; let physical = true;
    privacy.disable.and.returnValue(new Promise<void>(resolve => { finish = () => { physical = false; resolve(); }; }));
    privacy.enable.and.callFake(async () => { physical = true; });
    const old = vault.disablePrivacyShield(); await settle(); switchTo(b); (vault as any).captureContext();
    const next = vault.enablePrivacyShield(); await settle(); expect(privacy.enable).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([old, next]); expect(physical).toBeTrue(); expect(privacy.enable).toHaveBeenCalledTimes(2);
    privacy.disable.and.resolveTo();
  });

  it('does not enable a stale A shield when its optional plugin import resolves after switching', async () => {
    let finish!: (value: unknown) => void;
    ((vault as any).loadPrivacyScreen as jasmine.Spy).and.returnValue(new Promise(resolve => { finish = resolve; }));
    const old = vault.enablePrivacyShield(); switchTo(b); (vault as any).captureContext();
    ((vault as any).loadPrivacyScreen as jasmine.Spy).and.resolveTo(privacy);
    finish(privacy); await old; expect(privacy.enable).not.toHaveBeenCalled(); expect(privacy.disable).toHaveBeenCalledTimes(1);
  });
});
