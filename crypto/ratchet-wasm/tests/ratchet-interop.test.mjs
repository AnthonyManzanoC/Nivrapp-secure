import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  PreKeyBundle, ProtocolAddress, PublicKey, KEMPublicKey, signalEncrypt, signalDecrypt, signalDecryptPreKey,
  SignalMessage, PreKeySignalMessage, CiphertextMessageType,
} from '../../ratchet-pilot/node_modules/@signalapp/libsignal-client/dist/index.js';
import { PilotDevice } from '../../ratchet-pilot/ratchet.mjs';

const wasm = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_wasm.js');
const b64 = value => Buffer.from(value).toString('base64');
const binary = value => Buffer.from(value, 'base64');
function newWasm(name) {
  const secret = wasm.createIdentity(), pub = wasm.identityPublic(secret);
  const device = new wasm.RatchetDevice(name, 1, secret, 37); secret.fill(0);
  return { device, pub, address: ProtocolAddress.new(name, 1), name };
}
function nativeBundle(wire) {
  return PreKeyBundle.new(wire.registrationId, wire.deviceId, wire.preKeyId, PublicKey.deserialize(binary(wire.preKeyPublic)),
    wire.signedPreKeyId, PublicKey.deserialize(binary(wire.signedPreKeyPublic)), binary(wire.signedPreKeySignature),
    PublicKey.deserialize(binary(wire.identityKey)), wire.kyberPreKeyId, KEMPublicKey.deserialize(binary(wire.kyberPreKeyPublic)), binary(wire.kyberPreKeySignature));
}
function bundleWire(bundle) {
  return JSON.stringify({ v: 1, suite: 'NIVRA-LIBSIGNAL-BUNDLE-PILOT-1', registrationId: bundle.registrationId(), deviceId: bundle.deviceId(),
    identityKey: b64(bundle.identityKey().serialize()), preKeyId: bundle.preKeyId(), preKeyPublic: b64(bundle.preKeyPublic().serialize()),
    signedPreKeyId: bundle.signedPreKeyId(), signedPreKeyPublic: b64(bundle.signedPreKeyPublic().serialize()), signedPreKeySignature: b64(bundle.signedPreKeySignature()),
    kyberPreKeyId: bundle.kyberPreKeyId(), kyberPreKeyPublic: b64(bundle.kyberPreKeyPublic().serialize()), kyberPreKeySignature: b64(bundle.kyberPreKeySignature()) });
}
async function nativeEncrypt(device, recipient, text) {
  const message = await signalEncrypt(Buffer.from(text), recipient, device.address, device, device);
  return { type: message.type(), bytes: b64(message.serialize()) };
}
async function nativeDecrypt(device, sender, packet) {
  const bytes = binary(packet.bytes);
  return Buffer.from(packet.type === CiphertextMessageType.PreKey
    ? await signalDecryptPreKey(PreKeySignalMessage.deserialize(bytes), sender, device.address, device, device, device, device, device)
    : await signalDecrypt(SignalMessage.deserialize(bytes), sender, device.address, device, device));
}
async function nativeInitiator() {
  const alice = new PilotDevice(randomUUID()); const bob = newWasm('wasm-bob');
  await alice.pinIdentity(bob.address, PublicKey.deserialize(bob.pub));
  await bob.device.pinIdentity(alice.address.name(), 1, alice.publicIdentity.serialize());
  await alice.establish(bob.address, nativeBundle(JSON.parse(await bob.device.preKeyBundle(Date.now()))));
  return { alice, bob };
}

test('native initiator and WASM responder exchange eight turns through real libsignal ratchet steps', async () => {
  const { alice, bob } = await nativeInitiator();
  try {
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) {
        const packet = await nativeEncrypt(alice, bob.address, 'native-' + i);
        const plain = await bob.device.decrypt(alice.address.name(), 1, packet.type, binary(packet.bytes));
        assert.equal(Buffer.from(plain).toString(), 'native-' + i);
      } else {
        const packet = JSON.parse(await bob.device.encrypt(alice.address.name(), 1, Buffer.from('wasm-' + i), Date.now()));
        assert.equal((await nativeDecrypt(alice, bob.address, packet)).toString(), 'wasm-' + i);
      }
    }
  } finally { bob.device.free(); }
});
test('WASM initiates with a native prekey bundle, including its PQ handshake', async () => {
  const alice = newWasm('wasm-alice'), bob = new PilotDevice(randomUUID());
  try {
    await alice.device.pinIdentity(bob.address.name(), 1, bob.publicIdentity.serialize());
    await bob.pinIdentity(alice.address, PublicKey.deserialize(alice.pub));
    await alice.device.establish(bob.address.name(), 1, bundleWire(await bob.bundle()), Date.now());
    const packet = JSON.parse(await alice.device.encrypt(bob.address.name(), 1, Buffer.from('WASM initiation'), Date.now()));
    assert.equal(packet.type, CiphertextMessageType.PreKey);
    assert.equal((await nativeDecrypt(bob, alice.address, packet)).toString(), 'WASM initiation');
    const reply = await nativeEncrypt(bob, alice.address, 'Native reply');
    assert.equal(Buffer.from(await alice.device.decrypt(bob.address.name(), 1, reply.type, binary(reply.bytes))).toString(), 'Native reply');
  } finally { alice.device.free(); }
});
test('WASM handles out-of-order messages, rejects replay and rolls back a damaged packet', async () => {
  const { alice, bob } = await nativeInitiator();
  try {
    const packets = [];
    for (let i = 0; i < 5; i++) packets.push(await nativeEncrypt(alice, bob.address, 'order-' + i));
    const corrupt = binary(packets[3].bytes); corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(bob.device.decrypt(alice.address.name(), 1, packets[3].type, corrupt));
    for (const i of [3, 0, 4, 2, 1]) {
      assert.equal(Buffer.from(await bob.device.decrypt(alice.address.name(), 1, packets[i].type, binary(packets[i].bytes))).toString(), 'order-' + i);
    }
    await assert.rejects(bob.device.decrypt(alice.address.name(), 1, packets[1].type, binary(packets[1].bytes)));
  } finally { bob.device.free(); }
});
test('WASM checkpoint permits outer authentication rollback and rejects stale transaction tokens', async () => {
  const { alice, bob } = await nativeInitiator();
  try {
    const packet = await nativeEncrypt(alice, bob.address, 'Authenticated capsule');
    const checkpoint = bob.device.checkpoint();
    await bob.device.decrypt(alice.address.name(), 1, packet.type, binary(packet.bytes));
    assert.throws(() => bob.device.commit(checkpoint + 1));
    bob.device.rollback(checkpoint);
    assert.equal(Buffer.from(await bob.device.decrypt(alice.address.name(), 1, packet.type, binary(packet.bytes))).toString(), 'Authenticated capsule');
    assert.throws(() => bob.device.rollback(checkpoint));
    await assert.rejects(bob.device.decrypt(alice.address.name(), 1, packet.type, binary(packet.bytes)));
  } finally { bob.device.free(); }
});
test('WASM rejects unverified or changed identities, invalid signatures and unknown wire versions', async () => {
  const alice = newWasm('wasm-unverified'), bob = new PilotDevice(randomUUID());
  try {
    const wire = bundleWire(await bob.bundle());
    await assert.rejects(alice.device.establish(bob.address.name(), 1, wire, Date.now()));
    await alice.device.pinIdentity(bob.address.name(), 1, bob.publicIdentity.serialize());
    const changed = new PilotDevice(bob.address.name());
    await assert.rejects(alice.device.pinIdentity(bob.address.name(), 1, changed.publicIdentity.serialize()));
    const altered = JSON.parse(wire); const signature = binary(altered.signedPreKeySignature); signature[0] ^= 1;
    altered.signedPreKeySignature = b64(signature);
    await assert.rejects(alice.device.establish(bob.address.name(), 1, JSON.stringify(altered), Date.now()));
    await assert.rejects(alice.device.establish(bob.address.name(), 1, JSON.stringify({ ...JSON.parse(wire), v: 2 }), Date.now()));
    await alice.device.establish(bob.address.name(), 1, wire, Date.now());
    await assert.rejects(alice.device.decrypt(bob.address.name(), 1, 999, new Uint8Array(1)));
  } finally { alice.device.free(); }
});
