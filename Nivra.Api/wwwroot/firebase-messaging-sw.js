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

const FIREBASE_SDK_VERSION = self.NIVRA_FIREBASE_SDK_VERSION || "10.13.2";
const FIREBASE_CONFIG = self.NIVRA_FIREBASE_CONFIG || null;

if (FIREBASE_CONFIG) {
  try {
    importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-compat.js`);
    importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-messaging-compat.js`);
    firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const data = payload?.data || {};
      const notification = payload?.notification || {};
      const title = notification.title || "Nivra";
      const body = notification.body || (isIncomingCallData(data) ? "Llamada entrante" : "Nuevo evento privado");
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

function pushTargetUrl(data = {}, action = "") {
  const params = new URLSearchParams();
  if (data.conversationId) params.set("conversationId", data.conversationId);
  if (data.callId) params.set("callId", data.callId);
  if (data.callerId) params.set("callerId", data.callerId);
  if (data.callerUserId) params.set("callerUserId", data.callerUserId);
  if (data.callerName) params.set("callerName", data.callerName);
  if (data.callType) params.set("callType", data.callType);
  if (data.type) params.set("type", data.type);
  if (action) params.set("pushAction", action);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function isIncomingCallData(data = {}) {
  const type = String(data.type || data.Type || "").toLowerCase();
  return Boolean(data.callId || data.CallId) && type !== "missed-call" && (type.includes("call") || type === "");
}
