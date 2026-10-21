const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FEED_URL, trustedFeedUrl, validatedManifest, loadLatestManifest } = require('./update-feed-policy.cjs');
const manifest = () => ({ schemaVersion: 1, version: '4.1.0', publishedAt: '2026-10-21T00:00:00Z',
  android: { version: '4.1.0', versionCode: 28, size: 82, sha256: 'a'.repeat(64), url: 'https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.0-debug.apk' },
  windows: { version: '4.1.0', size: 105, sha256: 'b'.repeat(64), url: 'https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.0-Setup.exe' } });

test('accepts one complete release and exposes only known publisher fields', () => {
  const input = { ...manifest(), untrustedHtml: '<script>' };
  assert.deepEqual(validatedManifest(input), manifest());
});
test('rejects mismatched platform versions, untrusted URLs, invalid digests and sizes', () => {
  for (const patch of [{version:'4.0.1'}, {url:'https://evil.test/update.exe'}, {sha256:'x'}, {size:0}, {size:2**40}]) {
    const input = manifest(); Object.assign(input.windows, patch);
    assert.throws(() => validatedManifest(input));
  }
  const input = manifest(); input.android.versionCode = 2147483648;
  assert.throws(() => validatedManifest(input));
});
test('restricts metadata redirects to this repository and the release asset CDN', () => {
  assert.equal(trustedFeedUrl(FEED_URL), true);
  assert.equal(trustedFeedUrl('https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/latest.json'), true);
  for (const url of ['http://github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest/download/latest.json', 'https://github.com/other/repo/releases/latest/download/latest.json', 'https://github.com.evil.test/latest.json', 'https://user:secret@github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest/download/latest.json', 'https://release-assets.githubusercontent.com/arbitrary-path']) assert.equal(trustedFeedUrl(url), false);
});
test('follows bounded metadata redirects and returns a normalized complete manifest', async () => {
  let requests = 0;
  const result = await loadLatestManifest(async () => ++requests === 1 ? new Response(null, { status:302, headers:{location:'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/latest.json'} }) : Response.json(manifest()));
  assert.deepEqual(result, manifest()); assert.equal(requests, 2);
});
test('never requests an arbitrary redirect destination', async () => {
  let requests = 0;
  await assert.rejects(loadLatestManifest(async () => { requests++; return new Response(null, {status:302,headers:{location:'https://evil.test/feed'}}); }), /UNTRUSTED_REDIRECT/);
  assert.equal(requests, 1);
});
test('fails closed on oversized, malformed, missing or looping publisher feeds', async () => {
  await assert.rejects(loadLatestManifest(async () => new Response('x'.repeat(32769))), /FEED_TOO_LARGE/);
  await assert.rejects(loadLatestManifest(async () => new Response('<html>')), SyntaxError);
  await assert.rejects(loadLatestManifest(async () => new Response(null, {status:404})), /UPSTREAM_UNAVAILABLE/);
  await assert.rejects(loadLatestManifest(async () => new Response(null, {status:302,headers:{location:FEED_URL}})), /TOO_MANY_REDIRECTS/);
});
