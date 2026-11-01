import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LabWebDevice } from '../web-device.mjs';
const bridge = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_wasm.js');

test('prekeys replenish beyond 256 lifetime initiations and consumed private bootstrap keys are erased', async () => {
  const rows = new Map();
  const storage = { read: async scope => structuredClone(rows.get(scope) ?? null), commit: async (scope, revision, state) => {
    assert.equal(rows.get(scope)?.revision ?? 0, revision);
    rows.set(scope, { revision: revision + 1, state: structuredClone(state) }); return revision + 1;
  } };
  const alice = new LabWebDevice(bridge, 'lifecycle-alice');
  let bob = await LabWebDevice.open(bridge, 'lifecycle-bob', 1, storage, { createIfMissing: true });
  try {
    await alice.pinIdentity(bob.address, bob.publicIdentity); await bob.pinIdentity(alice.address, alice.publicIdentity);
    for (let index = 0; index < 260; index++) {
      const bundle = await bob.bundle(); await bob.acknowledgeBundles([bundle.preKeyId]);
      await alice.establish(bob.address, bundle);
      const context = { conversationId: 'lifecycle', messageId: 'message-' + index };
      const envelope = await alice.encrypt(bob.address, context, { text: 'hello-' + index });
      assert.deepEqual(await bob.decrypt(alice.address, context, envelope), { text: 'hello-' + index });
      for (const pending of await bob.pendingReceived()) await bob.acknowledgeReceived(pending.id);
      await alice.releaseOutgoing(context.conversationId, context.messageId);
    }
    const core = JSON.parse(rows.get(JSON.stringify(['lifecycle-bob', 1])).state.core);
    assert.equal(core.counter, 260); assert.equal(core.prekeys.length, 0); assert.equal(core.signed.length, 0); assert.equal(core.kyber.length, 0);
    await bob.close(); bob = await LabWebDevice.open(bridge, 'lifecycle-bob', 1, storage);
    assert.equal((await bob.bundle()).preKeyId, 261);
  } finally { await alice.close(); await bob.close(); }
});
