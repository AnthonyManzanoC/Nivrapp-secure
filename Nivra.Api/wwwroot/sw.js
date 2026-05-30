const CACHE_NAME = "nivra-shell-v7";
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
  const data = payload.data || payload;
  const title = payload.title || notification.title || "Nivra";
  const body = payload.body || notification.body || "Nuevo evento privado";
  const isCall = isIncomingCallData(data);

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/assets/icon-192.png",
      badge: "/assets/icon-192.png",
      tag: data.tag || data.conversationId || "nivra-event",
      data,
      requireInteraction: isCall,
      actions: isCall
        ? [
            { action: "accept", title: "Contestar" },
            { action: "decline", title: "Rechazar" }
          ]
        : []
    })
  );
});

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

function isFreshShellAsset(pathname) {
  return pathname === "/app.js" ||
    pathname === "/styles.css" ||
    pathname === "/native-config.js" ||
    pathname === "/firebase-messaging-sw.js" ||
    pathname === "/sw.js";
}

function isIncomingCallData(data = {}) {
  const type = String(data.type || data.Type || "").toLowerCase();
  return Boolean(data.callId || data.CallId) && type !== "missed-call" && (type.includes("call") || type === "");
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
