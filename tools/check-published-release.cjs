'use strict';

// Checks the public routes used by installed apps, including the actual bytes.
// No publishing credentials or installer execution are involved.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validatedManifest } = require('../nivra-app/update-feed-policy.cjs');

const origin = 'https://nivrapp-secure.vercel.app';
const repository = 'AnthonyManzanoC/Nivrapp-secure';
const version = process.argv[2];
const commit = process.argv[3];
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '')) {
  throw new Error('Usage: node tools/check-published-release.cjs VERSION FULL_SOURCE_COMMIT');
}
const artifacts = path.resolve(__dirname, '../artifacts');
const expected = validatedManifest(JSON.parse(fs.readFileSync(path.join(artifacts, `Nivra-${version}-update-manifest.json`), 'utf8')));
assert.equal(expected.version, version);

async function publicJson(url, maximum) {
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Accept: 'application/json', 'User-Agent': 'Nivra-Public-Release-Check' }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Public JSON failed: ${url}`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= maximum, 'Public JSON exceeded its size limit');
    chunks.push(chunk);
  }
  return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), response };
}

function trustedDownload(url, filename) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  if (parsed.origin === origin) return parsed.href === `${origin}/downloads/${filename}`;
  if (parsed.origin === 'https://github.com') return parsed.href === `https://github.com/${repository}/releases/download/v${version}/${filename}`;
  return parsed.hostname === 'release-assets.githubusercontent.com'
    && /^\/github-production-release-asset(?:-[a-z0-9]+)?\/[^/]+\/[^/]+$/.test(parsed.pathname);
}

async function verifyDownload(item, filename) {
  let url = item.url;
  const deadline = AbortSignal.timeout(300000);
  for (let hop = 0; hop < 6; hop++) {
    assert.ok(trustedDownload(url, filename), `Untrusted download route for ${filename}`);
    const response = await fetch(url, { redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Nivra-Public-Release-Check' }, signal: deadline });
    if (filename.endsWith('-Setup.exe')) {
      assert.equal(response.status, 200, 'Windows download must remain on the first-party route for installed updater compatibility');
      assert.equal(response.headers.get('x-nivra-download-proxy'), 'streamed', 'Windows download route is not streaming');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      assert.ok(location, 'Download redirect has no destination');
      url = new URL(location, url).href;
      continue;
    }
    assert.equal(response.status, 200, `Download failed for ${filename}`);
    const hash = crypto.createHash('sha256'); let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= item.size, `Download exceeded verified size: ${filename}`);
      hash.update(chunk);
    }
    assert.equal(size, item.size, `Incomplete public download: ${filename}`);
    assert.equal(hash.digest('hex'), item.sha256, `Public download hash differs: ${filename}`);
    console.log(`Verified public download: ${filename}, ${size} bytes, SHA256 matches.`);
    return { filename, size, sha256: item.sha256 };
  }
  throw new Error(`Too many download redirects: ${filename}`);
}

async function main() {
  const { value: release } = await publicJson(`https://api.github.com/repos/${repository}/releases/latest`, 256 * 1024);
  assert.equal(release.tag_name, `v${version}`, 'GitHub latest still points to another release');
  assert.equal(release.target_commitish, commit, 'Published release targets another source commit');
  const { value, response } = await publicJson(`${origin}/updates/latest.json`, 32768);
  assert.equal(response.headers.get('access-control-allow-origin'), '*', 'The feed must support native WebView origins');
  assert.deepEqual(validatedManifest(value), expected, 'Public app update feed differs from the verified release');
  console.log(`Verified public update feed: ${version}, Android build ${expected.android.versionCode}.`);
  const binaries = [];
  for (const [platform, filename] of [['android', `Nivra-${version}-debug.apk`], ['windows', `Nivra-${version}-Setup.exe`]]) {
    const item = expected[platform];
    const asset = release.assets.find(candidate => candidate.name === filename);
    assert.ok(asset, `Release asset missing: ${filename}`);
    assert.equal(asset.size, item.size);
    assert.equal(asset.digest, `sha256:${item.sha256}`);
    binaries.push(await verifyDownload(item, filename));
  }
  fs.writeFileSync(path.join(artifacts, `Nivra-${version}-public-verification.json`), JSON.stringify({
    version, commit, checkedAt: new Date().toISOString(), releaseUrl: release.html_url, binaries,
  }, null, 2) + '\n');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
