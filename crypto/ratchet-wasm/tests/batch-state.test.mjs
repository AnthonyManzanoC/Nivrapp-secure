import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LabWebDevice } from '../web-device.mjs';
const bridge = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_wasm.js');

test('multi-recipient encryption commits one revision and rolls the whole batch back on failure', async () => {
  const saved = new Map(); let commits = 0;
  const storage = { read: async key => structuredClone(saved.get(key) ?? null), commit: async (key, revision, state) => {
    assert.equal(saved.get(key)?.revision ?? 0, revision); commits++; saved.set(key, { revision: revision + 1, state: structuredClone(state) }); return revision + 1;
  } };
  let alice = await LabWebDevice.open(bridge, 'batch-alice', 1, storage, { createIfMissing: true });
  const bob = new LabWebDevice(bridge, 'batch-bob'), carol = new LabWebDevice(bridge, 'batch-carol');
  try {
    for (const peer of [bob, carol]) {
      await alice.pinIdentity(peer.address, peer.publicIdentity); await peer.pinIdentity(alice.address, alice.publicIdentity);
      await alice.establish(peer.address, await peer.bundle());
    }
    const context = { conversationId: 'batch-chat', messageId: 'first' }, payload = { key: 'synthetic-content-key' };
    const before = commits;
    const requests = [bob, carol].map(peer => ({ peer: peer.address, context, payload }));
    const encrypted = await alice.encryptMany(requests);
    assert.equal(commits, before + 1);
    await alice.close(); alice = await LabWebDevice.open(bridge, 'batch-alice', 1, storage);
    assert.deepEqual(await alice.encryptMany(requests), encrypted);
    assert.deepEqual(await bob.decrypt(alice.address, context, encrypted[0]), payload);
    assert.deepEqual(await carol.decrypt(alice.address, context, encrypted[1]), payload);
    const failed = commits, next = { conversationId: 'batch-chat', messageId: 'second' };
    await assert.rejects(alice.encryptMany([{ peer: bob.address, context: next, payload }, { peer: { name: 'unverified', device: 1 }, context: next, payload }]));
    assert.equal(commits, failed);
    const valid = await alice.encrypt(bob.address, next, payload);
    assert.deepEqual(await bob.decrypt(alice.address, next, valid), payload);
  } finally { await alice.close(); await bob.close(); await carol.close(); }
});
