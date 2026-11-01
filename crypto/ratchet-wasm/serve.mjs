import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.argv[2] || 8124);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid test port');
const root = new URL('./', import.meta.url);
const allowed = /^\/(browser\.html|fixtures\.json|(?:web-device|indexeddb-state|browser-storage-tests|browser-persistence-tests)\.mjs|pkg\/web\/[a-zA-Z0-9_.-]+\.(js|wasm))$/;
createServer(async (request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname;
  if (!allowed.test(name) || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
  try {
    const content = await readFile(new URL(name.slice(1), root));
    response.writeHead(200, { 'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'application/javascript' : name.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`Isolated bridge test server: 127.0.0.1:${port}`));
