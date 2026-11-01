// Isolated PostgreSQL/HTTP integration. Fixture bearer tokens are never logged.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { LabWebDevice } from '../ratchet-common/web-device.mjs';
const bridge = createRequire(import.meta.url)('./pkg/node/nivra_ratchet_olm.js');
if (process.env.CI !== 'true' || !process.env.NIVRA_RATCHET_TEST_POSTGRES) throw Error('An isolated CI database is required');
const host = spawn('dotnet', ['run', '--no-build', '--project', 'checks/Nivra.RatchetChecks/Nivra.RatchetChecks.csproj', '--', '--postgres-ci', '--serve-for-interop'], { stdio: ['ignore', 'pipe', 'inherit'] });
const lines = createInterface({ input: host.stdout }); let fixture, exited = false, startupError;
host.on('error', error => { startupError = error; }); host.on('exit', () => { exited = true; });
lines.on('line', line => { if (line.startsWith('RATCHET_FIXTURE ')) fixture = JSON.parse(line.slice('RATCHET_FIXTURE '.length)); else console.log(line); });
let alice, bob;
try {
  const deadline = Date.now() + 90000;
  while (!fixture && Date.now() < deadline && !exited && !startupError) await delay(100);
  if (!fixture) throw Error('Synthetic HTTP fixture did not start');
  async function post(token, path, body, status = 200) {
    const response = await fetch(fixture.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const value = response.status === 204 ? null : await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  alice = new LabWebDevice(bridge, fixture.aliceDevice); bob = new LabWebDevice(bridge, fixture.bobDevice);
  await alice.pinIdentity(bob.address, bob.publicIdentity); await bob.pinIdentity(alice.address, alice.publicIdentity);
  await post(fixture.aliceToken, '/ratchet/olm/prekeys', { bundles: [await alice.bundle()] });
  const publicBundle = await bob.bundle(); await post(fixture.bobToken, '/ratchet/olm/prekeys', { bundles: [publicBundle] });
  const path = '/ratchet/olm/devices/' + fixture.bobDevice + '/prekey', requestId = randomUUID();
  const claims = await Promise.all(Array.from({ length: 12 }, () => post(fixture.aliceToken, path, { conversationId: fixture.conversationId, requestId })));
  assert.ok(claims.every(claim => JSON.stringify(claim) === JSON.stringify(claims[0]))); assert.deepEqual(claims[0].bundle, publicBundle);
  await alice.establish(bob.address, claims[0].bundle);
  for (let turn = 0; turn < 8; turn++) {
    const sender = turn % 2 ? bob : alice, receiver = turn % 2 ? alice : bob;
    const context = { conversationId: fixture.conversationId, messageId: 'hybrid-api-' + turn }, payload = { text: 'Synthetic hybrid turn ' + turn };
    assert.deepEqual(await receiver.decrypt(sender.address, context, await sender.encrypt(receiver.address, context, payload)), payload);
  }
  assert.deepEqual(await bob.pendingConsumedPreKeys(), [publicBundle.preKeyId]);
  await post(fixture.bobToken, '/ratchet/olm/prekeys/consumed', { preKeyIds: await bob.pendingConsumedPreKeys() }, 204);
  await bob.acknowledgeConsumedPreKeys([publicBundle.preKeyId]);
  await post(fixture.bobToken, '/ratchet/olm/prekeys', { bundles: [publicBundle] }, 409);
  await post(fixture.aliceToken, path, { conversationId: fixture.conversationId, requestId: randomUUID() }, 503);
  console.log('PASS real ML-KEM hybrid prekeys traverse .NET/PostgreSQL atomically, eight ratchet turns, consumed-key cleanup and no fallback');
} finally { await alice?.close().catch(() => undefined); await bob?.close().catch(() => undefined); lines.close(); host.kill('SIGTERM'); }
