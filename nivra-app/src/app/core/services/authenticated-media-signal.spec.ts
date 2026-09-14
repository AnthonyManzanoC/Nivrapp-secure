import { TestBed } from '@angular/core/testing';
import { AuthSession, CallSignalEvent, PublicKeyDirectory, StoredDeviceKeys } from '../models/nivra.models';
import { CryptoService } from './crypto.service';
import { NativeSecureVaultService } from './native-secure-vault.service';
import { decodeAuthenticatedMediaKeySignal } from './authenticated-media-signal';

describe('authenticated media key signaling', () => {
  let cryptography: CryptoService;
  let directory: PublicKeyDirectory;
  let session: AuthSession;
  let signal: CallSignalEvent;
  let receiver: StoredDeviceKeys;
  let encrypted: { ciphertext: string; header?: string | null };
  const payload = { v: 1, callId: 'secure-room', key: 'fixture-only' };
  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [CryptoService, { provide: NativeSecureVaultService, useValue: {} }] });
    cryptography = TestBed.inject(CryptoService);
    const sender = { ...await cryptography.createDeviceKeys(), alias: 'sender', deviceId: 'sender-phone' } as StoredDeviceKeys;
    receiver = { ...await cryptography.createDeviceKeys(), alias: 'receiver', deviceId: 'receiver-phone' } as StoredDeviceKeys;
    spyOn(cryptography, 'currentKeyMaterial').and.resolveTo(receiver);
    session = { user: { id: 'receiver', alias: 'receiver' }, device: { id: receiver.deviceId } } as AuthSession;
    directory = { userId: 'sender', alias: 'sender', devices: [{ deviceId: sender.deviceId, deviceName: 'sender', keyBundle: sender.keyBundle, lastRotatedAt: '' }] };
    encrypted = await cryptography.encryptForPublicKey(sender, receiver.publicJwk, {
      type: 'media-key', sourceDeviceId: sender.deviceId, sourceSessionId: 'sender-tab', payload,
    });
    signal = { callId: 'secure-room', fromUserId: 'sender', fromDeviceId: sender.deviceId, fromClientSessionId: 'sender-tab', signalType: 'media-key',
      payloadCiphertext: cryptography.base64UrlJson({ v: 2, type: 'nivra-call-signal', recipients: [{ userId: 'receiver', deviceId: receiver.deviceId, ...encrypted }] }) };
  });
  it('decrypts a message authenticated to the current sender device directory', async () => {
    expect(await decodeAuthenticatedMediaKeySignal(signal, directory, session, cryptography)).toEqual(payload);
  });
  it('rejects plaintext legacy key messages', async () => {
    signal.payloadCiphertext = btoa(JSON.stringify({ type: 'media-key', payload }));
    expect(await decodeAuthenticatedMediaKeySignal(signal, directory, session, cryptography)).toBeNull();
  });
  it('rejects substituted sender keys before decryption', async () => {
    const attacker = await cryptography.createDeviceKeys();
    directory.devices[0].keyBundle = attacker.keyBundle;
    expect(await decodeAuthenticatedMediaKeySignal(signal, directory, session, cryptography)).toBeNull();
  });
  it('does not fall back to another local device recipient', async () => {
    signal.payloadCiphertext = cryptography.base64UrlJson({ v: 2, type: 'nivra-call-signal', recipients: [{ userId: 'receiver', deviceId: 'other-phone', ...encrypted }] });
    expect(await decodeAuthenticatedMediaKeySignal(signal, directory, session, cryptography)).toBeNull();
  });
  it('rejects changing the outer source session or signal type', async () => {
    expect(await decodeAuthenticatedMediaKeySignal({ ...signal, fromClientSessionId: 'other-tab' }, directory, session, cryptography)).toBeNull();
    expect(await decodeAuthenticatedMediaKeySignal({ ...signal, signalType: 'media-key-ready' }, directory, session, cryptography)).toBeNull();
  });
  it('rejects changing ciphertext authenticated by AES-GCM', async () => {
    encrypted.ciphertext = `${encrypted.ciphertext[0] === 'A' ? 'B' : 'A'}${encrypted.ciphertext.slice(1)}`;
    signal.payloadCiphertext = cryptography.base64UrlJson({ v: 2, type: 'nivra-call-signal', recipients: [{ userId: 'receiver', deviceId: receiver.deviceId, ...encrypted }] });
    expect(await decodeAuthenticatedMediaKeySignal(signal, directory, session, cryptography)).toBeNull();
  });
});
