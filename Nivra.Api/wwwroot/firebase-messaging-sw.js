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
      const isCall = isIncomingCallData(data);
      self.registration.showNotification(notification.title || "Nivra", {
        body: notification.body || (isCall ? "Llamada entrante" : "Nuevo evento privado"),
        icon: "/assets/icon-192.png",
        badge: "/assets/icon-192.png",
        tag: data.tag || data.conversationId || data.callId || "nivra-event",
        data,
        requireInteraction: isCall,
        actions: isCall
          ? [
              { action: "accept", title: "Contestar" },
              { action: "decline", title: "Rechazar" }
            ]
          : []
      });
    });
  } catch (error) {
    console.warn("Firebase messaging worker could not initialize.", error);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action || "";
  const targetUrl = data.conversationId
    ? `/?conversationId=${encodeURIComponent(data.conversationId)}`
    : "/";

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

function isIncomingCallData(data = {}) {
  const type = String(data.type || data.Type || "").toLowerCase();
  return Boolean(data.callId || data.CallId) && type !== "missed-call" && (type.includes("call") || type === "");
}
