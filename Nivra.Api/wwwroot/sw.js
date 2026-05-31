const CACHE_NAME = "nivra-shell-v12";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/native-config.js",
  "/firebase-messaging-sw.js",
  "/vendor/signalr.min.js",
  "/vendor/qrcode-generator.js",
  "/vendor/html5-qrcode.min.js",
  "/manifest.webmanifest",
  "/assets/nivra-mark.svg",
  "/assets/icon-192.png",
  "/assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== location.origin || isLiveEndpoint(url.pathname)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html"))
    );
    return;
  }

  if (isFreshShellAsset(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      return cached || network.catch(() => caches.match("/index.html"));
    })
  );
});

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  const notification = payload.notification || payload.webpush?.notification || {};
  const data = normalizePushData(payload);
  if (isTerminalCallData(data)) {
    event.waitUntil(closeCallNotifications(data));
    return;
  }

  const title = data.title || payload.title || notification.title || "Nivra";
  const body = data.body || payload.body || notification.body || "Nuevo evento privado";

  event.waitUntil(
    self.registration.showNotification(title, notificationOptions(body, data, notification))
  );
});

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
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

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

function isFreshShellAsset(pathname) {
  return pathname === "/app.js" ||
    pathname === "/styles.css" ||
    pathname === "/native-config.js" ||
    pathname === "/firebase-messaging-sw.js" ||
    pathname === "/sw.js";
}

function notificationOptions(body, data = {}, notification = {}) {
  const isCall = isIncomingCallData(data);
  return {
    body,
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    tag: data.tag || data.conversationId || data.callId || "nivra-event",
    data,
    actions: isCall
      ? [
          { action: "accept", title: "Contestar" },
          { action: "decline", title: "Rechazar" }
        ]
      : (notification.actions || []),
    requireInteraction: isCall,
    renotify: isCall,
    silent: false,
    vibrate: isCall ? [320, 140, 320, 140, 480] : [80, 40, 80],
    timestamp: Date.now()
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
  const view = pushTargetView(data);
  if (view) params.set("view", view);
  if (action) params.set("pushAction", action);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function pushTargetView(data = {}) {
  const type = String(data.type || data.Type || "").toLowerCase();
  if (type.includes("story") || type.includes("friend")) return "world";
  if (type.includes("vault")) return "vault";
  if (type.includes("call")) return "calls";
  return "";
}

function isIncomingCallData(data = {}) {
  const normalized = normalizePushType(data.type || data.Type);
  return Boolean(data.callId || data.CallId) &&
    normalized !== "missed-call" &&
    normalized !== "end-call" &&
    normalized !== "call-ended" &&
    (normalized.includes("call") || normalized === "");
}

function normalizePushType(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

function isLiveEndpoint(pathname) {
  return pathname.startsWith("/api") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/me") ||
    pathname.startsWith("/devices") ||
    pathname.startsWith("/contacts") ||
    pathname.startsWith("/directory") ||
    pathname.startsWith("/friends") ||
    pathname.startsWith("/conversations") ||
    pathname.startsWith("/messages") ||
    pathname.startsWith("/files") ||
    pathname.startsWith("/vault") ||
    pathname.startsWith("/calls") ||
    pathname.startsWith("/privacy") ||
    pathname.startsWith("/sync") ||
    pathname.startsWith("/hubs") ||
    pathname.startsWith("/monetization") ||
    pathname.startsWith("/data");
}
