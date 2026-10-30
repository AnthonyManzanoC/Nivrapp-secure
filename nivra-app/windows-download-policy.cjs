'use strict';
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const MAX_BYTES = 512 * 1024 * 1024;

function trustedInstallerUrl(value, version) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (url.origin === 'https://github.com') return url.href === `https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v${version}/Nivra-${version}-Setup.exe`;
    return url.hostname === 'release-assets.githubusercontent.com'
      && /^\/github-production-release-asset(?:-[a-z0-9]+)?\/[^/]+\/[^/]+$/i.test(url.pathname);
  } catch { return false; }
}

function createWindowsDownloadHandler(fetchImpl = fetch) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD, OPTIONS'); response.writeHead(405); response.end(); return;
    }
    const incoming = new URL(request.url, 'https://nivrapp-secure.vercel.app');
    // Vercel exposes rewrite parameters through query even when url retains
    // the original public path. Plain Node requests use the URL query instead.
    const rewritten = request.query?.version;
    const version = rewritten === undefined ? incoming.searchParams.getAll('version') : [rewritten];
    if (version.length !== 1 || !VERSION.test(version[0])) { response.writeHead(400); response.end(); return; }
    const targetVersion = version[0];
    if (typeof targetVersion !== 'string') { response.writeHead(400); response.end(); return; }
    const publicPath = incoming.pathname.match(/^\/downloads\/Nivra-([^/]+)-Setup\.exe$/);
    if (publicPath && publicPath[1] !== targetVersion) { response.writeHead(400); response.end(); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 285000);
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.on('close', disconnect);
    let upstream;
    try {
      let url = `https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v${targetVersion}/Nivra-${targetVersion}-Setup.exe`;
      for (let hop = 0; hop < 5; hop++) {
        if (!trustedInstallerUrl(url, targetVersion)) throw new Error('UNTRUSTED_REDIRECT');
        upstream = await fetchImpl(url, { method: request.method, redirect: 'manual', credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'Nivra-Windows-Download' }, signal: controller.signal });
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
        const location = upstream.headers.get('location');
        await upstream.body?.cancel(); upstream = null;
        if (!location) throw new Error('INVALID_REDIRECT');
        url = new URL(location, url).href;
      }
      if (!upstream) throw new Error('TOO_MANY_REDIRECTS');
      if (upstream.status !== 200) {
        await upstream.body?.cancel(); response.writeHead(upstream.status === 404 ? 404 : 503); response.end(); return;
      }
      const rawLength = upstream.headers.get('content-length');
      const length = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
      if (length !== null && (!Number.isSafeInteger(length) || length < 2 || length > MAX_BYTES)) throw new Error('INVALID_SIZE');
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', `attachment; filename="Nivra-${targetVersion}-Setup.exe"`);
      response.setHeader('X-Nivra-Download-Proxy', 'streamed');
      if (length !== null) response.setHeader('Content-Length', length);
      if (request.method === 'HEAD') { await upstream.body?.cancel(); response.writeHead(200); response.end(); return; }
      if (!upstream.body) throw new Error('MISSING_BODY');
      let bytes = 0;
      const bounded = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(bytes > MAX_BYTES || (length !== null && bytes > length) ? new Error('INVALID_SIZE') : null, chunk);
        },
        flush(done) { done(length !== null && bytes !== length ? new Error('INCOMPLETE_DOWNLOAD') : null); },
      });
      // Stream immediately: never buffer an installer in function memory. This
      // also avoids the ordinary Vercel buffered-response payload limit.
      response.writeHead(200); response.flushHeaders();
      await pipeline(Readable.fromWeb(upstream.body), bounded, response, { signal: controller.signal });
    } catch {
      controller.abort();
      try { await upstream?.body?.cancel(); } catch { /* A pipeline may own the stream. */ }
      if (!response.headersSent) { response.writeHead(503); response.end(); }
      else if (!response.writableFinished) response.destroy();
    } finally { clearTimeout(timer); response.off('close', disconnect); }
  };
}
module.exports = { createWindowsDownloadHandler, trustedInstallerUrl };
