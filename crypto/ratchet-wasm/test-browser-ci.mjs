// CI-only real-time browser harness. dump-dom's virtual clock can finish before
// asynchronous IndexedDB work; explicitly wait for the laboratory page outcome.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.CI !== 'true' || !process.env.RUNNER_TEMP) throw Error('Run this browser harness only in isolated CI');
const profile = await mkdtemp(join(process.env.RUNNER_TEMP, 'nivra-ratchet-chrome-'));
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError, socket, nextId = 0;
const pending = new Map();
chrome.on('error', error => { chromeError = error; });
chrome.stderr.on('data', () => {});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error(`Browser command timed out: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  let port;
  for (let i = 0; i < 100; i++) {
    if (chromeError) throw chromeError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await delay(100); }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Browser debugging endpoint unavailable');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  if (!target) throw Error('Isolated browser page unavailable');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
  });
  await command('Page.navigate', { url: 'http://127.0.0.1:8123/browser.html' });
  const deadline = Date.now() + 45000;
  let outcome;
  while (Date.now() < deadline) {
    const result = await command('Runtime.evaluate', { expression: '({status: document.body?.dataset.result, text: document.body?.textContent})', returnByValue: true });
    outcome = result.result?.value;
    if (['passed', 'failed'].includes(outcome?.status)) break;
    await delay(200);
  }
  const document = await command('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  await writeFile(new URL('./browser-result.html', import.meta.url), document.result.value);
  if (outcome?.status !== 'passed') throw Error(`Browser test ${outcome?.status ?? 'timed out'}: ${outcome?.text?.slice(0, 500)}`);
  console.log(outcome.text);
} finally {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Browser harness closed')); }
  socket?.close(); chrome.kill('SIGTERM');
}
