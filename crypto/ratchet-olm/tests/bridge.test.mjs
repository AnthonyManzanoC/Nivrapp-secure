import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LabWebDevice } from '../../ratchet-wasm/web-device.mjs';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
const bridge = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_olm.js');
function memory() {
  const rows = new Map();
  return { rows, read: async key => structuredClone(rows.get(key) ?? null), commit: async (key, revision, state) => {
    assert.equal(rows.get(key)?.revision ?? 0, revision); rows.set(key, { revision: revision + 1, state: structuredClone(state) }); return revision + 1;
  } };
}
const context = messageId => ({ conversationId: 'olm-chat', messageId });

test('ephemeral reception commits the ratchet without retaining a recoverable message', async () => {
  const {alice, bob} = await pair();
  try {
    await alice.establish(bob.address, await bob.bundle());
    const value = {text:'memory-only room'};
    const envelope = await alice.encrypt(bob.address, context('ephemeral-1'), value);
    assert.deepEqual(await bob.decrypt(alice.address, context('ephemeral-1'), envelope, true), value);
    assert.equal((await bob.pendingReceived()).length, 0);
    await assert.rejects(bob.decrypt(alice.address, context('ephemeral-1'), envelope, true));
    const next = await alice.encrypt(bob.address, context('normal-after-ephemeral'), {text:'regular history'});
    assert.deepEqual(await bob.decrypt(alice.address, context('normal-after-ephemeral'), next), {text:'regular history'});
    assert.equal((await bob.pendingReceived()).length, 1);
  } finally {await alice.close();await bob.close();}
});

test('a copied live session loses access after an honest two-way DH ratchet rotation', async () => {
  const { alice, bob, storage } = await pair(); let compromised;
  try {
    await alice.establish(bob.address, await bob.bundle());
    const first = await alice.encrypt(bob.address, context('compromise-0'), { text: 'before snapshot' });
    await bob.decrypt(alice.address, context('compromise-0'), first);
    await alice.releaseOutgoing('olm-chat', 'compromise-0');
    const fork = memory(); for (const [key, value] of storage.rows) fork.rows.set(key, structuredClone(value));
    compromised = await LabWebDevice.open(bridge, 'olm-alice', 1, fork);
    const exposed = await bob.encrypt(alice.address, context('compromise-1'), { text: 'current state is exposed' });
    assert.deepEqual(await compromised.decrypt(bob.address, context('compromise-1'), exposed), { text: 'current state is exposed' });
    await alice.decrypt(bob.address, context('compromise-1'), exposed);
    const rotated = await alice.encrypt(bob.address, context('compromise-2'), { text: 'fresh sender secret' });
    await bob.decrypt(alice.address, context('compromise-2'), rotated);
    const recovered = await bob.encrypt(alice.address, context('compromise-3'), { text: 'recovered session' });
    await assert.rejects(compromised.decrypt(bob.address, context('compromise-3'), recovered));
    assert.deepEqual(await alice.decrypt(bob.address, context('compromise-3'), recovered), { text: 'recovered session' });
  } finally { await compromised?.close(); await alice.close(); await bob.close(); }
});
test('ML-KEM-768 matches the independent noble implementation for seeded keys, ciphertexts and shared secrets', () => {
  for (let vector = 0; vector < 8; vector++) {
    const seed = Uint8Array.from({ length: 64 }, (_, index) => (index * 7 + vector * 31) & 255);
    const entropy = Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + vector * 17) & 255);
    const actual = JSON.parse(bridge.mlKemVector(seed, entropy)), reference = ml_kem768.keygen(seed), encapsulated = ml_kem768.encapsulate(reference.publicKey, entropy);
    assert.equal(actual.publicKey, Buffer.from(reference.publicKey).toString('base64'));
    assert.equal(actual.cipherText, Buffer.from(encapsulated.cipherText).toString('base64'));
    assert.equal(actual.sharedSecret, Buffer.from(encapsulated.sharedSecret).toString('base64'));
    assert.deepEqual(ml_kem768.decapsulate(encapsulated.cipherText, reference.secretKey), encapsulated.sharedSecret);
    reference.secretKey.fill(0); encapsulated.sharedSecret.fill(0);
  }
});
async function pair(storage = memory()) {
  const alice = await LabWebDevice.open(bridge, 'olm-alice', 1, storage, { createIfMissing: true });
  const bob = await LabWebDevice.open(bridge, 'olm-bob', 1, storage, { createIfMissing: true });
  await alice.pinIdentity(bob.address, bob.publicIdentity); await bob.pinIdentity(alice.address, alice.publicIdentity);
  return { alice, bob, storage };
}
test('signing a linked device leaves the source ratchet intact and the new device uses independent hybrid prekeys', async () => {
  const { alice, bob, storage } = await pair();
  const linked = await LabWebDevice.open(bridge, 'olm-alice-linked', 1, storage, { createIfMissing: true });
  try {
    await alice.establish(bob.address, await bob.bundle());
    const first = await alice.encrypt(bob.address, context('before-link'), { text: 'original session' });
    assert.deepEqual(await bob.decrypt(alice.address, context('before-link'), first), { text: 'original session' });
    const revision = storage.rows.get(JSON.stringify(['olm-alice', 1])).revision;
    const statement = new TextEncoder().encode(JSON.stringify(['nivra-device-continuity-v1','alice','olm-alice','A'.repeat(43)+':'+ 'B'.repeat(43)]));
    const signature = await alice.signDeviceContinuity(statement);
    assert(bridge.verifyIdentity(alice.publicIdentity, statement, signature));
    assert(!bridge.verifyIdentity(linked.publicIdentity, statement, signature));
    assert.equal(storage.rows.get(JSON.stringify(['olm-alice', 1])).revision, revision);
    await linked.pinIdentity(bob.address, bob.publicIdentity);
    await bob.pinIdentity(linked.address, linked.publicIdentity);
    await linked.establish(bob.address, await bob.bundle());
    const latest = await linked.encrypt(bob.address, context('new-linked'), { text: 'no history copied' });
    assert.deepEqual(await bob.decrypt(linked.address, context('new-linked'), latest), { text: 'no history copied' });
    const reply = await bob.encrypt(alice.address, context('keep-old'), { text: 'original device stays connected' });
    assert.deepEqual(await alice.decrypt(bob.address, context('keep-old'), reply), { text: 'original device stays connected' });
  } finally { await linked.close(); await alice.close(); await bob.close(); }
});
test('permissive bridge uses separate agreement/signing keys and authenticates its prekeys', async () => {
  const identity = bridge.createIdentity();
  try {
    const publicKey = bridge.identityPublic(identity); assert.equal(publicKey.length, 64);
    const message = new TextEncoder().encode('device continuity');
    const signature = bridge.signIdentity(identity, message);
    assert.equal(bridge.verifyIdentity(publicKey, message, signature), true);
    signature[0] ^= 1; assert.equal(bridge.verifyIdentity(publicKey, message, signature), false);
  } finally { identity.fill(0); }
  const { alice, bob } = await pair();
  try {
    const bundle = await bob.bundle(); assert.equal(bundle.suite, 'NIVRA-PQXDH-MLKEM768-BUNDLE-1');
    const altered = structuredClone(bundle); altered.preKeyId++;
    await assert.rejects(alice.establish(bob.address, altered));
    await alice.establish(bob.address, bundle);
  } finally { await alice.close(); await bob.close(); }
});
test('Olm and AES-GCM exchange ratchet turns, preserve exact retries and recover after reopening', async () => {
  let { alice, bob, storage } = await pair();
  try {
    await alice.establish(bob.address, await bob.bundle());
    for (let turn = 0; turn < 8; turn++) {
      const sender = turn % 2 ? bob : alice, receiver = turn % 2 ? alice : bob;
      const payload = { text: 'turn-' + turn }, at = context('turn-' + turn);
      const packet = await sender.encrypt(receiver.address, at, payload);
      assert.equal(packet.suite, 'NIVRA-PQXDH-MLKEM768-A256GCM-1');
      assert.deepEqual(await receiver.decrypt(sender.address, at, packet), payload);
      assert.deepEqual(await sender.encrypt(receiver.address, at, payload), packet);
      if (turn === 3) {
        await alice.close(); await bob.close();
        alice = await LabWebDevice.open(bridge, 'olm-alice', 1, storage); bob = await LabWebDevice.open(bridge, 'olm-bob', 1, storage);
      }
    }
    assert.equal((await alice.pendingReceived()).length, 4);
  } finally { await alice.close(); await bob.close(); }
});
test('simultaneous session initiation, out-of-order delivery, replay and altered outer payload fail safely', async () => {
  const { alice, bob } = await pair();
  try {
    await alice.establish(bob.address, await bob.bundle()); await bob.establish(alice.address, await alice.bundle());
    const left = await alice.encrypt(bob.address, context('sim-left'), { text: 'left' });
    const right = await bob.encrypt(alice.address, context('sim-right'), { text: 'right' });
    assert.deepEqual(await alice.decrypt(bob.address, context('sim-right'), right), { text: 'right' });
    assert.deepEqual(await bob.decrypt(alice.address, context('sim-left'), left), { text: 'left' });
    const packets = await Promise.all(Array.from({ length: 5 }, (_, index) => alice.encrypt(bob.address, context('order-' + index), { index })));
    const altered = structuredClone(packets[3]); const bytes = Buffer.from(altered.ciphertext, 'base64'); bytes[0] ^= 1; altered.ciphertext = bytes.toString('base64');
    await assert.rejects(bob.decrypt(alice.address, context('order-3'), altered));
    for (const index of [3, 0, 4, 1, 2]) assert.deepEqual(await bob.decrypt(alice.address, context('order-' + index), packets[index]), { index });
    await assert.rejects(bob.decrypt(alice.address, context('order-3'), packets[3]));
  } finally { await alice.close(); await bob.close(); }
});
test('one-time private keys replenish beyond 256 initiations without automatic eviction or identifier reuse', async () => {
  const { alice, bob } = await pair();
  try {
    for (let index = 0; index < 260; index++) {
      const bundle = await bob.bundle(); assert.equal(bundle.preKeyId, index + 1); await bob.acknowledgeBundles([bundle.preKeyId]);
      await alice.establish(bob.address, bundle);
      const at = context('lifecycle-' + index), packet = await alice.encrypt(bob.address, at, { index });
      assert.deepEqual(await bob.decrypt(alice.address, at, packet), { index });
      for (const item of await bob.pendingReceived()) await bob.acknowledgeReceived(item.id);
      await alice.releaseOutgoing(at.conversationId, at.messageId);
    }
    assert.equal((await bob.bundle()).preKeyId, 261);
    assert.equal((await bob.pendingBundles()).length, 1);
  } finally { await alice.close(); await bob.close(); }
});
test('consumed private prekeys and uncertain publication metadata disappear only after a durable authenticated delivery', async () => {
  let { alice, bob, storage } = await pair();
  try {
    const bundle = await bob.bundle(); assert.equal((await bob.pendingBundles()).length, 1);
    await alice.establish(bob.address, bundle);
    const envelope = await alice.encrypt(bob.address, context('consumed'), { text: 'durable' });
    assert.deepEqual(await bob.decrypt(alice.address, context('consumed'), envelope), { text: 'durable' });
    assert.equal((await bob.pendingBundles()).length, 0); assert.deepEqual(await bob.pendingConsumedPreKeys(), [bundle.preKeyId]);
    await bob.close(); bob = await LabWebDevice.open(bridge, 'olm-bob', 1, storage);
    assert.deepEqual(await bob.pendingConsumedPreKeys(), [bundle.preKeyId]);
    await bob.acknowledgeConsumedPreKeys([bundle.preKeyId]); assert.deepEqual(await bob.pendingConsumedPreKeys(), []);
  } finally { await alice.close(); await bob.close(); }
});
