const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');

function workerHarness({ visible = true, existing = true, acknowledge = true, active = 'alice', scopes, records = [] } = {}) {
  const handlers = new Map(); const posted = []; const shown = []; const opened = []; const saved = new Map();
  let focused = 0;
  const windowClient = {
    focused: visible, visibilityState: visible ? 'visible' : 'hidden',
    focus: async () => { focused++; },
    postMessage: (message, ports) => {
      posted.push(JSON.parse(JSON.stringify(message)));
      if (acknowledge && ports?.[0]) { ports[0].postMessage({ handled: true }); ports[0].close(); }
      else ports?.[0]?.close();
    },
  };
  const clients = {
    matchAll: async () => existing ? [windowClient] : [], claim: async () => undefined,
    openWindow: async route => opened.push(route),
  };
  const self = {
    clients, addEventListener: (name, handler) => handlers.set(name, handler), skipWaiting: async () => undefined,
    registration: { showNotification: async (title, options) => shown.push({ title, ...JSON.parse(JSON.stringify(options)) }) },
  };
  const state = { scopes: scopes || ['alice', 'bob'].map(userId => ({ userId, deviceId: `browser-${userId}` })), activeUserId: active, activeDeviceId: `browser-${active}` };
  const context = vm.createContext({ self, clients, state, saved, records,
    importScripts: () => { throw new Error('Offline worker fixture'); },
    console, TextEncoder, TextDecoder, Uint8Array, atob, MessageChannel, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../nivra-app/src/firebase-messaging-sw.js'), 'utf8'), context);
  vm.runInContext(`readPushState = async () => state;
    writePushState = async (key, value) => saved.set(key, JSON.parse(JSON.stringify(value)));
    markPendingWipe = async data => saved.set('pendingWipes', [{userId:data.recipientUserId,deviceId:data.recipientDeviceId}]);
    idbOpen = async () => ({close(){}}); idbGetAll = async () => records;`, context);
  async function dispatch(name, data) {
    let complete;
    handlers.get(name)({ ...data, waitUntil: promise => { complete = promise; } });
    await complete;
  }
  return { posted, shown, opened, saved, focused: () => focused, dispatch, context };
}
const privateMessage = { type: 'message', nivraWebPush: '1', conversationId: 'private-chat', recipientUserId: 'alice', recipientDeviceId: 'browser-alice' };
const receive = data => ({ data: { json: () => ({ data }) } });

test('matching visible tab acknowledgement suppresses only its own OS notice', async () => {
  const worker = workerHarness();
  await worker.dispatch('push', receive(privateMessage));
  assert.deepEqual(worker.posted, [{ type: 'nivra.push.received', intent: 'receive', data: privateMessage }]);
  assert.equal(worker.focused(), 0); assert.deepEqual(worker.opened, []); assert.deepEqual(worker.shown, []);
});

test('a visible tab for the other account cannot swallow its background notice', async () => {
  const worker = workerHarness({ active: 'bob', acknowledge: false });
  await worker.dispatch('push', receive({ ...privateMessage, type: 'incoming_call' }));
  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].body, 'Llamada entrante');
  assert.deepEqual(worker.shown[0].actions, []);
  assert.equal(worker.shown[0].data.recipientUserId, 'alice');
  assert.equal(worker.focused(), 0);
});

test('unregistered or incomplete scopes are rejected without forwarding or displaying', async () => {
  const worker = workerHarness({ scopes: [{ userId: 'bob', deviceId: 'browser-bob' }] });
  await worker.dispatch('push', receive(privateMessage));
  await worker.dispatch('push', receive({ ...privateMessage, recipientDeviceId: '' }));
  assert.deepEqual(worker.posted, []); assert.deepEqual(worker.shown, []);
});

test('network payload cannot supply routing or call actions', async () => {
  const worker = workerHarness();
  await worker.dispatch('push', receive({ ...privateMessage, nivraRouteIntent: 'tap', action: 'accept' }));
  assert.equal(worker.posted[0].intent, 'receive');
  assert.equal(worker.posted[0].data.nivraRouteIntent, undefined);
  assert.equal(worker.posted[0].data.action, undefined);
  assert.equal(worker.focused(), 0);
});

test('notification click durably preserves recipient before focusing an existing window', async () => {
  const worker = workerHarness(); let closed = false;
  await worker.dispatch('notificationclick', { notification: { data: privateMessage, close: () => { closed = true; } } });
  assert.equal(closed, true); assert.equal(worker.focused(), 1);
  const clicked = { ...privateMessage, nivraRouteIntent: 'tap' };
  assert.deepEqual(JSON.parse(JSON.stringify(worker.saved.get('pendingClick'))), clicked);
  assert.deepEqual(worker.posted, [{ type: 'nivra.push', intent: 'click', data: clicked }]);
});

test('cold notification click retains recipient and enters a neutral route for account adoption', async () => {
  const worker = workerHarness({ existing: false, visible: false });
  await worker.dispatch('push', receive(privateMessage));
  assert.equal(worker.shown.length, 1); assert.deepEqual(worker.opened, []);
  await worker.dispatch('notificationclick', { notification: { data: worker.shown[0].data, close() {} } });
  assert.deepEqual(worker.opened, ['/app/chats?pushIntent=1']);
  assert.equal(worker.saved.get('pendingClick').recipientDeviceId, 'browser-alice');
});

test('FORCE_WIPE persists exact pending owner and stays silent', async () => {
  const worker = workerHarness({ existing: false });
  await worker.dispatch('push', receive({ ...privateMessage, type: 'force_wipe', code: 'FORCE_WIPE' }));
  assert.deepEqual(JSON.parse(JSON.stringify(worker.saved.get('pendingWipes'))), [{ userId: 'alice', deviceId: 'browser-alice' }]);
  assert.deepEqual(worker.shown, []);
});

test('preview selection uses both verified owner and device, never latest global or ownerless alias', async () => {
  const exact = { userId: 'alice', deviceId: 'browser-alice', privateJwk: { d: 'a' }, publicJwk: {}, updatedAt: '2020' };
  const worker = workerHarness({ records: [exact,
    { userId: 'bob', deviceId: 'browser-bob', privateJwk: { d: 'b' }, publicJwk: {}, updatedAt: '2026' },
    { alias: 'alice', deviceId: 'browser-alice', privateJwk: { d: 'legacy' }, publicJwk: {}, updatedAt: '2027' }] });
  worker.context.fixtureData = privateMessage;
  const selected = await vm.runInContext('recipientDeviceKey(fixtureData)', worker.context);
  assert.equal(selected.privateJwk.d, 'a');
});
