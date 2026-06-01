// Compatibility worker for Firebase Cloud Messaging background pushes.
// Nivra registers /sw.js as the main app service worker and passes that
// registration to FCM. This file is kept at the root because some browsers
// and Firebase tooling still look for firebase-messaging-sw.js by convention.
self.window = self;

try {
  importScripts("/native-config.js");
} catch {
  // The foreground app can still pass an explicit service worker registration.
}

const FIREBASE_SDK_VERSION = self.NIVRA_FIREBASE_SDK_VERSION || "12.14.0";
const FIREBASE_CONFIG = self.NIVRA_FIREBASE_CONFIG || null;

if (FIREBASE_CONFIG) {
  try {
    importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-compat.js`);
    importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-messaging-compat.js`);
    firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const data = normalizePushData(payload);
      if (isTerminalCallData(data)) {
        return closeCallNotifications(data);
      }
      const notification = payload?.notification || {};
      const title = data.title || notification.title || "Nivra";
      const body = data.body || notification.body || (isIncomingCallData(data) ? "Llamada entrante" : "Nuevo evento privado");
      return self.registration.showNotification(title, notificationOptions(body, data));
    });
  } catch (error) {
    console.warn("Firebase messaging worker could not initialize.", error);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action || "";
  if (isTerminalCallData(data)) {
    event.waitUntil(closeCallNotifications(data));
    return;
  }
  const targetUrl = pushTargetUrl(data, action);

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const client = clientList.find((item) => "focus" in item);
      if (client) {
        client.postMessage({ type: "nivra.push-click", data, action });
        return client.focus();
      }
      return clients.openWindow ? clients.openWindow(targetUrl) : undefined;
    })
  );
});

function normalizePushData(payload = {}) {
  const data = {
    ...(payload.data || {}),
    ...(payload.notification?.data || {}),
    ...(payload.webpush?.data || {})
  };
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || typeof value === "object" || data[key] !== undefined) continue;
    data[key] = String(value);
  }
  return data;
}

function notificationOptions(body, data = {}) {
  const isCall = isIncomingCallData(data);
  return {
    body,
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    tag: data.tag || data.conversationId || data.callId || "nivra-event",
    data,
    requireInteraction: isCall,
    renotify: isCall,
    silent: false,
    vibrate: isCall ? [320, 140, 320, 140, 480] : [80, 40, 80],
    timestamp: Date.now(),
    actions: isCall
      ? [
          { action: "accept", title: "Contestar" },
          { action: "decline", title: "Rechazar" }
        ]
      : []
  };
}

async function closeCallNotifications(data = {}) {
  const callId = data.callId || data.CallId || "";
  const tags = new Set([
    data.tag,
    data.Tag,
    callId ? `nivra-call-${callId}` : "",
    callId ? `nivra-missed-call-${callId}` : "",
    callId
  ].filter(Boolean).map(String));
  let notifications = await self.registration.getNotifications({ includeTriggered: true }).catch(() => null);
  if (!notifications) notifications = await self.registration.getNotifications().catch(() => []);
  notifications
    .filter((notification) => {
      const item = notification.data || {};
      const itemCallId = item.callId || item.CallId || "";
      return tags.has(notification.tag) || (callId && itemCallId === callId);
    })
    .forEach((notification) => notification.close());
}

function isTerminalCallData(data = {}) {
  const type = normalizePushType(data.type || data.Type);
  return Boolean(data.callId || data.CallId) && (type === "end-call" || type === "missed-call" || type === "call-ended");
}

function pushTargetUrl(data = {}, action = "") {
  const params = new URLSearchParams();
  if (data.conversationId) params.set("conversationId", data.conversationId);
  if (data.callId) params.set("callId", data.callId);
  if (data.callerId) params.set("callerId", data.callerId);
  if (data.callerUserId) params.set("callerUserId", data.callerUserId);
  if (data.callerName) params.set("callerName", data.callerName);
  if (data.callType) params.set("callType", data.callType);
  if (data.type) params.set("type", data.type);
  const view = pushTargetView(data);
  if (view) params.set("view", view);
  if (action) params.set("pushAction", action);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function pushTargetView(data = {}) {
  if (isTerminalCallData(data)) return "";
  const type = normalizePushType(data.type || data.Type);
  if (type.includes("story") || type.includes("friend")) return "world";
  if (type.includes("vault")) return "vault";
  if (type.includes("call")) return "calls";
  return "";
}

function isIncomingCallData(data = {}) {
  const type = normalizePushType(data.type || data.Type);
  return Boolean(data.callId || data.CallId) &&
    type !== "missed-call" &&
    type !== "end-call" &&
    type !== "call-ended" &&
    (type.includes("call") || type === "");
}

function normalizePushType(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}
