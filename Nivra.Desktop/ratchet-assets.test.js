'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerRatchetScheme, createRatchetAssetHandler } = require('./ratchet-assets');
test('ratchet asset protocol grants module loading without disabling renderer security', () => {
  let schemes; registerRatchetScheme({ registerSchemesAsPrivileged: value => { schemes = value; } });
  assert.equal(schemes[0].scheme, 'nivra-crypto'); assert.equal(schemes[0].privileges.secure, true); assert.equal(schemes[0].privileges.bypassCSP, undefined);
});
test('ratchet protocol never exposes arbitrary paths, remote hosts or private state', async () => {
  const handler = createRatchetAssetHandler(path.resolve(__dirname, '../crypto/ratchet-common'));
  const result = await handler(new Request('nivra-crypto://app/web-device.mjs'));
  assert.equal(result.status, 200); assert.match(result.headers.get('content-type'), /javascript/);
  assert.match(await result.text(), /class LabWebDevice/);
  for (const url of ['nivra-crypto://remote/web-device.mjs', 'nivra-crypto://app/../../main.js', 'nivra-crypto://app/%2e%2e/main.js', 'nivra-crypto://app/web-device.mjs?path=secret', 'nivra-crypto://app/private-state.json']) {
    assert.equal((await handler(new Request(url))).status, 404);
  }
  assert.equal((await handler(new Request('nivra-crypto://app/web-device.mjs', { method: 'POST' }))).status, 404);
});
