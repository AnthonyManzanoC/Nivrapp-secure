import init, * as wasm from './pkg/web/nivra_ratchet_wasm.js';
import { LabWebDevice } from './web-device.mjs';
const native = globalThis.RatchetNativeState;
const check = (value, label) => { if (!value) throw Error(label); };
const encode = bytes => btoa(String.fromCharCode(...bytes));
const hash = async object => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(object)))));
const reject = async operation => { let failed = false; try { await operation(); } catch { failed = true; } check(failed, 'Invalid operation accepted'); };
const storage = {
  async read(scope) { const result = JSON.parse(native.read(scope)); if (!result.ok) throw Error(result.code); return result.row; },
  async commit(scope, revision, state) { const result = JSON.parse(native.commit(scope, revision, JSON.stringify(state))); if (!result.ok) throw Error(result.code); return result.revision; },
};
let alice, bob, stale;
try {
  await init();
  const info = JSON.parse(native.info());
  check(['1', '2'].includes(info.phase) && /^[a-zA-Z0-9-]{36}$/.test(info.runId), 'Invalid native fixture metadata');
  const aliceName = 'android-alice-' + info.runId, bobName = 'android-bob-' + info.runId;
  const context = i => ({ conversationId: 'android-lab', messageId: 'packet-' + i });
  alice = await LabWebDevice.open(wasm, aliceName, 1, storage, { createIfMissing: info.phase === '1' });
  bob = await LabWebDevice.open(wasm, bobName, 1, storage, { createIfMissing: info.phase === '1' });
  if (info.phase === '1') {
    await alice.pinIdentity(bob.address, bob.publicIdentity); await bob.pinIdentity(alice.address, alice.publicIdentity);
    await alice.establish(bob.address, await bob.bundle());
    const packets = await Promise.all([0, 1, 2].map(i => alice.encrypt(bob.address, context(i), { text: 'android-' + i })));
    check((await bob.decrypt(alice.address, context(2), packets[2])).text === 'android-2', 'Initial Android ratchet failed');
    check(native.remember('alicePublic', encode(alice.publicIdentity)), 'Public identity fixture not saved');
    check(native.remember('retryHash', await hash(packets[2])), 'Retry hash fixture not saved');
  } else {
    check(encode(alice.publicIdentity) === info.alicePublic, 'Identity changed after process restart');
    const retry = await alice.encrypt(bob.address, context(2), { text: 'android-2' });
    check(await hash(retry) === info.retryHash, 'Retry bytes changed after process restart');
    const pending = await bob.pendingReceived();
    check(pending.length === 1 && pending[0].payload.text === 'android-2', 'Incoming delivery lost during process restart');
    await reject(() => bob.decrypt(alice.address, context(2), retry)); await bob.acknowledgeReceived(pending[0].id);
    for (const i of [1, 0]) {
      const packet = await alice.encrypt(bob.address, context(i), { text: 'android-' + i });
      check((await bob.decrypt(alice.address, context(i), packet)).text === 'android-' + i, 'Skipped key lost after process restart');
    }
    for (const delivery of await bob.pendingReceived()) await bob.acknowledgeReceived(delivery.id);
    const reply = await bob.encrypt(alice.address, context(3), { text: 'Android reply' });
    check((await alice.decrypt(bob.address, context(3), reply)).text === 'Android reply', 'Restored Android reply failed');
    stale = await LabWebDevice.open(wasm, aliceName, 1, storage);
    await alice.encrypt(bob.address, context(4), { text: 'winner' });
    await reject(() => stale.encrypt(bob.address, context(5), { text: 'stale writer' }));
    check(native.rejectsWrongKey(), 'Wrong SQLCipher key opened database');
  }
  check(native.inspectProtection(), 'SQLCipher header or Android Keystore protection check failed');
  await alice.close(); alice = null; await bob.close(); bob = null; await stale?.close(); stale = null;
  native.complete('PASS Android phase ' + info.phase + ': WASM ratchet, SQLCipher and Android Keystore');
} catch (error) { native.complete('FAIL Android: ' + (error?.message || String(error))); }
finally { await alice?.close(); await bob?.close(); await stale?.close(); }
