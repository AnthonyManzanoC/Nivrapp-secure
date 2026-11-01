import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LabWebDevice } from '../../ratchet-wasm/web-device.mjs';
const bridge = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_olm.js');
function memory() {
  const rows = new Map();
  return { rows, read: async key => structuredClone(rows.get(key) ?? null), commit: async (key, revision, state) => {
    assert.equal(rows.get(key)?.revision ?? 0, revision); rows.set(key, { revision: revision + 1, state: structuredClone(state) }); return revision + 1;
  } };
}
const context = messageId => ({ conversationId: 'olm-chat', messageId });
async function pair(storage = memory()) {
  const alice = await LabWebDevice.open(bridge, 'olm-alice', 1, storage, { createIfMissing: true });
  const bob = await LabWebDevice.open(bridge, 'olm-bob', 1, storage, { createIfMissing: true });
  await alice.pinIdentity(bob.address, bob.publicIdentity); await bob.pinIdentity(alice.address, alice.publicIdentity);
  return { alice, bob, storage };
}
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
