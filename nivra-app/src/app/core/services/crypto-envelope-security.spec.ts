import { TestBed } from '@angular/core/testing';
import { StoredDeviceKeys } from '../models/nivra.models';
import { CryptoService } from './crypto.service';
import { NativeSecureVaultService } from './native-secure-vault.service';

describe('encrypted envelope security boundary', () => {
  let cryptoService: CryptoService;
  let sender: StoredDeviceKeys;
  let recipient: StoredDeviceKeys;
  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [{ provide: NativeSecureVaultService, useValue: {} }] });
    cryptoService = TestBed.inject(CryptoService);
    sender = { ...await cryptoService.createDeviceKeys(), userId: 'alice', deviceId: 'a' } as StoredDeviceKeys;
    recipient = { ...await cryptoService.createDeviceKeys(), userId: 'bob', deviceId: 'b' } as StoredDeviceKeys;
  });
  it('preserves v1 direct and v2 group decryption for existing devices', async () => {
    const payload = { text: 'Mensaje privado 🔐' };
    const direct = await cryptoService.encryptForPublicKey(sender, recipient.publicJwk, payload);
    expect(await cryptoService.decryptEnvelope(recipient, direct.header, direct.ciphertext)).toEqual(payload);
    const [group] = await cryptoService.encryptGroupPayloadForRecipients(sender, [{ userId: 'bob', deviceId: 'b', publicJwk: recipient.publicJwk }], payload);
    expect(await cryptoService.decryptEnvelope(recipient, group.header, group.ciphertext)).toEqual(payload);
  });
  it('rejects tampering, a foreign device and private material in a public header', async () => {
    const sealed = await cryptoService.encryptForPublicKey(sender, recipient.publicJwk, { text: 'secret' });
    const meta = JSON.parse(sealed.header!);
    const bytes = atob(sealed.ciphertext);
    const changed = btoa(String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1));
    await expectAsync(cryptoService.decryptEnvelope(recipient, sealed.header, changed)).toBeRejected();
    await expectAsync(cryptoService.decryptEnvelope(sender, sealed.header, sealed.ciphertext)).toBeRejected();
    await expectAsync(cryptoService.decryptEnvelope(recipient, JSON.stringify({ ...meta, senderPublicKey: sender.privateJwk }), sealed.ciphertext)).toBeRejected();
  });
  it('does not downgrade unknown versions or algorithms to static ECDH', async () => {
    const sealed = await cryptoService.encryptForPublicKey(sender, recipient.publicJwk, { text: 'secret' });
    const meta = JSON.parse(sealed.header!);
    for (const changed of [{ ...meta, v: 3 }, { ...meta, alg: 'NIVRA-RATCHET-V3' }, null, [], { ...meta, iv: btoa('short') }]) {
      await expectAsync(cryptoService.decryptEnvelope(recipient, JSON.stringify(changed), sealed.ciphertext)).toBeRejected();
    }
  });
  it('rejects nested group envelopes before recursion', async () => {
    const [sealed] = await cryptoService.encryptGroupPayloadForRecipients(sender, [{ userId: 'bob', deviceId: 'b', publicJwk: recipient.publicJwk }], { text: 'secret' });
    const meta = JSON.parse(sealed.header!);
    meta.keyHeader = sealed.header;
    await expectAsync(cryptoService.decryptEnvelope(recipient, JSON.stringify(meta), sealed.ciphertext)).toBeRejectedWithError('Formato de llave de grupo inválido.');
  });
  it('uses independent random nonces for consecutive legacy messages without claiming a ratchet', async () => {
    const a = await cryptoService.encryptForPublicKey(sender, recipient.publicJwk, { text: 'same' });
    const b = await cryptoService.encryptForPublicKey(sender, recipient.publicJwk, { text: 'same' });
    expect(JSON.parse(a.header!).iv).not.toBe(JSON.parse(b.header!).iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
