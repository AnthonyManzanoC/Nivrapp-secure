'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createWindowsDownloadHandler } = require('./windows-download-policy.cjs');

async function serverFor(t, fetcher, rewritten) {
  const handler = createWindowsDownloadHandler(fetcher);
  const server = http.createServer((req, res) => { if (rewritten) req.query = rewritten; void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('rejects malformed or ambiguous versions and unsupported methods before contacting GitHub', async t => {
  let calls = 0;
  const url = await serverFor(t, async () => { calls++; throw new Error('Unexpected fetch'); });
  for (const suffix of ['', '?version=../7.0.0', '?version=07.0.0', '?version=7.0.0&version=6.1.3']) {
    assert.equal((await fetch(url + '/' + suffix)).status, 400);
  }
  assert.equal((await fetch(url + '/?version=7.0.0', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/', { method: 'OPTIONS' })).status, 204);
  assert.equal(calls, 0);
});

test('accepts Vercel rewrite parameters and streams a real CDN redirect as a stable first-party response', async t => {
  const calls = [];
  const url = await serverFor(t, async (target, options) => {
    calls.push(target); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    return calls.length === 1 ? new Response(null, { status: 302, headers: {
      location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1254/example?signature=opaque',
    } }) : new Response('MZinstaller', { headers: { 'content-length': '11' } });
  }, { version: '7.0.0' });
  const response = await fetch(url + '/downloads/Nivra-7.0.0-Setup.exe');
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-nivra-download-proxy'), 'streamed');
  assert.equal(response.headers.get('content-length'), '11'); assert.equal(await response.text(), 'MZinstaller');
  assert.equal(calls[0], 'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v7.0.0/Nivra-7.0.0-Setup.exe');
  assert.equal(calls.length, 2);
  assert.equal((await fetch(url + '/downloads/Nivra-6.1.3-Setup.exe')).status, 400);
});

test('rejects redirects to another host, repository or release without contacting the destination', async t => {
  for (const location of ['https://evil.test/app.exe', 'http://release-assets.githubusercontent.com/asset',
    'https://github.com/other/project/releases/download/v7.0.0/Nivra-7.0.0-Setup.exe',
    'https://release-assets.githubusercontent.com.evil.test/github-production-release-asset/1/2']) {
    let calls = 0;
    const url = await serverFor(t, async () => { calls++; return new Response(null, { status: 302, headers: { location } }); });
    assert.equal((await fetch(url + '/?version=7.0.0')).status, 503); assert.equal(calls, 1);
  }
});

test('streams more than the buffered function limit and delivers the first chunk before upstream completion', async t => {
  let controller;
  const chunk = Buffer.alloc(2 * 1024 * 1024, 65);
  const size = 7 + 3 * chunk.length;
  const url = await serverFor(t, async () => new Response(new ReadableStream({ start(value) {
    controller = value; controller.enqueue(Buffer.from('MZstart'));
  } }), { headers: { 'content-length': String(size) } }));
  const response = await fetch(url + '/?version=7.0.0');
  const reader = response.body.getReader();
  const first = await reader.read(); assert.equal(Buffer.from(first.value).toString(), 'MZstart');
  for (let i = 0; i < 3; i++) controller.enqueue(chunk);
  controller.close();
  let bytes = first.value.length;
  for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; }
  assert.equal(bytes, size);
});

test('HEAD returns installer metadata without consuming binary data; missing assets return 404', async t => {
  let method;
  const url = await serverFor(t, async (_target, options) => {
    method = options.method; return new Response(null, { headers: { 'content-length': '108007509' } });
  });
  const response = await fetch(url + '/?version=7.0.0', { method: 'HEAD' });
  assert.equal(method, 'HEAD'); assert.equal(response.headers.get('content-length'), '108007509');
  assert.equal(await response.text(), '');
  const missing = await serverFor(t, async () => new Response(null, { status: 404 }));
  assert.equal((await fetch(missing + '/?version=7.0.0')).status, 404);
});

test('an incomplete upstream body terminates the response instead of claiming a complete installer', async t => {
  const url = await serverFor(t, async () => new Response('MZpartial', { headers: { 'content-length': '100' } }));
  await assert.rejects(async () => { const response = await fetch(url + '/?version=7.0.0'); await response.arrayBuffer(); });
});
