import { TestBed } from '@angular/core/testing';
import { BaseKeyProvider } from 'livekit-client';
import { CallSession } from '../models/nivra.models';
import { GROUP_CRYPTO_PLATFORM, GroupCallCryptoService, GroupEncryptionContext, MediaKeySignalType } from './group-call-crypto.service';

describe('group media encryption', () => {
  let alice: GroupCallCryptoService;
  let bob: GroupCallCryptoService;
  let terminated: jasmine.Spy[];
  let call: CallSession;
  let messages: Array<{ from: string; to: string; type: MediaKeySignalType; payload: any }>;
  let contexts: GroupEncryptionContext[];
  beforeEach(() => {
    terminated = []; messages = []; contexts = [];
    TestBed.configureTestingModule({ providers: [{ provide: GROUP_CRYPTO_PLATFORM, useValue: {
      supported: () => true,
      createWorker: () => { const terminate = jasmine.createSpy(); terminated.push(terminate); return { terminate } as unknown as Worker; },
      handshakeTimeoutMs: 250,
    } }] });
    alice = TestBed.runInInjectionContext(() => new GroupCallCryptoService());
    bob = TestBed.runInInjectionContext(() => new GroupCallCryptoService());
    call = { id: 'secure-room', initiatorUserId: 'alice', type: 'Voice', status: 'Active', startedAt: new Date().toISOString(),
      mediaEncryption: 'livekit-e2ee-v1', participantUserIds: ['alice', 'bob'], participantSessions: {
        alice: { deviceId: 'alice-phone', clientSessionId: 'alice-tab' }, bob: { deviceId: 'bob-phone', clientSessionId: 'bob-tab' },
      } };
  });
  afterEach(() => { contexts.forEach(context => context.dispose()); alice.clear(call.id); bob.clear(call.id); });
  const transport = (from: string, service: () => GroupCallCryptoService, currentCall: () => CallSession,
    records: () => typeof messages) => async (to: string, type: MediaKeySignalType, payload: unknown) => {
    records().push({ from, to, type, payload });
    if ((from === 'alice' && to === 'bob') || (from === 'bob' && to === 'alice')) await service().handleSignal(currentCall(), from, type, payload);
  };
  async function connectPair() {
    contexts = await Promise.all([
      alice.prepare(call, 'alice', transport('alice', () => bob, () => call, () => messages)),
      bob.prepare(call, 'bob', transport('bob', () => alice, () => call, () => messages)),
    ]);
  }
  it('exchanges distinct publisher keys and imports nonextractable SDK material', async () => {
    await connectPair();
    const aliceKey = messages.find(message => message.from === 'alice' && message.type === 'media-key')!.payload.key;
    const bobKey = messages.find(message => message.from === 'bob' && message.type === 'media-key')!.payload.key;
    expect(aliceKey).not.toEqual(bobKey);
    const provider = (contexts[0].encryption as { keyProvider: BaseKeyProvider }).keyProvider;
    expect(provider.getOptions().sharedKey).toBeFalse();
    expect(provider.getOptions().keySize).toBe(256);
    expect(provider.getKeys().length).toBe(2);
    expect(provider.getKeys().every(info => !info.key.extractable)).toBeTrue();
  });
  it('refuses a legacy room rather than downgrading media', async () => {
    await expectAsync(alice.prepare({ ...call, mediaEncryption: null }, 'alice', async () => undefined)).toBeRejected();
    expect(terminated.length).toBe(0);
  });
  it('fails closed if an active peer never confirms encryption', async () => {
    await expectAsync(alice.prepare(call, 'alice', async () => undefined)).toBeRejectedWithError(/No se confirmó/);
    expect(terminated[0]).toHaveBeenCalled();
  });
  it('does not accept a key addressed to a different browser session', async () => {
    const waiting = alice.prepare(call, 'alice', async () => undefined);
    await alice.handleSignal(call, 'bob', 'media-key', { v: 1, callId: call.id, senderSession: 'bob-phone:bob-tab',
      recipientSession: 'alice-phone:another-tab', revision: 1, keyId: 'key-test', key: btoa('a'.repeat(32)) });
    await expectAsync(waiting).toBeRejectedWithError(/No se confirmó/);
  });
  it('rotates publisher key on membership change and excludes a departed user', async () => {
    await connectPair();
    const before = (alice as any).states.get(call.id).local.keyId;
    messages.length = 0;
    call = { ...call, participantSessions: { alice: call.participantSessions!['alice'] } };
    await alice.updateRoster(call);
    expect((alice as any).states.get(call.id).local.keyId).not.toEqual(before);
    expect(messages.length).toBe(0);
    expect((alice as any).states.get(call.id).remote.size).toBe(0);
  });
  it('rejects an old key revision after publisher rotation', async () => {
    await connectPair();
    const old = messages.find(message => message.from === 'bob' && message.type === 'media-key')!;
    call = { ...call, participantSessions: { ...call.participantSessions, carol: { deviceId: 'carol-phone', clientSessionId: 'carol-tab' } } };
    await Promise.all([alice.updateRoster(call), bob.updateRoster(call)]);
    const revision = (alice as any).states.get(call.id).remote.get('bob').revision;
    await alice.handleSignal(call, 'bob', 'media-key', old.payload);
    expect((alice as any).states.get(call.id).remote.get('bob').revision).toBe(revision);
    expect(revision).toBeGreaterThan(old.payload.revision);
  });
  it('enables SDK encryption before callers can publish', async () => {
    await connectPair();
    const room = { isE2EEEnabled: false, setE2EEEnabled: jasmine.createSpy().and.callFake(async (enabled: boolean) => { room.isE2EEEnabled = enabled; }) };
    await contexts[0].enable(room);
    expect(room.setE2EEEnabled).toHaveBeenCalledOnceWith(true);
    expect(room.isE2EEEnabled).toBeTrue();
  });
  it('clears retained raw keys and terminates cryptographic workers on exit', async () => {
    await connectPair();
    const raw: Uint8Array = (alice as any).states.get(call.id).local.raw;
    alice.clear(call.id);
    expect([...raw].every(value => value === 0)).toBeTrue();
    expect((alice as any).states.size).toBe(0);
    expect(terminated[0]).toHaveBeenCalled();
    await expectAsync(contexts[0].enable({ isE2EEEnabled: true, setE2EEEnabled: async () => undefined })).toBeRejected();
  });
});
