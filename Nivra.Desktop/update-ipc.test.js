'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { updateErrorCode } = require('./update-manager');

const json = value => JSON.parse(JSON.stringify(value));

test('preload exposes narrow update actions and strips IPC events or extra state fields', async () => {
  const bridges = {}, invocations = [], events = new EventEmitter();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => bridges[name] = value },
        ipcRenderer: {
          invoke: async (...args) => { invocations.push(args); return { status: 'current' }; },
          on: (name, handler) => events.on(name, handler),
          removeListener: (name, handler) => events.removeListener(name, handler),
        },
      };
    },
  });
  const updates = bridges.nivraDesktopUpdates;
  for (const method of ['checkForUpdate', 'downloadUpdate', 'installUpdate', 'getUpdateState']) {
    await updates[method]({ url: 'https://attacker.test', file: 'C:\\bad.exe', sha256: 'bad' });
  }
  assert.deepEqual(invocations, [
    ['nivra-updates:check'], ['nivra-updates:download'], ['nivra-updates:install'], ['nivra-updates:get-state'],
  ]);
  let received;
  const unsubscribe = updates.onUpdateState(state => received = state);
  const secretEvent = { sender: 'never expose Electron IPC to renderer' };
  events.emit('nivra-updates:state', secretEvent, { phase: 'downloading', progress: 23.5, path: 'C:\\private', url: 'https://hidden' });
  assert.deepEqual(json(received), { phase: 'downloading', progress: 23 });
  events.emit('nivra-updates:state', secretEvent, { phase: 'error', progress: -20, error: 'UPDATE_HASH_MISMATCH' });
  assert.deepEqual(json(received), { phase: 'error', progress: 0, error: 'UPDATE_HASH_MISMATCH' });
  events.emit('nivra-updates:state', secretEvent, { phase: 'untrusted', progress: 100 });
  assert.equal(received.phase, 'error');
  unsubscribe(); assert.equal(events.listenerCount('nivra-updates:state'), 0);
});

async function mainFixture() {
  const handlers = new Map(), timers = [], calls = [], spawnCalls = [];
  let window, updateOptions;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getVersion: () => '4.0.1', getPath: () => 'C:\\Nivra-Test-Profile', quit: () => calls.push('quit'),
  });
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.send = (...args) => calls.push(['event', ...args]);
    }
    removeMenu() {}
    isDestroyed() { return false; }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    static getAllWindows() { return [window]; }
  }
  const manager = Object.fromEntries(['checkForUpdate', 'downloadUpdate', 'installUpdate', 'getUpdateState'].map(method => [method, async () => {
    calls.push(method); return { status: method === 'installUpdate' ? 'installing' : 'available' };
  }]));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), {
    __dirname, Buffer, URL, setTimeout: callback => timers.push(callback),
    process: { platform: 'win32', resourcesPath: 'C:\\Nivra-Test-Resources', env: {} },
    require: name => {
      if (name === 'electron') return {
        app, BrowserWindow: FakeWindow, Menu: { setApplicationMenu() {} }, shell: {}, net: {}, safeStorage: {},
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        session: { defaultSession: { webRequest: { onHeadersReceived() {} }, setPermissionRequestHandler() {} } },
      };
      if (name === 'fs') return { existsSync: () => true, readFileSync: () => '' };
      if (name === './update-manager') return {
        createElectronRequest: () => () => {}, updateErrorCode,
        createUpdateManager: options => { updateOptions = options; return manager; },
      };
      if (name === 'node:child_process') return { spawn: (...args) => {
        spawnCalls.push(args); const child = new EventEmitter(); child.unref = () => calls.push('unref');
        process.nextTick(() => child.emit('spawn')); return child;
      } };
      return require(name);
    },
  });
  await Promise.resolve();
  return { handlers, calls, timers, window, manager, updateOptions, spawnCalls };
}

test('all update IPC rejects remote frames, child frames and renderer-supplied update parameters', async () => {
  const { handlers, calls, window } = await mainFixture();
  const valid = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  for (const channel of ['nivra-updates:check', 'nivra-updates:download', 'nivra-updates:install', 'nivra-updates:get-state']) {
    const handler = handlers.get(channel); assert.equal(typeof handler, 'function');
    await assert.rejects(handler({ sender: {}, senderFrame: valid.senderFrame }), /Untrusted IPC sender/);
    await assert.rejects(handler({ sender: valid.sender, senderFrame: { url: valid.senderFrame.url } }), /Untrusted IPC sender/);
    await assert.rejects(handler(valid, { url: 'https://attacker.test', file: 'C:\\bad.exe' }), /UPDATE_INVALID_MANIFEST/);
  }
  assert.deepEqual(calls, []);
  await handlers.get('nivra-updates:check')(valid);
  assert.deepEqual(calls, ['checkForUpdate']);
  valid.senderFrame.url = 'https://attacker.test';
  await assert.rejects(handlers.get('nivra-updates:install')(valid), /Untrusted IPC sender/);
});

test('only the explicit install IPC schedules normal exit, and native errors remain sanitized', async () => {
  const { handlers, calls, timers, window, manager } = await mainFixture();
  const valid = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  await handlers.get('nivra-updates:download')(valid);
  assert.equal(timers.length, 0); assert.equal(calls.includes('quit'), false);
  assert.deepEqual(json(await handlers.get('nivra-updates:install')(valid)), { status: 'installing' });
  assert.equal(timers.length, 1); assert.equal(calls.includes('quit'), false);
  timers[0](); assert.equal(calls.includes('quit'), true);
  manager.checkForUpdate = async () => { throw new Error('private path and network diagnostics'); };
  await assert.rejects(handlers.get('nivra-updates:check')(valid), error => error.message === 'UPDATE_NETWORK');
});

test('the native launcher uses a verified executable directly and update events require the local entry', async () => {
  const { calls, window, updateOptions, spawnCalls } = await mainFixture();
  const file = 'C:\\Nivra-Test-Profile\\updates\\Nivra-4.1.0-Setup.exe';
  await updateOptions.launchInstaller(file);
  assert.equal(spawnCalls[0][0], file); assert.deepEqual(json(spawnCalls[0][1]), []);
  assert.deepEqual(json(spawnCalls[0][2]), { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  updateOptions.onState({ phase: 'ready', progress: 100 });
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'event' && call[1] === 'nivra-updates:state'));
  const eventCount = calls.filter(Array.isArray).length;
  window.webContents.mainFrame.url = 'https://foreign.test';
  updateOptions.onState({ phase: 'ready', progress: 100 });
  assert.equal(calls.filter(Array.isArray).length, eventCount);
});
