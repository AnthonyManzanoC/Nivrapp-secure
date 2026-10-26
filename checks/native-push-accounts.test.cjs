const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const native = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'nivra', 'app');
const read = name => fs.readFileSync(path.join(native, `${name}.java`), 'utf8');

test('native account revocation retires a scope and persists a pending cleanup instead of destroying shared vaults', () => {
  const messaging = read('NivraMessagingService');
  assert.match(messaging, /retireForWipe\(this, data\)/);
  assert.doesNotMatch(messaging, /clearAllSecureSecrets|cancelAll\(/);
  const registry = read('NivraNativePushRegistration');
  const retirement = registry.slice(registry.indexOf('static synchronized void retireForWipe'), registry.indexOf('static synchronized JSONArray pendingWipes'));
  assert.match(retirement, /pending\.put\(new JSONObject\(\)\.put\("userId", user\)\.put\("deviceId", device\)\)/);
  assert.ok(retirement.indexOf('write(context, root)') < retirement.indexOf('clearNotifications(context, user, device)'));
  assert.doesNotMatch(retirement, /\.clear\(|deleteEntry|clearSecureSecret/);
  assert.match(registry, /indexOf\(root\.optJSONArray\("pendingWipes"\), user, device\) >= 0\) return null/);
});

test('renewal enumerates both encrypted accounts and checks each account generation independently', () => {
  const worker = read('NivraPushRegistrationWorker');
  assert.match(worker, /for \(JSONObject session : NivraNativePushRegistration\.readAll\(context\)\)/);
  assert.match(worker, /session\.optString\("pendingToken"\)/);
  assert.match(worker, /retry \|= renewAccount\(context, session, token\)/);
  const registry = read('NivraNativePushRegistration');
  assert.match(registry, /requested\.length\(\) > 2/);
  assert.match(registry, /Cipher\.getInstance\("AES\/GCM\/NoPadding"\)/);
  assert.match(registry, /find\(root\.optJSONArray\("accounts"\), snapshot\.optString\("userId"\), snapshot\.optString\("deviceId"\)\)/);
  assert.match(registry, /NivraPushScopePolicy\.currentSnapshot/);
  assert.match(registry, /enqueueRegistration\(context, ExistingWorkPolicy\.REPLACE\)/);
});

test('inactive delivery has no full-screen call or active-call side effect', () => {
  const messaging = read('NivraMessagingService');
  assert.match(messaging, /if \(active && isAppInForeground\(\)\) return/);
  assert.match(messaging, /if \(active\) NivraNativePlugin\.showIncomingCallNotification\(this, data\);\s*else showNotification/);
  assert.match(messaging, /NivraOngoingCallService\.stopScopeCall/);
  const plugin = read('NivraNativePlugin');
  assert.match(plugin, /if \(!active && !mappedAction\.isEmpty\(\)\) mappedAction = "open"/);
  assert.match(plugin, /if \(mappedAction\.isEmpty\(\) \|\| !active\) return true/);
});

test('message, call and action identities include the recipient account scope', () => {
  const messaging = read('NivraMessagingService');
  assert.match(messaging, /\.notify\(scopeTag\(data\), id, builder\.build\(\)\)/);
  assert.match(messaging, /intent\.setData\(Uri\.parse\("nivra:\/\/push\/" \+ Uri\.encode\(scopeTag\(data\)\)/);
  assert.match(read('NivraNativePlugin'), /\.notify\(NivraPushScopePolicy\.notificationTag\(data\.get\("recipientUserId"\), data\.get\("recipientDeviceId"\)\)/);
  assert.match(read('NivraCallPushPolicy'), /NivraPushScopePolicy\.callKey\(data\.get\("recipientUserId"\), data\.get\("recipientDeviceId"\), callId\)/);
});

test('cold and live push taps use a durable recipient-scoped metadata-only record', () => {
  const plugin = read('NivraNativePlugin');
  const route = plugin.slice(plugin.indexOf('JSObject route = new JSObject()'), plugin.indexOf('JSObject payload = callPayload(intent, mappedAction)'));
  assert.match(route, /"recipientUserId", "recipientDeviceId"/);
  assert.doesNotMatch(route, /"callerName"|"body"|"message"|"title"/);
  assert.match(route, /savePendingIntent\(context, route\)/);
  assert.match(route, /notifyListeners\("nativePushIntent", event, true\)/);
  assert.match(read('MainActivity'), /handleCallIntent\(this, getIntent\(\)\)/);
  for (const method of ['syncPushRegistrations', 'getPendingPushAccountWipes', 'acknowledgePushAccountWipe', 'getPendingPushIntent', 'clearPendingPushIntent']) {
    assert.match(plugin, new RegExp(`public void ${method}\\(PluginCall call\\)`));
  }
});
