import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PilotDevice } from './ratchet.mjs';
import { EncryptedPilotState } from './encrypted-state.mjs';

const context = messageId => ({ conversationId: 'persisted-chat', messageId });
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nivra-ratchet-test-'));
  const connections = new Set();
  const key = randomBytes(32);
  const file = join(directory, 'state.sqlite');
  const store = () => {
    const value = new EncryptedPilotState(file, key); connections.add(value); return value;
  };
  t.after(() => { for (const db of connections) db.close(); key.fill(0); rmSync(directory, { recursive: true }); });
  const disk = store();
  const alice = await PilotDevice.open('alice', 1, disk);
  const bob = await PilotDevice.open('bob', 1, disk);
  await alice.pinIdentity(bob.address, bob.publicIdentity);
  await bob.pinIdentity(alice.address, alice.publicIdentity);
  await alice.establish(bob.address, await bob.bundle());
  return { alice, bob, disk, store, file, key };
}

test('persisted identity, prekeys, session and exact retry bytes survive reopening', async t => {
  const f = await fixture(t);
  const before = Buffer.from(f.alice.publicIdentity.serialize());
  const ctx = context('reopen');
  const sent = await f.alice.encrypt(f.bob.address, ctx, { text: 'Mensaje durable privado' });
  const secondStore = f.store();
  const alice = await PilotDevice.open('alice', 1, secondStore);
  const bob = await PilotDevice.open('bob', 1, secondStore);
  assert.deepEqual(Buffer.from(alice.publicIdentity.serialize()), before);
  assert.deepEqual(await alice.encrypt(bob.address, ctx, { text: 'Mensaje durable privado' }), sent);
  assert.deepEqual(await bob.decrypt(alice.address, ctx, sent), { text: 'Mensaje durable privado' });
  const receiverAfterRestart = await PilotDevice.open('bob', 1, f.store());
  await assert.rejects(receiverAfterRestart.decrypt(alice.address, ctx, sent));
});

test('skipped keys and a reply survive reopening without sharing device identities', async t => {
  const { alice, bob, store } = await fixture(t);
  const packets = [];
  for (let i = 0; i < 4; i++) packets.push(await alice.encrypt(bob.address, context('order-' + i), { n: i }));
  await bob.decrypt(alice.address, context('order-3'), packets[3]);
  const reopened = await PilotDevice.open('bob', 1, store());
  for (const i of [1, 0, 2]) assert.deepEqual(await reopened.decrypt(alice.address, context('order-' + i), packets[i]), { n: i });
  const reply = await reopened.encrypt(alice.address, context('reply'), { text: 'Recibido' });
  assert.deepEqual(await alice.decrypt(reopened.address, context('reply'), reply), { text: 'Recibido' });
});

test('a failed durable commit rolls back receive state and preserves the legitimate retry', async t => {
  const f = await fixture(t);
  let fail = false;
  const storage = { read: scope => f.disk.read(scope), commit: (...args) => { if (fail) throw new Error('Simulated disk failure'); return f.disk.commit(...args); } };
  const receiver = await PilotDevice.open('bob', 1, storage);
  const ctx = context('commit-failure');
  const packet = await f.alice.encrypt(receiver.address, ctx, { text: 'Recoverable' });
  fail = true;
  await assert.rejects(receiver.decrypt(f.alice.address, ctx, packet), /disk failure/);
  fail = false;
  assert.deepEqual(await receiver.decrypt(f.alice.address, ctx, packet), { text: 'Recoverable' });
});

test('a fresh Node process resumes the session without loading any private key from its caller', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const { PilotDevice } = await import(process.argv[1]);
    const { EncryptedPilotState } = await import(process.argv[2]);
    const { ProtocolAddress } = await import(process.argv[3]);
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const store = new EncryptedPilotState(input.file, Buffer.from(input.key, 'base64'));
    try {
      const sender = await PilotDevice.open('alice', 1, store);
      const packet = await sender.encrypt(ProtocolAddress.new('bob', 1), input.context, { text: 'After process restart' });
      process.stdout.write(JSON.stringify(packet));
    } finally { store.close(); }
  `, new URL('./ratchet.mjs', import.meta.url).href,
    new URL('./encrypted-state.mjs', import.meta.url).href,
    new URL('./node_modules/@signalapp/libsignal-client/dist/index.js', import.meta.url).href],
  { input: JSON.stringify({ file: f.file, key: f.key.toString('base64'), context: context('new-process') }), encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const packet = JSON.parse(child.stdout);
  assert.deepEqual(await f.bob.decrypt(f.alice.address, context('new-process'), packet), { text: 'After process restart' });
});

test('send state and retry bytes are both rolled back when storage rejects the commit', async t => {
  const f = await fixture(t);
  let fail = false;
  const storage = { read: scope => f.disk.read(scope), commit: (...args) => { if (fail) throw new Error('Simulated disk failure'); return f.disk.commit(...args); } };
  const sender = await PilotDevice.open('alice', 1, storage);
  const ctx = context('send-failure');
  fail = true;
  await assert.rejects(sender.encrypt(f.bob.address, ctx, { text: 'Atomic send' }), /disk failure/);
  fail = false;
  const packet = await sender.encrypt(f.bob.address, ctx, { text: 'Atomic send' });
  assert.deepEqual(await f.bob.decrypt(sender.address, ctx, packet), { text: 'Atomic send' });
  const reopened = await PilotDevice.open('alice', 1, f.store());
  assert.deepEqual(await reopened.encrypt(f.bob.address, ctx, { text: 'Atomic send' }), packet);
});

test('concurrent stale writers cannot overwrite a ratchet advance', async t => {
  const f = await fixture(t);
  const stale = await PilotDevice.open('alice', 1, f.store());
  await f.alice.encrypt(f.bob.address, context('first-writer'), { text: 'First' });
  await assert.rejects(stale.encrypt(f.bob.address, context('stale-writer'), { text: 'Second' }), /Stale ratchet state/);
  const reopened = await PilotDevice.open('alice', 1, f.store());
  const packet = await reopened.encrypt(f.bob.address, context('stale-writer'), { text: 'Second' });
  assert.deepEqual(await f.bob.decrypt(reopened.address, context('stale-writer'), packet), { text: 'Second' });
});

test('wrong keys and modified ciphertext fail without replacing existing identities', async t => {
  const f = await fixture(t);
  const wrong = new EncryptedPilotState(f.file, randomBytes(32));
  try { await assert.rejects(PilotDevice.open('alice', 1, wrong)); } finally { wrong.close(); }
  const db = new DatabaseSync(f.file);
  try { db.prepare('UPDATE ratchet_state SET ciphertext=? WHERE scope=?').run(Buffer.from('tampered'), JSON.stringify(['alice', 1])); }
  finally { db.close(); }
  await assert.rejects(PilotDevice.open('alice', 1, f.disk));
  const bob = await PilotDevice.open('bob', 1, f.disk);
  assert.deepEqual(Buffer.from(bob.publicIdentity.serialize()), Buffer.from(f.bob.publicIdentity.serialize()));
});

test('stored material is encrypted and isolated by account and device', async t => {
  const f = await fixture(t);
  const alice2 = await PilotDevice.open('alice', 2, f.disk);
  assert.notDeepEqual(Buffer.from(alice2.publicIdentity.serialize()), Buffer.from(f.alice.publicIdentity.serialize()));
  const marker = 'private-material-that-must-not-be-on-disk';
  f.disk.commit('isolated-probe', 0, { marker });
  for (const suffix of ['', '-wal']) {
    assert.equal(readFileSync(f.file + suffix).includes(Buffer.from(marker)), false);
  }
  assert.equal(f.disk.read('unregistered-scope'), null);
  assert.throws(() => f.disk.commit('isolated-probe', 0, {}), /Stale ratchet state/);
  assert.deepEqual(f.disk.read('isolated-probe').state, { marker });
});
