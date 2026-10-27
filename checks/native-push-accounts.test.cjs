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

test('inactive delivery offers only explicit scoped actions and never opens a full-screen UI on receipt', () => {
  const messaging = read('NivraMessagingService');
  assert.match(messaging, /if \(active && isAppInForeground\(\)\) return/);
  assert.match(messaging, /if \(active\) NivraNativePlugin\.showIncomingCallNotification\(this, data\);\s*else showNotification/);
  assert.match(messaging, /NivraOngoingCallService\.stopScopeCall/);
  assert.match(messaging, /openIntent\(remoteMessage, data, "accept", id\)/);
  assert.match(messaging, /openIntent\(remoteMessage, data, "decline", id\)/);
  const plugin = read('NivraNativePlugin');
  const handler = plugin.slice(plugin.indexOf('public static boolean handleCallIntent(Context'), plugin.indexOf('public static boolean handleShareIntent'));
  assert.doesNotMatch(handler, /mappedAction = "open";\s*JSObject route/);
  assert.doesNotMatch(handler, /notifyListeners\("nativeCallAction"/);
  assert.match(handler, /"answer"\.equals\(mappedAction\) \? "accept"/);
  assert.match(read('NivraIncomingCallActivity'), /else finish\(\); \/\/ A full-screen reception must never switch accounts/);
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
  const route = plugin.slice(plugin.indexOf('JSObject route = new JSObject()'), plugin.indexOf('public static boolean handleShareIntent'));
  assert.match(route, /"recipientUserId", "recipientDeviceId"/);
  assert.doesNotMatch(route, /"callerName"|"body"|"message"|"title"/);
  assert.match(route, /savePendingIntent\(context, route\)/);
  assert.match(route, /route\.put\("nivraIntentId", intentId\)/);
  assert.match(route, /notifyListeners\("nativePushIntent", event, true\)/);
  assert.match(read('MainActivity'), /handleCallIntent\(this, getIntent\(\)\)/);
  for (const method of ['syncPushRegistrations', 'getPendingPushAccountWipes', 'acknowledgePushAccountWipe', 'getPendingPushIntent', 'clearPendingPushIntent']) {
    assert.match(plugin, new RegExp(`public void ${method}\\(PluginCall call\\)`));
  }
});

test('exported call entry points require a private exact-command marker before dispatching actions', () => {
  const registry = read('NivraNativePushRegistration');
  assert.match(registry, /UUID\.randomUUID\(\)\.toString\(\)/);
  assert.match(registry, /callIntentMarkers/);
  assert.match(registry, /account\.optString\("notificationEpoch", account\.optString\("epoch"\)\)\.equals\(marker\.optString\("epoch"\)\)/);
  assert.match(registry, /prior == null \? UUID\.randomUUID\(\)\.toString\(\) : prior\.optString\("notificationEpoch", prior\.optString\("epoch"\)\)/);
  assert.match(read('NivraNotificationIntentPolicy'), /MessageDigest\.isEqual/);
  const plugin = read('NivraNativePlugin');
  const handler = plugin.slice(plugin.indexOf('public static boolean handleCallIntent(Context'), plugin.indexOf('public static boolean handleShareIntent'));
  assert.ok(handler.indexOf('acceptsCallIntent(context, intent)') < handler.indexOf('savePendingIntent(context, route)'));
  assert.doesNotMatch(handler, /route\.put\("nivraCallIntentMarker"/);
  assert.match(plugin, /signCallIntent\(context, intent\)/);
  assert.match(read('NivraMessagingService'), /signCallIntent\(this, intent\)/);
});

test('both native FCM and foreground call UI suppress caller-account echoes without dropping the callee account', () => {
  assert.match(read('NivraMessagingService'), /NivraNotificationIntentPolicy\.callerEcho\(data\.get\("recipientUserId"\)/);
  assert.match(read('NivraNativePlugin'), /NivraNotificationIntentPolicy\.callerEcho\(data\.get\("recipientUserId"\)/);
});
