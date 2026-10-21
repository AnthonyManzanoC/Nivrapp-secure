'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const {
  UPDATE_FEED_URL, UPDATE_ORIGIN, compareVersions, validateManifest,
  allowedUpdateRedirect, createElectronRequest, createUpdateManager,
} = require('./update-manager');

const bytes = Buffer.from('MZsynthetic-Nivra-setup-for-verification-only');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const feed = (version = '4.1.0') => ({
  schemaVersion: 1, version, publishedAt: '2026-10-21T12:00:00.000Z',
  windows: { version, url: `${UPDATE_ORIGIN}/downloads/Nivra-${version}-Setup.exe`, sha256, size: bytes.length },
  android: { version, versionCode: 28, url: `${UPDATE_ORIGIN}/downloads/Nivra-${version}-debug.apk`, sha256, size: bytes.length },
});
const response = (body, headers = {}) => ({ status: 200, headers, body: Readable.from([body]), cancel() {} });
const errorIs = code => error => error?.code === code;

async function fixture(t, overrides = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'nivra-update-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('nivra-update-test-'));
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const calls = [], launched = [], states = [];
  const manager = createUpdateManager({
    platform: 'win32', isPackaged: true, currentVersion: '4.0.1', cacheDirectory: path.join(directory, 'updates'),
    request: async (url, options) => {
      calls.push({ url, options });
      return url === UPDATE_FEED_URL ? response(Buffer.from(JSON.stringify(feed()))) : response(bytes, { 'content-length': String(bytes.length) });
    },
    launchInstaller: async file => launched.push(file), onState: state => states.push(state), ...overrides,
  });
  return { directory, manager, calls, launched, states, cached: path.join(directory, 'updates', 'Nivra-4.1.0-Setup.exe') };
}

test('stable semver compares numeric components and rejects ambiguous or unsafe versions', () => {
  assert.equal(compareVersions('4.10.0', '4.9.99'), 1);
  assert.equal(compareVersions('4.1.0', '4.1.0'), 0);
  assert.equal(compareVersions('4.0.9', '4.1.0'), -1);
  for (const value of ['v4.1.0', '4.01.0', '4.1', '4.1.0-beta', '4.1.0+meta', '4.1.0/../bad', '99999999999999999999.0.0', '65536.1.0']) {
    assert.throws(() => compareVersions(value, '4.0.1'), errorIs('UPDATE_INVALID_MANIFEST'));
  }
});

test('the feed pins versioned first-party installers and strictly validates metadata', () => {
  assert.deepEqual(validateManifest(feed()), feed().windows);
  const mutations = [
    item => item.schemaVersion = 2,
    item => item.windows.version = '4.2.0',
    item => item.windows.url = 'https://attacker.test/update.exe',
    item => item.windows.url += '?path=other',
    item => item.windows.url = item.windows.url.replace('https:', 'http:'),
    item => item.windows.sha256 = 'a'.repeat(63),
    item => item.windows.size = 512 * 1024 * 1024 + 1,
    item => item.windows.size = 12.5,
    item => item.windows.path = 'C:\\other.exe',
    item => item.publishedAt = 'tomorrow',
    item => item.android.version = '1.0.0',
    item => item.android.versionCode = 0,
    item => item.extra = true,
  ];
  for (const mutate of mutations) { const item = feed(); mutate(item); assert.throws(() => validateManifest(item), errorIs('UPDATE_INVALID_MANIFEST')); }
  const input = feed(), safe = validateManifest(input); input.windows.url = 'https://attacker.test';
  assert.ok(Object.isFrozen(safe)); assert.equal(safe.url, feed().windows.url);
});

test('metadata redirects admit only the release repository feed and GitHub asset CDN over HTTPS', () => {
  for (const url of [
    'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest/download/latest.json',
    'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/latest.json',
    'https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/123/id?signature=test',
  ]) assert.equal(allowedUpdateRedirect(url), true, url);
  for (const url of [
    'http://github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest/download/latest.json',
    'https://github.com/Other/Nivrapp-secure/releases/latest/download/latest.json',
    'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/other.json',
    'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0-beta/latest.json',
    'https://user@github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest/download/latest.json',
    'https://release-assets.githubusercontent.com.attacker.test/github-production-release-asset-2e65be/123/id',
    'https://release-assets.githubusercontent.com:8443/github-production-release-asset-2e65be/123/id',
    'https://release-assets.githubusercontent.com/other/123/id',
    'file:///C:/setup.exe',
  ]) assert.equal(allowedUpdateRedirect(url), false, url);
});

test('installer redirects pin the exact repository, release and filename', () => {
  const release = validateManifest(feed());
  const expected = 'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/Nivra-4.1.0-Setup.exe';
  assert.equal(allowedUpdateRedirect(expected, release), true);
  for (const url of [expected.replace('v4.1.0/', 'v4.0.1/'), expected.replace('Setup.exe', 'portable.zip'), expected + '?next=other', expected.replace('github.com/', 'github.com.attacker.test/')]) {
    assert.equal(allowedUpdateRedirect(url, release), false);
  }
});

test('the Chromium adapter checks redirects synchronously without cookies, bearer or shell input', async () => {
  const requests = [];
  const request = createElectronRequest({ request(options) {
    const req = new EventEmitter(); requests.push({ req, options });
    req.abort = () => req.emit('close'); req.end = () => {};
    req.followRedirect = () => { req.followed = (req.followed || 0) + 1; };
    return req;
  } });
  const pending = request(UPDATE_FEED_URL, { signal: new AbortController().signal, allowRedirect: allowedUpdateRedirect });
  const { req, options } = requests[0];
  assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.headers, undefined);
  req.emit('redirect', 302, 'GET', 'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest/download/latest.json');
  assert.equal(req.followed, 1);
  req.emit('redirect', 302, 'GET', 'https://attacker.test/setup.exe');
  await assert.rejects(pending, errorIs('UPDATE_UNTRUSTED_REDIRECT'));
  assert.equal(req.followed, 1);
});

test('the Chromium adapter bounds redirect loops and honors cancellation', async () => {
  let req;
  const request = createElectronRequest({ request() {
    req = new EventEmitter(); req.abort = () => req.emit('close'); req.end = () => {}; req.followRedirect = () => {};
    return req;
  } });
  const pending = request(UPDATE_FEED_URL, { signal: new AbortController().signal, allowRedirect: () => true });
  for (let i = 0; i < 5; i++) req.emit('redirect', 302, 'GET', 'https://github.com');
  await assert.rejects(pending, errorIs('UPDATE_UNTRUSTED_REDIRECT'));
  const controller = new AbortController();
  const aborted = request(UPDATE_FEED_URL, { signal: controller.signal, allowRedirect: () => true });
  req.emit('close');
  controller.abort(); await assert.rejects(aborted, errorIs('UPDATE_NETWORK'));
});

test('checking never installs or downloads, and exposes only sanitized metadata', async t => {
  const { manager, calls, launched } = await fixture(t);
  const result = await manager.checkForUpdate();
  assert.deepEqual(result, { status: 'available', currentVersion: '4.0.1', version: '4.1.0', size: bytes.length });
  assert.deepEqual(calls.map(call => call.url), [UPDATE_FEED_URL]); assert.deepEqual(launched, []);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.allowRedirect('https://attacker.test'), false);
  await assert.rejects(manager.installUpdate(), errorIs('UPDATE_NOT_READY'));
});

test('same and older versions never become installable', async t => {
  for (const version of ['4.0.1', '3.99.99']) {
    let calls = 0;
    const { manager, launched } = await fixture(t, { request: async url => { calls++; assert.equal(url, UPDATE_FEED_URL); return response(Buffer.from(JSON.stringify(feed(version)))); } });
    assert.equal((await manager.downloadUpdate()).status, 'current');
    assert.equal(calls, 1); assert.deepEqual(launched, []);
    await assert.rejects(manager.installUpdate(), errorIs('UPDATE_NOT_READY'));
  }
});

test('download streams into an atomic cache and install revalidates the verified executable', async t => {
  const { manager, calls, cached, launched, states } = await fixture(t);
  assert.equal((await manager.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(await fsp.readFile(cached), bytes);
  assert.deepEqual(launched, []); assert.equal(calls.length, 2);
  assert.equal(calls[1].options.allowRedirect('https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/Nivra-4.1.0-Setup.exe'), true);
  assert.deepEqual(manager.getUpdateState(), { phase: 'ready', progress: 100 });
  const visibleState = manager.getUpdateState(); visibleState.phase = 'tampered';
  assert.equal(manager.getUpdateState().phase, 'ready');
  assert.ok(states.some(state => state.phase === 'downloading'));
  assert.equal((await manager.installUpdate()).status, 'installing');
  assert.deepEqual(launched, [cached]);
  assert.equal((await manager.installUpdate()).status, 'installing'); assert.equal(launched.length, 1);
});

test('partial or oversized downloads never become executable and remove their partial file', async t => {
  for (const body of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('extra')])]) {
    const { manager, directory, launched } = await fixture(t, { request: async url => url === UPDATE_FEED_URL ? response(Buffer.from(JSON.stringify(feed()))) : response(body) });
    await assert.rejects(manager.downloadUpdate(), errorIs('UPDATE_SIZE_MISMATCH'));
    assert.deepEqual(await fsp.readdir(path.join(directory, 'updates')), []);
    assert.deepEqual(launched, []); await assert.rejects(manager.installUpdate(), errorIs('UPDATE_NOT_READY'));
  }
});

test('download rejects dishonest length, invalid executable bytes and SHA-256 mismatches', async t => {
  for (const [body, headers, code] of [
    [bytes, { 'content-length': '2' }, 'UPDATE_SIZE_MISMATCH'],
    [bytes, { 'content-length': '12,12' }, 'UPDATE_SIZE_MISMATCH'],
    [Buffer.from(bytes.toString().replace('MZ', 'ZZ')), {}, 'UPDATE_HASH_MISMATCH'],
    [Buffer.from(bytes.toString().replace('synthetic', 'Synthetic')), {}, 'UPDATE_HASH_MISMATCH'],
  ]) {
    const { manager, launched } = await fixture(t, { request: async url => url === UPDATE_FEED_URL ? response(Buffer.from(JSON.stringify(feed()))) : response(body, headers) });
    await assert.rejects(manager.downloadUpdate(), errorIs(code)); assert.deepEqual(launched, []);
  }
});

test('a cached installer changed after download is never launched', async t => {
  const { manager, cached, launched } = await fixture(t);
  await manager.downloadUpdate();
  await fsp.writeFile(cached, Buffer.from(bytes.toString().replace('synthetic', 'Synthetic')));
  await assert.rejects(manager.installUpdate(), errorIs('UPDATE_HASH_MISMATCH'));
  assert.deepEqual(launched, []); assert.equal(manager.getUpdateState().phase, 'error');
});

test('a cache junction cannot redirect writes outside the application cache', async t => {
  const { manager, directory, launched } = await fixture(t);
  const other = path.join(directory, 'other'); await fsp.mkdir(other);
  await fsp.symlink(other, path.join(directory, 'updates'), 'junction');
  await assert.rejects(manager.downloadUpdate(), errorIs('UPDATE_CACHE_UNSAFE'));
  assert.deepEqual(await fsp.readdir(other), []); assert.deepEqual(launched, []);
});

test('hard-linked cached installers fail closed before execution', async t => {
  const { manager, cached, directory, launched } = await fixture(t);
  await manager.downloadUpdate();
  await fsp.link(cached, path.join(directory, 'external.exe'));
  await assert.rejects(manager.installUpdate(), errorIs('UPDATE_CACHE_UNSAFE'));
  assert.deepEqual(launched, []);
});

test('oversized feeds, invalid schemas and network failures preserve a noninstallable state', async t => {
  for (const request of [
    async () => response(Buffer.alloc(16385, ' ')),
    async () => response(Buffer.from('{"schemaVersion":99}')),
    async () => { throw new Error('synthetic internal network diagnostics'); },
  ]) {
    const { manager, launched } = await fixture(t, { request });
    await assert.rejects(manager.checkForUpdate(), error => /^UPDATE_/.test(error.message) && !error.message.includes('diagnostics'));
    assert.deepEqual(launched, []); await assert.rejects(manager.installUpdate(), errorIs('UPDATE_NOT_READY'));
  }
});

test('parallel downloads share one operation; subsequent checks reuse only the verified cached file', async t => {
  const { manager, calls, launched } = await fixture(t);
  const first = manager.downloadUpdate(), second = manager.downloadUpdate();
  assert.equal(first, second);
  await first; assert.equal(calls.length, 2);
  assert.equal((await manager.checkForUpdate()).status, 'downloaded');
  await manager.downloadUpdate(); assert.equal(calls.length, 3); assert.deepEqual(launched, []);
});

test('installer launch errors are sanitized, and unpackaged/non-Windows applications cannot update', async t => {
  const { manager, launched } = await fixture(t, { launchInstaller: async () => { throw new Error('secret path in native error'); } });
  await manager.downloadUpdate();
  await assert.rejects(manager.installUpdate(), errorIs('UPDATE_INSTALL_FAILED'));
  assert.deepEqual(launched, []);
  for (const options of [{ platform: 'linux' }, { isPackaged: false }]) {
    const { manager, calls } = await fixture(t, options);
    assert.throws(() => manager.checkForUpdate(), errorIs('UPDATE_UNSUPPORTED'));
    assert.equal(calls.length, 0);
  }
});
