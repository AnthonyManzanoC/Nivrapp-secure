// Ephemeral PostgreSQL/HTTP integration only. Never load application settings.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicKey, ProtocolAddress } from '@signalapp/libsignal-client';
import { PilotDevice } from './ratchet.mjs';
import { LabWebDevice } from '../ratchet-wasm/web-device.mjs';
const wasm = createRequire(import.meta.url)('../ratchet-wasm/pkg/node/nivra_ratchet_wasm.js');

if (process.env.CI !== 'true' || !process.env.NIVRA_RATCHET_TEST_POSTGRES) throw Error('Run with an isolated CI database only');
const host = spawn('dotnet', ['run', '--no-build', '--project', 'checks/Nivra.RatchetChecks/Nivra.RatchetChecks.csproj', '--', '--postgres-ci', '--serve-for-interop'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
const lines = createInterface({ input: host.stdout });
let fixture, hostExited = false, startupError;
host.on('error', error => { startupError = error; }); host.on('exit', () => { hostExited = true; });
lines.on('line', line => {
  if (line.startsWith('RATCHET_FIXTURE ')) fixture = JSON.parse(line.slice('RATCHET_FIXTURE '.length));
  else console.log(line);
});
const encode = bytes => Buffer.from(bytes).toString('base64');
function wire(bundle) {
  return { v: 1, suite: 'NIVRA-LIBSIGNAL-BUNDLE-PILOT-1', registrationId: bundle.registrationId(), deviceId: bundle.deviceId(),
    identityKey: encode(bundle.identityKey().serialize()), preKeyId: bundle.preKeyId(), preKeyPublic: encode(bundle.preKeyPublic().serialize()),
    signedPreKeyId: bundle.signedPreKeyId(), signedPreKeyPublic: encode(bundle.signedPreKeyPublic().serialize()), signedPreKeySignature: encode(bundle.signedPreKeySignature()),
    kyberPreKeyId: bundle.kyberPreKeyId(), kyberPreKeyPublic: encode(bundle.kyberPreKeyPublic().serialize()), kyberPreKeySignature: encode(bundle.kyberPreKeySignature()) };
}
try {
  const deadline = Date.now() + 90000;
  while (!fixture && Date.now() < deadline && !hostExited && !startupError) await delay(100);
  if (!fixture) throw Error('HTTP/PostgreSQL checks did not complete: ' + (startupError?.message ?? (hostExited ? 'test host exited' : 'timeout')));
  async function post(token, path, data) {
    const response = await fetch(fixture.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
    const result = await response.json(); assert.equal(response.status, 200, 'HTTP failure: ' + JSON.stringify(result)); return result;
  }
  const alice = new LabWebDevice(wasm, fixture.aliceUser, 2), bob = new PilotDevice(fixture.bobUser, 2);
  const nativeAliceAddress = ProtocolAddress.new(fixture.aliceUser, 2), webBobAddress = { name: fixture.bobUser, device: 2 };
  // Fixture pins are exchanged directly; the production migration/directory
  // proof is a separate activation requirement.
  await alice.pinIdentity(webBobAddress, bob.publicIdentity.serialize()); await bob.pinIdentity(nativeAliceAddress, PublicKey.deserialize(alice.publicIdentity));
  const bobBundle = wire(await bob.bundle());
  await post(fixture.aliceToken, '/experimental/ratchet/prekeys', { bundles: [await alice.bundle()] });
  await post(fixture.bobToken, '/experimental/ratchet/prekeys', { bundles: [bobBundle] });
  const requestId = randomUUID(), path = '/experimental/ratchet/devices/' + fixture.bobDevice + '/prekey';
  const claims = await Promise.all(Array.from({ length: 8 }, () => post(fixture.aliceToken, path, { conversationId: fixture.conversationId, requestId })));
  assert.ok(claims.every(claim => JSON.stringify(claim) === JSON.stringify(claims[0])));
  assert.deepEqual(claims[0].bundle, bobBundle);
  await alice.establish(webBobAddress, claims[0].bundle);
  for (let i = 0; i < 8; i++) {
    const context = { conversationId: fixture.conversationId, messageId: 'api-prekey-' + i }, payload = { text: 'Synthetic API ratchet turn ' + i };
    if (i % 2 === 0) {
      const envelope = await alice.encrypt(webBobAddress, context, payload);
      assert.deepEqual(await bob.decrypt(nativeAliceAddress, context, envelope), payload);
    } else {
      const envelope = await bob.encrypt(nativeAliceAddress, context, payload);
      assert.deepEqual(await alice.decrypt(webBobAddress, context, envelope), payload);
    }
  }
  const exhausted = await fetch(fixture.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + fixture.aliceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: fixture.conversationId, requestId: randomUUID() }), signal: AbortSignal.timeout(15000) });
  assert.equal(exhausted.status, 409);
  assert.equal((await exhausted.json()).code, 'prekeys_exhausted');
  await alice.close();
  console.log('PASS real signed libsignal prekey travels through .NET/PostgreSQL once, idempotent races agree, eight WASM/native AES-GCM ratchet turns and exhaustion rejects fallback');
} finally {
  lines.close(); host.kill('SIGTERM');
}
