self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = normalizeData(event.notification.data || {});
  data.nivraRouteIntent = 'tap';
  if (event.action) data.action = event.action;
  event.waitUntil((async () => {
    const state = await readPushState();
    if (!registeredScope(state, data)) return;
    await writePushState('pendingClick', data);
    const clientsList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clientsList.find((client) => 'focus' in client);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'nivra.push', intent: 'click', data });
      return;
    }
    // Protected registry adoption must finish before a recipient-specific route.
    await clients.openWindow('/app/chats?pushIntent=1');
  })());
});

self.addEventListener('push', (event) => {
  const payload = readStandardWebPushPayload(event);
  const data = normalizeData(payload?.data || payload || {});
  if (data.nivraWebPush !== '1') {
    return;
  }
  event.waitUntil(showNivraNotification(data).catch(() => undefined));
});

self.window = self;

try {
  importScripts('/native-config.js');
} catch {
  // The foreground app can still pass a service worker registration explicitly.
}

const FIREBASE_SDK_VERSION = self.NIVRA_FIREBASE_SDK_VERSION || '12.19.0';
const FIREBASE_CONFIG = self.NIVRA_FIREBASE_CONFIG || {
  apiKey: 'AIzaSyC4TZyBBy6Hj_2vgAngbuN8QD6ND48GEyg',
  authDomain: 'nivra-af67e.firebaseapp.com',
  projectId: 'nivra-af67e',
  storageBucket: 'nivra-af67e.firebasestorage.app',
  messagingSenderId: '1052459577646',
  appId: '1:1052459577646:web:104a77188d9e03b0b10abf',
  vapidKey: 'BI-QXrOQJ14bj9GWZ5_ZniwQ63HxBW1E2n0qOLCe-fHME72yyuXQz2nRdEjSqstpw7IQNOE9U8fx8l9tGrbYHBY'
};
FIREBASE_CONFIG.vapidKey = String(self.NIVRA_FIREBASE_VAPID_KEY || FIREBASE_CONFIG.vapidKey || '').trim();

try {
  importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-compat.js`);
  importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-messaging-compat.js`);

  firebase.initializeApp(FIREBASE_CONFIG);

  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const data = normalizeData(payload.data || {});
    return showNivraNotification(data).catch(() => undefined);
  });
} catch {
  // Standard Web Push must keep working even if Firebase's worker runtime is unavailable.
}

async function showNivraNotification(data) {
  delete data.nivraRouteIntent;
  delete data.action;
  const state = await readPushState();
  if (!registeredScope(state, data)) return;
  const clientsList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (normalizeType(data.type) === 'force-wipe' && data.code === 'FORCE_WIPE') {
    await markPendingWipe(data);
    for (const client of clientsList) client.postMessage({ type: 'nivra.push.received', intent: 'receive', data });
    return;
  }
  const visible = clientsList.filter(client => client.focused || client.visibilityState === 'visible');
  // B's visible tab cannot suppress A's notice. Require exact-scope acknowledgement.
  const acknowledged = await Promise.all(visible.map(client => deliverReceipt(client, data)));
  if (acknowledged.some(Boolean)) return;
  const visual = await visualForData(data, state);
  await self.registration.showNotification(visual.title, {
    body: visual.body, tag: visual.tag, data,
    icon: '/assets/icon/favicon.png', badge: '/assets/icon/favicon.png',
    requireInteraction: visual.requireInteraction,
    renotify: visual.requireInteraction,
    actions: visual.type === 'incoming-call' && activeScope(state, data)
      ? [{ action: 'accept', title: 'Contestar' }, { action: 'decline', title: 'Rechazar' }] : []
  });
}

function deliverReceipt(client, data) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 350);
    channel.port1.onmessage = event => {
      if (event.data?.handled !== true) return;
      clearTimeout(timer); channel.port1.close(); resolve(true);
    };
    client.postMessage({ type: 'nivra.push.received', intent: 'receive', data }, [channel.port2]);
  });
}

function registeredScope(state, data) {
  return Boolean(data.recipientUserId && data.recipientDeviceId && state?.scopes?.some(scope =>
    scope.userId === data.recipientUserId && scope.deviceId === data.recipientDeviceId));
}

function activeScope(state, data) {
  return state?.activeUserId === data.recipientUserId && state?.activeDeviceId === data.recipientDeviceId;
}

async function readPushState() {
  const db = await pushStateDb();
  try { return await idbGet(db, 'state', 'saved'); } finally { db.close(); }
}

async function writePushState(key, value) {
  const db = await pushStateDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(value, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function markPendingWipe(data) {
  const db = await pushStateDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite'); const store = tx.objectStore('state');
      const request = store.get('pendingWipes');
      request.onsuccess = () => {
        const pending = Array.isArray(request.result) ? request.result : [];
        if (!pending.some(scope => scope.userId === data.recipientUserId && scope.deviceId === data.recipientDeviceId))
          pending.push({ userId: data.recipientUserId, deviceId: data.recipientDeviceId });
        store.put(pending, 'pendingWipes');
        const scopes = store.get('saved');
        scopes.onsuccess = () => {
          const state = scopes.result;
          if (!state) return;
          state.scopes = (state.scopes || []).filter(scope => scope.userId !== data.recipientUserId || scope.deviceId !== data.recipientDeviceId);
          if (activeScope(state, data)) { state.activeUserId = ''; state.activeDeviceId = ''; }
          store.put(state, 'saved');
        };
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

function pushStateDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('NivraPushScopes', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function visualForData(data, state) {
  const type = normalizeType(data.type);
  const tag = `${data.recipientUserId}:${data.recipientDeviceId}:${data.tag || data.callId || data.messageId || data.conversationId || 'nivra-event'}`;
  const scope = state.scopes.find(item => item.userId === data.recipientUserId && item.deviceId === data.recipientDeviceId);
  const preview = activeScope(state, data) && scope?.hideNotificationContent !== true
    ? await decryptPreviewIfPresent(data).catch(() => null) : null;
  if (preview) {
    return {
      title: preview.title || 'Nivra',
      body: preview.body || genericBody(type),
      tag,
      type,
      requireInteraction: type === 'incoming-call'
    };
  }
  return {
    title: 'Nivra',
    body: genericBody(type),
    tag,
    type,
    requireInteraction: type === 'incoming-call'
  };
}

function genericBody(type) {
  if (type === 'incoming-call') {
    return 'Llamada entrante';
  }
  if (type === 'missed-call') {
    return 'Llamada perdida';
  }
  if (type.includes('call')) {
    return 'Actualizacion de llamada';
  }
  if (type === 'message') {
    return 'Nuevo mensaje privado';
  }
  if (type === 'contact-joined') {
    return 'Un contacto de tu agenda se ha unido a Nivra.';
  }
  return 'Nueva actividad privada';
}

async function decryptPreviewIfPresent(data) {
  const header = data.previewHeader || data.notificationHeader || data.encryptedHeader;
  const ciphertext = data.previewCiphertext || data.notificationCiphertext || data.encryptedPreview;
  if (!header || !ciphertext) {
    return null;
  }
  const own = await recipientDeviceKey(data);
  if (!own?.privateJwk) {
    return null;
  }
  const meta = JSON.parse(header);
  if (!meta.senderPublicKey || !meta.iv) {
    return null;
  }
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    own.privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  );
  const senderPublic = await crypto.subtle.importKey(
    'jwk',
    meta.senderPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: senderPublic },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64bytes(meta.iv) },
    key,
    b64bytes(ciphertext)
  );
  const value = JSON.parse(new TextDecoder().decode(plain));
  return typeof value === 'object' && value ? value : null;
}

async function recipientDeviceKey(data) {
  const db = await idbOpen('NivraDB');
  const records = await idbGetAll(db, 'deviceKeys').catch(() => []);
  db.close();
  return records
    .filter((record) => record && record.userId === data.recipientUserId && record.deviceId === data.recipientDeviceId && record.privateJwk && record.publicJwk)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
}

function idbOpen(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function normalizeData(raw) {
  return Object.entries(raw || {}).reduce((data, entry) => {
    const key = entry[0];
    const value = entry[1];
    if (value !== undefined && value !== null) {
      data[key] = String(value);
    }
    return data;
  }, {});
}

function readStandardWebPushPayload(event) {
  if (!event.data) {
    return {};
  }
  try {
    return event.data.json();
  } catch {
    try {
      return JSON.parse(event.data.text());
    } catch {
      return {};
    }
  }
}

function normalizeType(type) {
  return String(type || '').replace(/_/g, '-').toLowerCase();
}

function b64bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
