import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { IdentityKeyPair, PublicKey } from '../../ratchet-pilot/node_modules/@signalapp/libsignal-client/dist/index.js';

const wasm = createRequire(import.meta.url)('../pkg/node/nivra_ratchet_wasm.js');
const context = Buffer.from('Nivra isolated bridge interoperability; no user data');
test('WASM and native Signal agree on identity serialization and signatures in both directions', () => {
  assert.equal(wasm.bridgeVersion(), 'NIVRA-LIBSIGNAL-WASM-PORTABILITY-1');
  const keys = new Set();
  for (let i = 0; i < 16; i++) {
    const privateBytes = wasm.createIdentity();
    const native = IdentityKeyPair.deserialize(privateBytes);
    const publicBytes = wasm.identityPublic(privateBytes);
    assert.deepEqual(Buffer.from(publicBytes), Buffer.from(native.publicKey.serialize()));
    assert.ok(native.publicKey.verify(context, wasm.signIdentity(privateBytes, context)));
    assert.ok(wasm.verifyIdentity(publicBytes, context, native.privateKey.sign(context)));
    assert.equal(wasm.verifyIdentity(publicBytes, Buffer.from('altered context'), native.privateKey.sign(context)), false);
    keys.add(Buffer.from(publicBytes).toString('base64'));
    privateBytes.fill(0);
  }
  assert.equal(keys.size, 16);
});
test('native-created identities can be restored by the web bridge; invalid inputs fail closed', () => {
  const native = IdentityKeyPair.generate();
  const bytes = native.serialize();
  assert.deepEqual(Buffer.from(wasm.identityPublic(bytes)), Buffer.from(native.publicKey.serialize()));
  assert.throws(() => wasm.identityPublic(new Uint8Array()));
  assert.throws(() => wasm.verifyIdentity(new Uint8Array(33), context, new Uint8Array(64)));
  assert.throws(() => wasm.signIdentity(bytes, new Uint8Array(131073)));
  assert.ok(PublicKey.deserialize(wasm.identityPublic(bytes)).equals(native.publicKey));
  // Ephemeral CI fixture only. Never committed or uploaded with production assets.
  writeFileSync(new URL('../fixtures.json', import.meta.url), JSON.stringify({
    identity: Buffer.from(bytes).toString('base64'), public: Buffer.from(native.publicKey.serialize()).toString('base64'),
    context: context.toString('base64'), signature: Buffer.from(native.privateKey.sign(context)).toString('base64'),
  }));
});
