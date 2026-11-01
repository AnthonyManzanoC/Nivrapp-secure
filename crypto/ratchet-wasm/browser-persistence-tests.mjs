import { EncryptedIndexedDbState } from './indexeddb-state.mjs';
import { LabWebDevice } from './web-device.mjs';
const check = (condition, reason) => { if (!condition) throw Error(reason); };
const rejected = async (operation, reason) => {
  let failed = false;
  try { await operation(); } catch { failed = true; }
  check(failed, reason);
};
export async function testBrowserPersistence(bridge) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const storage = await EncryptedIndexedDbState.open(key), suffix = crypto.randomUUID();
  const aliceName = 'persistent-alice-' + suffix, bobName = 'persistent-bob-' + suffix;
  let alice, bob, stale;
  const context = i => ({ conversationId: 'persistent-browser', messageId: 'message-' + i });
  try {
    alice = await LabWebDevice.open(bridge, aliceName, 1, storage, { createIfMissing: true });
    bob = await LabWebDevice.open(bridge, bobName, 1, storage, { createIfMissing: true });
    const originalIdentity = alice.publicIdentity;
    await alice.pinIdentity(bob.address, bob.publicIdentity); await bob.pinIdentity(alice.address, alice.publicIdentity);
    await alice.establish(bob.address, await bob.bundle());
    const packets = await Promise.all([0, 1, 2].map(i => alice.encrypt(bob.address, context(i), { text: 'persistent-' + i })));
    check((await bob.decrypt(alice.address, context(2), packets[2])).text === 'persistent-2', 'Initial persistent decrypt failed');
    await alice.close(); await bob.close();
    alice = await LabWebDevice.open(bridge, aliceName, 1, storage); bob = await LabWebDevice.open(bridge, bobName, 1, storage);
    check(alice.publicIdentity.every((byte, i) => byte === originalIdentity[i]), 'Identity changed after reopening');
    check(JSON.stringify(await alice.encrypt(bob.address, context(1), { text: 'persistent-1' })) === JSON.stringify(packets[1]), 'Retry changed after reopening');
    await rejected(() => bob.decrypt(alice.address, context(2), packets[2]), 'Replay accepted after reopening');
    for (const i of [0, 1]) check((await bob.decrypt(alice.address, context(i), packets[i])).text === 'persistent-' + i, 'Skipped key lost after reopening');
    stale = await LabWebDevice.open(bridge, aliceName, 1, storage);
    const last = await alice.encrypt(bob.address, context(3), { text: 'winner' });
    await rejected(() => stale.encrypt(bob.address, context(4), { text: 'stale writer' }), 'Stale session emitted a packet');
    await rejected(() => stale.bundle(), 'Stale session continued without reopening');
    check((await bob.decrypt(alice.address, context(3), last)).text === 'winner', 'Committed packet failed');
  } finally { await alice?.close(); await bob?.close(); await stale?.close(); storage.close(); }
}
