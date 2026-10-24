'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nivra-vault-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^nivra-vault-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const handlers = new Map();
  let available = true;
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`wrapped:${value}`),
    decryptString: bytes => {
      const value = bytes.toString();
      if (!value.startsWith('wrapped:')) throw new Error('DPAPI provider details must not escape');
      return value.slice('wrapped:'.length);
    },
  };
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  // Exercise the real secure-vault functions/IPC handlers without launching
  // Electron, networking or any user's actual OS-protected profile.
  vm.runInNewContext(source.slice(0, source.indexOf('function installContentProtectionHandlers()')) + '\ninstallSecureVaultHandlers();', {
    __dirname, Buffer, URL,
    require: name => {
      if (name === 'electron') return {
        app: { getPath: () => root }, safeStorage,
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      };
      if (name === './renderer-security') return { isTrustedIpc: event => event && event.trusted === true };
      return require(name);
    },
  });
  return { root, file: name => path.join(root, 'secure-vault', `${name}.bin`),
    invoke: (name, options, event = { trusted: true }) => handlers.get('nivra-secure-vault:get-or-create')(event, name, options),
    available: value => { available = value; } };
}

test('read-only lookup of a missing protector creates neither a wrapped secret nor a vault directory', t => {
  const f = fixture(t);
  const result = f.invoke('local-db', { create: false });
  assert.equal(result.secret, undefined);
  assert.equal(result.created, false);
  assert.equal(fs.existsSync(path.dirname(f.file('local-db'))), false);
});

test('read-only lookup retains exactly the existing protector and creation keeps its committed winner', t => {
  const f = fixture(t);
  const first = f.invoke('device-keys');
  const wrapped = fs.readFileSync(f.file('device-keys'));
  assert.match(first.secret, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(f.invoke('device-keys', { create: false }).secret, first.secret);
  assert.equal(f.invoke('device-keys').secret, first.secret);
  assert.deepEqual(fs.readFileSync(f.file('device-keys')), wrapped);
});

for (const bytes of [Buffer.from('corrupt-existing-wrapper'), Buffer.alloc(0), Buffer.from('wrapped:')]) {
  test(`an unreadable existing protector is preserved instead of regenerated (${bytes.length} bytes)`, t => {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.file('auth-session')), { recursive: true });
    fs.writeFileSync(f.file('auth-session'), bytes);
    for (const options of [undefined, { create: false }]) {
      assert.throws(() => f.invoke('auth-session', options), /NIVRA_SECURE_DECRYPT_FAILED/);
      assert.deepEqual(fs.readFileSync(f.file('auth-session')), bytes);
    }
  });
}

test('a locked OS vault preserves the wrapped protector and exposes only a stable error code', t => {
  const f = fixture(t);
  f.invoke('local-db');
  const wrapped = fs.readFileSync(f.file('local-db'));
  f.available(false);
  assert.throws(() => f.invoke('local-db', { create: false }), /NIVRA_SECURE_UNAVAILABLE/);
  assert.deepEqual(fs.readFileSync(f.file('local-db')), wrapped);
});

test('read-only IPC retains renderer and secret-name access restrictions', t => {
  const f = fixture(t);
  assert.throws(() => f.invoke('local-db', { create: false }, {}), /Untrusted IPC sender/);
  assert.throws(() => f.invoke('../other-file', { create: false }), /not allowed/);
  assert.equal(fs.existsSync(path.dirname(f.file('local-db'))), false);
});

test('preload advertises read-only support and forwards only the explicit no-create option', async () => {
  const bridges = {}, calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (name, bridge) => { bridges[name] = bridge; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); }, on() {}, removeListener() {} } };
    },
  });
  assert.equal(bridges.nivraSecureVault.readOnlySupported, true);
  await bridges.nivraSecureVault.getOrCreateSecret('device-keys', { create: false, path: 'untrusted', secret: 'untrusted' });
  await bridges.nivraSecureVault.getOrCreateSecret('device-keys');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['nivra-secure-vault:get-or-create', 'device-keys', { create: false }],
    ['nivra-secure-vault:get-or-create', 'device-keys'],
  ]);
});
