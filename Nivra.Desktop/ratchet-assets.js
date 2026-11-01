'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const SCHEME = 'nivra-crypto';
const FILES = new Map([
  ['/web-device.mjs', 'text/javascript; charset=utf-8'],
  ['/pkg/nivra_ratchet_wasm.js', 'text/javascript; charset=utf-8'],
  ['/pkg/nivra_ratchet_wasm_bg.wasm', 'application/wasm'],
  ['/pkg/nivra_ratchet_olm.js', 'text/javascript; charset=utf-8'],
  ['/pkg/nivra_ratchet_olm_bg.wasm', 'application/wasm'],
]);
function registerRatchetScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}
function createRatchetAssetHandler(directory) {
  const root = path.resolve(directory);
  return async request => {
    try {
      const url = new URL(request.url), type = FILES.get(url.pathname);
      if (url.protocol !== SCHEME + ':' || url.host !== 'app' || url.username || url.password || url.search || url.hash || !type || !['GET', 'HEAD'].includes(request.method)) return new Response('', { status: 404 });
      const file = path.resolve(root, '.' + url.pathname), relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('', { status: 404 });
      const content = request.method === 'HEAD' ? null : await fs.readFile(file);
      return new Response(content, { headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('', { status: 404 }); }
  };
}
function installRatchetAssets(protocol, webRoot) { protocol.handle(SCHEME, createRatchetAssetHandler(path.join(webRoot, 'assets', 'ratchet'))); }
module.exports = { registerRatchetScheme, createRatchetAssetHandler, installRatchetAssets };
