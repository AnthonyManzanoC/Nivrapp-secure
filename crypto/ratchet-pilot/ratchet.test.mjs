import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PilotDevice, SUITE } from './ratchet.mjs';

const context = messageId => ({ conversationId: 'local-conversation', messageId });
async function pair() {
  const alice = new PilotDevice(randomUUID());
  const bob = new PilotDevice(randomUUID());
  // Represents an authenticated out-of-band identity comparison, never TOFU.
  alice.pinIdentity(bob.address, bob.publicIdentity);
  bob.pinIdentity(alice.address, alice.publicIdentity);
  await alice.establish(bob.address, await bob.bundle());
  return { alice, bob };
}
test('real libsignal handshake, reply and successive DH ratchet steps with AES-256-GCM payloads', async () => {
  const { alice, bob } = await pair();
  for (let i = 0; i < 8; i++) {
    const [sender, receiver] = i % 2 ? [bob, alice] : [alice, bob];
    const ctx = context('turn-' + i);
    const payload = { text: 'Privado 🔐 ' + i };
    const envelope = await sender.encrypt(receiver.address, ctx, payload);
    assert.equal(envelope.suite, SUITE);
    assert.deepEqual(await receiver.decrypt(sender.address, ctx, envelope), payload);
    assert.equal(JSON.stringify(envelope).includes(payload.text), false);
  }
});
test('out-of-order delivery and replay protection', async () => {
  const { alice, bob } = await pair();
  const messages = [];
  for (let i = 0; i < 5; i++) messages.push(await alice.encrypt(bob.address, context('order-' + i), { index: i }));
  for (const i of [3, 0, 4, 2, 1]) assert.deepEqual(await bob.decrypt(alice.address, context('order-' + i), messages[i]), { index: i });
  await assert.rejects(bob.decrypt(alice.address, context('order-1'), messages[1]));
});
test('tampering never consumes the legitimate message or poisons ratchet state', async () => {
  const { alice, bob } = await pair();
  const ctx = context('tampered');
  const envelope = await alice.encrypt(bob.address, ctx, { text: 'Recoverable after attack' });
  for (const field of ['ciphertext', 'keyMessage', 'iv']) {
    const changed = structuredClone(envelope);
    const bytes = Buffer.from(changed[field], 'base64'); bytes[Math.floor(bytes.length / 2)] ^= 1;
    changed[field] = bytes.toString('base64');
    await assert.rejects(bob.decrypt(alice.address, ctx, changed), undefined, field + ' tampering must be rejected');
  }
  assert.deepEqual(await bob.decrypt(alice.address, ctx, envelope), { text: 'Recoverable after attack' });
});
test('conversation, message, sender and recipient binding', async () => {
  const { alice, bob } = await pair();
  const ctx = context('bound');
  const envelope = await alice.encrypt(bob.address, ctx, { text: 'Correct recipient only' });
  await assert.rejects(bob.decrypt(alice.address, { ...ctx, conversationId: 'other' }, envelope));
  await assert.rejects(bob.decrypt(alice.address, context('other'), envelope));
  const stranger = new PilotDevice(randomUUID());
  await assert.rejects(stranger.decrypt(alice.address, ctx, envelope));
  await assert.rejects(bob.decrypt(stranger.address, ctx, envelope));
  assert.equal((await bob.decrypt(alice.address, ctx, envelope)).text, 'Correct recipient only');
});
test('identical retries preserve exact ciphertext while concurrent new messages remain distinct', async () => {
  const { alice, bob } = await pair();
  const ctx = context('retry');
  const [a, b] = await Promise.all([alice.encrypt(bob.address, ctx, { text: 'same' }), alice.encrypt(bob.address, ctx, { text: 'same' })]);
  assert.deepEqual(a, b);
  await assert.rejects(alice.encrypt(bob.address, ctx, { text: 'different' }), /reused/);
  const fresh = await Promise.all(Array.from({ length: 12 }, (_, i) => alice.encrypt(bob.address, context('concurrent-' + i), { text: 'same' })));
  assert.equal(new Set(fresh.map(value => value.keyMessage)).size, 12);
  assert.equal(new Set(fresh.map(value => value.ciphertext)).size, 12);
  for (let i = 11; i >= 0; i--) assert.deepEqual(await bob.decrypt(alice.address, context('concurrent-' + i), fresh[i]), { text: 'same' });
  assert.deepEqual(await bob.decrypt(alice.address, ctx, a), { text: 'same' });
});
test('unverified and changed identities are rejected', async () => {
  const alice = new PilotDevice(randomUUID());
  const bob = new PilotDevice(randomUUID());
  await assert.rejects(alice.establish(bob.address, await bob.bundle()));
  alice.pinIdentity(bob.address, bob.publicIdentity);
  const imposter = new PilotDevice(bob.address.name());
  assert.throws(() => alice.pinIdentity(bob.address, imposter.publicIdentity), /Identity changed/);
  await assert.rejects(alice.establish(bob.address, await imposter.bundle()));
});
test('unknown protocols and malformed or oversized data fail closed', async () => {
  const { alice, bob } = await pair();
  const ctx = context('bounds');
  const envelope = await alice.encrypt(bob.address, ctx, { text: 'valid' });
  for (const changed of [{ ...envelope, v: 1 }, { ...envelope, suite: 'legacy' }, { ...envelope, type: 999 },
    { ...envelope, ciphertext: 'a'.repeat(2 * 1024 * 1024) }, { ...envelope, keyMessage: '???' }, { ...envelope, iv: '' }]) {
    await assert.rejects(bob.decrypt(alice.address, ctx, changed));
  }
  assert.deepEqual(await bob.decrypt(alice.address, ctx, envelope), { text: 'valid' });
});
