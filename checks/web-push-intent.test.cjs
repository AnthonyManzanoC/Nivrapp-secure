const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function workerHarness({ visible = true, existing = true } = {}) {
  const handlers = new Map();
  const posted = [];
  const shown = [];
  const opened = [];
  let focused = 0;
  const windowClient = {
    focused: visible, visibilityState: visible ? 'visible' : 'hidden',
    focus: async () => { focused++; },
    postMessage: message => posted.push(JSON.parse(JSON.stringify(message))),
  };
  const clients = {
    matchAll: async () => existing ? [windowClient] : [],
    claim: async () => undefined,
    openWindow: async route => opened.push(route),
  };
  const self = {
    clients,
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: async () => undefined,
    registration: { showNotification: async (title, options) => shown.push({ title, ...JSON.parse(JSON.stringify(options)) }) },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../nivra-app/src/firebase-messaging-sw.js'), 'utf8'), {
    self, clients,
    importScripts: () => { throw new Error('Offline worker fixture'); },
    console, TextEncoder, TextDecoder, Uint8Array, atob,
  });
  async function dispatch(name, data) {
    let complete;
    handlers.get(name)({ ...data, waitUntil: promise => { complete = promise; } });
    await complete;
  }
  return { posted, shown, opened, focused: () => focused, dispatch };
}

const privateMessage = { type: 'message', nivraWebPush: '1', conversationId: 'private-chat', recipientUserId: 'alice', recipientDeviceId: 'browser-alice' };

test('visible Web Push reception forwards receipt without opening a chat', async () => {
  const worker = workerHarness();
  await worker.dispatch('push', { data: { json: () => ({ data: privateMessage }) } });
  assert.deepEqual(worker.posted, [{ type: 'nivra.push.received', intent: 'receive', data: privateMessage }]);
  // The 5.0.1 foreground handler navigates only for its old `nivra.push` type.
  assert.notEqual(worker.posted[0].type, 'nivra.push');
  assert.equal(worker.focused(), 0);
  assert.deepEqual(worker.opened, []);
  assert.deepEqual(worker.shown, []);
});

test('a network payload cannot supply a notification click marker', async () => {
  const worker = workerHarness();
  await worker.dispatch('push', { data: { json: () => ({ data: { ...privateMessage, nivraRouteIntent: 'tap' } }) } });
  assert.equal(worker.posted[0].intent, 'receive');
  assert.equal(worker.posted[0].data.nivraRouteIntent, undefined);
  assert.equal(worker.focused(), 0);
});

test('an actual notification click focuses the existing window and forwards navigation intent', async () => {
  const worker = workerHarness();
  let closed = false;
  await worker.dispatch('notificationclick', { notification: { data: privateMessage, close: () => { closed = true; } } });
  assert.equal(closed, true);
  assert.equal(worker.focused(), 1);
  assert.deepEqual(worker.posted, [{ type: 'nivra.push', intent: 'click', data: { ...privateMessage, nivraRouteIntent: 'tap' } }]);
  assert.deepEqual(worker.opened, []);
});

test('background reception displays a notice and opens a new chat only after notification click', async () => {
  const worker = workerHarness({ existing: false, visible: false });
  await worker.dispatch('push', { data: { json: () => ({ data: privateMessage }) } });
  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].data.nivraRouteIntent, undefined);
  assert.deepEqual(worker.opened, []);
  await worker.dispatch('notificationclick', { notification: { data: worker.shown[0].data, close: () => undefined } });
  assert.deepEqual(worker.opened, ['/app/chats/private-chat']);
});
