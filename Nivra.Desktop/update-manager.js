'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const UPDATE_ORIGIN = 'https://nivrapp-secure.vercel.app';
const UPDATE_FEED_URL = `${UPDATE_ORIGIN}/updates/latest.json`;
const RELEASE_PATH = '/AnthonyManzanoC/Nivrapp-secure/releases/';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_MANIFEST_BYTES = 16384;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const ERROR_CODES = new Set([
  'UPDATE_NETWORK', 'UPDATE_INVALID_MANIFEST', 'UPDATE_UNTRUSTED_REDIRECT',
  'UPDATE_SIZE_MISMATCH', 'UPDATE_HASH_MISMATCH', 'UPDATE_NOT_READY',
  'UPDATE_INSTALL_FAILED', 'UPDATE_UNSUPPORTED', 'UPDATE_BUSY', 'UPDATE_CACHE_UNSAFE',
]);

function fail(code) { const error = new Error(code); error.code = code; return error; }
function updateErrorCode(error) { return ERROR_CODES.has(error?.code) ? error.code : 'UPDATE_NETWORK'; }
function versionParts(value) {
  if (typeof value !== 'string' || !VERSION.test(value) || value.length > 32) return null;
  const parts = value.split('.').map(Number);
  return parts.every(part => Number.isSafeInteger(part) && part <= 65535) ? parts : null;
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) throw fail('UPDATE_INVALID_MANIFEST');
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; }
  return 0;
}
function safeHttps(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (!url.port || url.port === '443') ? url : null;
  } catch { return null; }
}
function allowedUpdateRedirect(value, release = null) {
  const url = safeHttps(value);
  if (!url) return false;
  if (url.hostname === 'release-assets.githubusercontent.com') {
    return /^\/github-production-release-asset-[a-z0-9]+\/[^/]+\//i.test(url.pathname);
  }
  if (url.origin !== 'https://github.com' || url.search) return false;
  if (release) {
    return url.pathname === `${RELEASE_PATH}download/v${release.version}/Nivra-${release.version}-Setup.exe`;
  }
  if (url.pathname === `${RELEASE_PATH}latest/download/latest.json`) return true;
  const match = url.pathname.match(/^\/AnthonyManzanoC\/Nivrapp-secure\/releases\/download\/v([^/]+)\/latest\.json$/);
  return Boolean(match && versionParts(match[1]));
}
function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function validateManifest(value) {
  if (!exactKeys(value, ['schemaVersion', 'version', 'publishedAt', 'windows', 'android'])
    || value.schemaVersion !== 1 || !versionParts(value.version)
    || typeof value.publishedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.publishedAt)
    || !Number.isFinite(Date.parse(value.publishedAt))) throw fail('UPDATE_INVALID_MANIFEST');
  const item = value.windows;
  if (!exactKeys(item, ['version', 'url', 'sha256', 'size']) || item.version !== value.version
    || item.url !== `${UPDATE_ORIGIN}/downloads/Nivra-${value.version}-Setup.exe`
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !Number.isSafeInteger(item.size) || item.size < 2 || item.size > MAX_INSTALLER_BYTES) {
    throw fail('UPDATE_INVALID_MANIFEST');
  }
  // Android has its own verifier. Do not let malformed shared feed metadata go unnoticed.
  const android = value.android;
  if (!exactKeys(android, ['version', 'versionCode', 'url', 'sha256', 'size']) || android.version !== value.version
    || !Number.isSafeInteger(android.versionCode) || android.versionCode < 1
    || android.url !== `${UPDATE_ORIGIN}/downloads/Nivra-${value.version}-debug.apk`
    || typeof android.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(android.sha256)
    || !Number.isSafeInteger(android.size) || android.size < 2 || android.size > MAX_INSTALLER_BYTES) {
    throw fail('UPDATE_INVALID_MANIFEST');
  }
  return Object.freeze({ version: item.version, url: item.url, sha256: item.sha256, size: item.size });
}
function header(response, name) {
  if (typeof response.headers?.get === 'function') return response.headers.get(name);
  const key = Object.keys(response.headers || {}).find(key => key.toLowerCase() === name.toLowerCase());
  const value = key ? response.headers[key] : null;
  return Array.isArray(value) ? value.join(',') : value;
}
function responseSize(response, maximum, exact = false) {
  const raw = header(response, 'content-length');
  if (raw == null || raw === '') return;
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))
    || Number(raw) > maximum || (exact && Number(raw) !== maximum)) throw fail('UPDATE_SIZE_MISMATCH');
}

/** Uses Chromium's system TLS/proxy settings, with every redirect checked before following it. */
function createElectronRequest(net) {
  return (url, { signal, allowRedirect }) => new Promise((resolve, reject) => {
    let settled = false, redirects = 0;
    const request = net.request({
      url, method: 'GET', redirect: 'manual', credentials: 'omit',
      cache: 'no-store', referrerPolicy: 'no-referrer', bypassCustomProtocolHandlers: true,
    });
    const cleanup = () => signal.removeEventListener('abort', abort);
    const rejectRequest = error => {
      if (!settled) { settled = true; reject(error); }
      cleanup();
      request.abort();
    };
    const abort = () => rejectRequest(fail('UPDATE_NETWORK'));
    signal.addEventListener('abort', abort, { once: true });
    request.on('error', () => { if (!settled) { settled = true; cleanup(); reject(fail('UPDATE_NETWORK')); } });
    request.on('redirect', (_status, method, target) => {
      if (method !== 'GET' || ++redirects > 4 || !allowRedirect(target)) {
        rejectRequest(fail('UPDATE_UNTRUSTED_REDIRECT'));
      } else { request.followRedirect(); }
    });
    request.once('response', response => {
      if (settled) { request.abort(); return; }
      settled = true;
      // The body can outlive the writable request. Keep the deadline active
      // until the incoming stream finishes or is explicitly cancelled.
      response.once('end', cleanup);
      response.once('close', cleanup);
      response.once('error', cleanup);
      resolve({ status: response.statusCode, headers: response.headers, body: response, cancel: () => request.abort() });
    });
    if (signal.aborted) abort(); else request.end();
  });
}

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function sameFile(left, right) {
  // Windows lstat can report dev=0 while fstat exposes the volume serial.
  // BigInt preserves the complete NTFS file index for replacement checks.
  return left.ino === right.ino && (left.dev === 0n || right.dev === 0n || left.dev === right.dev);
}

function createUpdateManager(options) {
  const { currentVersion, cacheDirectory, request, launchInstaller } = options;
  if (!versionParts(currentVersion) || typeof cacheDirectory !== 'string' || !path.isAbsolute(cacheDirectory)) {
    throw fail('UPDATE_INVALID_MANIFEST');
  }
  const cacheRoot = path.resolve(cacheDirectory);
  let manifest = null, downloaded = null, checking = null, downloading = null, installing = null;
  let state = Object.freeze({ phase: 'idle', progress: 0 });
  const emit = (phase, progress = 0, error) => {
    const next = { phase, progress: Math.max(0, Math.min(100, Math.floor(progress))), ...(error ? { error: updateErrorCode(error) } : {}) };
    if (state.phase === next.phase && state.progress === next.progress && state.error === next.error) return;
    state = Object.freeze(next);
    try { options.onState?.({ ...state }); } catch { /* A closed renderer cannot affect update verification. */ }
  };
  const supported = () => { if (options.platform !== 'win32' || !options.isPackaged) throw fail('UPDATE_UNSUPPORTED'); };
  const result = status => ({ status, currentVersion, ...(manifest ? { version: manifest.version, size: manifest.size } : {}) });
  const reportError = error => { emit('error', 0, error); throw fail(updateErrorCode(error)); };
  const ensureCache = async () => {
    await fsp.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(cacheRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fsp.realpath(cacheRoot), cacheRoot)) {
      throw fail('UPDATE_CACHE_UNSAFE');
    }
  };
  const fileFor = release => path.join(cacheRoot, `Nivra-${release.version}-Setup.exe`);
  const verifyFile = async (file, release) => {
    await ensureCache();
    if (!samePath(file, fileFor(release))) throw fail('UPDATE_CACHE_UNSAFE');
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(release.size)) {
      throw fail(before.isSymbolicLink() || before.nlink !== 1n ? 'UPDATE_CACHE_UNSAFE' : 'UPDATE_SIZE_MISMATCH');
    }
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(opened, before)) throw fail('UPDATE_CACHE_UNSAFE');
      const hash = crypto.createHash('sha256'); let size = 0; let prefix = Buffer.alloc(0);
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > release.size) throw fail('UPDATE_SIZE_MISMATCH');
        if (prefix.length < 2) prefix = Buffer.concat([prefix, chunk]).subarray(0, 2);
        hash.update(chunk);
      }
      const after = await fsp.lstat(file, { bigint: true }), final = await handle.stat({ bigint: true });
      if (after.isSymbolicLink() || !sameFile(after, opened) || after.nlink !== 1n
        || final.mtimeNs !== opened.mtimeNs || final.size !== opened.size) throw fail('UPDATE_CACHE_UNSAFE');
      if (size !== release.size) throw fail('UPDATE_SIZE_MISMATCH');
      if (prefix.toString('ascii') !== 'MZ' || hash.digest('hex') !== release.sha256) throw fail('UPDATE_HASH_MISMATCH');
    } finally { await handle.close(); }
  };

  const checkOnce = async () => {
    const response = await request(UPDATE_FEED_URL, {
      signal: AbortSignal.timeout(15000), allowRedirect: target => allowedUpdateRedirect(target),
    });
    try {
      if (response.status !== 200 || !response.body) throw fail('UPDATE_NETWORK');
      responseSize(response, MAX_MANIFEST_BYTES);
      const parts = []; let size = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_MANIFEST_BYTES) throw fail('UPDATE_INVALID_MANIFEST');
        parts.push(bytes);
      }
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw fail('UPDATE_INVALID_MANIFEST'); }
      const release = validateManifest(parsed);
      if (compareVersions(release.version, currentVersion) <= 0) {
        manifest = null; downloaded = null; emit('idle'); return result('current');
      }
      if (!manifest || manifest.sha256 !== release.sha256 || manifest.version !== release.version || manifest.size !== release.size) {
        downloaded = null; emit('idle');
      }
      manifest = release;
      return result(downloaded ? 'downloaded' : 'available');
    } finally { response.cancel?.(); }
  };
  const checkForUpdate = () => {
    supported();
    if (downloading || installing) return Promise.reject(fail('UPDATE_BUSY'));
    checking ??= checkOnce().catch(reportError).finally(() => { checking = null; });
    return checking;
  };
  const downloadOnce = async () => {
    if (checking) await checking;
    if (!manifest) { await checkForUpdate(); if (!manifest) return result('current'); }
    const release = manifest, destination = fileFor(release);
    await ensureCache();
    try {
      await verifyFile(destination, release);
      downloaded = { file: destination, release }; emit('ready', 100); return result('downloaded');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (!['UPDATE_SIZE_MISMATCH', 'UPDATE_HASH_MISMATCH'].includes(error.code)) throw error;
        await fsp.unlink(destination);
      }
    }
    const temporary = path.join(cacheRoot, `.Nivra-${release.version}-${crypto.randomBytes(16).toString('hex')}.part`);
    let response = null, file = null;
    emit('downloading');
    try {
      response = await request(release.url, {
        signal: AbortSignal.timeout(10 * 60 * 1000), allowRedirect: target => allowedUpdateRedirect(target, release),
      });
      if (response.status !== 200 || !response.body) throw fail('UPDATE_NETWORK');
      responseSize(response, release.size, true);
      file = await fsp.open(temporary, 'wx', 0o600);
      const hash = crypto.createHash('sha256'); let size = 0; let prefix = Buffer.alloc(0);
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > release.size) throw fail('UPDATE_SIZE_MISMATCH');
        if (prefix.length < 2) prefix = Buffer.concat([prefix, bytes]).subarray(0, 2);
        hash.update(bytes); await file.writeFile(bytes);
        emit('downloading', Math.min(99, size * 100 / release.size));
      }
      if (size !== release.size) throw fail('UPDATE_SIZE_MISMATCH');
      if (prefix.toString('ascii') !== 'MZ' || hash.digest('hex') !== release.sha256) throw fail('UPDATE_HASH_MISMATCH');
      await file.sync(); await file.close(); file = null;
      await ensureCache();
      await fsp.rename(temporary, destination);
      await verifyFile(destination, release);
      downloaded = { file: destination, release }; emit('ready', 100);
      return result('downloaded');
    } finally {
      response?.cancel?.();
      if (file) await file.close();
      await fsp.unlink(temporary).catch(() => undefined);
    }
  };
  const downloadUpdate = () => {
    supported();
    if (installing) return Promise.reject(fail('UPDATE_BUSY'));
    downloading ??= downloadOnce().catch(reportError).finally(() => { downloading = null; });
    return downloading;
  };
  const installUpdate = () => {
    supported();
    if (installing) return installing;
    if (downloading || checking) return Promise.reject(fail('UPDATE_BUSY'));
    if (!downloaded || !manifest || compareVersions(manifest.version, currentVersion) <= 0) return Promise.reject(fail('UPDATE_NOT_READY'));
    installing = (async () => {
      await verifyFile(downloaded.file, downloaded.release);
      emit('installing', 100);
      try { await launchInstaller(downloaded.file); } catch { throw fail('UPDATE_INSTALL_FAILED'); }
      return result('installing');
    })().catch(error => { installing = null; downloaded = null; return reportError(error); });
    return installing;
  };
  return Object.freeze({ checkForUpdate, downloadUpdate, installUpdate, getUpdateState: () => ({ ...state }) });
}

module.exports = {
  UPDATE_FEED_URL, UPDATE_ORIGIN, compareVersions, validateManifest, allowedUpdateRedirect,
  createElectronRequest, createUpdateManager, updateErrorCode,
};
