import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { PublicKey, ProtocolAddress, PreKeyBundle, KEMPublicKey } from '../../ratchet-pilot/node_modules/@signalapp/libsignal-client/dist/index.js';
import { PilotDevice } from '../../ratchet-pilot/ratchet.mjs';
import { LabWebDevice } from '../web-device.mjs';

const bridge = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_wasm.js');
const decode = value => Buffer.from(value, 'base64');
const encode = value => Buffer.from(value).toString('base64');
const context = id => ({ conversationId: 'synthetic-conversation', messageId: id });
const address = native => ({ name: native.address.name(), device: native.address.deviceId() });
function wire(bundle) {
  return { v: 1, suite: 'NIVRA-LIBSIGNAL-BUNDLE-PILOT-1', registrationId: bundle.registrationId(), deviceId: bundle.deviceId(),
    identityKey: encode(bundle.identityKey().serialize()), preKeyId: bundle.preKeyId(), preKeyPublic: encode(bundle.preKeyPublic().serialize()),
    signedPreKeyId: bundle.signedPreKeyId(), signedPreKeyPublic: encode(bundle.signedPreKeyPublic().serialize()), signedPreKeySignature: encode(bundle.signedPreKeySignature()),
    kyberPreKeyId: bundle.kyberPreKeyId(), kyberPreKeyPublic: encode(bundle.kyberPreKeyPublic().serialize()), kyberPreKeySignature: encode(bundle.kyberPreKeySignature()) };
}
async function pair(initiator = 'web') {
  const web = new LabWebDevice(bridge, 'web-' + randomUUID()), native = new PilotDevice(randomUUID());
  const webAddress = ProtocolAddress.new(web.address.name, web.address.device);
  await web.pinIdentity(address(native), native.publicIdentity.serialize());
  await native.pinIdentity(webAddress, PublicKey.deserialize(web.publicIdentity));
  if (initiator === 'web') await web.establish(address(native), wire(await native.bundle()));
  else {
    const bundle = await web.bundle();
    await native.establish(webAddress, PreKeyBundle.new(bundle.registrationId, bundle.deviceId, bundle.preKeyId, PublicKey.deserialize(decode(bundle.preKeyPublic)),
      bundle.signedPreKeyId, PublicKey.deserialize(decode(bundle.signedPreKeyPublic)), decode(bundle.signedPreKeySignature), PublicKey.deserialize(decode(bundle.identityKey)),
      bundle.kyberPreKeyId, KEMPublicKey.deserialize(decode(bundle.kyberPreKeyPublic)), decode(bundle.kyberPreKeySignature)));
  }
  return { web, native, webAddress };
}

for (const initiator of ['web', 'native']) test(`WebCrypto AES-256-GCM envelopes interoperate with native pilot, initiated by ${initiator}`, async () => {
  const { web, native, webAddress } = await pair(initiator);
  try {
    for (let i = 0; i < 8; i++) {
      const payload = { type: 'text', text: 'Mensaje seguro 🌎 ' + i, ttl: 86400 }, ctx = context('turn-' + i);
      if ((i % 2 === 0) === (initiator === 'web')) {
        const envelope = await web.encrypt(address(native), ctx, payload);
        assert.deepEqual(await native.decrypt(webAddress, ctx, envelope), payload);
      } else {
        const envelope = await native.encrypt(webAddress, ctx, payload);
        assert.deepEqual(await web.decrypt(address(native), ctx, envelope), payload);
      }
    }
  } finally { await web.close(); }
});

test('concurrent browser sends preserve exact retry bytes and snapshot caller input', async () => {
  const { web, native, webAddress } = await pair();
  try {
    const payload = { text: 'original' }, ctx = context('snapshot');
    const first = web.encrypt(address(native), ctx, payload);
    payload.text = 'changed'; ctx.messageId = 'changed';
    const original = await first;
    assert.deepEqual(await native.decrypt(webAddress, context('snapshot'), original), { text: 'original' });
    const retry = await web.encrypt(address(native), context('snapshot'), { text: 'original' });
    assert.deepEqual(retry, original);
    retry.iv = 'caller changed';
    assert.deepEqual(await web.encrypt(address(native), context('snapshot'), { text: 'original' }), original);
    await assert.rejects(web.encrypt(address(native), context('snapshot'), { text: 'different' }), /reused/);
    const packets = await Promise.all(Array.from({ length: 12 }, (_, i) => web.encrypt(address(native), context('queued-' + i), { text: 'queued-' + i })));
    for (const i of [11, 0, 7, 4, 2, 10, 6, 3, 8, 1, 9, 5]) {
      assert.deepEqual(await native.decrypt(webAddress, context('queued-' + i), packets[i]), { text: 'queued-' + i });
    }
  } finally { await web.close(); }
});

test('AES-GCM nonce/payload tampering and wrong routing roll back without consuming the valid message', async () => {
  const { web, native, webAddress } = await pair('native');
  try {
    const ctx = context('authentication'), payload = { text: 'legitimate' };
    const envelope = await native.encrypt(webAddress, ctx, payload);
    for (const field of ['iv', 'ciphertext']) {
      const bad = structuredClone(envelope), bytes = decode(bad[field]); bytes[0] ^= 1; bad[field] = encode(bytes);
      await assert.rejects(web.decrypt(address(native), ctx, bad));
    }
    await assert.rejects(web.decrypt(address(native), context('another-chat-message'), envelope), /context/);
    await assert.rejects(web.decrypt(address(native), ctx, { ...envelope, v: 99 }), /protocol/);
    assert.deepEqual(await web.decrypt(address(native), ctx, envelope), payload);
    await assert.rejects(web.decrypt(address(native), ctx, envelope));
  } finally { await web.close(); }
});
