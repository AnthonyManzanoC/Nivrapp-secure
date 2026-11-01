import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { LabWebDevice } from '../web-device.mjs';
import { EncryptedPilotState } from '../../ratchet-pilot/encrypted-state.mjs';

const bridge = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_wasm.js');
const context = messageId => ({ conversationId: 'storage-test', messageId });
async function initialize(storage) {
  const alice = await LabWebDevice.open(bridge, 'alice', 1, storage, { createIfMissing: true });
  const bob = await LabWebDevice.open(bridge, 'bob', 1, storage, { createIfMissing: true });
  await alice.pinIdentity(bob.address, bob.publicIdentity); await bob.pinIdentity(alice.address, alice.publicIdentity);
  await alice.establish(bob.address, await bob.bundle());
  return { alice, bob };
}
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'nivra-wasm-state-'));
  const store = new EncryptedPilotState(join(directory, 'state.sqlite'), randomBytes(32));
  return { store, cleanup: () => {
    store.close();
    if (resolve(dirname(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('nivra-wasm-state-')) throw Error('Unexpected test cleanup path');
    rmSync(directory, { recursive: true, force: true });
  } };
}
test('WASM core snapshots preserve skipped keys, replay gates, identity and exact retries on encrypted disk', async () => {
  const { store, cleanup } = temporary(); let alice, bob;
  try {
    ({ alice, bob } = await initialize(store));
    const publicAlice = alice.publicIdentity;
    const packets = await Promise.all(Array.from({ length: 5 }, (_, i) => alice.encrypt(bob.address, context('order-' + i), { text: 'message-' + i })));
    assert.deepEqual(await bob.decrypt(alice.address, context('order-3'), packets[3]), { text: 'message-3' });
    await alice.close(); await bob.close();
    alice = await LabWebDevice.open(bridge, 'alice', 1, store); bob = await LabWebDevice.open(bridge, 'bob', 1, store);
    assert.deepEqual(alice.publicIdentity, publicAlice);
    const pending = await bob.pendingReceived();
    assert.equal(pending.length, 1); assert.deepEqual(pending[0].payload, { text: 'message-3' });
    assert.deepEqual(await alice.encrypt(bob.address, context('order-3'), { text: 'message-3' }), packets[3]);
    await assert.rejects(bob.decrypt(alice.address, context('order-3'), packets[3]));
    for (const i of [1, 4, 0, 2]) assert.deepEqual(await bob.decrypt(alice.address, context('order-' + i), packets[i]), { text: 'message-' + i });
    const reply = await bob.encrypt(alice.address, context('reply'), { text: 'reply after restoring' });
    assert.deepEqual(await alice.decrypt(bob.address, context('reply'), reply), { text: 'reply after restoring' });
  } finally { await alice?.close(); await bob?.close(); cleanup(); }
});
test('incoming delivery survives reopening until history acknowledges it, without weakening replay rejection', async () => {
  const { store, cleanup } = temporary(); let alice, bob;
  try {
    ({ alice, bob } = await initialize(store));
    const packet = await alice.encrypt(bob.address, context('history-gap'), { text: 'survives a process exit' });
    const received = await bob.decrypt(alice.address, context('history-gap'), packet); received.text = 'caller mutation';
    await bob.close(); bob = await LabWebDevice.open(bridge, 'bob', 1, store);
    const pending = await bob.pendingReceived();
    assert.deepEqual(pending[0].payload, { text: 'survives a process exit' });
    pending[0].payload.text = 'list mutation';
    assert.equal((await bob.pendingReceived())[0].payload.text, 'survives a process exit');
    await assert.rejects(bob.decrypt(alice.address, context('history-gap'), packet));
    assert.equal(await bob.acknowledgeReceived(pending[0].id), true);
    await bob.close(); bob = await LabWebDevice.open(bridge, 'bob', 1, store);
    assert.deepEqual(await bob.pendingReceived(), []);
    await assert.rejects(bob.decrypt(alice.address, context('history-gap'), packet));
  } finally { await alice?.close(); await bob?.close(); cleanup(); }
});
test('stale disk writers cannot return a packet and must reopen before another operation', async () => {
  const { store, cleanup } = temporary(); let alice, bob, stale;
  try {
    ({ alice, bob } = await initialize(store));
    stale = await LabWebDevice.open(bridge, 'alice', 1, store);
    const packet = await alice.encrypt(bob.address, context('committed'), { text: 'committed' });
    await assert.rejects(stale.encrypt(bob.address, context('stale'), { text: 'never released' }), /Stale/);
    await assert.rejects(stale.bundle(), /reopen/);
    assert.deepEqual(await bob.decrypt(alice.address, context('committed'), packet), { text: 'committed' });
  } finally { await alice?.close(); await bob?.close(); await stale?.close(); cleanup(); }
});
test('failed disk writes do not consume incoming messages; missing state cannot silently replace an identity', async () => {
  const { store, cleanup } = temporary(); let alice, bob;
  try {
    ({ alice, bob } = await initialize(store));
    const packet = await alice.encrypt(bob.address, context('disk-failure'), { text: 'recoverable' });
    await bob.close();
    let fail = true;
    bob = await LabWebDevice.open(bridge, 'bob', 1, { read: scope => store.read(scope), commit: (...args) => {
      if (fail) throw Error('Injected storage failure'); return store.commit(...args);
    } });
    await assert.rejects(bob.decrypt(alice.address, context('disk-failure'), packet), /storage failure/);
    await bob.close(); fail = false;
    bob = await LabWebDevice.open(bridge, 'bob', 1, store);
    assert.deepEqual(await bob.decrypt(alice.address, context('disk-failure'), packet), { text: 'recoverable' });
    await assert.rejects(LabWebDevice.open(bridge, 'missing-' + randomUUID(), 1, store), /initialization/);
  } finally { await alice?.close(); await bob?.close(); cleanup(); }
});
test('private core restore rejects scope changes and duplicate or malformed key records', async () => {
  const key = bridge.createIdentity(); const core = new bridge.RatchetDevice('scope-test', 1, key, 17); key.fill(0);
  try {
    await core.preKeyBundle(Date.now());
    const encoded = await core.exportPrivateStateForEncryption();
    await assert.rejects(bridge.RatchetDevice.restorePrivateState('different-account', 1, encoded));
    const duplicate = JSON.parse(encoded); duplicate.prekeys.push(duplicate.prekeys[0]);
    await assert.rejects(bridge.RatchetDevice.restorePrivateState('scope-test', 1, JSON.stringify(duplicate)));
    const changed = JSON.parse(encoded); changed.identity = 'AA==';
    await assert.rejects(bridge.RatchetDevice.restorePrivateState('scope-test', 1, JSON.stringify(changed)));
  } finally { core.free(); }
});
