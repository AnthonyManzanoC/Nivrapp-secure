const PLATFORM = detectPlatform();
const API_BASE_URL = resolveApiBaseUrl(PLATFORM);
const APP = document.querySelector("#app");
const TOAST = document.querySelector("#toast");
const TEXT = new TextEncoder();
const READ = new TextDecoder();
const LOCAL_DB_NAME = "NivraDB";
const LOCAL_DB_VERSION = 4;
const LOCAL_MESSAGE_STORE = "messages";
const LOCAL_KEY_STORE = "deviceKeys";
const LOCAL_PROFILE_STORE = "profilesStore";
const VIEW_ONCE_DELETE_DELAY_MS = 15000;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const SYSTEM_MISSED_CALL_POLICY = "system:missed-call";
const RINGTONE_SRC = "";
const QR_LOGIN_TTL_MS = 2 * 60 * 1000;
const SYNC_POLL_MS = 7000;
const SYNC_MIN_INTERVAL_MS = 1200;
const MESSAGE_PAGE_SIZE = 50;
const MESSAGE_BOTTOM_THRESHOLD_PX = 100;
const MESSAGE_SCROLL_DEBOUNCE_MS = 120;
const SEARCH_DEBOUNCE_MS = 600;
const SEARCH_MIN_CHARS = 2;
const MAIN_THREAD_YIELD_EVERY = 8;
const MESSAGE_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢"];
const STORY_REACTIONS = [
  { key: "heart", value: "\u2764\uFE0F" },
  { key: "laugh", value: "\uD83D\uDE02" },
  { key: "wow", value: "\uD83D\uDE2E" },
  { key: "sad", value: "\uD83D\uDE22" },
  { key: "fire", value: "\uD83D\uDD25" }
];
const LONG_PRESS_MS = 520;
const VOICE_NOTE_MIN_DURATION_MS = 500;
const PUSH_TOKEN_ENDPOINT = "/push-tokens";
const FIREBASE_SDK_VERSION = window.NIVRA_FIREBASE_SDK_VERSION || "10.13.2";

class LocalStore {
  constructor(dbName = LOCAL_DB_NAME, version = LOCAL_DB_VERSION) {
    this.dbName = dbName;
    this.version = version;
    this.dbPromise = null;
  }

  open() {
    if (!window.indexedDB?.open) return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null), 1800);
      let request;
      try {
        request = indexedDB.open(this.dbName, this.version);
      } catch {
        finish(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        const messageStore = db.objectStoreNames.contains(LOCAL_MESSAGE_STORE)
          ? request.transaction.objectStore(LOCAL_MESSAGE_STORE)
          : db.createObjectStore(LOCAL_MESSAGE_STORE, { keyPath: "key" });
        if (!messageStore.indexNames.contains("byAccount")) {
          messageStore.createIndex("byAccount", "accountKey");
        }
        if (!messageStore.indexNames.contains("byConversation")) {
          messageStore.createIndex("byConversation", ["accountKey", "conversationId"]);
        }
        if (!messageStore.indexNames.contains("byConversationAt")) {
          messageStore.createIndex("byConversationAt", ["accountKey", "conversationId", "at"]);
        }
        if (!messageStore.indexNames.contains("byExpiry")) {
          messageStore.createIndex("byExpiry", "expiresAtMs");
        }

        const keyStore = db.objectStoreNames.contains(LOCAL_KEY_STORE)
          ? request.transaction.objectStore(LOCAL_KEY_STORE)
          : db.createObjectStore(LOCAL_KEY_STORE, { keyPath: "id" });
        if (!keyStore.indexNames.contains("byAlias")) {
          keyStore.createIndex("byAlias", "aliasLower");
        }
        if (!keyStore.indexNames.contains("byUser")) {
          keyStore.createIndex("byUser", "userId");
        }
        if (!keyStore.indexNames.contains("byUpdated")) {
          keyStore.createIndex("byUpdated", "updatedAt");
        }

        const profileStore = db.objectStoreNames.contains(LOCAL_PROFILE_STORE)
          ? request.transaction.objectStore(LOCAL_PROFILE_STORE)
          : db.createObjectStore(LOCAL_PROFILE_STORE, { keyPath: "userId" });
        if (!profileStore.indexNames.contains("byAlias")) {
          profileStore.createIndex("byAlias", "aliasLower");
        }
        if (!profileStore.indexNames.contains("byUpdated")) {
          profileStore.createIndex("byUpdated", "updatedAt");
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    });
    return this.dbPromise;
  }

  async putMessage(accountKey, conversationId, message) {
    if (!accountKey || !conversationId || !message?.id) return;
    const db = await this.open();
    if (!db) return;
    const record = {
      ...message,
      key: messageStorageKey(accountKey, conversationId, message.id),
      accountKey,
      conversationId,
      expiresAtMs: messageExpiryMs(message),
      openedAtMs: message.openedAt ? Date.parse(message.openedAt) : null
    };
    await idbRequest(db.transaction(LOCAL_MESSAGE_STORE, "readwrite").objectStore(LOCAL_MESSAGE_STORE).put(record));
  }

  async removeMessage(accountKey, conversationId, messageId) {
    if (!accountKey || !conversationId || !messageId) return;
    const db = await this.open();
    if (!db) return;
    await idbRequest(db.transaction(LOCAL_MESSAGE_STORE, "readwrite").objectStore(LOCAL_MESSAGE_STORE).delete(messageStorageKey(accountKey, conversationId, messageId)));
  }

  async removeConversationMessages(accountKey, conversationId) {
    if (!accountKey || !conversationId) return;
    const db = await this.open();
    if (!db) return;
    const keyRange = IDBKeyRange.only([accountKey, conversationId]);
    const readStore = db.transaction(LOCAL_MESSAGE_STORE, "readonly").objectStore(LOCAL_MESSAGE_STORE);
    const keys = await idbRequest(readStore.index("byConversation").getAllKeys(keyRange));
    if (!keys?.length) return;
    const writeStore = db.transaction(LOCAL_MESSAGE_STORE, "readwrite").objectStore(LOCAL_MESSAGE_STORE);
    await Promise.all(keys.map((key) => idbRequest(writeStore.delete(key))));
  }

  async conversationMessages(accountKey, conversationId) {
    if (!accountKey || !conversationId) return [];
    const db = await this.open();
    if (!db) return [];
    const store = db.transaction(LOCAL_MESSAGE_STORE, "readonly").objectStore(LOCAL_MESSAGE_STORE);
    const records = await idbRequest(store.index("byConversation").getAll(IDBKeyRange.only([accountKey, conversationId])));
    return this.activeMessages(records);
  }

  async conversationMessagesPage(accountKey, conversationId, { before = null, limit = MESSAGE_PAGE_SIZE } = {}) {
    if (!accountKey || !conversationId) return [];
    const db = await this.open();
    if (!db) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || MESSAGE_PAGE_SIZE, 120));
    const store = db.transaction(LOCAL_MESSAGE_STORE, "readonly").objectStore(LOCAL_MESSAGE_STORE);
    if (!store.indexNames.contains("byConversationAt")) {
      const all = await idbRequest(store.index("byConversation").getAll(IDBKeyRange.only([accountKey, conversationId])));
      return this.sliceMessagesPage(all, before, safeLimit);
    }

    const upper = before || "\uffff";
    const range = IDBKeyRange.bound(
      [accountKey, conversationId, ""],
      [accountKey, conversationId, upper],
      false,
      Boolean(before)
    );
    const records = await idbCursorRecords(store.index("byConversationAt"), range, "prev", safeLimit);
    return this.activeMessages(records).sort(compareMessagesByTime);
  }

  async accountMessages(accountKey) {
    if (!accountKey) return [];
    const db = await this.open();
    if (!db) return [];
    const store = db.transaction(LOCAL_MESSAGE_STORE, "readonly").objectStore(LOCAL_MESSAGE_STORE);
    const records = await idbRequest(store.index("byAccount").getAll(accountKey));
    return this.activeMessages(records);
  }

  async purgeExpired(accountKey) {
    if (!accountKey) return [];
    const db = await this.open();
    if (!db) return [];
    const now = Date.now();
    const records = await idbRequest(db.transaction(LOCAL_MESSAGE_STORE, "readonly").objectStore(LOCAL_MESSAGE_STORE).getAll());
    const expired = (records || []).filter((record) => {
      if (record.accountKey !== accountKey) return false;
      return this.isExpired(record, now);
    });
    for (const record of expired) {
      await idbRequest(db.transaction(LOCAL_MESSAGE_STORE, "readwrite").objectStore(LOCAL_MESSAGE_STORE).delete(record.key));
    }
    return expired;
  }

  async putDeviceKeys(record) {
    if (!record?.alias || !record?.deviceId || !record?.privateJwk || !record?.publicJwk) return null;
    const db = await this.open();
    if (!db) return null;
    const now = new Date().toISOString();
    const normalized = {
      ...record,
      id: deviceKeyStorageId(record.alias, record.deviceId),
      aliasLower: normalizeAlias(record.alias),
      createdAt: record.createdAt || now,
      updatedAt: now
    };
    await idbRequest(db.transaction(LOCAL_KEY_STORE, "readwrite").objectStore(LOCAL_KEY_STORE).put(normalized));
    return normalized;
  }

  async getDeviceKeys(alias, deviceId) {
    if (!alias || !deviceId) return null;
    const db = await this.open();
    if (!db) return null;
    return idbRequest(db.transaction(LOCAL_KEY_STORE, "readonly").objectStore(LOCAL_KEY_STORE).get(deviceKeyStorageId(alias, deviceId)));
  }

  async latestDeviceKeysForAlias(alias) {
    if (!alias) return null;
    const db = await this.open();
    if (!db) return null;
    const store = db.transaction(LOCAL_KEY_STORE, "readonly").objectStore(LOCAL_KEY_STORE);
    const records = await idbRequest(store.index("byAlias").getAll(IDBKeyRange.only(normalizeAlias(alias))));
    return latestKeyRecord(records);
  }

  async latestDeviceKeys() {
    const db = await this.open();
    if (!db) return null;
    const records = await idbRequest(db.transaction(LOCAL_KEY_STORE, "readonly").objectStore(LOCAL_KEY_STORE).getAll());
    return latestKeyRecord(records);
  }

  async putProfile(profile) {
    const normalized = normalizeStoredProfile(profile);
    if (!normalized) return null;
    const db = await this.open();
    if (!db) return null;
    await idbRequest(db.transaction(LOCAL_PROFILE_STORE, "readwrite").objectStore(LOCAL_PROFILE_STORE).put(normalized));
    return normalized;
  }

  async putProfiles(profiles = []) {
    const normalized = profiles.map(normalizeStoredProfile).filter(Boolean);
    if (!normalized.length) return [];
    const db = await this.open();
    if (!db) return [];
    const store = db.transaction(LOCAL_PROFILE_STORE, "readwrite").objectStore(LOCAL_PROFILE_STORE);
    await Promise.all(normalized.map((profile) => idbRequest(store.put(profile))));
    return normalized;
  }

  async profiles(userIds = []) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const db = await this.open();
    if (!db) return [];
    const store = db.transaction(LOCAL_PROFILE_STORE, "readonly").objectStore(LOCAL_PROFILE_STORE);
    const records = await Promise.all(ids.map((id) => idbRequest(store.get(id))));
    return records.filter(Boolean);
  }

  activeMessages(records) {
    const now = Date.now();
    return (records || [])
      .filter((record) => !this.isExpired(record, now))
      .map(({ key, accountKey: _accountKey, expiresAtMs, openedAtMs, ...message }) => message);
  }

  sliceMessagesPage(records, before, limit) {
    const active = this.activeMessages(records).sort(compareMessagesByTime);
    const filtered = before
      ? active.filter((message) => compareMessageAt(message.at, before) < 0)
      : active;
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  isExpired(record, now) {
    const expired = record.expiresAtMs && record.expiresAtMs <= now;
    const openedOnce = record.deleteAfterRead && record.openedAtMs && record.openedAtMs + VIEW_ONCE_DELETE_DELAY_MS <= now;
    return Boolean(expired || openedOnce);
  }
}

const localStore = new LocalStore();
const callTones = {
  incoming: createLoopingAudio(0.86),
  outgoing: createLoopingAudio(0.38)
};
let fallbackTone = null;

const state = {
  auth: loadJson("nivra.auth"),
  view: "chats",
  mobileChatOpen: false,
  query: "",
  contactPanel: {
    tab: "mine",
    query: "",
    results: []
  },
  messagePolicy: {
    ttlSeconds: "default",
    deleteAfterRead: false
  },
  conversations: [],
  contacts: [],
  friendRequests: [],
  directoryResults: [],
  stories: [],
  devices: [],
  vaultItems: [],
  vaultRooms: [],
  privacy: null,
  entitlements: null,
  selectedConversationId: loadJson("nivra.selectedConversationId"),
  profileConversationId: null,
  modal: null,
  activeStory: null,
  vaultLobbyRoomId: null,
  vaultActiveRoomId: null,
  chatSearch: {
    mode: "alias",
    query: "",
    results: [],
    selectedIds: new Set()
  },
  vaultInvite: {
    roomId: null,
    query: "",
    results: [],
    selectedIds: new Set()
  },
  call: {
    current: null,
    phase: "idle",
    muted: false,
    cameraOff: false,
    speaker: true,
    localStream: null,
    peers: new Map(),
    remoteStreams: new Map(),
    remoteStates: new Map(),
    pendingSignals: [],
    startedAt: null
  },
  camera: {
    stream: null,
    recorder: null,
    chunks: [],
    recording: false,
    facingMode: "environment",
    discardRecording: false,
    viewOnce: true
  },
  voice: {
    stream: null,
    recorder: null,
    chunks: [],
    starting: false,
    recording: false,
    startedAt: null,
    recordingStartTime: null,
    stopRequested: false,
    discardRecording: false,
    justRecorded: false,
    timer: null,
    hintTimer: null,
    lastTouchAt: 0,
    sessionId: 0
  },
  drafts: {},
  pendingStoryFile: null,
  storyPublishing: false,
  storyResponse: {
    reaction: null,
    reactionsOpen: false,
    sending: false
  },
  typingByConversation: new Map(),
  typingStopTimer: null,
  lastTypingSentAt: 0,
  presenceByUserId: new Map(),
  readReceiptSentIds: new Set(),
  forwardPicker: {
    query: "",
    selectedIds: new Set(),
    busy: false
  },
  vaultMessages: new Map(),
  messages: new Map(),
  messagePaging: new Map(),
  mediaCache: new Map(),
  objectUrls: new Set(),
  seenMessageIds: new Set(loadJson("nivra.seen") || []),
  keyDirectory: new Map(),
  aliasByUserId: new Map(),
  profileByUserId: new Map(),
  archivedConversationIds: new Set(loadJson("nivra.archivedConversations") || []),
  replyTo: null,
  contextMenu: null,
  connection: null,
  polling: null,
  syncInFlight: false,
  lastSyncAt: 0,
  messageScrollTimer: null,
  realtimeReconnectTimer: null,
  pushReady: false,
  pushRegistering: false,
  pushListenersReady: false,
  retentionTimer: null,
  searchTimer: null,
  contactSearchTimer: null,
  chatSearchTimer: null,
  vaultInviteTimer: null,
  searchRequestSeq: 0,
  contactSearchRequestSeq: 0,
  chatSearchRequestSeq: 0,
  vaultInviteSearchRequestSeq: 0,
  lastRenderedView: null,
  qrLogin: null,
  qrScanner: {
    reader: null,
    stream: null,
    raf: null,
    busy: false,
    status: "Listo para escanear"
  },
  vault: {
    unlocked: false,
    key: null,
    decoded: new Map()
  }
};

let authRefreshPromise = null;
let qrLoginStartPromise = null;

function debounce(func, delay) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => func.apply(this, args), delay);
    return timer;
  };
}

const debouncedDirectorySearch = debounce(() => searchDirectory(), SEARCH_DEBOUNCE_MS);
const debouncedContactsPanelSearch = debounce(() => searchContactsPanel(), SEARCH_DEBOUNCE_MS);
const debouncedChatModalSearch = debounce(() => searchChatModal(), SEARCH_DEBOUNCE_MS);
const debouncedVaultInviteSearch = debounce(() => searchVaultInviteModal(), SEARCH_DEBOUNCE_MS);

document.documentElement.dataset.platform = PLATFORM.name;
window.addEventListener("beforeunload", revokeCachedMediaPreviews);

init().catch((error) => {
  console.error(error);
  toast("No se pudo iniciar Nivra.");
});

function detectPlatform() {
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  const userAgent = navigator.userAgent || "";
  const isHttp = protocol === "http:" || protocol === "https:";
  const isLocalhost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  const isCapacitor = Boolean(window.Capacitor) || protocol === "capacitor:" || protocol === "ionic:";
  const query = new URLSearchParams(window.location.search);
  const isElectron = query.has("electron") || (protocol === "file:" && /Electron/i.test(userAgent));
  const isAndroid = /Android/i.test(userAgent);

  return {
    name: isCapacitor ? "capacitor" : isElectron ? "electron" : protocol === "file:" ? "file" : "web",
    isHttp,
    isLocalhost,
    isCapacitor,
    isElectron,
    isAndroid,
    isFile: protocol === "file:"
  };
}

function resolveApiBaseUrl(platform) {
  const query = new URLSearchParams(window.location.search);
  const explicit = normalizeApiBaseUrl(
    query.get("apiBaseUrl") ||
    window.NIVRA_API_BASE_URL ||
    window.NIVRA_NATIVE_API_BASE_URL ||
    readStoredApiBaseUrl()
  );

  if (explicit) return explicit;
  if (platform.isHttp && !platform.isCapacitor) return window.location.origin;
  if (platform.isCapacitor && platform.isAndroid) return "http://10.0.2.2:5055";
  return "http://localhost:5055";
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function readStoredApiBaseUrl() {
  try {
    return localStorage.getItem("nivra.apiBaseUrl") || "";
  } catch {
    return "";
  }
}

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function syncShellClasses() {
  const chatPanelOpen = Boolean(
    state.auth?.tokens?.accessToken &&
    state.view === "chats" &&
    state.selectedConversationId &&
    state.mobileChatOpen
  );

  document.body.dataset.view = state.view;
  document.body.dataset.platform = PLATFORM.name;
  document.body.classList.toggle("chat-abierto", chatPanelOpen);
  document.body.classList.toggle("chat-open", chatPanelOpen);
}

async function init() {
  await localStore.open().catch(() => null);
  await migrateLegacyKeyMaterial().catch(() => {});
  applyLaunchParams();
  registerServiceWorker();
  listenForServiceWorkerMessages();
  setupConnectivityListeners();
  startLocalMessageRetention();
  render();
  if (state.auth?.tokens?.accessToken) {
    await bootstrap();
    await initializePushNotifications().catch(() => {});
    await connectRealtime();
    startPolling();
  }
}

function applyLaunchParams() {
  const conversationId = new URLSearchParams(window.location.search).get("conversationId");
  if (!conversationId) return;
  state.selectedConversationId = conversationId;
  state.mobileChatOpen = true;
  saveJson("nivra.selectedConversationId", conversationId);
}

function listenForServiceWorkerMessages() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "nivra.push-click") return;
    handlePushNavigation(event.data?.data || {})
      .catch(() => {})
      .finally(() => {
        syncPendingMessages("push-click", { force: true }).catch(() => {});
        render();
      });
  });
}

function setupConnectivityListeners() {
  window.addEventListener("online", () => {
    toast("Conexion recuperada. Sincronizando...");
    connectRealtime().catch(() => {});
    syncPendingMessages("online", { force: true }).catch(() => {});
  });
  window.addEventListener("offline", () => {
    toast("Sin conexion. Nivra guardara lo recibido localmente.");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.auth?.tokens?.accessToken) {
      connectRealtime().catch(() => {});
      syncPendingMessages("visible", { force: true }).catch(() => {});
    }
  });
}

function openLocalDb() {
  return localStore.open();
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbCursorRecords(source, range, direction, limit) {
  return new Promise((resolve, reject) => {
    const records = [];
    const request = source.openCursor(range, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || records.length >= limit) {
        resolve(records);
        return;
      }
      records.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

function normalizeAlias(alias = "") {
  return String(alias || "").trim().toLowerCase();
}

function normalizeStoredProfile(profile) {
  const userId = profile?.userId || profile?.id;
  if (!userId) return null;
  const alias = profile.alias || profile.userAlias || "";
  const now = new Date().toISOString();
  return {
    ...profile,
    id: userId,
    userId,
    alias,
    aliasLower: normalizeAlias(alias),
    displayName: profile.displayName || null,
    profilePhotoDataUrl: profile.profilePhotoDataUrl || null,
    bio: profile.bio || null,
    updatedAt: profile.updatedAt || profile.cachedAt || now,
    cachedAt: now
  };
}

function rememberProfile(profile, { persist = false } = {}) {
  const normalized = normalizeStoredProfile(profile);
  if (!normalized) return null;
  const previous = state.profileByUserId.get(normalized.userId) || {};
  const merged = { ...previous, ...normalized };
  state.profileByUserId.set(merged.userId, merged);
  if (merged.alias) state.aliasByUserId.set(merged.userId, merged.alias);
  if (persist) localStore.putProfile(merged).catch(() => {});
  return merged;
}

function rememberProfiles(profiles = [], options = {}) {
  return (profiles || []).map((profile) => rememberProfile(profile, options)).filter(Boolean);
}

function deviceKeyStorageId(alias, deviceId) {
  return `${normalizeAlias(alias)}:${deviceId}`;
}

function latestKeyRecord(records = []) {
  return [...(records || [])]
    .filter((record) => record?.privateJwk && record?.publicJwk)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0] || null;
}

function localAccountKey() {
  return state.auth?.user?.id && state.auth?.device?.id
    ? `${state.auth.user.id}:${state.auth.device.id}`
    : null;
}

function messageStorageKey(accountKey, conversationId, messageId) {
  return `${accountKey}:${conversationId}:${messageId}`;
}

function messageExpiryMs(message) {
  const value = message?.expiresAt ? Date.parse(message.expiresAt) : NaN;
  return Number.isFinite(value) ? value : null;
}

function compareMessageAt(left, right) {
  const leftTime = Date.parse(left || 0);
  const rightTime = Date.parse(right || 0);
  return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
}

function compareMessagesByTime(left, right) {
  return compareMessageAt(left?.at, right?.at);
}

async function persistLocalMessage(conversationId, message) {
  const accountKey = localAccountKey();
  if (!accountKey || !conversationId || !message?.id) return;
  await localStore.putMessage(accountKey, conversationId, message);
}

async function removeLocalMessage(conversationId, messageId) {
  const accountKey = localAccountKey();
  if (!accountKey || !conversationId || !messageId) return;
  await localStore.removeMessage(accountKey, conversationId, messageId);
}

function messagePagingState(conversationId) {
  if (!conversationId) return null;
  let paging = state.messagePaging.get(conversationId);
  if (!paging) {
    paging = { loading: false, exhausted: false, oldestAt: null };
    state.messagePaging.set(conversationId, paging);
  }
  return paging;
}

function updateConversationPaging(conversationId, messages) {
  const paging = messagePagingState(conversationId);
  if (!paging) return;
  const oldest = oldestLoadedMessageAt(conversationId);
  paging.oldestAt = oldest;
  if ((messages || []).length < MESSAGE_PAGE_SIZE) {
    paging.exhausted = true;
  }
}

function oldestLoadedMessageAt(conversationId) {
  const messages = state.messages.get(conversationId) || [];
  return messages[0]?.at || null;
}

async function loadLocalConversationMessages(conversationId, shouldRender = true) {
  const accountKey = localAccountKey();
  if (!accountKey || !conversationId) return;
  const messages = await localStore.conversationMessagesPage(accountKey, conversationId, { limit: MESSAGE_PAGE_SIZE });
  state.messages.set(conversationId, []);
  mergeConversationMessages(conversationId, messages);
  const paging = messagePagingState(conversationId);
  if (paging) {
    paging.loading = false;
    paging.exhausted = messages.length < MESSAGE_PAGE_SIZE;
    paging.oldestAt = oldestLoadedMessageAt(conversationId);
  }
  if (shouldRender && !renderConversationMessages(conversationId, { replace: true, scroll: "bottom" })) render();
}

async function loadLocalAccountMessages(shouldRender = true) {
  const accountKey = localAccountKey();
  if (!accountKey) return;
  if (!state.selectedConversationId) return;
  await loadLocalConversationMessages(state.selectedConversationId, shouldRender);
}

async function purgeLocalExpiredMessages({ renderAfter = false } = {}) {
  const accountKey = localAccountKey();
  if (!accountKey) return;
  const records = await localStore.purgeExpired(accountKey);
  let changed = false;
  for (const record of records || []) {
    const list = state.messages.get(record.conversationId) || [];
    const next = list.filter((message) => message.id !== record.id);
    if (next.length !== list.length) {
      state.messages.set(record.conversationId, next);
      changed = true;
    }
  }
  if (changed && renderAfter) renderConversationMessages(state.selectedConversationId, { replace: true });
}

function startLocalMessageRetention() {
  clearInterval(state.retentionTimer);
  state.retentionTimer = setInterval(() => {
    purgeLocalExpiredMessages({ renderAfter: true }).catch(() => {});
  }, 60000);
  purgeLocalExpiredMessages({ renderAfter: false }).catch(() => {});
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !["http:", "https:"].includes(window.location.protocol)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, { once: true });
}

async function bootstrap() {
  try {
    await loadLocalAccountMessages(false);
    if (state.selectedConversationId && state.messages.has(state.selectedConversationId)) {
      render();
    }
    const data = await request("/sync/bootstrap");
    state.conversations = data.conversations || [];
    state.contacts = data.contacts || [];
    state.friendRequests = data.friendRequests || [];
    state.stories = data.stories || [];
    state.devices = data.devices || [];
    state.privacy = data.privacySettings || data.privacy || data.user?.privacySettings || null;
    rememberProfile(state.auth.user, { persist: true });
    rememberProfiles(state.contacts, { persist: true });
    state.contacts.forEach((contact) => {
      state.aliasByUserId.set(contact.userId, contact.alias);
    });
    state.stories.forEach((story) => {
      if (story.owner?.id && story.owner?.alias) rememberProfile(story.owner, { persist: true });
    });
    state.entitlements = await request("/monetization/entitlements");
    state.vaultItems = data.vaultItems || [];
    state.vaultRooms = data.vaultRooms || [];
    state.vaultRooms.forEach((room) => {
      if (room.owner?.id && room.owner?.alias) rememberProfile(room.owner, { persist: true });
      (room.members || []).forEach((member) => rememberProfile(member, { persist: true }));
    });
    await hydrateConversationProfilesFromCache();
    if (state.selectedConversationId && !state.conversations.some((conversation) => conversation.id === state.selectedConversationId)) {
      selectConversation(null);
    }
    if (!state.selectedConversationId && state.conversations.length) {
      selectConversation(state.conversations[0].id);
    }
    if (state.selectedConversationId) {
      await loadLocalConversationMessages(state.selectedConversationId, false);
      render();
      await loadConversationHistory(state.selectedConversationId, false);
    }
    await refreshPresence();
    refreshConversationProfilesInBackground();
  } catch (error) {
    if (error.status === 401) {
      clearSession();
    } else {
      toast(error.message || "No se pudo sincronizar.");
    }
  }
  render();
}

function conversationParticipantUserIds() {
  return [...new Set(state.conversations
    .flatMap((conversation) => conversation.participants || [])
    .filter((participant) => participant.userId && participant.userId !== state.auth?.user?.id)
    .map((participant) => participant.userId))];
}

async function hydrateConversationProfilesFromCache() {
  const ids = conversationParticipantUserIds();
  if (!ids.length) return;
  const cached = await localStore.profiles(ids).catch(() => []);
  rememberProfiles(cached);
}

function refreshConversationProfilesInBackground() {
  const ids = conversationParticipantUserIds();
  if (!ids.length || !state.auth?.tokens?.accessToken) return;
  ids.forEach((userId) => {
    request(`/directory/users/${encodeURIComponent(userId)}`)
      .then((profile) => {
        const before = JSON.stringify(state.profileByUserId.get(userId) || {});
        const stored = rememberProfile(profile, { persist: true });
        if (stored && before !== JSON.stringify(stored)) {
          updateConversationProfileNodes(userId);
        }
      })
      .catch(() => {});
  });
}

function captureTransientInputs() {
  const active = document.activeElement;
  const snapshot = {
    activeId: active?.id || null,
    selectionStart: typeof active?.selectionStart === "number" ? active.selectionStart : null,
    selectionEnd: typeof active?.selectionEnd === "number" ? active.selectionEnd : null,
    scrollTop: active?.scrollTop || 0,
    messages: captureMessagesScroll()
  };
  document.querySelectorAll("input[id], textarea[id], select[id]").forEach((node) => {
    if (node.type === "file") return;
    state.drafts[node.id] = node.type === "checkbox" ? node.checked : node.value;
  });
  return snapshot;
}

function restoreTransientInputs(snapshot = {}) {
  document.querySelectorAll("input[id], textarea[id], select[id]").forEach((node) => {
    if (node.type === "file" || !(node.id in state.drafts)) return;
    if (node.type === "checkbox") {
      node.checked = Boolean(state.drafts[node.id]);
    } else if (node.value !== state.drafts[node.id]) {
      node.value = state.drafts[node.id] ?? "";
    }
  });

  restoreMessagesScroll(snapshot.messages);
  if (!snapshot.activeId) return;
  const active = document.getElementById(snapshot.activeId);
  if (!active || !isTextEntryElement(active)) return;
  const restoreFocus = () => {
    active.focus({ preventScroll: true });
    if (typeof active.setSelectionRange === "function" && snapshot.selectionStart !== null) {
      active.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart);
    }
    if (snapshot.scrollTop) active.scrollTop = snapshot.scrollTop;
  };
  restoreFocus();
  requestAnimationFrame(restoreFocus);
}

function captureMessagesScroll() {
  const node = document.querySelector("#messages");
  if (!node || !state.selectedConversationId) return null;
  return {
    conversationId: state.selectedConversationId,
    nearBottom: isNearMessagesBottom(node),
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight
  };
}

function restoreMessagesScroll(snapshot) {
  const node = document.querySelector("#messages");
  if (!node) return;
  if (!snapshot || snapshot.conversationId !== state.selectedConversationId) {
    scrollMessages({ force: true });
    return;
  }
  if (snapshot.nearBottom) {
    scrollMessages({ force: true });
    hideNewMessagesBadge();
    return;
  }
  const delta = Math.max(0, node.scrollHeight - snapshot.scrollHeight);
  node.scrollTop = Math.min(snapshot.scrollTop + delta, node.scrollHeight);
}

function setDraftValue(id, value) {
  if (!id) return;
  state.drafts[id] = value;
}

function clearDraftValue(id) {
  delete state.drafts[id];
}

function isTextEntryElement(node) {
  return node?.matches?.("input:not([type=file]):not([type=checkbox]), textarea, select");
}

function render() {
  const transient = captureTransientInputs();
  closeFloatingMenu();
  syncShellClasses();
  if (!state.auth?.tokens?.accessToken) {
    renderAuth();
    restoreTransientInputs(transient);
    cleanupObjectUrls({ keepVisible: false });
    state.lastRenderedView = null;
    return;
  }

  APP.innerHTML = `
    <div class="workspace">
      <nav class="rail" aria-label="Nivra">
        <img src="assets/nivra-mark.svg" alt="Nivra" class="rail-logo">
        ${navButton("chats", "message", "Chats")}
        ${navButton("world", "globe", "Mundo")}
        ${navButton("vault", "vault", "Boveda")}
        ${navButton("calls", "phone", "Llamadas")}
        ${navButton("privacy", "shield", "Privacidad")}
        <div class="nav-spacer"></div>
        ${navButton("account", "user", "Cuenta")}
      </nav>
      ${renderSidebar()}
      <main class="main">
        ${renderTopbar()}
        <section class="view">${renderMainView()}</section>
      </main>
    </div>
    <input id="fileInput" type="file" class="hidden" multiple>
    <input id="vaultFileInput" type="file" class="hidden">
    ${renderChatProfileDrawer()}
    ${renderCallLayer()}
    ${renderVoiceRecordingHud()}
    ${renderModalLayer()}
  `;

  bindAppEvents();
  restoreTransientInputs(transient);
  cleanupObjectUrls({ keepVisible: true });
  state.lastRenderedView = state.view;
}

function renderAuth() {
  const mode = defaultAuthMode();
  APP.innerHTML = `
    <div class="auth-shell" data-auth-default="${mode}">
      <section class="auth-panel">
        <div class="brand-row">
          <img src="assets/nivra-mark.svg" alt="">
          <div><strong>Nivra</strong><span>Private messenger and vault</span></div>
        </div>
        <h1>Tu espacio privado, simple y serio.</h1>
        <p class="auth-copy">Chats, archivos, llamadas y boveda en una experiencia rapida. El servidor guarda paquetes opacos; tu navegador prepara el contenido antes de enviarlo.</p>
        <div class="tabs">
          <button class="tab-btn ${mode === "login" ? "active" : ""}" data-auth-tab="login" type="button">Entrar</button>
          <button class="tab-btn ${mode === "register" ? "active" : ""}" data-auth-tab="register" type="button">Crear cuenta</button>
          <button class="tab-btn ${mode === "phone" ? "active" : ""}" data-auth-tab="phone" type="button">Telefono</button>
          <button class="tab-btn ${mode === "qr" ? "active" : ""}" data-auth-tab="qr" type="button">QR</button>
        </div>
        <form id="authForm" data-mode="${mode}">
          <div class="field auth-alias-field ${mode === "phone" || mode === "qr" ? "hidden" : ""}">
            <label for="alias">Alias</label>
            <input id="alias" class="input" autocomplete="username" placeholder="tu_alias" ${mode === "login" || mode === "register" ? "required" : ""}>
          </div>
          <div class="field auth-password-field ${mode === "phone" || mode === "qr" ? "hidden" : ""}">
            <label for="password">Password</label>
            <input id="password" class="input" type="password" autocomplete="current-password" placeholder="Minimo 10 caracteres" ${mode === "login" || mode === "register" ? "required" : ""}>
          </div>
          <div id="displayNameWrap" class="field ${mode === "register" ? "" : "hidden"}">
            <label for="displayName">Nombre visible</label>
            <input id="displayName" class="input" placeholder="Como te veran tus contactos">
          </div>
          <div id="phoneWrap" class="field ${mode === "phone" ? "" : "hidden"}">
            <label for="phoneLogin">Telefono</label>
            <div class="inline-field">
              <input id="phoneLogin" class="input" inputmode="tel" autocomplete="tel" placeholder="+57 300 000 0000">
              <button class="btn ghost" type="button" id="sendOtpBtn">Codigo</button>
            </div>
          </div>
          <div id="otpWrap" class="field ${mode === "phone" ? "" : "hidden"}">
            <label for="otpCode">Codigo</label>
            <input id="otpCode" class="input" inputmode="numeric" autocomplete="one-time-code" placeholder="000000">
          </div>
          <div id="qrLoginBox" class="qr-login-box ${mode === "qr" ? "" : "hidden"}">
            <div class="qr-frame" id="qrFrame">QR</div>
            <div>
              <strong id="qrCodeText">Listo para generar</strong>
              <span id="qrHint">Escanealo desde Cuenta -> Vincular dispositivo en un celular con sesion activa.</span>
            </div>
          </div>
          <div class="auth-actions">
            <button class="btn primary" type="submit">${authSubmitLabel(mode)}</button>
            <p class="hint">Nivra reutiliza la llave local cuando ya existe. El QR solo mueve un paquete cifrado entre tus dispositivos; el servidor no puede leerlo.</p>
          </div>
        </form>
      </section>
      <section class="auth-visual">
        <div class="product-card">
          <div class="trust-pill">Supabase + realtime + vault</div>
          <h2>Mensajeria privada con boveda integrada.</h2>
          <p>Una interfaz premium para conversar, guardar archivos sensibles, controlar privacidad por chat y sostener un modelo gratis con anuncios suaves sin leer mensajes.</p>
          <div class="phone-preview" aria-hidden="true">
            <div class="phone-head"><span>Nivra Secure</span><b>online</b></div>
            <div class="phone-chat">
              <div class="mini-bubble">Contrato recibido. Lo guardo en boveda.</div>
              <div class="mini-bubble mine">Archivo cifrado listo para descargar.</div>
              <div class="mini-row"><i></i><i></i><i></i></div>
            </div>
          </div>
          <div class="signal-strip">
            <div class="signal-item"><b>E2E ready</b><span>Paquetes opacos para el backend.</span></div>
            <div class="signal-item"><b>Vault</b><span>Metadata protegida por PIN local.</span></div>
            <div class="signal-item"><b>Realtime</b><span>SignalR con fallback de sincronizacion.</span></div>
          </div>
        </div>
      </section>
    </div>
  `;

  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      setAuthMode(button.dataset.authTab);
    });
  });

  document.querySelector("#authForm").addEventListener("submit", handleAuthSubmit);
  document.querySelector("#sendOtpBtn")?.addEventListener("click", startPhoneOtp);
  if (mode === "qr") {
    window.setTimeout(() => startQrLogin().catch((error) => toast(error.message || "No se pudo generar QR.")), 0);
  } else {
    stopQrLogin().catch(() => {});
  }
}

function defaultAuthMode() {
  if (state.qrLogin?.active && !isMobileViewport()) return "qr";
  return isMobileViewport() ? "phone" : "qr";
}

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 767px)")?.matches ?? window.innerWidth < 768;
}

function authSubmitLabel(mode) {
  return mode === "register" ? "Crear Nivra" : mode === "qr" ? "Regenerar QR" : mode === "phone" ? "Verificar codigo" : "Continuar";
}

function setAuthMode(mode) {
  document.querySelectorAll("[data-auth-tab]").forEach((tab) => tab.classList.toggle("active", tab.dataset.authTab === mode));
  const form = document.querySelector("#authForm");
  if (!form) return;
  form.dataset.mode = mode;
  document.querySelector("#displayNameWrap")?.classList.toggle("hidden", mode !== "register");
  document.querySelector("#phoneWrap")?.classList.toggle("hidden", mode !== "phone");
  document.querySelector("#otpWrap")?.classList.toggle("hidden", mode !== "phone");
  document.querySelector("#qrLoginBox")?.classList.toggle("hidden", mode !== "qr");
  document.querySelector(".auth-alias-field")?.classList.toggle("hidden", mode === "phone" || mode === "qr");
  document.querySelector(".auth-password-field")?.classList.toggle("hidden", mode === "phone" || mode === "qr");
  const alias = document.querySelector("#alias");
  const password = document.querySelector("#password");
  if (alias) alias.required = mode === "login" || mode === "register";
  if (password) password.required = mode === "login" || mode === "register";
  const submit = document.querySelector(".auth-actions .btn");
  if (submit) submit.textContent = authSubmitLabel(mode);
  if (mode === "qr") {
    startQrLogin().catch((error) => toast(error.message || "No se pudo generar QR."));
  } else {
    stopQrLogin().catch(() => {});
  }
}

function navButton(view, iconName, title) {
  return `<button class="nav-btn ${state.view === view ? "active" : ""}" data-view="${view}" title="${title}" aria-label="${title}">${icon(iconName)}<span>${title}</span></button>`;
}

function renderSidebar() {
  const title = {
    chats: "Chats",
    world: "Mundo",
    vault: "Boveda",
    calls: "Llamadas",
    privacy: "Privacidad",
    account: "Cuenta"
  }[state.view];

  const action = state.view === "chats"
    ? `<div class="side-actions">
        <button class="btn icon" id="contactsBtn" title="Contactos" aria-label="Contactos">${icon("user")}</button>
        <button class="btn icon" id="newChatBtn" title="Nuevo chat" aria-label="Nuevo chat">${icon("plus")}</button>
      </div>`
    : "";

  return `
    <aside class="sidebar">
      <div class="side-head">
        <div><h2>${title}</h2><span>${escapeHtml(state.auth.user.alias)} - ${escapeHtml(state.entitlements?.planCode || "free")}</span></div>
        ${action}
      </div>
      <div class="search-box">
        <input class="input" id="globalSearch" placeholder="${state.view === "world" ? "Buscar personas publicas" : "Buscar"}" value="${escapeAttr(state.query)}">
      </div>
      <div class="list">${renderSideList()}</div>
    </aside>
  `;
}

function renderSideList() {
  if (state.view === "chats") {
    const query = state.query.toLowerCase();
    const conversations = state.conversations.filter((conversation) => conversationTitle(conversation).toLowerCase().includes(query));
    if (!conversations.length) {
      const globalAction = query
        ? `<button class="btn ghost full" data-global-person-search="${escapeAttr(state.query)}">${icon("globe")}<span>Buscar "${escapeHtml(state.query)}" en la red global</span></button>`
        : `<button class="btn ghost full" id="contactsEmptyBtn">${icon("user")}<span>Ver contactos</span></button>`;
      return `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>${query ? "No esta en tus chats" : "Sin chats"}</h2><p>${query ? "El buscador de chats solo filtra conversaciones abiertas." : "Abre contactos o crea una conversacion nueva."}</p>${globalAction}</div>`;
    }
    const activeConversations = conversations.filter((conversation) => !state.archivedConversationIds.has(conversation.id));
    const archivedConversations = conversations.filter((conversation) => state.archivedConversationIds.has(conversation.id));
    const renderedConversations = [
      ...activeConversations.map((conversation) => renderConversationListItem(conversation)),
      archivedConversations.length && !query ? `<div class="side-section-title">Archivados</div>` : "",
      ...archivedConversations.map((conversation) => renderConversationListItem(conversation, { archived: true }))
    ].join("");
    const globalAction = query
      ? `<button class="quick-create" data-global-person-search="${escapeAttr(state.query)}">${icon("globe")}<span>Buscar "${escapeHtml(state.query)}" en la red global</span></button>`
      : "";
    return renderedConversations + globalAction;
  }

  if (state.view === "world") {
    const people = state.directoryResults.slice(0, 12);
    const incoming = state.friendRequests.filter((request) => request.status === "Pending" && request.to.id === state.auth.user.id);
    if (!people.length && !incoming.length) {
      return `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Mundo listo</h2><p>Busca personas publicas o publica una instantanea.</p></div>`;
    }
    return `
      ${incoming.length ? `<div class="side-section-title">Pendientes</div>${incoming.map(renderFriendRequestListItem).join("")}` : ""}
      ${people.length ? `<div class="side-section-title">Busquedas</div>${people.map(renderPersonListItem).join("")}` : ""}
    `;
  }

  if (state.view === "vault") {
    return state.vaultItems.length
      ? state.vaultItems.map((item) => `<div class="list-item"><div class="avatar">V</div><div><div class="item-title">${escapeHtml(item.kind)}</div><div class="item-sub">${formatTime(item.updatedAt)}</div></div></div>`).join("")
      : `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Boveda vacia</h2><p>Crea notas o guarda archivos cifrados desde un chat.</p></div>`;
  }

  if (state.view === "calls") {
    return `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Lista limpia</h2><p>Las llamadas se inician desde un chat o desde el panel principal.</p></div>`;
  }

  return `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Nivra</h2><p>Privacidad, cuenta y preferencias listas.</p></div>`;
}

function renderConversationListItem(conversation, { archived = false } = {}) {
  const title = conversationTitle(conversation);
  const person = conversationPrimaryPerson(conversation);
  const subtitle = conversationSubtitle(conversation, { archived });
  return `
    <div class="list-item conversation-item ${state.selectedConversationId === conversation.id ? "active" : ""} ${archived ? "archived" : ""}" data-open-conversation="${conversation.id}" role="button" tabindex="0">
      <div class="avatar-slot" data-conversation-avatar="${conversation.id}">${avatarNode(person || title)}</div>
      <div class="item-copy">
        <div class="item-title" data-conversation-title="${conversation.id}">${escapeHtml(title)}</div>
        <div class="item-sub" data-conversation-subtitle="${conversation.id}">${escapeHtml(subtitle)}</div>
      </div>
      <div class="item-trailing">
        <span class="badge">${conversation.participants?.length || 0}</span>
        <button class="btn icon subtle-menu chat-menu-button" data-chat-menu="${conversation.id}" title="Opciones del chat" aria-label="Opciones del chat">${icon("more")}</button>
      </div>
    </div>
  `;
}

function renderPersonListItem(person) {
  const userId = person.id || person.userId;
  return `
    <button class="list-item" data-start-chat-user="${userId}">
      ${avatarNode(person)}
      <div>
        <div class="item-title">${escapeHtml(displayPerson(person))}</div>
        <div class="item-sub">@${escapeHtml(person.alias)} - ${friendshipLabel(person.friendshipState)}</div>
      </div>
      <span class="badge">${person.isMutualContact ? "2" : person.isContact ? "1" : "+"}</span>
    </button>
  `;
}

function renderFriendRequestListItem(request) {
  const person = request.from.id === state.auth.user.id ? request.to : request.from;
  return `
    <div class="list-item">
      ${avatarNode(person)}
      <div>
        <div class="item-title">${escapeHtml(displayPerson(person))}</div>
        <div class="item-sub">${escapeHtml(request.status)} - @${escapeHtml(person.alias)}</div>
      </div>
    </div>
  `;
}

function renderTopbar() {
  const selected = selectedConversation();
  const title = state.view === "chats" && selected ? conversationTitle(selected) : viewTitle();
  const subtitle = state.view === "chats" && selected
    ? conversationTopbarSubtitle(selected)
    : "Nivra conectado a Supabase";
  const person = selected ? conversationPrimaryPerson(selected) : null;
  const titleNode = state.view === "chats" && selected
    ? `<button class="top-title top-title-button" id="openChatProfile" title="Ver perfil del chat" aria-label="Ver perfil del chat">
        <span class="avatar-slot" data-topbar-avatar="${selected.id}">${avatarNode(person || title)}</span>
        <div><h1 data-topbar-title="${selected.id}">${escapeHtml(title)}</h1><p data-topbar-subtitle="${selected.id}">${escapeHtml(subtitle)}</p></div>
      </button>`
    : `<div class="top-title"><div class="avatar">${initials(title)}</div><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div>`;

  const chatActions = state.view === "chats" && selected
    ? `<button class="btn icon" id="voiceCallBtn" title="Llamada de voz" aria-label="Llamada de voz">${icon("phone")}</button><button class="btn icon" id="videoCallBtn" title="Videollamada" aria-label="Videollamada">${icon("video")}</button><button class="btn icon subtle-menu" id="chatHeaderMenuBtn" data-chat-menu="${selected.id}" title="Opciones del chat" aria-label="Opciones del chat">${icon("more")}</button>`
    : "";
  const mobileBack = state.view === "chats" && selected
    ? `<button class="btn icon mobile-back" id="backToChatList" title="Volver a chats" aria-label="Volver a chats">${icon("x")}</button>`
    : "";

  return `
    <header class="topbar">
      ${mobileBack}${titleNode}
      <div class="top-actions">
        ${chatActions}
        <button class="btn ghost" id="syncBtn">${icon("sync")}<span>Sync</span></button>
      </div>
    </header>
  `;
}

function renderMainView() {
  if (state.view === "chats") return renderChatView();
  if (state.view === "world") return renderWorldView();
  if (state.view === "vault") return renderVaultView();
  if (state.view === "calls") return renderCallsView();
  if (state.view === "privacy") return renderPrivacyView();
  return renderAccountView();
}

function renderChatView() {
  const conversation = selectedConversation();
  if (!conversation) {
    return `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Elige o crea un chat</h2><p>Los mensajes se cifran en el cliente y viajan como paquetes opacos al backend.</p></div>`;
  }

  const messages = state.messages.get(conversation.id) || [];
  return `
    <div class="chat-view" data-chat-view style="position: relative;">
      <div class="messages" id="messages">
        ${messages.length ? messages.map(renderMessage).join("") : emptyChatHtml()}
      </div>
      <button class="badge" id="newMessagesBadge" type="button" hidden style="position: absolute; right: clamp(18px, 4vw, 52px); bottom: 98px; z-index: 6; border: 0; cursor: pointer; box-shadow: 0 14px 36px rgba(0,0,0,.28);">Mensajes nuevos</button>
      <div class="typing-strip" id="typingStrip">${escapeHtml(typingLabel(conversation.id))}</div>
      <div class="composer">
        <div class="reply-bar ${state.replyTo ? "show" : ""}" id="replyBar">
          <span>Respondiendo a: ${escapeHtml(state.replyTo?.preview || "")}</span>
          <button class="btn ghost" id="cancelReplyBtn">Cancelar</button>
        </div>
        <div class="composer-policy">
          <label>
            <span>Duracion</span>
            <select class="select compact" id="messageTtlSelect">
              <option value="default" ${state.messagePolicy.ttlSeconds === "default" ? "selected" : ""}>Predeterminada (${ttlLabel(state.privacy?.defaultMessageTtlSeconds)})</option>
              <option value="" ${state.messagePolicy.ttlSeconds === "" ? "selected" : ""}>Sin expiracion</option>
              <option value="3600" ${state.messagePolicy.ttlSeconds === "3600" ? "selected" : ""}>1 hora</option>
              <option value="86400" ${state.messagePolicy.ttlSeconds === "86400" ? "selected" : ""}>1 dia</option>
              <option value="604800" ${state.messagePolicy.ttlSeconds === "604800" ? "selected" : ""}>7 dias</option>
            </select>
          </label>
          <label class="check-row"><input type="checkbox" id="viewOnceToggle" ${state.messagePolicy.deleteAfterRead ? "checked" : ""}> Ver una vez</label>
        </div>
        <div class="composer-row">
          <button class="btn icon" id="attachBtn" title="Adjuntar" aria-label="Adjuntar">${icon("clip")}</button>
          <button class="btn icon voice-note-button ${state.voice.recording ? "recording" : ""}" id="voiceNoteBtn" title="Mantener para grabar nota de voz" aria-label="Nota de voz">${icon("mic")}</button>
          <textarea class="textarea" id="messageInput" placeholder="Mensaje privado. Usa @alias para mencionar."></textarea>
          <button class="btn primary send" id="sendBtn">${icon("send")}<span>Enviar</span></button>
        </div>
      </div>
    </div>
  `;
}

function renderMessage(message) {
  const payload = message.payload || {};
  const isDeleted = message.status === "eliminado" || payload.deleted;
  if (payload.type === "system") {
    const title = payload.title || (payload.event === "missed-call" ? "Llamada perdida" : "Aviso de sistema");
    const text = payload.text || "Evento de sistema";
    return `
      <article class="message system-message" data-message-id="${message.id}">
        <div class="system-message-body">
          ${icon(payload.event === "missed-call" ? "phone-off" : "shield")}
          <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>
        </div>
        <div class="message-meta"><span>${escapeHtml(message.senderAlias || "Nivra")}</span><span>${formatTime(message.at)}</span><span>sistema</span></div>
      </article>
    `;
  }
  if (message.deleteAfterRead && !message.mine && !message.openedAt) {
    return `
      <article class="message view-once" data-message-id="${message.id}">
        <div class="view-once-box">
          ${icon("shield")}
          <div><strong>Mensaje de una sola vez</strong><span>Se borrara de este dispositivo despues de abrirlo.</span></div>
          <button class="btn primary" data-open-view-once="${message.id}">Abrir</button>
        </div>
        <div class="message-meta"><span>${escapeHtml(message.senderAlias || "Contacto")}</span><span>${formatTime(message.at)}</span><span>privado</span></div>
      </article>
    `;
  }
  const text = messageDisplayText(payload);
  const reply = payload.replyTo ? `<div class="reply-chip">Respuesta a ${escapeHtml(payload.replyTo.preview || payload.replyTo.id || "mensaje")}</div>` : "";
  const storyReply = payload.type === "story-response"
    ? `<div class="story-reply-chip">${icon("globe")}<span>${escapeHtml(payload.storyPreview || "Respuesta a historia")}</span></div>`
    : "";
  const forwarded = payload.forwardedFrom ? `<div class="forwarded-chip">${icon("forward")}<span>Reenviado</span></div>` : "";
  const reactions = (message.reactions || []).map((item) => `<span class="reaction-pill">${escapeHtml(item)}</span>`).join("");
  const policy = messagePolicyLabel(message);
  const receipt = renderMessageReceipt(message);
  return `
    <article class="message ${message.mine ? "mine" : ""} ${isDeleted ? "deleted" : ""}" data-message-id="${message.id}">
      ${forwarded}
      ${reply}
      ${storyReply}
      <div class="${payload.type === "file" ? `file-bubble ${payload.voiceNote ? "voice-file" : ""}` : ""}">${payload.type === "file" ? `<span>${payload.voiceNote ? icon("mic") : fileTypeIcon(payload.mime)}</span><strong>${escapeHtml(text)}</strong><small>${escapeHtml(fileMetaLabel(payload))}</small>` : linkify(escapeHtml(text))}</div>
      ${payload.type === "file" ? renderFilePreview(payload, message.id) : ""}
      ${payload.type === "file" ? `<div class="message-actions"><button class="btn ghost" data-download-file="${payload.fileId}" ${fileDataAttributes(payload, message.id)}>Descargar</button></div>` : ""}
      ${reactions ? `<div class="message-reactions">${reactions}</div>` : ""}
      <div class="message-meta"><span>${message.mine ? "Tu" : escapeHtml(message.senderAlias || "Contacto")}</span><span>${formatTime(message.at)}</span>${receipt}${policy ? `<span>${escapeHtml(policy)}</span>` : ""}</div>
    </article>
  `;
}

function renderFilePreview(payload, messageId) {
  if (!payload?.fileId || !isPreviewableMime(payload.mime)) return "";
  const cached = state.mediaCache.get(payload.fileId);
  const mime = cached?.mime || payload.mime || "application/octet-stream";
  const name = cached?.name || payload.fileName || "adjunto cifrado";
  if (cached?.url) {
    if (mime.startsWith("image/")) {
      return `<div class="file-preview" data-preview-slot="${escapeAttr(payload.fileId)}"><img class="file-preview-image" data-media-preview="${escapeAttr(payload.fileId)}" src="${escapeAttr(cached.url)}" alt="${escapeAttr(name)}"></div>`;
    }
    if (mime.startsWith("video/")) {
      return `<div class="file-preview" data-preview-slot="${escapeAttr(payload.fileId)}"><video class="file-preview-video" data-media-preview="${escapeAttr(payload.fileId)}" src="${escapeAttr(cached.url)}" controls playsinline></video></div>`;
    }
    return `<div class="file-preview" data-preview-slot="${escapeAttr(payload.fileId)}"><audio class="file-preview-audio" data-media-preview="${escapeAttr(payload.fileId)}" src="${escapeAttr(cached.url)}" controls></audio></div>`;
  }

  const label = payload.voiceNote
    ? "Reproducir nota"
    : mime.startsWith("image/")
      ? "Ver imagen"
      : mime.startsWith("video/")
        ? "Ver video"
        : "Reproducir audio";
  const iconName = payload.voiceNote ? "play" : mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "music";
  return `
    <div class="file-preview file-preview-prompt" data-preview-slot="${escapeAttr(payload.fileId)}">
      <button class="btn ghost" data-preview-file="${escapeAttr(payload.fileId)}" ${fileDataAttributes(payload, messageId)}>
        ${icon(iconName)}<span>${label}</span>
      </button>
    </div>
  `;
}

function fileDataAttributes(payload, messageId = "") {
  return [
    `data-message-id="${escapeAttr(messageId)}"`,
    `data-file-key="${escapeAttr(payload.fileKey || "")}"`,
    `data-file-iv="${escapeAttr(payload.fileIv || "")}"`,
    `data-file-name="${escapeAttr(payload.fileName || "nivra-file.bin")}"`,
    `data-file-mime="${escapeAttr(payload.mime || "application/octet-stream")}"`
  ].join(" ");
}

function emptyChatHtml() {
  return `<div class="empty" data-empty-chat><img src="assets/nivra-mark.svg" alt=""><h2>Chat listo</h2><p>Escribe el primer mensaje, adjunta un archivo o inicia una llamada.</p></div>`;
}

function renderConversationMessages(conversationId, { replace = false, scroll = true } = {}) {
  if (!conversationId || conversationId !== state.selectedConversationId) return false;
  const container = document.querySelector("#messages");
  if (!container) return false;
  const messages = state.messages.get(conversationId) || [];
  const wasNearBottom = isNearMessagesBottom(container);
  const oldTop = container.scrollTop;
  const oldHeight = container.scrollHeight;
  if (replace) {
    container.replaceChildren();
    if (!messages.length) {
      container.insertAdjacentHTML("beforeend", emptyChatHtml());
    } else {
      for (const message of messages) {
        container.insertAdjacentHTML("beforeend", renderMessage(message));
      }
    }
    bindMessageGestureMenu();
    if (scroll === "bottom") {
      scrollMessages({ force: true });
    } else if (scroll && wasNearBottom) {
      scrollMessages({ force: true });
    } else if (scroll) {
      container.scrollTop = Math.min(oldTop + Math.max(0, container.scrollHeight - oldHeight), container.scrollHeight);
    }
    markVisibleMessagesRead(conversationId).catch(() => {});
    return true;
  }
  for (const message of messages) {
    upsertMessageNode(conversationId, message.id, { scroll: false });
  }
  if (scroll) smartScrollMessages(container, { wasNearBottom, conversationId });
  markVisibleMessagesRead(conversationId).catch(() => {});
  return true;
}

function upsertMessageNode(conversationId, messageId, { scroll = true } = {}) {
  if (!conversationId || conversationId !== state.selectedConversationId || !messageId) return false;
  const container = document.querySelector("#messages");
  if (!container) return false;
  const wasNearBottom = isNearMessagesBottom(container);
  const message = (state.messages.get(conversationId) || []).find((item) => item.id === messageId);
  if (!message) {
    const existing = container.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
    existing?.remove();
    if (!container.querySelector("[data-message-id]")) container.insertAdjacentHTML("beforeend", emptyChatHtml());
    return true;
  }
  container.querySelector("[data-empty-chat]")?.remove();
  const existing = container.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
  let appended = false;
  if (existing) {
    existing.insertAdjacentHTML("afterend", renderMessage(message));
    existing.remove();
  } else {
    const messages = state.messages.get(conversationId) || [];
    const index = messages.findIndex((item) => item.id === messageId);
    const next = messages.slice(index + 1).find((item) => container.querySelector(`[data-message-id="${cssEscape(item.id)}"]`));
    const nextNode = next ? container.querySelector(`[data-message-id="${cssEscape(next.id)}"]`) : null;
    if (nextNode) {
      nextNode.insertAdjacentHTML("beforebegin", renderMessage(message));
    } else {
      container.insertAdjacentHTML("beforeend", renderMessage(message));
      appended = true;
    }
  }
  if (scroll) smartScrollMessages(container, { wasNearBottom, conversationId, showBadge: appended });
  return true;
}

function removeMessageNode(conversationId, messageId) {
  if (!conversationId || conversationId !== state.selectedConversationId || !messageId) return false;
  const container = document.querySelector("#messages");
  if (!container) return false;
  container.querySelector(`[data-message-id="${cssEscape(messageId)}"]`)?.remove();
  if (!container.querySelector("[data-message-id]")) container.insertAdjacentHTML("beforeend", emptyChatHtml());
  return true;
}

async function loadOlderConversationMessages(conversationId) {
  if (!conversationId || conversationId !== state.selectedConversationId) return;
  const paging = messagePagingState(conversationId);
  const accountKey = localAccountKey();
  const before = paging?.oldestAt || oldestLoadedMessageAt(conversationId);
  if (!paging || paging.loading || paging.exhausted || !accountKey || !before) return;
  const container = document.querySelector("#messages");
  if (!container) return;
  paging.loading = true;
  try {
    const page = await localStore.conversationMessagesPage(accountKey, conversationId, { before, limit: MESSAGE_PAGE_SIZE });
    const loadedIds = new Set((state.messages.get(conversationId) || []).map((message) => message.id));
    const older = page.filter((message) => message?.id && !loadedIds.has(message.id));
    if (!older.length) {
      paging.exhausted = true;
      return;
    }
    mergeConversationMessages(conversationId, older);
    prependMessageNodes(conversationId, older);
    updateConversationPaging(conversationId, page);
    markVisibleMessagesRead(conversationId).catch(() => {});
  } catch (error) {
    console.warn("No se pudo cargar mas historial local.", error);
  } finally {
    paging.loading = false;
  }
}

function prependMessageNodes(conversationId, messages) {
  if (!conversationId || conversationId !== state.selectedConversationId || !messages?.length) return false;
  const container = document.querySelector("#messages");
  if (!container) return false;
  const oldHeight = container.scrollHeight;
  const oldTop = container.scrollTop;
  container.querySelector("[data-empty-chat]")?.remove();
  const fragment = document.createDocumentFragment();
  for (const message of [...messages].sort(compareMessagesByTime)) {
    fragment.appendChild(htmlToNode(renderMessage(message)));
  }
  const firstMessage = container.querySelector("[data-message-id]");
  container.insertBefore(fragment, firstMessage || null);
  container.scrollTop = container.scrollHeight - oldHeight + oldTop;
  bindMessageGestureMenu();
  return true;
}

function bindMessagesScrollLoader() {
  const container = document.querySelector("#messages");
  if (!container || container.dataset.scrollLoaderBound === "1") return;
  container.dataset.scrollLoaderBound = "1";
  container.addEventListener("scroll", () => {
    if (isNearMessagesBottom(container)) hideNewMessagesBadge();
    clearTimeout(state.messageScrollTimer);
    state.messageScrollTimer = setTimeout(() => {
      if (container.scrollTop <= 4) {
        loadOlderConversationMessages(state.selectedConversationId).catch(() => {});
      }
    }, MESSAGE_SCROLL_DEBOUNCE_MS);
  }, { passive: true });

  document.querySelector("#newMessagesBadge")?.addEventListener("click", () => {
    scrollMessages({ force: true });
    hideNewMessagesBadge();
    markVisibleMessagesRead(state.selectedConversationId).catch(() => {});
  });
}

function updateReplyBar() {
  const bar = document.querySelector("#replyBar");
  if (!bar) return;
  bar.classList.toggle("show", Boolean(state.replyTo));
  const label = bar.querySelector("span");
  if (label) label.textContent = state.replyTo ? `Respondiendo a: ${state.replyTo.preview || ""}` : "";
}

function bindMessageGestureMenu() {
  const container = document.querySelector("#messages");
  if (!container || container.dataset.gestureMenuBound === "1") return;
  container.dataset.gestureMenuBound = "1";
  let longPressTimer = null;
  let pressPoint = null;

  const clearLongPress = () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    pressPoint = null;
  };

  container.addEventListener("contextmenu", (event) => {
    const bubble = event.target.closest("[data-message-id]");
    if (!bubble || !container.contains(bubble)) return;
    event.preventDefault();
    openMessageContextMenu(bubble.dataset.messageId, { x: event.clientX, y: event.clientY });
  });

  container.addEventListener("pointerdown", (event) => {
    const bubble = event.target.closest("[data-message-id]");
    if (!bubble || !container.contains(bubble) || event.pointerType === "mouse") return;
    pressPoint = { x: event.clientX, y: event.clientY, messageId: bubble.dataset.messageId };
    longPressTimer = setTimeout(() => {
      if (!pressPoint) return;
      openMessageContextMenu(pressPoint.messageId, pressPoint);
      clearLongPress();
    }, LONG_PRESS_MS);
  });

  ["pointerup", "pointercancel", "pointerleave", "scroll"].forEach((eventName) => {
    container.addEventListener(eventName, clearLongPress, { passive: true });
  });
}

function openChatContextMenu(conversationId, anchor) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  const archived = state.archivedConversationIds.has(conversationId);
  openFloatingMenu({
    anchor,
    className: "chat-floating-menu",
    items: [
      { label: archived ? "Desarchivar" : "Archivar", iconName: "archive", action: () => toggleArchiveChat(conversationId) },
      { label: "Vaciar chat", iconName: "trash", action: () => clearChat(conversationId, "everyone"), danger: true },
      { label: "Eliminar para mi", iconName: "trash", action: () => deleteChat(conversationId, "me") },
      { label: "Eliminar para todos", iconName: "trash", action: () => deleteChat(conversationId, "everyone"), danger: true }
    ]
  });
}

function openMessageContextMenu(messageId, point) {
  const message = findMessage(messageId);
  if (!message) return;
  const deleted = message.status === "eliminado" || message.payload?.deleted;
  const forwardable = forwardAvailability(message).ok;
  openFloatingMenu({
    point,
    className: "message-floating-menu",
    reactions: deleted ? [] : MESSAGE_REACTION_EMOJIS.map((emoji) => ({
      label: emoji,
      action: () => sendReaction(messageId, emoji)
    })),
    items: [
      { label: "Responder", iconName: "reply", action: () => setReply(messageId), disabled: deleted },
      { label: "Reenviar", iconName: "forward", action: () => openForwardPicker(messageId), disabled: !forwardable },
      { label: "Eliminar para mi", iconName: "trash", action: () => deleteMessageForMe(messageId) },
      { label: "Eliminar para todos", iconName: "trash", action: () => deleteMessageForEveryone(messageId), danger: true, disabled: !message.mine || deleted }
    ]
  });
}

function openFloatingMenu({ anchor = null, point = null, className = "", reactions = [], items = [] }) {
  closeFloatingMenu();
  const menu = document.createElement("div");
  menu.className = `floating-menu ${className}`.trim();
  menu.setAttribute("role", "menu");

  if (reactions.length) {
    const reactionRow = document.createElement("div");
    reactionRow.className = "floating-reactions";
    reactions.forEach((reaction) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "floating-reaction";
      button.textContent = reaction.label;
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        closeFloatingMenu();
        await reaction.action?.();
      });
      reactionRow.appendChild(button);
    });
    menu.appendChild(reactionRow);
  }

  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `floating-menu-item ${item.danger ? "danger" : ""}`.trim();
    button.disabled = Boolean(item.disabled);
    button.innerHTML = `${item.iconName ? icon(item.iconName) : ""}<span>${escapeHtml(item.label)}</span>`;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      closeFloatingMenu();
      await item.action?.();
    });
    menu.appendChild(button);
  });

  document.body.appendChild(menu);
  const anchorRect = anchor?.getBoundingClientRect?.();
  const x = point?.x ?? anchorRect?.right ?? window.innerWidth / 2;
  const y = point?.y ?? anchorRect?.bottom ?? window.innerHeight / 2;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(10, Math.min(x, window.innerWidth - rect.width - 10));
  const top = Math.max(10, Math.min(y, window.innerHeight - rect.height - 10));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onPointerDown = (event) => {
    if (!menu.contains(event.target)) closeFloatingMenu();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closeFloatingMenu();
  };
  window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
  document.addEventListener("keydown", onKeyDown);
  state.contextMenu = { menu, onPointerDown, onKeyDown };
}

function closeFloatingMenu() {
  if (!state.contextMenu) return;
  document.removeEventListener("pointerdown", state.contextMenu.onPointerDown);
  document.removeEventListener("keydown", state.contextMenu.onKeyDown);
  state.contextMenu.menu?.remove();
  state.contextMenu = null;
}

function renderWorldView() {
  const incoming = state.friendRequests.filter((request) => request.status === "Pending" && request.to.id === state.auth.user.id);
  const outgoing = state.friendRequests.filter((request) => request.status === "Pending" && request.from.id === state.auth.user.id);
  const people = state.directoryResults.slice(0, 16);
  const stories = state.stories.slice(0, 24);
  const storyDraftText = state.drafts.storyText || "";
  const pendingMedia = state.pendingStoryFile;
  const storyPublishing = Boolean(state.storyPublishing);
  const publishLabel = storyPublishing ? (pendingMedia ? "Cifrando..." : "Publicando...") : "Publicar";

  return `
    <div class="panel-view">
      <div class="grid">
        <div class="card span-7">
          <div class="split">
            <h3>Instantaneas</h3>
            <select class="select compact" id="storyVisibility">
              <option value="PublicWorld">Mundo</option>
              <option value="MutualContacts">Mutuos</option>
              <option value="CloseFriends">Mejores amigos</option>
              <option value="SelectedUsers">Seleccionados</option>
            </select>
          </div>
          <form id="storyForm" class="stack">
            <textarea class="textarea" id="storyText" placeholder="Publica algo que expire">${escapeHtml(storyDraftText)}</textarea>
            <div class="story-compose-media">
              <button class="btn ghost" type="button" id="storyAttachBtn">${icon("clip")}<span>Foto, video o audio</span></button>
              <input class="hidden" id="storyMediaInput" type="file" accept="image/*,video/*,audio/*">
              ${pendingMedia ? `<span class="pill">${escapeHtml(pendingMedia.name)} - ${formatBytes(pendingMedia.size)}</span><button class="btn ghost" type="button" id="clearStoryMediaBtn">${icon("x")}<span>Quitar</span></button>` : ""}
            </div>
            <div class="row">
              <select class="select compact" id="storyDuration">
                <option value="3600">1 hora</option>
                <option value="86400" selected>24 horas</option>
                <option value="604800">7 dias</option>
              </select>
              <label class="check-row"><input type="checkbox" id="storyViewOnce"> Ver una vez</label>
              <button class="btn primary" type="button" id="storyPublishBtn" ${storyPublishing ? `disabled aria-busy="true"` : ""}>${storyPublishing ? `${icon("sync")}<span>${publishLabel}</span>` : publishLabel}</button>
            </div>
          </form>
        </div>
        <div class="card span-5">
          <h3>Amistades</h3>
          <div class="stack">
            ${incoming.length ? incoming.map(renderFriendRequestCard).join("") : `<p class="muted">No hay solicitudes pendientes.</p>`}
            ${outgoing.length ? `<p class="muted">${outgoing.length} solicitud(es) enviadas.</p>` : ""}
          </div>
        </div>
        <div class="card span-6">
          <h3>Personas</h3>
          <div class="stack">${people.length ? people.map(renderPersonCard).join("") : `<p class="muted">Escribe en el buscador para descubrir perfiles publicos.</p>`}</div>
        </div>
        <div class="card span-6">
          <h3>Mundo</h3>
          <div class="story-grid">${stories.length ? stories.map(renderStoryCard).join("") : `<p class="muted">Aun no hay instantaneas visibles.</p>`}</div>
        </div>
      </div>
    </div>
  `;
}

function renderPersonCard(person) {
  return `
    <div class="person-card">
      ${avatarNode(person, "profile-avatar")}
      <div>
        <strong>${escapeHtml(displayPerson(person))}</strong>
        <span>@${escapeHtml(person.alias)} ${person.bio ? "- " + escapeHtml(person.bio) : ""}</span>
      </div>
      <div class="row">
        <button class="btn ghost" data-start-chat-user="${person.id}">${icon("message")}<span>Chat</span></button>
        ${person.friendshipState === "none" ? `<button class="btn ghost" data-add-friend="${person.id}">${icon("user-plus")}<span>Agregar</span></button>` : `<span class="pill">${friendshipLabel(person.friendshipState)}</span>`}
      </div>
    </div>
  `;
}

function renderFriendRequestCard(request) {
  return `
    <div class="person-card">
      ${avatarNode(request.from, "profile-avatar")}
      <div>
        <strong>${escapeHtml(displayPerson(request.from))}</strong>
        <span>@${escapeHtml(request.from.alias)} ${request.message ? "- " + escapeHtml(request.message) : ""}</span>
      </div>
      <div class="row">
        <button class="btn primary" data-accept-friend="${request.id}">Aceptar</button>
        <button class="btn ghost" data-reject-friend="${request.id}">Rechazar</button>
      </div>
    </div>
  `;
}

function renderStoryCard(story) {
  const payload = decodeStoryPayload(story.encryptedPayload);
  const mediaLabel = payload.media ? fileTypeLabel(payload.media.mime) : null;
  return `
    <button class="story-card" data-view-story="${story.id}">
      <div class="story-head">
        ${avatarNode(story.owner)}
        <div><strong>${escapeHtml(displayPerson(story.owner))}</strong><span>${escapeHtml(story.visibility)} - ${formatTime(story.expiresAt)}</span></div>
      </div>
      <p>${escapeHtml(story.caption || payload.text || "Instantanea")}</p>
      <div class="story-meta"><span>${mediaLabel || (story.viewOnce ? "Una vez" : "Normal")}</span><span>${story.viewCount} vistas</span></div>
    </button>
  `;
}

function renderVaultView() {
  if (!state.vault.unlocked) {
    const hasVault = !!localStorage.getItem(vaultMetaKey());
    return `
      <div class="panel-view">
        <div class="grid">
          <div class="card span-7">
            <h3>${hasVault ? "Desbloquear boveda" : "Crear PIN de boveda"}</h3>
            <p>La metadata de la boveda se cifra en el navegador con una llave derivada de tu PIN local.</p>
            <form id="vaultPinForm" class="stack">
              <input class="input" id="vaultPin" type="password" inputmode="numeric" minlength="4" placeholder="PIN privado" required>
              <button class="btn primary">${hasVault ? "Desbloquear" : "Crear PIN"}</button>
            </form>
          </div>
          <div class="card span-5">
            <h3>Modo privado</h3>
            <p>Oculta previews, protege acceso local y mantiene los nombres sensibles fuera del servidor.</p>
            <div class="metric">Zero content</div>
          </div>
        </div>
      </div>
    `;
  }

  const activeRoom = state.vaultRooms.find((room) => room.id === state.vaultActiveRoomId);
  if (activeRoom) return renderVaultRoomWorkspace(activeRoom);

  const lobbyRoom = state.vaultRooms.find((room) => room.id === state.vaultLobbyRoomId);
  if (lobbyRoom) return renderVaultRoomLobby(lobbyRoom);

  const favoriteContacts = state.contacts.slice(0, 8);
  return `
    <div class="panel-view">
      <div class="grid">
        <div class="card span-5">
          <h3>Nueva nota privada</h3>
          <form id="vaultNoteForm" class="stack">
            <input class="input" id="vaultTitle" placeholder="Titulo">
            <textarea class="textarea" id="vaultBody" placeholder="Contenido sensible"></textarea>
            <button class="btn primary">Guardar en boveda</button>
          </form>
        </div>
        <div class="card span-7">
          <div class="split"><h3>Elementos</h3><button class="btn ghost" id="lockVaultBtn">Bloquear</button></div>
          <div class="stack" id="vaultList">${renderVaultItems()}</div>
        </div>
        <div class="card span-5">
          <h3>Boveda temporal</h3>
          <p>Configura una sala privada. Puedes invitar contactos, exigir PIN y elegir si se destruye al salir o por tiempo.</p>
          <form id="vaultRoomForm" class="stack">
            <input class="input" id="vaultRoomName" placeholder="Nombre de sala">
            <input class="input" id="vaultRoomPin" type="password" inputmode="numeric" placeholder="PIN de acceso">
            <select class="select" id="vaultRoomAccess">
              <option value="PinOnly">Cualquiera con PIN</option>
              <option value="InviteOnly">Solo invitados</option>
              <option value="WaitingRoom">Sala de espera</option>
            </select>
            <select class="select" id="vaultRoomRetention">
              <option value="BurnOnExit" selected>Se elimina al salir</option>
              <option value="ExpiresAfterTtl">Expira por tiempo</option>
              <option value="Persistent">Persistente manual</option>
            </select>
            <select class="select" id="vaultRoomTtl">
              <option value="900">15 minutos</option>
              <option value="3600" selected>1 hora</option>
              <option value="86400">24 horas</option>
            </select>
            <textarea class="textarea" id="vaultRoomWelcome" placeholder="Mensaje de lobby opcional"></textarea>
            ${favoriteContacts.length ? `<div class="vault-contact-picker">${favoriteContacts.map((contact) => `
              <label class="contact-chip">
                <input type="checkbox" name="vaultInviteContact" value="${contact.userId}">
                ${avatarNode(contact, "mini-avatar")}
                <span>${escapeHtml(displayPerson(contact))}</span>
              </label>
            `).join("")}</div>` : `<p class="muted">Agrega contactos desde Chats para invitarlos al crear.</p>`}
            <button class="btn primary">Crear sala</button>
          </form>
        </div>
        <div class="card span-7">
          <h3>Salas</h3>
          <div class="stack">${renderVaultRooms()}</div>
        </div>
      </div>
    </div>
  `;
}

function renderVaultItems() {
  if (!state.vaultItems.length) return `<p class="muted">Aun no hay elementos guardados.</p>`;
  return state.vaultItems.map((item) => {
    const meta = decryptVaultPreview(item.encryptedMetadata);
    return `<div class="card"><strong>${escapeHtml(meta.title || item.kind)}</strong><p>${escapeHtml(meta.body || "Elemento cifrado")}</p><span class="muted">${formatTime(item.updatedAt)}</span></div>`;
  }).join("");
}

function renderVaultRooms() {
  if (!state.vaultRooms.length) return `<p class="muted">Aun no hay salas compartidas.</p>`;
  return state.vaultRooms.map((room) => `
    <div class="person-card">
      <div class="avatar">B</div>
      <div>
        <strong>${escapeHtml(room.name)}</strong>
        <span>${vaultModeLabel(room.accessMode)} - ${vaultRetentionLabel(room.retentionMode)} - ${room.members?.length || 0} miembros</span>
      </div>
      <div class="row">
        <button class="btn primary" data-open-vault-room="${room.id}">Entrar</button>
        <button class="btn ghost" data-invite-vault-room="${room.id}">Invitar</button>
        <button class="btn danger" data-leave-vault-room="${room.id}">Salir</button>
      </div>
    </div>
  `).join("");
}

function renderVaultRoomLobby(room) {
  const isWaiting = currentVaultMember(room)?.status === "Waiting";
  return `
    <div class="panel-view">
      <div class="vault-lobby">
        <button class="btn ghost" id="backToVaultRooms">${icon("message")}<span>Volver</span></button>
        <div class="lobby-hero">
          <div class="avatar xl">B</div>
          <h2>${escapeHtml(room.name)}</h2>
          <p>${escapeHtml(room.encryptedWelcome || "Estas a punto de entrar a una boveda temporal. El contenido vive solo dentro de esta sala y puede cerrarse al salir o al expirar el tiempo.")}</p>
          <div class="lobby-rules">
            <span>${vaultModeLabel(room.accessMode)}</span>
            <span>${vaultRetentionLabel(room.retentionMode)}</span>
            <span>${room.expiresAt ? `Expira ${formatTime(room.expiresAt)}` : "Sin reloj visible"}</span>
          </div>
        </div>
        ${isWaiting ? `<div class="card"><h3>Solicitud enviada</h3><p>El propietario debe aprobar tu entrada antes de abrir la sala.</p></div>` : `
          <form id="vaultJoinForm" class="card stack">
            <h3>Entrar al lobby</h3>
            <input class="input" id="vaultJoinPin" type="password" inputmode="numeric" placeholder="PIN de la boveda">
            <button class="btn primary">Abrir boveda</button>
          </form>
        `}
      </div>
    </div>
  `;
}

function renderVaultRoomWorkspace(room) {
  const messages = state.vaultMessages.get(room.id) || [];
  return `
    <div class="chat-view vault-room-view">
      <div class="vault-room-header">
        <button class="btn ghost" id="closeVaultRoom">${icon("vault")}<span>Salir</span></button>
        <div>
          <h2>${escapeHtml(room.name)}</h2>
          <p>${vaultRetentionLabel(room.retentionMode)} - ${room.members?.filter((member) => member.status === "Active").length || 1} activos</p>
        </div>
        <button class="btn ghost" data-invite-vault-room="${room.id}">Invitar</button>
      </div>
      <div class="messages" id="vaultMessages">
        ${messages.length ? messages.map(renderVaultRoomMessage).join("") : `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Boveda abierta</h2><p>Envia texto, fotos, videos o archivos. Si alguien sale y la sala es temporal, el canal se cierra.</p></div>`}
      </div>
      <div class="composer">
        <div class="composer-row">
          <button class="btn icon" id="vaultAttachBtn" title="Adjuntar" aria-label="Adjuntar">${icon("clip")}</button>
          <textarea class="textarea" id="vaultMessageInput" placeholder="Mensaje efimero dentro de la boveda"></textarea>
          <button class="btn primary send" id="vaultSendBtn">${icon("send")}<span>Enviar</span></button>
        </div>
      </div>
    </div>
  `;
}

function renderVaultRoomMessage(message) {
  const payload = message.payload || {};
  const text = payload.type === "file"
    ? `${fileTypeLabel(payload.mime)}: ${payload.fileName || "adjunto"}`
    : payload.text || "Contenido efimero";
  return `
    <article class="message ${message.mine ? "mine" : ""}" data-message-id="${message.id}">
      <div class="${payload.type === "file" ? "file-bubble" : ""}">${payload.type === "file" ? `<span>${fileTypeIcon(payload.mime)}</span><strong>${escapeHtml(text)}</strong><small>${escapeHtml(fileMetaLabel(payload))}</small>` : escapeHtml(text)}</div>
      ${payload.type === "file" ? renderFilePreview(payload, message.id) : ""}
      ${payload.type === "file" ? `<div class="message-actions"><button class="btn ghost" data-download-file="${payload.fileId}" ${fileDataAttributes(payload, message.id)}>Descargar</button></div>` : ""}
      <div class="message-meta"><span>${message.mine ? "Tu" : escapeHtml(message.senderAlias || "Invitado")}</span><span>${formatTime(message.at)}</span><span>efimero</span></div>
    </article>
  `;
}

function renderChatProfileDrawer() {
  const conversation = state.conversations.find((item) => item.id === state.profileConversationId);
  if (!conversation) return "";
  const person = conversationPrimaryPerson(conversation);
  const title = conversationTitle(conversation);
  const participantIds = (conversation.participants || []).filter((participant) => !participant.removedAt).map((participant) => participant.userId);
  const stories = state.stories.filter((story) => participantIds.includes(story.owner?.id) && new Date(story.expiresAt) > new Date());
  const media = sharedMediaForConversation(conversation.id);
  const privacy = conversation.privacySettings || {};

  return `
    <aside class="profile-drawer show" aria-label="Perfil del chat">
      <div class="drawer-head">
        <button class="btn icon" id="closeChatProfile" title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
        <span>Info</span>
      </div>
      <section class="profile-hero">
        ${avatarNode(person || title, "profile-avatar huge")}
        <h2>${escapeHtml(title)}</h2>
        <p>${person?.alias ? "@" + escapeHtml(person.alias) : `${participantIds.length} participantes`}</p>
        ${person?.bio ? `<span>${escapeHtml(person.bio)}</span>` : ""}
      </section>
      <section class="drawer-section">
        <h3>Configuracion</h3>
        ${chatSettingRow("hideNotificationContent", "Silenciar previews", privacy.hideNotificationContent)}
        ${chatSettingRow("allowScreenshots", "Permitir capturas", privacy.allowScreenshots)}
        ${chatSettingRow("readReceipts", "Confirmaciones", privacy.readReceipts)}
      </section>
      <section class="drawer-section">
        <div class="split"><h3>Multimedia</h3><span class="muted">${media.length}</span></div>
        ${media.length ? `<div class="media-grid">${media.map(renderSharedMediaItem).join("")}</div>` : `<p class="muted">Aun no hay imagenes, videos o archivos visibles en este dispositivo.</p>`}
      </section>
      <section class="drawer-section">
        <div class="split"><h3>Instantaneas</h3><span class="muted">${stories.length}</span></div>
        ${stories.length ? `<div class="story-strip">${stories.map(renderStoryStripItem).join("")}</div>` : `<p class="muted">No hay instantaneas activas de este chat.</p>`}
      </section>
    </aside>
    <button class="drawer-scrim" id="profileScrim" aria-label="Cerrar perfil"></button>
  `;
}

function chatSettingRow(key, title, value) {
  return `
    <div class="switch-row compact">
      <div><strong>${title}</strong><span>${value ? "Activo" : "Inactivo"}</span></div>
      <button class="switch ${value ? "on" : ""}" data-chat-privacy="${key}" aria-label="${title}"></button>
    </div>
  `;
}

function renderSharedMediaItem(item) {
  return `
    <button class="media-tile" data-download-file="${item.fileId}" data-file-key="${item.fileKey}" data-file-iv="${item.fileIv}" data-file-name="${escapeAttr(item.fileName || "nivra-file.bin")}">
      <span>${fileTypeIcon(item.mime)}</span>
      <strong>${escapeHtml(fileTypeLabel(item.mime))}</strong>
      <small>${escapeHtml(item.fileName || "archivo cifrado")}</small>
    </button>
  `;
}

function renderStoryStripItem(story) {
  return `
    <button class="story-dot" data-view-story="${story.id}">
      ${avatarNode(story.owner, "mini-avatar")}
      <span>${escapeHtml(displayPerson(story.owner))}</span>
    </button>
  `;
}

function renderModalLayer() {
  if (state.activeStory) return renderStoryModal();
  if (!state.modal) return "";
  const modalType = typeof state.modal === "string" ? state.modal : state.modal.type;
  const contentByType = {
    newChat: renderNewChatModal,
    vaultInvite: renderVaultInviteModal,
    editMessage: renderEditMessageModal,
    forwardMessage: renderForwardMessageModal,
    deleteAccount: renderDeleteAccountModal,
    attachments: renderAttachmentModal,
    camera: renderCameraModal,
    contacts: renderContactsModal,
    qrScanner: renderQrScannerModal
  };
  const content = contentByType[modalType]?.() || "";
  if (!content) return "";
  return `<div class="modal-backdrop show"><div class="modal-shell">${content}</div></div>`;
}

function renderAttachmentModal() {
  return `
    <section class="modal command-modal attachment-modal">
      <div class="modal-head">
        <div><h3>Adjuntar</h3><p>Elige el tipo de archivo; se cifra antes de subir.</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <div class="attachment-grid">
        <button class="attachment-option" data-attach-picker="document">
          <span>${icon("file")}</span>
          <strong>Documento</strong>
          <small>PDF, ZIP, texto y otros archivos</small>
        </button>
        <button class="attachment-option" data-attach-picker="media">
          <span>${icon("image")}</span>
          <strong>Foto/Video</strong>
          <small>Galeria del dispositivo</small>
        </button>
        <button class="attachment-option" id="openCameraBtn">
          <span>${icon("camera")}</span>
          <strong>Camara</strong>
          <small>Tomar foto o grabar video</small>
        </button>
        <button class="attachment-option" data-attach-picker="audio">
          <span>${icon("music")}</span>
          <strong>Audio</strong>
          <small>Musica o notas guardadas</small>
        </button>
      </div>
    </section>
  `;
}

function renderCameraModal() {
  return `
    <section class="modal command-modal camera-modal">
      <div class="modal-head">
        <div><h3>Camara</h3><p>${state.camera.recording ? "Grabando video cifrado para este chat." : state.camera.viewOnce ? "Captura y envia como ver una vez." : "Captura una foto o video para enviarlo directo."}</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <div class="camera-preview">
        <video id="cameraPreview" autoplay playsinline muted></video>
        <div class="camera-status ${state.camera.recording ? "recording" : ""}">${state.camera.recording ? "Grabando" : "Vista previa"}</div>
      </div>
      <label class="check-row camera-view-once"><input type="checkbox" id="cameraViewOnceToggle" ${state.camera.viewOnce ? "checked" : ""}> Enviar como ver una vez</label>
      <div class="camera-actions">
        <button class="btn ghost" id="switchCameraBtn">${icon("sync")}<span>${state.camera.facingMode === "environment" ? "Trasera" : "Frontal"}</span></button>
        <button class="btn primary" id="capturePhotoBtn">${icon("camera")}<span>${state.camera.viewOnce ? "Foto 1 vez" : "Foto"}</span></button>
        <button class="btn ${state.camera.recording ? "danger" : "ghost"}" id="cameraRecordBtn">${icon(state.camera.recording ? "square" : "video")}<span>${state.camera.recording ? "Detener" : "Video"}</span></button>
      </div>
    </section>
  `;
}

function renderQrScannerModal() {
  return `
    <section class="modal command-modal qr-scanner-modal">
      <div class="modal-head">
        <div><h3>Vincular dispositivo</h3><p>${escapeHtml(state.qrScanner.status || "Apunta la camara al QR de la PC.")}</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <div class="qr-scanner-frame">
        <div id="qrScannerRegion"></div>
        <video id="qrScannerVideo" autoplay playsinline muted class="hidden"></video>
        <canvas id="qrScannerCanvas" class="hidden"></canvas>
        <div class="qr-scanner-reticle" aria-hidden="true"></div>
      </div>
      <div class="qr-scanner-actions">
        <input id="qrScanFileInput" class="hidden" type="file" accept="image/*">
        <button class="btn ghost" type="button" id="qrScanFileBtn">${icon("image")}<span>Imagen</span></button>
        <button class="btn primary" type="button" id="restartQrScannerBtn">${icon("sync")}<span>Reintentar</span></button>
      </div>
    </section>
  `;
}

function renderNewChatModal() {
  const mode = state.chatSearch.mode;
  const query = state.chatSearch.query;
  const results = state.chatSearch.results.filter((person) => (person.id || person.userId) !== state.auth.user.id);
  return `
    <section class="modal command-modal">
      <div class="modal-head">
        <div><h3>Nuevo chat</h3><p>Busca por alias, numero o arma un grupo.</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <div class="segmented">
        ${chatModeButton("alias", "Alias", mode)}
        ${chatModeButton("phone", "Numero", mode)}
        ${chatModeButton("group", "Grupo", mode)}
      </div>
      <input class="input command-search" id="chatModalSearch" value="${escapeAttr(query)}" placeholder="${mode === "phone" ? "Buscar por telefono publico" : mode === "group" ? "Buscar contactos para el grupo" : "Buscar @alias o nombre"}" autofocus>
      ${mode !== "group" && query ? `<button class="quick-create" id="createAliasChatBtn">${icon("send")}<span>Abrir chat con "${escapeHtml(query)}"</span></button>` : ""}
      <div class="modal-list">
        ${results.length ? results.map((person) => renderChatSearchResult(person, mode)).join("") : `<div class="empty compact"><img src="assets/nivra-mark.svg" alt=""><h2>Busca personas</h2><p>Respeta la configuracion publica de cada cuenta.</p></div>`}
      </div>
      ${mode === "group" ? `<button class="btn primary full" id="createGroupChatBtn" ${state.chatSearch.selectedIds.size ? "" : "disabled"}>Crear grupo (${state.chatSearch.selectedIds.size})</button>` : ""}
    </section>
  `;
}

function renderContactsModal() {
  const tab = state.contactPanel.tab;
  const query = state.contactPanel.query.trim().toLowerCase();
  const mine = state.contacts
    .filter((contact) => !query || displayPerson(contact).toLowerCase().includes(query) || contact.alias.toLowerCase().includes(query))
    .map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" }));
  const people = tab === "mine"
    ? mine
    : state.contactPanel.results.filter((person) => (person.id || person.userId) !== state.auth.user.id);
  return `
    <section class="modal command-modal contacts-modal">
      <div class="modal-head">
        <div><h3>Contactos</h3><p>${tab === "mine" ? "Libreta Nivra" : "Red global publica"}</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <div class="segmented two">
        <button class="segment ${tab === "mine" ? "active" : ""}" data-contact-tab="mine">Mis contactos</button>
        <button class="segment ${tab === "discover" ? "active" : ""}" data-contact-tab="discover">Descubrir</button>
      </div>
      <input class="input command-search" id="contactsSearch" value="${escapeAttr(state.contactPanel.query)}" placeholder="${tab === "mine" ? "Filtrar contactos" : "Buscar @alias o nombre publico"}" autofocus>
      <div class="modal-list">
        ${people.length ? people.map((person) => renderContactSearchResult(person, tab)).join("") : renderContactsEmpty(tab)}
      </div>
    </section>
  `;
}

function renderContactsEmpty(tab) {
  return tab === "mine"
    ? `<div class="empty compact"><img src="assets/nivra-mark.svg" alt=""><h2>Sin contactos visibles</h2><p>Cuando agregues personas, apareceran aqui separados de tus chats.</p></div>`
    : `<div class="empty compact"><img src="assets/nivra-mark.svg" alt=""><h2>Busca en Mundo</h2><p>Solo aparecen cuentas publicas o contactos permitidos por privacidad.</p></div>`;
}

function renderContactSearchResult(person, tab) {
  const userId = person.id || person.userId;
  const isContact = tab === "mine" || person.isContact || person.friendshipState === "friends";
  return `
    <div class="search-result">
      ${avatarNode(person, "profile-avatar")}
      <div>
        <strong>${escapeHtml(displayPerson(person))}</strong>
        <span>@${escapeHtml(person.alias)} - ${isContact ? "contacto" : friendshipLabel(person.friendshipState)}</span>
      </div>
      <div class="row">
        <button class="btn primary" data-start-chat-user="${userId}">${icon("message")}<span>Chat</span></button>
        ${isContact ? "" : `<button class="btn ghost" data-add-friend="${userId}">${icon("user-plus")}</button>`}
      </div>
    </div>
  `;
}

function chatModeButton(value, label, active) {
  return `<button class="segment ${active === value ? "active" : ""}" data-chat-mode="${value}">${label}</button>`;
}

function renderChatSearchResult(person, mode) {
  const userId = person.id || person.userId;
  const checked = state.chatSearch.selectedIds.has(userId);
  return `
    <div class="search-result ${checked ? "selected" : ""}">
      ${avatarNode(person, "profile-avatar")}
      <div>
        <strong>${escapeHtml(displayPerson(person))}</strong>
        <span>@${escapeHtml(person.alias)} - ${friendshipLabel(person.friendshipState)}</span>
      </div>
      ${mode === "group"
        ? `<button class="btn icon" data-toggle-group-user="${userId}" title="${checked ? "Quitar" : "Agregar"}" aria-label="${checked ? "Quitar" : "Agregar"}">${icon(checked ? "check" : "plus")}</button>`
        : `<div class="row"><button class="btn primary" data-start-chat-user="${userId}">${icon("message")}<span>Abrir</span></button>${person.friendshipState === "none" ? `<button class="btn ghost" data-add-friend="${userId}">${icon("user-plus")}</button>` : ""}</div>`}
    </div>
  `;
}

function renderVaultInviteModal() {
  const room = state.vaultRooms.find((item) => item.id === state.vaultInvite.roomId);
  const results = state.vaultInvite.results.filter((person) => (person.id || person.userId) !== state.auth.user.id);
  return `
    <section class="modal command-modal">
      <div class="modal-head">
        <div><h3>Invitar a boveda</h3><p>${room ? escapeHtml(room.name) : "Sala privada"}</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <input class="input command-search" id="vaultInviteSearch" value="${escapeAttr(state.vaultInvite.query)}" placeholder="Buscar contactos por alias, nombre o numero">
      <div class="modal-list">
        ${results.length ? results.map(renderVaultInviteResult).join("") : `<p class="muted">Busca o elige contactos para enviar invitacion.</p>`}
      </div>
      <button class="btn primary full" id="sendVaultInvitesBtn" ${state.vaultInvite.selectedIds.size ? "" : "disabled"}>Enviar invitaciones (${state.vaultInvite.selectedIds.size})</button>
    </section>
  `;
}

function renderVaultInviteResult(person) {
  const userId = person.id || person.userId;
  const checked = state.vaultInvite.selectedIds.has(userId);
  return `
    <button class="search-result as-button ${checked ? "selected" : ""}" data-toggle-vault-invite="${userId}">
      ${avatarNode(person, "profile-avatar")}
      <div>
        <strong>${escapeHtml(displayPerson(person))}</strong>
        <span>@${escapeHtml(person.alias)} - ${friendshipLabel(person.friendshipState)}</span>
      </div>
      <span class="badge">${checked ? "ok" : "+"}</span>
    </button>
  `;
}

function renderStoryModal() {
  const story = state.activeStory;
  const payload = story?.payload || decodeStoryPayload(story?.encryptedPayload);
  const media = payload?.media;
  const responseState = state.storyResponse || {};
  const selectedReaction = responseState.reaction;
  const responseBusy = Boolean(responseState.sending);
  const replyText = state.drafts.storyReplyInput || "";
  const reactionOptions = STORY_REACTIONS.map((item) => `
    <button class="story-reaction-option ${item.value === selectedReaction ? "selected" : ""}" type="button" data-story-reaction="${escapeAttr(item.key)}" aria-label="${escapeAttr(item.key)}">${escapeHtml(item.value)}</button>
  `).join("");
  const mediaHtml = media
    ? story.mediaUrl
      ? renderStoryMedia(story.mediaUrl, media, `story:${story.id}`)
      : `<div class="story-media-loading">${icon("sync")}<span>Cargando ${escapeHtml(fileTypeLabel(media.mime).toLowerCase())}</span></div>`
    : "";
  return `
    <div class="modal-backdrop show story-backdrop">
      <section class="story-viewer ${story.owner?.id !== state.auth.user.id ? "can-respond" : ""}">
        <div class="story-viewer-head">
          ${avatarNode(story.owner, "mini-avatar")}
          <div><strong>${escapeHtml(displayPerson(story.owner))}</strong><span>${formatTime(story.expiresAt)}</span></div>
          <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
        </div>
        <div class="story-viewer-body">
          ${mediaHtml}
          <p>${escapeHtml(payload?.text || story.text || story.caption || "Instantanea")}</p>
        </div>
        ${story.owner?.id !== state.auth.user.id ? `
          <div class="story-response-bar">
            <form id="storyReplyForm" class="story-reply-form">
              <input class="input" id="storyReplyInput" type="text" placeholder="Responder..." value="${escapeAttr(replyText)}" autocomplete="off" ${responseBusy ? "disabled" : ""}>
              <button class="btn icon story-reaction-toggle ${selectedReaction ? "active" : ""}" type="button" id="storyReactionToggle" aria-label="Reacciones rapidas" aria-expanded="${responseState.reactionsOpen ? "true" : "false"}" ${responseBusy ? "disabled" : ""}>${selectedReaction ? escapeHtml(selectedReaction) : "&hearts;"}</button>
              <button class="btn primary story-send-btn" type="submit" ${responseBusy ? `disabled aria-busy="true"` : ""}>${responseBusy ? `${icon("sync")}<span>Enviando...</span>` : `${icon("send")}<span>Enviar</span>`}</button>
              ${responseState.reactionsOpen ? `<div class="story-reaction-menu" role="menu" aria-label="Reacciones rapidas">${reactionOptions}</div>` : ""}
            </form>
          </div>
        ` : ""}
      </section>
    </div>
  `;
}

function renderEditMessageModal() {
  const message = findMessage(state.modal.messageId);
  return `
    <section class="modal command-modal">
      <div class="modal-head">
        <div><h3>Editar mensaje</h3><p>Actualiza el texto y se marcara como editado.</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <form id="editMessageForm" class="stack">
        <textarea class="textarea" id="editMessageText">${escapeHtml(state.modal.draft ?? message?.payload?.text ?? "")}</textarea>
        <button class="btn primary">Guardar cambio</button>
      </form>
    </section>
  `;
}

function renderForwardMessageModal() {
  const message = findMessage(state.modal.messageId);
  const conversations = forwardTargetConversations(state.modal.messageId);
  const selectedCount = state.forwardPicker.selectedIds.size;
  const preview = message?.payload?.type === "file"
    ? message.payload.fileName || "Adjunto cifrado"
    : message?.payload?.text || "Mensaje";
  return `
    <section class="modal command-modal forward-modal bottom-sheet">
      <div class="modal-head">
        <div><h3>Reenviar</h3><p>${escapeHtml(preview.slice(0, 120))}</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <input class="input command-search" id="forwardSearch" value="${escapeAttr(state.forwardPicker.query)}" placeholder="Buscar chats recientes" autofocus>
      <div class="modal-list">
        ${conversations.length ? conversations.map((conversation) => `
          <button class="search-result as-button ${state.forwardPicker.selectedIds.has(conversation.id) ? "selected" : ""}" data-toggle-forward="${conversation.id}">
            ${avatarNode(conversationPrimaryPerson(conversation) || conversationTitle(conversation), "mini-avatar")}
            <div><strong>${escapeHtml(conversationTitle(conversation))}</strong><span>${conversation.type === "Group" ? "Grupo privado" : "Chat directo"}</span></div>
            <span class="badge">${state.forwardPicker.selectedIds.has(conversation.id) ? "ok" : "+"}</span>
          </button>
        `).join("") : `<div class="empty compact"><img src="assets/nivra-mark.svg" alt=""><h2>Sin destino</h2><p>Crea otro chat para reenviar.</p></div>`}
      </div>
      <button class="btn primary full" id="sendForwardBtn" ${selectedCount && !state.forwardPicker.busy ? "" : "disabled"}>${state.forwardPicker.busy ? "Reenviando..." : `Enviar a ${selectedCount || 0}`}</button>
    </section>
  `;
}

function renderDeleteAccountModal() {
  return `
    <section class="modal command-modal">
      <div class="modal-head">
        <div><h3>Borrar cuenta</h3><p>Esta accion desactiva la cuenta y minimiza datos locales.</p></div>
        <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
      </div>
      <form id="deleteAccountForm" class="stack">
        <input class="input" id="deleteAccountConfirm" placeholder="Escribe DELETE para confirmar">
        <button class="btn danger">Confirmar borrado</button>
      </form>
    </section>
  `;
}

function renderCallLayer() {
  if (!state.call.current || state.call.phase === "idle") return "";
  const call = state.call.current;
  const isVideo = call.type === "Video";
  const isIncoming = state.call.phase === "incoming";
  const participants = callParticipants(call);
  const title = callTitle(call);
  const subtitle = callSubtitle(call);
  const status = callStatusText();
  return `
    <section class="call-layer ${isVideo ? "video" : "voice"} ${isIncoming ? "incoming" : ""}" aria-label="Llamada">
      <div class="call-shell">
        <div class="call-ambient"></div>
        <header class="call-header">
          <button class="btn ghost" id="minimizeCallBtn">${icon("message")}<span>Chat</span></button>
          <div>
            <strong data-call-status>${escapeHtml(status)}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <button class="btn danger" id="endCallTopBtn">${icon("phone-off")}<span>Colgar</span></button>
        </header>
        <div class="call-stage ${isVideo ? "video-stage" : "voice-stage"}">
          ${isVideo ? renderVideoCallStage(participants) : renderVoiceCallStage(participants, title)}
        </div>
        <footer class="call-controls">
          ${isIncoming ? `
            <button class="call-action accept" id="acceptCallBtn">${icon(isVideo ? "video" : "phone")}<span>Aceptar</span></button>
            <button class="call-action decline" id="declineCallBtn">${icon("phone-off")}<span>Rechazar</span></button>
          ` : `
            <button class="call-action ${state.call.muted ? "active" : ""}" id="toggleMuteBtn">${icon(state.call.muted ? "mic-off" : "mic")}<span>${state.call.muted ? "Silenciado" : "Micro"}</span></button>
            ${isVideo ? `<button class="call-action ${state.call.cameraOff ? "active" : ""}" id="toggleCameraBtn">${icon(state.call.cameraOff ? "video-off" : "video")}<span>${state.call.cameraOff ? "Camara off" : "Camara"}</span></button>` : ""}
            <button class="call-action ${state.call.speaker ? "active" : ""}" id="toggleSpeakerBtn">${icon("volume")}<span>Audio</span></button>
            <button class="call-action decline" id="endCallBtn">${icon("phone-off")}<span>Colgar</span></button>
          `}
        </footer>
      </div>
    </section>
  `;
}

function renderVoiceCallStage(participants, title) {
  const lead = participants.find((person) => person.id !== state.auth.user.id) || participants[0] || state.auth.user;
  return `
    <div class="voice-orbit">
      ${avatarNode(lead, "call-avatar giant")}
      <h2>${escapeHtml(title)}</h2>
      <p data-call-status>${escapeHtml(callStatusText())}</p>
      <div class="call-participants-row">${participants.map((person) => `
        <div class="call-mini-person">
          ${avatarNode(person, "mini-avatar")}
          <span>${escapeHtml(displayPerson(person))}</span>
        </div>
      `).join("")}</div>
      ${renderRemoteAudioElements(participants)}
    </div>
  `;
}

function renderVideoCallStage(participants) {
  return `
    <div class="video-grid ${participants.length > 2 ? "many" : ""}">
      ${participants.map((person) => `
        <div class="video-tile ${person.id === state.auth.user.id ? "local" : ""}">
          ${person.id === state.auth.user.id
            ? `<video id="localCallVideo" autoplay playsinline muted></video>`
            : `<video id="remoteCallVideo-${safeDomId(person.id)}" data-remote-video="${escapeAttr(person.id)}" autoplay playsinline></video>`}
          <div class="video-fallback">${avatarNode(person, "call-avatar large")}</div>
          <span>${escapeHtml(displayPerson(person))}</span>
        </div>
      `).join("")}
      ${renderRemoteAudioElements(participants)}
    </div>
  `;
}

function renderRemoteAudioElements(participants) {
  return participants
    .filter((person) => person.id !== state.auth.user.id)
    .map((person) => `<audio id="remoteCallAudio-${safeDomId(person.id)}" data-remote-audio="${escapeAttr(person.id)}" autoplay></audio>`)
    .join("");
}

function renderCallsView() {
  const conversation = selectedConversation();
  const selectedPeople = conversation ? callParticipants({
    participantUserIds: conversation.participants.filter((participant) => !participant.removedAt).map((participant) => participant.userId),
    conversationId: conversation.id
  }) : [];
  return `
    <div class="panel-view">
      <div class="grid">
        <div class="card span-7 call-console-card">
          <div class="split">
            <h3>Centro de llamadas</h3>
            <span class="pill">${state.connection ? "Realtime listo" : "Reconectando"}</span>
          </div>
          <p>Voz y video con sala visual, controles locales, senales por SignalR y presencia del chat seleccionado.</p>
          <div class="call-preview-panel">
            <div class="call-preview-people">
              ${selectedPeople.length ? selectedPeople.map((person) => avatarNode(person, "profile-avatar")).join("") : `<div class="avatar">N</div>`}
            </div>
            <div>
              <strong>${conversation ? escapeHtml(conversationTitle(conversation)) : "Elige un chat"}</strong>
              <span>${conversation ? `${selectedPeople.length} participantes disponibles` : "Abre un chat para llamar"}</span>
            </div>
          </div>
          <div class="row">
            <button class="btn primary" id="startVoicePanel" ${conversation ? "" : "disabled"}>${icon("phone")}<span>Llamada de voz</span></button>
            <button class="btn ghost" id="startVideoPanel" ${conversation ? "" : "disabled"}>${icon("video")}<span>Videollamada</span></button>
          </div>
        </div>
        <div class="card span-5">
          <h3>Estado de llamada</h3>
          <div class="call-status-stack">
            <div><strong data-call-status>${state.call.current ? escapeHtml(callStatusText()) : "Sin llamada activa"}</strong><span>${state.call.current ? escapeHtml(callTitle(state.call.current)) : "Listo para recibir"}</span></div>
            <div class="metric" data-call-duration>${state.call.current ? callDurationText() : "00:00"}</div>
          </div>
        </div>
        <div class="card span-12">
          <h3>Participantes</h3>
          <div class="call-roster">${selectedPeople.length ? selectedPeople.map(renderCallRosterPerson).join("") : `<p class="muted">Selecciona un chat para ver a quien puedes llamar.</p>`}</div>
        </div>
      </div>
    </div>
  `;
}

function renderCallRosterPerson(person) {
  return `
    <div class="person-card compact-person">
      ${avatarNode(person, "profile-avatar")}
      <div>
        <strong>${escapeHtml(displayPerson(person))}</strong>
        <span>${person.id === state.auth.user.id ? "Tu dispositivo" : `@${escapeHtml(person.alias || "contacto")}`}</span>
      </div>
    </div>
  `;
}

function renderPrivacyView() {
  const privacy = state.privacy || {};
  return `
    <div class="panel-view">
      <div class="grid">
        <div class="card span-7">
          <h3>Privacidad avanzada</h3>
          ${switchRow("hideNotificationContent", "Ocultar notificaciones", "Los push no deben mostrar contenido sensible.", privacy.hideNotificationContent)}
          ${switchRow("allowForwarding", "Permitir reenvio", "Control por defecto sobre contenido compartido.", privacy.allowForwarding)}
          ${switchRow("allowScreenshots", "Permitir capturas", "La app puede bloquear solo donde el sistema lo permita.", privacy.allowScreenshots)}
          ${switchRow("readReceipts", "Confirmaciones de lectura", "Controla entregado y leido en conversaciones.", privacy.readReceipts)}
        </div>
        <div class="card span-5">
          <h3>Retencion por defecto</h3>
          <p>Define TTL sugerido para mensajes nuevos.</p>
          <select class="select" id="ttlSelect">
            <option value="-1" ${privacy.defaultMessageTtlSeconds === null || privacy.defaultMessageTtlSeconds === undefined ? "selected" : ""}>Sin expiracion</option>
            <option value="3600" ${privacy.defaultMessageTtlSeconds === 3600 ? "selected" : ""}>1 hora</option>
            <option value="86400" ${privacy.defaultMessageTtlSeconds === 86400 ? "selected" : ""}>1 dia</option>
            <option value="604800" ${privacy.defaultMessageTtlSeconds === 604800 ? "selected" : ""}>7 dias</option>
          </select>
        </div>
      </div>
    </div>
  `;
}

function switchRow(key, title, description, value) {
  return `
    <div class="switch-row">
      <div><strong>${title}</strong><span>${description}</span></div>
      <button class="switch ${value ? "on" : ""}" data-privacy="${key}" aria-label="${title}"></button>
    </div>
  `;
}

function icon(name) {
  const paths = {
    message: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-5 4v-13.5z"/>',
    vault: '<path d="M5 9V7a7 7 0 0 1 14 0v2"/><path d="M4 9h16v11H4z"/><path d="M12 13v3"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9z"/>',
    "phone-off": '<path d="m2 2 20 20"/><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8"/><path d="M14.7 14.7a16 16 0 0 0 1.2 1.2l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7"/>',
    video: '<path d="M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="m16 10 6-3v10l-6-3z"/>',
    "video-off": '<path d="m2 2 20 20"/><path d="M10.7 6H14a2 2 0 0 1 2 2v3.3"/><path d="M16 16.7V18H4a2 2 0 0 1-2-2V8c0-.7.4-1.4 1-1.7"/><path d="m16 10 6-3v10l-4.2-2.1"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/>',
    user: '<path d="M20 21a8 8 0 0 0-16 0"/><path d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>',
    "user-plus": '<path d="M16 21a6 6 0 0 0-12 0"/><path d="M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M19 8v6"/><path d="M16 11h6"/>',
    globe: '<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/>',
    qr: '<path d="M3 3h6v6H3z"/><path d="M15 3h6v6h-6z"/><path d="M3 15h6v6H3z"/><path d="M15 15h2"/><path d="M21 15v2"/><path d="M15 21h6"/><path d="M21 19v2"/><path d="M12 7h.01"/><path d="M12 12h.01"/><path d="M7 12h.01"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 16v5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 8V3h-5"/>',
    clip: '<path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.7-9.7a4 4 0 1 1 5.7 5.7l-9.8 9.7a2 2 0 0 1-2.8-2.8l8.9-8.9"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
    image: '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="m8 14 2.5-3 3.5 4.5 2-2.5L20 18"/><path d="M8.5 8.5h.01"/>',
    camera: '<path d="M14.5 4 16 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3z"/><path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>',
    music: '<path d="M9 18V5l12-2v13"/><path d="M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"/><path d="M21 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"/>',
    mic: '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v4"/><path d="M8 22h8"/>',
    "mic-off": '<path d="m2 2 20 20"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1"/><path d="M15 9.3V5a3 3 0 0 0-5.1-2.1"/><path d="M19 11a7 7 0 0 1-1.3 4"/><path d="M5 11a7 7 0 0 0 7 7"/><path d="M12 18v4"/><path d="M8 22h8"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    more: '<circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>',
    archive: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
    reply: '<path d="m9 17-5-5 5-5"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>',
    forward: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-1a5 5 0 0 1 5-5h11"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    square: '<path d="M6 6h12v12H6z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/>'
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.message}</svg>`;
}

function renderAccountView() {
  const user = state.auth.user;
  const devices = state.devices.map((device) => {
    const isCurrent = device.id === state.auth.device.id;
    const label = device.revokedAt ? "Revocado" : isCurrent ? "Este dispositivo" : deviceStaleLabel(device);
    return `<div class="device-item">
      <div class="avatar">D</div>
      <div><div class="item-title">${escapeHtml(device.name)}</div><div class="item-sub">${label} - ${formatTime(device.lastSeenAt || device.createdAt)}</div></div>
      <button class="btn icon danger" data-revoke-device="${device.id}" title="Revocar dispositivo" aria-label="Revocar dispositivo">${icon("trash")}</button>
    </div>`;
  }).join("");
  return `
    <div class="panel-view">
      <div class="grid">
        <div class="card span-7">
          <h3>Centro de cuentas</h3>
          <form id="profileForm" class="stack">
            <div class="profile-row">
              ${avatarNode(user, "profile-avatar large")}
              <div class="stack">
                <input class="input" id="profilePhoto" type="file" accept="image/*">
                <label class="check-row"><input type="checkbox" id="profileDiscoverable" ${user.isDiscoverable ? "checked" : ""}> Aparecer en busquedas</label>
              </div>
            </div>
            <input class="input" id="profileName" value="${escapeAttr(user.displayName || "")}" placeholder="Nombre visible">
            <input class="input" id="profileEmail" value="${escapeAttr(user.email || "")}" placeholder="Email opcional">
            <input class="input" id="profilePhone" value="${escapeAttr(user.phone || "")}" placeholder="Telefono opcional">
            <textarea class="textarea" id="profileBio" placeholder="Bio publica">${escapeHtml(user.bio || "")}</textarea>
            <button class="btn primary">Guardar perfil</button>
          </form>
        </div>
        <div class="card span-5">
          <h3>Plan</h3>
          <p>Gratis en lo importante. Monetizacion suave con anuncios sin leer contenido.</p>
          <div class="metric">${escapeHtml(state.entitlements?.planCode || "free")}</div>
        </div>
        <div class="card span-7">
          <h3>Dispositivos</h3>
          <div class="stack">${devices || `<p class="muted">No hay dispositivos cargados.</p>`}</div>
        </div>
        <div class="card span-5">
          <h3>Vincular dispositivo</h3>
          <p>Abre la camara y escanea el QR que aparece en la PC. Tu llave privada viaja cifrada con la llave efimera del otro equipo.</p>
          <div class="link-device-panel">
            <div class="link-device-icon">${icon("qr")}</div>
            <div>
              <strong>QR seguro</strong>
              <span>Handshake opaco por SignalR</span>
            </div>
          </div>
          <button class="btn primary full" id="openQrScannerBtn">${icon("camera")}<span>Vincular dispositivo</span></button>
        </div>
        <div class="card span-5">
          <h3>Sesion</h3>
          <div class="stack">
            <button class="btn ghost" id="refreshBtn">Renovar sesion</button>
            <button class="btn danger" id="logoutBtn">Cerrar sesion</button>
            <button class="btn danger" id="deleteAccountBtn">Borrar cuenta</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindAppEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      if (state.view !== "chats") state.mobileChatOpen = false;
      render();
      if (state.view === "world" && !state.directoryResults.length && isRemoteSearchQueryReady(state.query)) {
        scheduleDirectorySearch();
      }
    });
  });
  document.querySelector("#globalSearch")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    if (state.view === "world") {
      scheduleDirectorySearch();
    } else {
      render();
    }
  });
  document.querySelector("#newChatBtn")?.addEventListener("click", openNewChatDialog);
  document.querySelector("#contactsBtn")?.addEventListener("click", () => openContactsDialog("mine"));
  document.querySelector("#contactsEmptyBtn")?.addEventListener("click", () => openContactsDialog("mine"));
  document.querySelectorAll("[data-global-person-search]").forEach((button) => {
    button.addEventListener("click", () => openContactsDialog("discover", button.dataset.globalPersonSearch || state.query));
  });
  document.querySelector("#openChatProfile")?.addEventListener("click", openChatProfile);
  document.querySelector("#closeChatProfile")?.addEventListener("click", closeChatProfile);
  document.querySelector("#profileScrim")?.addEventListener("click", closeChatProfile);
  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });
  document.querySelector("#editMessageForm")?.addEventListener("submit", handleEditMessageSubmit);
  document.querySelector("#forwardSearch")?.addEventListener("input", (event) => {
    state.forwardPicker.query = event.target.value;
    render();
  });
  document.querySelectorAll("[data-toggle-forward]").forEach((button) => {
    button.addEventListener("click", () => toggleForwardSelection(button.dataset.toggleForward));
  });
  document.querySelector("#sendForwardBtn")?.addEventListener("click", forwardMessageToSelectedConversations);
  document.querySelector("#deleteAccountForm")?.addEventListener("submit", handleDeleteAccountSubmit);
  document.querySelectorAll("[data-contact-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.contactPanel.tab = button.dataset.contactTab;
      state.contactPanel.results = [];
      render();
      scheduleContactsPanelSearch();
    });
  });
  document.querySelector("#contactsSearch")?.addEventListener("input", (event) => {
    state.contactPanel.query = event.target.value;
    scheduleContactsPanelSearch();
  });
  document.querySelectorAll("[data-chat-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.chatSearch.mode = button.dataset.chatMode;
      state.chatSearch.query = "";
      state.chatSearch.results = state.contacts.map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" }));
      render();
      scheduleChatModalSearch();
    });
  });
  document.querySelector("#chatModalSearch")?.addEventListener("input", (event) => {
    state.chatSearch.query = event.target.value;
    scheduleChatModalSearch();
  });
  document.querySelector("#createAliasChatBtn")?.addEventListener("click", () => createChatFromAliases(state.chatSearch.query));
  document.querySelectorAll("[data-toggle-group-user]").forEach((button) => {
    button.addEventListener("click", () => toggleGroupSelection(button.dataset.toggleGroupUser));
  });
  document.querySelector("#createGroupChatBtn")?.addEventListener("click", createGroupChatFromSelection);
  document.querySelectorAll("[data-open-conversation]").forEach((button) => {
    button.addEventListener("click", async () => {
      selectConversation(button.dataset.openConversation);
      state.view = "chats";
      state.mobileChatOpen = true;
      await loadConversationHistory(state.selectedConversationId, false);
      await joinSelectedConversation();
      render();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      button.click();
    });
  });
  document.querySelectorAll("[data-chat-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openChatContextMenu(button.dataset.chatMenu, button);
    });
  });
  document.querySelectorAll("[data-start-chat-user]").forEach((button) => {
    button.addEventListener("click", () => startChatWithUser(button.dataset.startChatUser));
  });
  document.querySelectorAll("[data-add-friend]").forEach((button) => {
    button.addEventListener("click", () => sendFriendRequest(button.dataset.addFriend));
  });
  document.querySelectorAll("[data-accept-friend]").forEach((button) => {
    button.addEventListener("click", () => respondFriendRequest(button.dataset.acceptFriend, "accept"));
  });
  document.querySelectorAll("[data-reject-friend]").forEach((button) => {
    button.addEventListener("click", () => respondFriendRequest(button.dataset.rejectFriend, "reject"));
  });
  document.querySelectorAll("[data-view-story]").forEach((button) => {
    button.addEventListener("click", () => viewStory(button.dataset.viewStory));
  });
  document.querySelector("#syncBtn")?.addEventListener("click", async () => {
    await bootstrap();
    await pollPending();
    toast("Sincronizado.");
  });
  document.querySelector("#sendBtn")?.addEventListener("click", sendTextMessage);
  const messageInput = document.querySelector("#messageInput");
  messageInput?.addEventListener("input", (event) => {
    setDraftValue("messageInput", event.target.value);
    sendTypingState("typing");
  });
  messageInput?.addEventListener("blur", () => sendTypingState("stopped", { force: true }));
  messageInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendTextMessage();
    }
  });
  document.querySelector("#cancelReplyBtn")?.addEventListener("click", () => {
    state.replyTo = null;
    updateReplyBar();
    document.querySelector("#messageInput")?.focus();
  });
  document.querySelector("#messageTtlSelect")?.addEventListener("change", (event) => {
    state.messagePolicy.ttlSeconds = event.target.value;
  });
  document.querySelector("#viewOnceToggle")?.addEventListener("change", (event) => {
    state.messagePolicy.deleteAfterRead = event.target.checked;
  });
  document.querySelector("#attachBtn")?.addEventListener("click", openAttachmentModal);
  document.querySelector("#fileInput")?.addEventListener("change", handleFileSelected);
  bindVoiceNoteButton(document.querySelector("#voiceNoteBtn"));
  document.querySelectorAll("[data-attach-picker]").forEach((button) => {
    button.addEventListener("click", () => pickAttachment(button.dataset.attachPicker));
  });
  document.querySelector("#openCameraBtn")?.addEventListener("click", openCameraModal);
  document.querySelector("#cameraViewOnceToggle")?.addEventListener("change", (event) => {
    state.camera.viewOnce = event.target.checked;
    render();
  });
  document.querySelector("#capturePhotoBtn")?.addEventListener("click", captureCameraPhoto);
  document.querySelector("#cameraRecordBtn")?.addEventListener("click", toggleCameraRecording);
  document.querySelector("#switchCameraBtn")?.addEventListener("click", switchCamera);
  document.querySelectorAll("[data-react]").forEach((button) => {
    button.addEventListener("click", () => sendReaction(button.dataset.react, button.dataset.emoji));
  });
  document.querySelectorAll("[data-reply]").forEach((button) => {
    button.addEventListener("click", () => setReply(button.dataset.reply));
  });
  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => editMessage(button.dataset.edit));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteMessage(button.dataset.delete));
  });
  document.querySelectorAll("[data-open-view-once]").forEach((button) => {
    button.addEventListener("click", () => openViewOnceMessage(button.dataset.openViewOnce));
  });
  document.querySelectorAll("[data-download-file]").forEach((button) => {
    button.addEventListener("click", () => downloadFile(button.dataset));
  });
  document.querySelectorAll("[data-preview-file]").forEach((button) => {
    button.addEventListener("click", () => previewFile(button.dataset));
  });
  bindMessageGestureMenu();
  bindMessagesScrollLoader();
  document.querySelectorAll("[data-chat-privacy]").forEach((button) => {
    button.addEventListener("click", () => toggleConversationPrivacy(button.dataset.chatPrivacy));
  });
  document.querySelector("#vaultPin")?.addEventListener("input", (event) => setDraftValue("vaultPin", event.target.value));
  document.querySelector("#vaultPinForm")?.addEventListener("submit", handleVaultPin);
  document.querySelector("#vaultNoteForm")?.addEventListener("submit", handleVaultNote);
  document.querySelector("#vaultRoomForm")?.addEventListener("submit", handleVaultRoom);
  document.querySelectorAll("[data-open-vault-room]").forEach((button) => {
    button.addEventListener("click", () => openVaultLobby(button.dataset.openVaultRoom));
  });
  document.querySelector("#backToVaultRooms")?.addEventListener("click", () => {
    state.vaultLobbyRoomId = null;
    state.vaultActiveRoomId = null;
    render();
  });
  document.querySelector("#vaultJoinForm")?.addEventListener("submit", handleVaultJoin);
  document.querySelector("#closeVaultRoom")?.addEventListener("click", () => leaveVaultRoom(state.vaultActiveRoomId));
  document.querySelector("#vaultSendBtn")?.addEventListener("click", sendVaultTextMessage);
  const vaultMessageInput = document.querySelector("#vaultMessageInput");
  vaultMessageInput?.addEventListener("input", (event) => setDraftValue("vaultMessageInput", event.target.value));
  vaultMessageInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendVaultTextMessage();
    }
  });
  document.querySelector("#vaultAttachBtn")?.addEventListener("click", () => document.querySelector("#vaultFileInput").click());
  document.querySelector("#vaultFileInput")?.addEventListener("change", handleVaultFileSelected);
  document.querySelector("#vaultInviteSearch")?.addEventListener("input", (event) => {
    state.vaultInvite.query = event.target.value;
    scheduleVaultInviteSearch();
  });
  document.querySelectorAll("[data-toggle-vault-invite]").forEach((button) => {
    button.addEventListener("click", () => toggleVaultInviteSelection(button.dataset.toggleVaultInvite));
  });
  document.querySelector("#sendVaultInvitesBtn")?.addEventListener("click", sendVaultInvites);
  document.querySelectorAll("[data-invite-vault-room]").forEach((button) => {
    button.addEventListener("click", () => openVaultInviteDialog(button.dataset.inviteVaultRoom));
  });
  document.querySelectorAll("[data-leave-vault-room]").forEach((button) => {
    button.addEventListener("click", () => leaveVaultRoom(button.dataset.leaveVaultRoom));
  });
  document.querySelector("#lockVaultBtn")?.addEventListener("click", () => {
    state.vault = { unlocked: false, key: null, decoded: new Map() };
    render();
  });
  document.querySelectorAll("[data-privacy]").forEach((button) => {
    button.addEventListener("click", () => togglePrivacy(button.dataset.privacy));
  });
  document.querySelector("#ttlSelect")?.addEventListener("change", (event) => updatePrivacy({ defaultMessageTtlSeconds: Number(event.target.value) }));
  document.querySelector("#profileForm")?.addEventListener("submit", handleProfile);
  document.querySelector("#profilePhoto")?.addEventListener("change", previewProfilePhoto);
  document.querySelector("#openQrScannerBtn")?.addEventListener("click", openQrScanner);
  document.querySelector("#restartQrScannerBtn")?.addEventListener("click", () => startQrScanner().catch((error) => setQrScannerStatus(error.message || "No se pudo abrir la camara.")));
  document.querySelector("#qrScanFileBtn")?.addEventListener("click", () => document.querySelector("#qrScanFileInput")?.click());
  document.querySelector("#qrScanFileInput")?.addEventListener("change", handleQrScanFile);
  document.querySelector("#storyText")?.addEventListener("input", (event) => setDraftValue("storyText", event.target.value));
  document.querySelector("#storyAttachBtn")?.addEventListener("click", () => document.querySelector("#storyMediaInput")?.click());
  document.querySelector("#storyMediaInput")?.addEventListener("change", handleStoryMediaSelected);
  document.querySelector("#clearStoryMediaBtn")?.addEventListener("click", () => {
    state.pendingStoryFile = null;
    render();
  });
  document.querySelector("#storyPublishBtn")?.addEventListener("click", handleStorySubmit);
  document.querySelector("#storyForm")?.addEventListener("submit", handleStorySubmit);
  document.querySelector("#storyReplyInput")?.addEventListener("input", (event) => setDraftValue("storyReplyInput", event.target.value));
  document.querySelector("#storyReactionToggle")?.addEventListener("click", toggleStoryReactions);
  document.querySelectorAll("[data-story-reaction]").forEach((button) => {
    button.addEventListener("click", (event) => selectStoryReaction(event, button.dataset.storyReaction));
  });
  document.querySelector("#storyReplyForm")?.addEventListener("submit", handleStoryReplySubmit);
  document.querySelector("#logoutBtn")?.addEventListener("click", logout);
  document.querySelector("#refreshBtn")?.addEventListener("click", refreshSession);
  document.querySelector("#deleteAccountBtn")?.addEventListener("click", deleteAccount);
  document.querySelectorAll("[data-revoke-device]").forEach((button) => {
    button.addEventListener("click", () => revokeDevice(button.dataset.revokeDevice));
  });
  document.querySelector("#backToChatList")?.addEventListener("click", () => {
    state.mobileChatOpen = false;
    state.profileConversationId = null;
    render();
  });
  document.querySelector("#voiceCallBtn")?.addEventListener("click", () => startCall("Voice"));
  document.querySelector("#videoCallBtn")?.addEventListener("click", () => startCall("Video"));
  document.querySelector("#startVoicePanel")?.addEventListener("click", () => startCall("Voice"));
  document.querySelector("#startVideoPanel")?.addEventListener("click", () => startCall("Video"));
  document.querySelector("#acceptCallBtn")?.addEventListener("click", acceptCall);
  document.querySelector("#declineCallBtn")?.addEventListener("click", declineCall);
  document.querySelector("#endCallBtn")?.addEventListener("click", endCurrentCall);
  document.querySelector("#endCallTopBtn")?.addEventListener("click", endCurrentCall);
  document.querySelector("#toggleMuteBtn")?.addEventListener("click", toggleCallMute);
  document.querySelector("#toggleCameraBtn")?.addEventListener("click", toggleCallCamera);
  document.querySelector("#toggleSpeakerBtn")?.addEventListener("click", toggleCallSpeaker);
  document.querySelector("#minimizeCallBtn")?.addEventListener("click", () => {
    state.view = "chats";
    render();
  });
  markVisibleMessagesRead(state.selectedConversationId).catch(() => {});
  attachCallMedia();
  attachCameraPreview();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const mode = form.dataset.mode;

  if (mode === "phone") {
    await verifyPhoneOtp();
    return;
  }

  if (mode === "qr") {
    await startQrLogin();
    return;
  }

  const alias = document.querySelector("#alias").value.trim();
  const password = document.querySelector("#password").value;
  const displayName = document.querySelector("#displayName")?.value.trim();

  try {
    const keys = await prepareDeviceKeys({ alias, registration: mode === "register" });
    const payload = {
      alias,
      password,
      deviceName: deviceName(),
      displayName: mode === "register" ? displayName || alias : undefined,
      email: null,
      phone: null,
      keyBundle: keys.keyBundle
    };
    const endpoint = mode === "register" ? "/auth/register" : "/auth/login";
    const auth = await request(endpoint, { method: "POST", body: payload, skipAuth: true });
    await completeAuth(auth, keys);
  } catch (error) {
    toast(error.message || "No se pudo autenticar.");
  }
}

async function startPhoneOtp() {
  const phone = document.querySelector("#phoneLogin")?.value.trim();
  if (!phone) return;
  try {
    const response = await request("/auth/phone/start", { method: "POST", body: { phone }, skipAuth: true });
    toast(response.deliveryHint || "Codigo enviado.");
  } catch (error) {
    toast(error.message || "No se pudo enviar codigo.");
  }
}

async function verifyPhoneOtp() {
  const phone = document.querySelector("#phoneLogin")?.value.trim();
  const code = document.querySelector("#otpCode")?.value.trim();
  if (!phone || !code) {
    toast("Telefono y codigo son obligatorios.");
    return;
  }
  try {
    const keys = await prepareDeviceKeys({ registration: false });
    const auth = await request("/auth/phone/verify", {
      method: "POST",
      body: { phone, code, deviceName: deviceName(), keyBundle: keys.keyBundle },
      skipAuth: true
    });
    await completeAuth(auth, keys);
  } catch (error) {
    toast(error.message || "No se pudo entrar por telefono.");
  }
}

async function startQrLogin() {
  if (qrLoginStartPromise) return qrLoginStartPromise;
  qrLoginStartPromise = startQrLoginInternal().finally(() => {
    qrLoginStartPromise = null;
  });
  return qrLoginStartPromise;
}

async function startQrLoginInternal() {
  if (state.qrLogin?.active && state.qrLogin?.connection?.state === window.signalR?.HubConnectionState.Connected) {
    renderQrChallenge(state.qrLogin);
    return;
  }
  if (!window.signalR) throw new Error("SignalR no esta cargado.");
  await stopQrLogin();
  const ephemeral = await createQrEphemeralKeys();
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(apiUrl("/hubs/realtime?qr_link=1"), { withCredentials: false })
    .withAutomaticReconnect()
    .build();
  detachQrLoginHandlers(connection);
  connection.on("qr-login-success", async (encryptedPayload) => {
    await handleQrLoginSuccess(encryptedPayload, ephemeral, connection);
  });
  await connection.start();
  const connectionId = connection.connectionId || await connection.invoke("GetConnectionId");
  const challenge = buildQrLinkChallenge(connectionId, ephemeral.publicJwk);
  state.qrLogin = { ...challenge, connection, ephemeral, active: true };
  renderQrChallenge(state.qrLogin);
}

async function completeAuth(auth, keys) {
  state.auth = auth;
  saveJson("nivra.auth", auth);
  await saveDeviceKeys(auth.user.alias, auth.device.id, keys.privateJwk, keys.publicJwk, { userId: auth.user.id });
  await bootstrap();
  await initializePushNotifications().catch(() => {});
  await connectRealtime();
  await syncPendingMessages("auth", { force: true }).catch(() => {});
  startPolling();
  toast("Bienvenido a Nivra.");
}

function renderQrChallenge(challenge) {
  const frame = document.querySelector("#qrFrame");
  const code = document.querySelector("#qrCodeText");
  const hint = document.querySelector("#qrHint");
  const qrText = challenge?.qrData || challenge?.deepLink || "";
  if (frame) {
    frame.innerHTML = "";
    if (window.QRCode?.toCanvas) {
      const canvas = document.createElement("canvas");
      frame.appendChild(canvas);
      window.QRCode.toCanvas(canvas, qrText, { width: 168, margin: 1, color: { dark: "#04100d", light: "#f4fbf7" } }).catch(() => {
        frame.innerHTML = renderQrSvg(qrText) || fakeQrMatrix(qrText || "nivra");
      });
    } else if (window.qrcode) {
      frame.innerHTML = renderQrSvg(qrText) || fakeQrMatrix(qrText || "nivra");
    } else {
      frame.innerHTML = fakeQrMatrix(qrText || "nivra");
    }
  }
  if (code) code.textContent = challenge?.shortCode || challenge?.connectionId?.slice(-6)?.toUpperCase() || "QR listo";
  if (hint) hint.textContent = challenge?.status || "Escanealo desde Cuenta -> Vincular dispositivo en tu celular.";
}

function renderQrSvg(value) {
  if (!value || !window.qrcode) return "";
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(value);
    qr.make();
    return qr.createSvgTag({ scalable: true, margin: 1 }).replace("<svg", '<svg class="qr-svg"');
  } catch {
    return "";
  }
}

async function stopQrLogin() {
  clearTimeout(state.qrLogin?.expiresTimer);
  const connection = state.qrLogin?.connection;
  state.qrLogin = null;
  if (connection) {
    detachQrLoginHandlers(connection);
    await connection.stop().catch(() => {});
  }
}

function detachQrLoginHandlers(connection) {
  connection?.off?.("qr-login-success");
}

function buildQrLinkChallenge(connectionId, publicJwk) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + QR_LOGIN_TTL_MS);
  const payload = {
    v: 1,
    type: "nivra-qr-login",
    alg: "RSA-OAEP-256+A256GCM",
    connectionId,
    publicKey: base64UrlJson(publicJwk),
    origin: API_BASE_URL,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  const qrData = base64UrlJson(payload);
  const expiresTimer = setTimeout(() => {
    if (state.qrLogin?.connectionId === connectionId) {
      stopQrLogin().catch(() => {});
      setAuthMode("qr");
      toast("QR renovado por seguridad.");
    }
  }, QR_LOGIN_TTL_MS);
  return {
    ...payload,
    qrData,
    shortCode: connectionId.slice(-6).toUpperCase(),
    status: "Escanealo desde Cuenta -> Vincular dispositivo.",
    expiresTimer
  };
}

async function handleQrLoginSuccess(encryptedPayload, ephemeral, connection) {
  try {
    const payload = await decryptQrPayload(encryptedPayload, ephemeral.privateKey);
    if (!payload?.auth?.tokens?.accessToken || !payload?.keyMaterial?.privateJwk) {
      throw new Error("El paquete QR no contiene una sesion valida.");
    }
    detachQrLoginHandlers(connection);
    await connection.stop().catch(() => {});
    state.qrLogin = null;
    state.auth = payload.auth;
    saveJson("nivra.auth", payload.auth);
    await saveDeviceKeys(
      payload.auth.user.alias,
      payload.auth.device.id,
      payload.keyMaterial.privateJwk,
      payload.keyMaterial.publicJwk,
      { userId: payload.auth.user.id, importedFromQr: true }
    );
    await bootstrap();
    await initializePushNotifications().catch(() => {});
    await connectRealtime();
    startPolling();
    toast("Dispositivo vinculado.");
  } catch (error) {
    toast(error.message || "No se pudo desbloquear el QR.");
  }
}

async function openNewChatDialog() {
  state.modal = "newChat";
  state.chatSearch = {
    mode: "alias",
    query: "",
    results: state.contacts.map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" })),
    selectedIds: new Set()
  };
  render();
  scheduleChatModalSearch();
}

function openContactsDialog(tab = "mine", query = "") {
  state.modal = { type: "contacts" };
  state.contactPanel = {
    tab,
    query,
    results: tab === "discover" ? [] : state.contacts.map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" }))
  };
  render();
  scheduleContactsPanelSearch();
}

function scheduleContactsPanelSearch() {
  state.contactSearchTimer = debouncedContactsPanelSearch();
}

async function searchContactsPanel() {
  const modalType = typeof state.modal === "string" ? state.modal : state.modal?.type;
  if (!state.auth?.tokens?.accessToken || modalType !== "contacts") return;
  const query = state.contactPanel.query.trim();
  if (state.contactPanel.tab === "mine") {
    state.contactPanel.results = state.contacts
      .filter((contact) => !query || displayPerson(contact).toLowerCase().includes(query.toLowerCase()) || contact.alias.toLowerCase().includes(query.toLowerCase()))
      .map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" }));
    render();
    return;
  }
  if (!isRemoteSearchQueryReady(query)) {
    state.contactPanel.results = [];
    render();
    return;
  }
  const requestSeq = ++state.contactSearchRequestSeq;
  try {
    const result = await request(`/directory/search?q=${encodeURIComponent(query)}`);
    if (requestSeq !== state.contactSearchRequestSeq) return;
    state.contactPanel.results = result.people || [];
    state.contactPanel.results.forEach((person) => state.aliasByUserId.set(person.id, person.alias));
    render();
  } catch {
    // Contact search should remain non-blocking.
  }
}

async function createChatFromAliases(rawAliases) {
  const aliases = rawAliases.split(",").map((item) => item.trim().replace(/^@/, "")).filter(Boolean);
  if (!aliases.length) return;
  try {
    const directories = [];
    for (const item of aliases) {
      const directory = await request(`/keys/${encodeURIComponent(item)}`, { skipAuth: !state.auth });
      directories.push(directory);
      cacheKeyDirectory(directory);
      await request("/contacts", { method: "POST", body: { alias: item, nicknameCiphertext: null } });
    }
    const conversation = await request("/conversations", {
      method: "POST",
      body: {
        type: directories.length > 1 ? "Group" : "Direct",
        participantUserIds: directories.map((directory) => directory.userId),
        titleCiphertext: directories.length > 1 ? btoa(`Grupo ${aliases.join(", ")}`) : null,
        privacySettings: null
      }
    });
    selectConversation(conversation.id);
    state.view = "chats";
    state.mobileChatOpen = true;
    closeModal();
    await bootstrap();
    await joinSelectedConversation();
    toast("Chat creado.");
  } catch (error) {
    toast(error.message || "No se pudo crear el chat.");
  }
}

function scheduleDirectorySearch() {
  state.searchTimer = debouncedDirectorySearch();
}

async function searchDirectory() {
  if (!state.auth?.tokens?.accessToken) return;
  const query = (state.query || "").trim();
  if (!isRemoteSearchQueryReady(query)) {
    state.directoryResults = [];
    render();
    return;
  }
  const requestSeq = ++state.searchRequestSeq;
  try {
    const result = await request(`/directory/search?q=${encodeURIComponent(query)}`);
    if (requestSeq !== state.searchRequestSeq) return;
    state.directoryResults = result.people || [];
    state.directoryResults.forEach((person) => state.aliasByUserId.set(person.id, person.alias));
    render();
  } catch {
    // Search should never interrupt chat typing.
  }
}

function scheduleChatModalSearch() {
  state.chatSearchTimer = debouncedChatModalSearch();
}

async function searchChatModal() {
  if (!state.auth?.tokens?.accessToken || state.modal !== "newChat") return;
  try {
    const query = state.chatSearch.query.trim();
    const requestSeq = ++state.chatSearchRequestSeq;
    const contacts = state.contacts
      .filter((contact) => !query || displayPerson(contact).toLowerCase().includes(query.toLowerCase()) || contact.alias.toLowerCase().includes(query.toLowerCase()))
      .map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" }));
    const remote = isRemoteSearchQueryReady(query)
      ? (await request(`/directory/search?q=${encodeURIComponent(query)}`)).people || []
      : [];
    if (requestSeq !== state.chatSearchRequestSeq) return;
    state.chatSearch.results = mergePeople(contacts, remote);
    render();
  } catch {
    // Modal search should stay soft while the user types.
  }
}

function isRemoteSearchQueryReady(query) {
  return String(query || "").trim().length >= SEARCH_MIN_CHARS;
}

function toggleGroupSelection(userId) {
  if (state.chatSearch.selectedIds.has(userId)) {
    state.chatSearch.selectedIds.delete(userId);
  } else {
    state.chatSearch.selectedIds.add(userId);
  }
  render();
}

async function createGroupChatFromSelection() {
  const selectedIds = [...state.chatSearch.selectedIds];
  if (!selectedIds.length) return;
  const people = selectedIds
    .map((userId) => findKnownPerson(userId))
    .filter(Boolean);
  const aliases = people.map((person) => person.alias).filter(Boolean);
  await createChatFromAliases(aliases.join(","));
}

function closeModal() {
  const modalType = typeof state.modal === "string" ? state.modal : state.modal?.type;
  if (modalType === "camera") {
    stopCameraStream({ discardRecording: true });
  }
  if (modalType === "qrScanner") {
    stopQrScanner().catch(() => {});
  }
  if (state.activeStory) resetStoryResponseDraft();
  state.modal = null;
  state.activeStory = null;
  state.chatSearch.selectedIds?.clear?.();
  state.vaultInvite.selectedIds?.clear?.();
  state.forwardPicker.selectedIds?.clear?.();
  state.forwardPicker.busy = false;
  state.forwardPicker.query = "";
  render();
}

async function openQrScanner() {
  if (!state.auth?.tokens?.accessToken) return;
  const keyMaterial = await currentKeyMaterial();
  if (!keyMaterial?.privateJwk) {
    toast("No encontre la llave privada local para autorizar este dispositivo.");
    return;
  }
  state.qrScanner.status = "Preparando camara segura...";
  state.qrScanner.busy = false;
  state.modal = { type: "qrScanner" };
  render();
  setTimeout(() => startQrScanner().catch((error) => setQrScannerStatus(error.message || "No se pudo abrir la camara.")), 0);
}

async function startQrScanner() {
  await stopQrScanner();
  state.qrScanner.busy = false;
  setQrScannerStatus("Apunta la camara al QR de la PC.");

  if (window.Html5Qrcode) {
    const reader = new Html5Qrcode("qrScannerRegion");
    state.qrScanner.reader = reader;
    await reader.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: (width, height) => ({ width: Math.min(width, height, 280), height: Math.min(width, height, 280) }) },
      (decodedText) => handleQrScanResult(decodedText)
    );
    return;
  }

  if ("BarcodeDetector" in window) {
    await startNativeQrScanner();
    return;
  }

  setQrScannerStatus("Camara lista solo con HTTPS o app nativa. Tambien puedes elegir una imagen del QR.");
}

async function startNativeQrScanner() {
  const video = document.querySelector("#qrScannerVideo");
  const canvas = document.querySelector("#qrScannerCanvas");
  if (!video || !canvas) throw new Error("No se encontro la vista del escaner.");
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  state.qrScanner.stream = stream;
  video.srcObject = stream;
  video.classList.remove("hidden");
  await video.play();

  const scan = async () => {
    if (state.modal?.type !== "qrScanner" || state.qrScanner.busy) return;
    try {
      const codes = await detector.detect(video);
      const raw = codes?.[0]?.rawValue;
      if (raw) {
        await handleQrScanResult(raw);
        return;
      }
    } catch {}
    state.qrScanner.raf = requestAnimationFrame(scan);
  };
  state.qrScanner.raf = requestAnimationFrame(scan);
}

async function stopQrScanner() {
  if (state.qrScanner.reader) {
    const reader = state.qrScanner.reader;
    state.qrScanner.reader = null;
    await reader.stop().catch(() => {});
    reader.clear?.();
  }
  if (state.qrScanner.raf) {
    cancelAnimationFrame(state.qrScanner.raf);
    state.qrScanner.raf = null;
  }
  if (state.qrScanner.stream) {
    state.qrScanner.stream.getTracks().forEach((track) => track.stop());
    state.qrScanner.stream = null;
  }
}

function setQrScannerStatus(status) {
  state.qrScanner.status = status;
  const node = document.querySelector(".qr-scanner-modal .modal-head p");
  if (node) node.textContent = status;
}

async function handleQrScanFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (state.qrScanner.reader?.scanFile) {
      const result = await state.qrScanner.reader.scanFile(file, true);
      await handleQrScanResult(result);
      return;
    }
    throw new Error("La lectura por imagen requiere html5-qrcode.");
  } catch (error) {
    setQrScannerStatus(error.message || "No pude leer ese QR.");
  } finally {
    event.target.value = "";
  }
}

async function handleQrScanResult(decodedText) {
  if (state.qrScanner.busy) return;
  state.qrScanner.busy = true;
  setQrScannerStatus("QR leido. Cifrando autorizacion...");
  try {
    const challenge = parseQrLoginData(decodedText);
    await authorizeQrLogin(challenge);
    await stopQrScanner();
    state.modal = null;
    render();
    toast("Autorizacion enviada al otro dispositivo.");
  } catch (error) {
    state.qrScanner.busy = false;
    setQrScannerStatus(error.message || "QR no valido.");
  }
}

function parseQrLoginData(raw) {
  const text = String(raw || "").trim();
  let encoded = text;
  try {
    const url = new URL(text);
    encoded = url.searchParams.get("data") || url.hash.replace(/^#/, "") || text;
  } catch {}
  let payload;
  try {
    payload = encoded.startsWith("{") ? JSON.parse(encoded) : jsonFromBase64Url(encoded);
  } catch {
    throw new Error("Ese QR no pertenece a Nivra.");
  }
  if (payload?.type !== "nivra-qr-login" || !payload.connectionId || !payload.publicKey) {
    throw new Error("QR de vinculacion invalido.");
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error("Ese QR ya vencio. Genera uno nuevo.");
  }
  return {
    ...payload,
    publicJwk: jsonFromBase64Url(payload.publicKey)
  };
}

async function authorizeQrLogin(challenge) {
  const keyMaterial = await currentKeyMaterial();
  if (!state.auth?.tokens?.accessToken || !keyMaterial?.privateJwk) {
    throw new Error("Necesitas una sesion activa y una llave local para vincular.");
  }
  const sealed = await encryptQrPayload(challenge.publicJwk, {
    auth: state.auth,
    keyMaterial,
    sourceDeviceName: deviceName(),
    linkedAt: new Date().toISOString()
  });
  await request("/api/auth/authorize-qr", {
    method: "POST",
    body: {
      targetConnectionId: challenge.connectionId,
      encryptedPayload: sealed
    }
  });
}

async function startChatWithUser(userId) {
  const person = findKnownPerson(userId);
  if (!person) return;
  try {
    const conversation = await ensureDirectConversationWithUser(userId);
    selectConversation(conversation.id);
    state.view = "chats";
    state.mobileChatOpen = true;
    closeModal();
    await loadConversationHistory(conversation.id, false);
    await joinSelectedConversation();
    render();
  } catch (error) {
    toast(error.message || "No se pudo abrir chat.");
  }
}

async function ensureDirectConversationWithUser(userId) {
  const existing = findDirectConversation(userId);
  if (existing) return existing;
  let person = findKnownPerson(userId);
  if (!person?.alias) {
    person = await request(`/directory/users/${encodeURIComponent(userId)}`);
    rememberProfile(person, { persist: true });
  }
  const directory = await request(`/keys/${encodeURIComponent(person.alias)}`);
  cacheKeyDirectory(directory);
  await request("/contacts", { method: "POST", body: { alias: person.alias, nicknameCiphertext: null } }).catch(() => {});
  const conversation = await request("/conversations", {
    method: "POST",
    body: {
      type: "Direct",
      participantUserIds: [directory.userId],
      titleCiphertext: null,
      privacySettings: null
    }
  });
  await bootstrap();
  return state.conversations.find((item) => item.id === conversation.id) || conversation;
}

async function openChatProfile() {
  const conversation = selectedConversation();
  if (!conversation) return;
  state.profileConversationId = conversation.id;
  await loadConversationHistory(conversation.id, false);
  const others = conversation.participants.filter((participant) => participant.userId !== state.auth.user.id && !participant.removedAt);
  for (const participant of others) {
    if (findKnownPerson(participant.userId)?.bio) continue;
    try {
      const person = await request(`/directory/users/${participant.userId}`);
      state.directoryResults = mergePeople(state.directoryResults, [person]);
      state.aliasByUserId.set(person.id, person.alias);
    } catch {
      // Private profiles can still open with conversation metadata.
    }
  }
  render();
}

function closeChatProfile() {
  state.profileConversationId = null;
  render();
}

async function toggleConversationPrivacy(key) {
  const conversation = state.conversations.find((item) => item.id === state.profileConversationId);
  if (!conversation) return;
  const nextPrivacy = { ...(conversation.privacySettings || PrivacyDefaults()), [key]: !conversation.privacySettings?.[key] };
  try {
    const updated = await request(`/conversations/${conversation.id}`, {
      method: "PATCH",
      body: { titleCiphertext: null, privacySettings: nextPrivacy }
    });
    state.conversations = state.conversations.map((item) => item.id === updated.id ? updated : item);
    render();
  } catch (error) {
    toast(error.message || "No se pudo actualizar el chat.");
  }
}

async function sendFriendRequest(userId) {
  try {
    await request("/friends/requests", { method: "POST", body: { userId, alias: null, message: null } });
    await bootstrap();
    toast("Solicitud enviada.");
  } catch (error) {
    toast(error.message || "No se pudo enviar solicitud.");
  }
}

async function respondFriendRequest(requestId, action) {
  try {
    await request(`/friends/requests/${requestId}/${action}`, { method: "POST" });
    await bootstrap();
    toast(action === "accept" ? "Solicitud aceptada." : "Solicitud rechazada.");
  } catch (error) {
    toast(error.message || "No se pudo actualizar solicitud.");
  }
}

async function handleStorySubmit(event) {
  event.preventDefault();
  if (state.storyPublishing) return;
  const text = document.querySelector("#storyText")?.value.trim() || "";
  const file = state.pendingStoryFile;
  if (!text && !file) return;
  const visibility = document.querySelector("#storyVisibility")?.value || "PublicWorld";
  const durationSeconds = Number(document.querySelector("#storyDuration")?.value || 86400);
  const viewOnce = Boolean(document.querySelector("#storyViewOnce")?.checked);
  state.storyPublishing = true;
  setStoryPublishBusy(true, file ? "Cifrando..." : "Publicando...");
  try {
    let media = null;
    let mediaFileObjectId = null;
    if (file) {
      await waitForPaint();
      const buffer = await file.arrayBuffer();
      const encrypted = await encryptAttachment(buffer);
      setStoryPublishBusy(true, "Subiendo...");
      const fileRecord = await request("/files", {
        method: "POST",
        body: {
          encryptedSize: encrypted.bytes.byteLength,
          mimeTypeCiphertext: b64(TEXT.encode(file.type || "application/octet-stream")),
          clientSha256: null,
          allowedUserIds: [state.auth.user.id],
          expiresAt: new Date(Date.now() + durationSeconds * 1000).toISOString()
        }
      });
      await request(`/files/${fileRecord.id}/blob`, {
        method: "PUT",
        rawBody: encrypted.bytes,
        headers: { "Content-Type": "application/octet-stream" }
      });
      mediaFileObjectId = fileRecord.id;
      media = {
        fileId: fileRecord.id,
        fileName: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        fileKey: encrypted.key,
        fileIv: encrypted.iv
      };
      rememberMediaPreview(`story:${fileRecord.id}`, file, media.mime, file.name);
    }

    setStoryPublishBusy(true, "Publicando...");
    await request("/stories", {
      method: "POST",
      body: {
        visibility,
        encryptedPayload: encodeStoryPayload({ type: media ? "media" : "text", text, media }),
        caption: text.slice(0, 180),
        mediaFileObjectId,
        allowedUserIds: visibility === "SelectedUsers" ? state.contacts.map((contact) => contact.userId) : [],
        viewOnce,
        durationSeconds
      }
    });
    state.pendingStoryFile = null;
    clearDraftValue("storyText");
    await bootstrap();
    state.view = "world";
    render();
    toast("Instantanea publicada.");
  } catch (error) {
    if (error.status >= 500) {
      toast("El servidor esta muy ocupado. Intenta publicar otra vez en unos segundos.");
    } else if (error.status === 401) {
      toast("Sesion renovada o cerrada. Vuelve a intentar si sigues conectado.");
    } else {
      toast(error.message || "No se pudo publicar.");
    }
  } finally {
    state.storyPublishing = false;
    setStoryPublishBusy(false);
  }
}

function setStoryPublishBusy(busy, label = "Publicar") {
  const button = document.querySelector("#storyPublishBtn");
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `${icon("sync")}<span>${escapeHtml(label)}</span>`;
  } else {
    button.removeAttribute("aria-busy");
    button.textContent = "Publicar";
  }
}

function waitForPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function yieldToMainThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function breatheMainThread(index, every = MAIN_THREAD_YIELD_EVERY) {
  if (index > 0 && index % every === 0) await yieldToMainThread();
}

async function viewStory(storyId) {
  try {
    const story = await request(`/stories/${storyId}/view`, { method: "POST" });
    const payload = decodeStoryPayload(story.encryptedPayload);
    const text = payload.text || story.caption || "Instantanea";
    resetStoryResponseDraft();
    state.activeStory = { ...story, payload, text };
    await bootstrap();
    state.activeStory = { ...story, payload, text };
    render();
    loadActiveStoryMedia().catch(() => {});
  } catch (error) {
    toast(error.message || "No se pudo abrir historia.");
  }
}

function handleStoryMediaSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!/^(image|video|audio)\//.test(file.type || "")) {
    toast("Usa foto, video o audio.");
    return;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    toast("Maximo 50 MB por instantanea cifrada.");
    return;
  }
  state.pendingStoryFile = file;
  render();
}

async function loadActiveStoryMedia() {
  const story = state.activeStory;
  const media = story?.payload?.media;
  if (!story?.id || !media?.fileKey || !media?.fileIv) return;
  const cacheKey = `story:${story.id}`;
  const cached = state.mediaCache.get(cacheKey);
  if (cached?.url) {
    state.activeStory = { ...state.activeStory, mediaUrl: cached.url };
    render();
    return;
  }
  const encrypted = await request(`/stories/${encodeURIComponent(story.id)}/media`, { rawResponse: true });
  const bytes = await encrypted.arrayBuffer();
  const plain = await decryptAttachment(bytes, media.fileKey, media.fileIv);
  const blob = new Blob([plain], { type: media.mime || "application/octet-stream" });
  const url = rememberMediaPreview(cacheKey, blob, media.mime, media.fileName || "historia");
  if (state.activeStory?.id === story.id) {
    state.activeStory = { ...state.activeStory, mediaUrl: url };
    render();
  }
}

function renderStoryMedia(url, media = {}, cacheKey = "") {
  const mime = media.mime || "application/octet-stream";
  const name = media.fileName || "instantanea";
  const cacheAttr = cacheKey ? ` data-media-preview="${escapeAttr(cacheKey)}"` : "";
  if (mime.startsWith("image/")) {
    return `<img class="story-media"${cacheAttr} src="${escapeAttr(url)}" alt="${escapeAttr(name)}">`;
  }
  if (mime.startsWith("video/")) {
    return `<video class="story-media"${cacheAttr} src="${escapeAttr(url)}" controls playsinline></video>`;
  }
  return `<audio class="story-audio"${cacheAttr} src="${escapeAttr(url)}" controls></audio>`;
}

function toggleStoryReactions(event) {
  event.preventDefault();
  if (!state.activeStory || state.storyResponse.sending) return;
  state.storyResponse.reactionsOpen = !state.storyResponse.reactionsOpen;
  render();
  requestAnimationFrame(() => document.querySelector("#storyReplyInput")?.focus());
}

function selectStoryReaction(event, reactionKey) {
  event.preventDefault();
  if (!state.activeStory || state.storyResponse.sending) return;
  const reaction = STORY_REACTIONS.find((item) => item.key === reactionKey)?.value;
  if (!reaction) return;
  state.storyResponse.reaction = reaction;
  state.storyResponse.reactionsOpen = false;
  render();
  requestAnimationFrame(() => document.querySelector("#storyReplyInput")?.focus());
}

async function handleStoryReplySubmit(event) {
  event.preventDefault();
  if (state.storyResponse.sending) return;
  const text = document.querySelector("#storyReplyInput")?.value.trim();
  const reaction = state.storyResponse.reaction;
  if ((!text && !reaction) || !state.activeStory) return;
  await sendStoryResponse({ reaction, text });
}

async function sendStoryResponse({ reaction = null, text = "" } = {}) {
  const story = state.activeStory;
  const ownerId = story?.owner?.id;
  if (!story || !ownerId || ownerId === state.auth.user.id) return;
  state.storyResponse.sending = true;
  render();
  try {
    const conversation = await ensureDirectConversationWithUser(ownerId);
    const storyPreview = story.caption || story.payload?.text || "Historia";
    const payload = {
      type: "story-response",
      storyId: story.id,
      storyOwnerId: ownerId,
      storyPreview,
      storyMediaType: story.payload?.media?.mime || null,
      replyTo: {
        type: "story",
        id: story.id,
        storyId: story.id,
        preview: "Respuesta a tu historia",
        storyPreview
      },
      metadata: {
        source: "story",
        storyId: story.id,
        storyOwnerId: ownerId
      },
      reaction,
      text
    };
    await sendPayloadToConversation(conversation, payload, "Text", null, { deleteAfterRead: false });
    resetStoryResponseDraft();
    closeModal();
    state.view = "chats";
    selectConversation(conversation.id);
    state.mobileChatOpen = true;
    render();
    toast("Respuesta enviada al chat directo.");
  } catch (error) {
    toast(error.message || "No se pudo responder la historia.");
  } finally {
    state.storyResponse.sending = false;
    state.storyResponse.reactionsOpen = false;
    render();
  }
}

function resetStoryResponseDraft() {
  clearDraftValue("storyReplyInput");
  state.storyResponse = {
    reaction: null,
    reactionsOpen: false,
    sending: false
  };
}

async function handleVaultRoom(event) {
  event.preventDefault();
  const name = document.querySelector("#vaultRoomName").value.trim();
  const pin = document.querySelector("#vaultRoomPin").value.trim();
  if (!name) return;
  const invitedUserIds = [...document.querySelectorAll("input[name='vaultInviteContact']:checked")].map((input) => input.value);
  const retentionMode = document.querySelector("#vaultRoomRetention").value;
  try {
    const room = await request("/vault/rooms", {
      method: "POST",
      body: {
        name,
        pin,
        accessMode: document.querySelector("#vaultRoomAccess").value,
        retentionMode,
        encryptedWelcome: document.querySelector("#vaultRoomWelcome").value.trim() || null,
        invitedUserIds,
        ttlSeconds: Number(document.querySelector("#vaultRoomTtl").value)
      }
    });
    await bootstrap();
    state.view = "vault";
    state.vault.unlocked = true;
    state.vaultLobbyRoomId = room.id;
    render();
    toast("Boveda compartida creada.");
  } catch (error) {
    toast(error.message || "No se pudo crear la sala.");
  }
}

function openVaultInviteDialog(roomId) {
  state.modal = "vaultInvite";
  state.vaultInvite = {
    roomId,
    query: "",
    results: state.contacts.map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" })),
    selectedIds: new Set()
  };
  render();
  scheduleVaultInviteSearch();
}

function scheduleVaultInviteSearch() {
  state.vaultInviteTimer = debouncedVaultInviteSearch();
}

async function searchVaultInviteModal() {
  if (!state.auth?.tokens?.accessToken || state.modal !== "vaultInvite") return;
  try {
    const query = state.vaultInvite.query.trim();
    const requestSeq = ++state.vaultInviteSearchRequestSeq;
    const contacts = state.contacts
      .filter((contact) => !query || displayPerson(contact).toLowerCase().includes(query.toLowerCase()) || contact.alias.toLowerCase().includes(query.toLowerCase()))
      .map((contact) => ({ ...contact, id: contact.userId, friendshipState: "friends" }));
    const remote = isRemoteSearchQueryReady(query)
      ? (await request(`/directory/search?q=${encodeURIComponent(query)}`)).people || []
      : [];
    if (requestSeq !== state.vaultInviteSearchRequestSeq) return;
    state.vaultInvite.results = mergePeople(contacts, remote);
    render();
  } catch {
    // Invitation search is best-effort.
  }
}

function toggleVaultInviteSelection(userId) {
  if (state.vaultInvite.selectedIds.has(userId)) {
    state.vaultInvite.selectedIds.delete(userId);
  } else {
    state.vaultInvite.selectedIds.add(userId);
  }
  render();
}

async function sendVaultInvites() {
  const roomId = state.vaultInvite.roomId;
  const userIds = [...state.vaultInvite.selectedIds];
  if (!roomId || !userIds.length) return;
  try {
    await request(`/vault/rooms/${roomId}/invite`, { method: "POST", body: { userIds } });
    await bootstrap();
    closeModal();
    toast("Invitacion enviada.");
  } catch (error) {
    toast(error.message || "No se pudo invitar.");
  }
}

async function leaveVaultRoom(roomId) {
  if (!roomId) return;
  await request(`/vault/rooms/${roomId}/leave`, { method: "POST" }).catch(() => {});
  if (state.vaultActiveRoomId === roomId || state.vaultLobbyRoomId === roomId) {
    state.vaultActiveRoomId = null;
    state.vaultLobbyRoomId = null;
  }
  await bootstrap();
  render();
}

function openVaultLobby(roomId) {
  state.vaultLobbyRoomId = roomId;
  state.vaultActiveRoomId = null;
  render();
}

async function handleVaultJoin(event) {
  event.preventDefault();
  const roomId = state.vaultLobbyRoomId;
  const pin = document.querySelector("#vaultJoinPin")?.value.trim() || null;
  if (!roomId) return;
  try {
    const room = await request(`/vault/rooms/${roomId}/join`, { method: "POST", body: { pin } });
    await bootstrap();
    if (currentVaultMember(room)?.status === "Waiting") {
      state.vaultLobbyRoomId = room.id;
      toast("Solicitud enviada al propietario.");
    } else {
      state.vaultLobbyRoomId = null;
      state.vaultActiveRoomId = room.id;
      state.vaultMessages.set(room.id, state.vaultMessages.get(room.id) || []);
      await joinVaultRoomRealtime(room.id);
      toast("Boveda abierta.");
    }
    render();
  } catch (error) {
    toast(error.message || "No se pudo entrar a la boveda.");
  }
}

async function joinVaultRoomRealtime(roomId) {
  if (state.connection && roomId) {
    await state.connection.invoke("JoinVaultRoom", roomId).catch(() => {});
  }
}

async function sendVaultTextMessage() {
  const input = document.querySelector("#vaultMessageInput");
  const text = input?.value.trim();
  if (!text) return;
  await sendVaultPayload({ type: "text", text }, "Text");
  input.value = "";
  clearDraftValue("vaultMessageInput");
  render();
}

async function handleVaultFileSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  const room = activeVaultRoom();
  if (!file || !room) return;
  if (file.size > 50 * 1024 * 1024) {
    toast("Maximo 50 MB por archivo cifrado.");
    return;
  }
  try {
    const encrypted = await encryptAttachment(await file.arrayBuffer());
    const allowedUserIds = activeVaultMemberIds(room);
    const expiresAt = vaultFileExpiry(room);
    const fileRecord = await request("/files", {
      method: "POST",
      body: {
        encryptedSize: encrypted.bytes.byteLength,
        mimeTypeCiphertext: b64(TEXT.encode(file.type || "application/octet-stream")),
        clientSha256: null,
        allowedUserIds,
        expiresAt,
        vaultRoomId: room.id
      }
    });
    await request(`/files/${fileRecord.id}/blob`, {
      method: "PUT",
      rawBody: encrypted.bytes,
      headers: { "Content-Type": "application/octet-stream" }
    });
    await sendVaultPayload({
      type: "file",
      fileId: fileRecord.id,
      fileName: file.name,
      mime: file.type,
      size: file.size,
      fileKey: encrypted.key,
      fileIv: encrypted.iv
    }, fileKind(file), fileRecord.id);
    render();
  } catch (error) {
    toast(error.message || "No se pudo enviar archivo a la boveda.");
  }
}

async function sendVaultPayload(payload, kind = "Text", fileObjectId = null) {
  const room = activeVaultRoom();
  if (!room) return;
  if (!state.connection) {
    toast("Realtime no esta conectado.");
    return;
  }
  try {
    await joinVaultRoomRealtime(room.id);
    const recipients = await vaultEncryptedRecipients(room, payload, fileObjectId);
    if (!recipients.length) {
      toast("No hay llaves publicas disponibles para esta boveda.");
      return;
    }
    const clientMessageId = `vault-${crypto.randomUUID()}`;
    await state.connection.invoke("SendVaultRoomMessage", room.id, {
      clientMessageId,
      kind,
      recipients,
      fileObjectId
    });
    pushVaultMessage(room.id, {
      id: clientMessageId,
      payload,
      mine: true,
      senderAlias: state.auth.user.alias,
      at: new Date().toISOString()
    });
  } catch (error) {
    toast(error.message || "No se pudo enviar en la boveda.");
  }
}

async function vaultEncryptedRecipients(room, payload, fileObjectId) {
  const recipients = [];
  let index = 0;
  for (const member of room.members || []) {
    if (member.status !== "Active") continue;
    if (member.userId === state.auth.user.id) {
      const own = await encryptForPublicKey(await currentPublicKey(), payload);
      recipients.push({
        userId: member.userId,
        deviceId: state.auth.device.id,
        ciphertext: own.ciphertext,
        header: own.header,
        fileObjectId
      });
      await breatheMainThread(++index);
      continue;
    }

    const directory = await directoryForVaultMember(member);
    for (const device of directory?.devices || []) {
      const publicKey = parsePublicJwk(device.keyBundle?.identityKey);
      if (!publicKey) continue;
      const sealed = await encryptForPublicKey(publicKey, payload);
      recipients.push({
        userId: member.userId,
        deviceId: device.deviceId,
        ciphertext: sealed.ciphertext,
        header: sealed.header,
        fileObjectId
      });
      await breatheMainThread(++index);
    }
  }
  return recipients;
}

async function directoryForVaultMember(member) {
  if (state.keyDirectory.has(member.userId)) return state.keyDirectory.get(member.userId);
  const directory = await request(`/keys/${encodeURIComponent(member.alias)}`);
  cacheKeyDirectory(directory);
  return directory;
}

async function handleVaultRealtimeMessage(message) {
  if (!message?.id || message.senderDeviceId === state.auth.device.id) return;
  const recipient = message.recipients?.find((item) => item.deviceId === state.auth.device.id);
  if (!recipient) return;
  const payload = await decryptEnvelope(recipient.header, recipient.ciphertext).catch(() => ({ type: "sealed", text: "Contenido cifrado no disponible en este dispositivo." }));
  pushVaultMessage(message.vaultRoomId, {
    id: message.id,
    payload,
    mine: message.senderUserId === state.auth.user.id,
    senderAlias: state.aliasByUserId.get(message.senderUserId),
    at: message.sentAt
  });
  render();
}

function pushVaultMessage(roomId, message) {
  const list = state.vaultMessages.get(roomId) || [];
  if (!list.some((item) => item.id === message.id)) {
    list.push(message);
  }
  state.vaultMessages.set(roomId, list);
}

async function sendTextMessage() {
  const input = document.querySelector("#messageInput");
  const text = input?.value.trim();
  if (!text) return;
  const payload = {
    type: "text",
    text,
    mentions: [...text.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map((match) => match[1]),
    replyTo: state.replyTo
  };
  const sent = await sendPayload(payload, "Text");
  if (!sent) return;
  input.value = "";
  clearDraftValue("messageInput");
  sendTypingState("stopped", { force: true });
  state.replyTo = null;
  updateReplyBar();
  input.focus();
}

async function sendReaction(messageId, emoji) {
  const message = findMessage(messageId);
  if (message) {
    message.reactions = [...(message.reactions || []), emoji];
    const location = findMessageLocation(messageId);
    if (location) persistLocalMessage(location.conversationId, message).catch(() => {});
  }
  await sendPayload({ type: "reaction", targetMessageId: messageId, emoji }, "System");
  const location = findMessageLocation(messageId);
  if (location) upsertMessageNode(location.conversationId, messageId);
}

function openAttachmentModal() {
  if (!selectedConversation()) return;
  state.modal = { type: "attachments" };
  render();
}

function pickAttachment(kind) {
  const acceptByKind = {
    document: ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar,.7z,application/*,text/*",
    media: "image/*,video/*",
    audio: "audio/*"
  };
  state.modal = null;
  render();
  requestAnimationFrame(() => {
    const input = document.querySelector("#fileInput");
    if (!input) return;
    input.accept = acceptByKind[kind] || "";
    input.multiple = true;
    input.click();
  });
}

async function sendPayload(payload, kind = "Text", fileObjectId = null, options = {}) {
  const conversation = selectedConversation();
  return sendPayloadToConversation(conversation, payload, kind, fileObjectId, options);
}

async function sendPayloadToConversation(conversation, payload, kind = "Text", fileObjectId = null, options = {}) {
  if (!conversation) return;

  try {
    const outgoingPayload = normalizeOutgoingPayload(conversation, payload);
    const recipients = await encryptedRecipients(conversation, outgoingPayload, fileObjectId);
    if (!recipients.length) {
      if (!options.quiet) toast("No hay llaves publicas disponibles para enviar.");
      return;
    }
    const ttl = options.ttlSeconds === undefined ? effectiveMessageTtlSeconds() : options.ttlSeconds;
    const expiresAt = options.expiresAt === undefined
      ? (ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null)
      : options.expiresAt;
    const deleteAfterRead = options.deleteAfterRead ?? state.messagePolicy.deleteAfterRead;
    const response = await request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      body: {
        clientMessageId: `web-${crypto.randomUUID()}`,
        kind,
        recipients,
        encryptedPolicy: outgoingPayload.replyTo ? "reply" : outgoingPayload.forwardedFrom ? "forward" : null,
        expiresAt,
        deleteAfterRead
      }
    });

    state.seenMessageIds.add(response.id);
    saveJson("nivra.seen", [...state.seenMessageIds]);
    pushMessage(conversation.id, {
      id: response.id,
      payload: outgoingPayload,
      mine: true,
      at: response.serverReceivedAt,
      status: "enviado",
      expiresAt: response.expiresAt || expiresAt,
      deleteAfterRead: response.deleteAfterRead || deleteAfterRead,
      receipts: response.receipts || []
    });
    return response;
  } catch (error) {
    if (!options.quiet) toast(error.message || "No se pudo enviar.");
    return null;
  }
}

function normalizeOutgoingPayload(conversation, payload) {
  const outgoing = { ...(payload || {}) };
  const controlTypes = new Set(["reaction", "edit", "delete", "system"]);
  if (outgoing.type && !controlTypes.has(outgoing.type) && outgoing.forwardingAllowed === undefined) {
    outgoing.forwardingAllowed = forwardingAllowedForConversation(conversation);
  }
  return outgoing;
}

function forwardingAllowedForConversation(conversation) {
  return conversation?.privacySettings?.allowForwarding ?? state.privacy?.allowForwarding ?? true;
}

async function encryptedRecipients(conversation, payload, fileObjectId) {
  const recipients = [];
  let index = 0;
  for (const participant of conversation.participants) {
    if (participant.removedAt) continue;
    if (participant.userId === state.auth.user.id) {
      const own = await encryptForPublicKey(await currentPublicKey(), payload);
      recipients.push({
        userId: participant.userId,
        deviceId: state.auth.device.id,
        ciphertext: own.ciphertext,
        header: own.header,
        fileObjectId
      });
      await breatheMainThread(++index);
      continue;
    }

    const directory = await directoryForUser(participant.userId);
    for (const device of directory?.devices || []) {
      const publicKey = parsePublicJwk(device.keyBundle?.identityKey);
      if (!publicKey) continue;
      const sealed = await encryptForPublicKey(publicKey, payload);
      recipients.push({
        userId: participant.userId,
        deviceId: device.deviceId,
        ciphertext: sealed.ciphertext,
        header: sealed.header,
        fileObjectId
      });
      await breatheMainThread(++index);
    }
  }
  return recipients;
}

async function handleFileSelected(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  if (!files.length || !selectedConversation()) return;
  let index = 0;
  for (const file of files) {
    await sendFileAttachment(file);
    await breatheMainThread(++index, 1);
  }
}

async function sendFileAttachment(file, options = {}) {
  return sendFileAttachmentToConversation(selectedConversation(), file, options);
}

async function sendFileAttachmentToConversation(conversation, file, options = {}) {
  if (!file || !conversation) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    if (!options.quiet) toast("Maximo 50 MB por archivo cifrado.");
    return;
  }
  try {
    const encrypted = await encryptAttachment(await file.arrayBuffer());
    const allowedUserIds = conversation.participants
      .filter((participant) => !participant.removedAt)
      .map((participant) => participant.userId);
    const ttl = options.ttlSeconds === undefined ? effectiveMessageTtlSeconds() : options.ttlSeconds;
    const expiresAt = options.expiresAt === undefined
      ? (ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null)
      : options.expiresAt;
    const fileRecord = await request("/files", {
      method: "POST",
      body: {
        encryptedSize: encrypted.bytes.byteLength,
        mimeTypeCiphertext: b64(TEXT.encode(file.type || "application/octet-stream")),
        clientSha256: null,
        allowedUserIds,
        expiresAt
      }
    });
    await request(`/files/${fileRecord.id}/blob`, {
      method: "PUT",
      rawBody: encrypted.bytes,
      headers: { "Content-Type": "application/octet-stream" }
    });
    const sent = await sendPayloadToConversation(conversation, {
      type: "file",
      fileId: fileRecord.id,
      fileName: file.name,
      mime: file.type,
      size: file.size,
      fileKey: encrypted.key,
      fileIv: encrypted.iv,
      voiceNote: Boolean(options.voiceNote),
      capture: options.capture || null,
      durationMs: options.durationMs || null,
      forwardedFrom: options.forwardedFrom || null
    }, fileKind(file), fileRecord.id, options);
    if (!sent) return null;
    rememberMediaPreview(fileRecord.id, file, file.type || "application/octet-stream", file.name);
    return fileRecord;
  } catch (error) {
    if (!options.quiet) toast(error.message || "No se pudo subir el archivo.");
    return null;
  }
}

async function downloadFile(data) {
  try {
    const encrypted = await request(`/files/${data.downloadFile}/blob`, { rawResponse: true });
    const bytes = await encrypted.arrayBuffer();
    const plain = await decryptAttachment(bytes, data.fileKey, data.fileIv);
    const url = createTrackedObjectUrl(new Blob([plain]));
    const link = document.createElement("a");
    link.href = url;
    link.download = data.fileName || "nivra-file.bin";
    link.click();
    revokeTrackedObjectUrl(url);
  } catch (error) {
    toast("No se pudo descargar el archivo.");
  }
}

async function previewFile(data) {
  const fileId = data.previewFile || data.downloadFile;
  if (!fileId || !data.fileKey || !data.fileIv) return;
  try {
    if (!state.mediaCache.has(fileId)) {
      const encrypted = await request(`/files/${fileId}/blob`, { rawResponse: true });
      const bytes = await encrypted.arrayBuffer();
      const plain = await decryptAttachment(bytes, data.fileKey, data.fileIv);
      const mime = data.fileMime || "application/octet-stream";
      const blob = new Blob([plain], { type: mime });
      rememberMediaPreview(fileId, blob, mime, data.fileName || "nivra-file.bin");
    }
    const location = data.messageId ? findMessageLocation(data.messageId) : null;
    if (location) {
      upsertMessageNode(location.conversationId, data.messageId);
    } else if (state.vaultActiveRoomId) {
      render();
    } else {
      renderConversationMessages(state.selectedConversationId, { replace: false });
    }
    const preview = state.mediaCache.get(fileId);
    if (preview?.mime?.startsWith("audio/")) {
      requestAnimationFrame(() => {
        const play = document.querySelector(`[data-media-preview="${cssEscape(fileId)}"]`)?.play?.();
        play?.catch?.(() => {});
      });
    }
  } catch (error) {
    toast(error.message || "No se pudo abrir el adjunto.");
  }
}

function rememberMediaPreview(fileId, fileOrBlob, mime = "", name = "") {
  if (!fileId || !fileOrBlob) return null;
  const blob = fileOrBlob instanceof Blob
    ? fileOrBlob
    : new Blob([fileOrBlob], { type: mime || "application/octet-stream" });
  const previous = state.mediaCache.get(fileId);
  if (previous?.url) revokeTrackedObjectUrl(previous.url);
  const url = createTrackedObjectUrl(blob);
  state.mediaCache.set(fileId, {
    url,
    mime: mime || blob.type || "application/octet-stream",
    name,
    createdAt: Date.now()
  });
  return url;
}

function createTrackedObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.add(url);
  return url;
}

function revokeTrackedObjectUrl(url) {
  if (!url) return;
  URL.revokeObjectURL(url);
  state.objectUrls.delete(url);
}

function cleanupObjectUrls({ keepVisible = true } = {}) {
  const keepKeys = keepVisible ? visibleMediaCacheKeys() : new Set();
  if (keepVisible && state.activeStory?.id) keepKeys.add(`story:${state.activeStory.id}`);
  for (const [key, item] of state.mediaCache.entries()) {
    if (keepKeys.has(key)) continue;
    revokeTrackedObjectUrl(item?.url);
    state.mediaCache.delete(key);
  }
  if (!keepVisible) {
    for (const url of [...state.objectUrls]) revokeTrackedObjectUrl(url);
  }
}

function visibleMediaCacheKeys() {
  const keys = new Set();
  const activeUrls = new Set();
  document.querySelectorAll("[data-media-preview]").forEach((node) => {
    const key = node.dataset.mediaPreview;
    if (key) keys.add(key);
    const url = node.currentSrc || node.src;
    if (url) activeUrls.add(url);
  });
  document.querySelectorAll("img[src^='blob:'], video[src^='blob:'], audio[src^='blob:']").forEach((node) => {
    const url = node.currentSrc || node.src;
    if (url) activeUrls.add(url);
  });
  if (activeUrls.size) {
    for (const [key, item] of state.mediaCache.entries()) {
      if (item?.url && activeUrls.has(item.url)) keys.add(key);
    }
  }
  return keys;
}

function revokeCachedMediaPreviews() {
  cleanupObjectUrls({ keepVisible: false });
}

async function openCameraModal() {
  if (!selectedConversation()) return;
  state.modal = { type: "camera" };
  render();
  await startCameraPreview().catch((error) => {
    toast(error.message || "No se pudo abrir la camara.");
    closeModal();
  });
}

async function startCameraPreview() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador no expone camara.");
  }
  stopCameraStream({ discardRecording: true, keepState: true });
  const video = { facingMode: { ideal: state.camera.facingMode } };
  let stream = await navigator.mediaDevices.getUserMedia({ video, audio: true }).catch(() => null);
  if (!stream) {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  }
  state.camera.stream = stream;
  attachCameraPreview();
  return stream;
}

function attachCameraPreview() {
  const video = document.querySelector("#cameraPreview");
  if (!video || !state.camera.stream) return;
  if (video.srcObject !== state.camera.stream) video.srcObject = state.camera.stream;
  video.play?.().catch(() => {});
}

async function switchCamera() {
  state.camera.facingMode = state.camera.facingMode === "environment" ? "user" : "environment";
  render();
  await startCameraPreview().catch((error) => toast(error.message || "No se pudo cambiar de camara."));
}

async function captureCameraPhoto() {
  const video = document.querySelector("#cameraPreview");
  if (!video || !state.camera.stream) return;
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) {
    toast("No se pudo capturar la foto.");
    return;
  }
  const file = new File([blob], `nivra-foto-${Date.now()}.jpg`, { type: "image/jpeg" });
  await sendFileAttachment(file, { capture: "camera-photo", deleteAfterRead: state.camera.viewOnce });
  closeModal();
  render();
}

function toggleCameraRecording() {
  if (state.camera.recording) {
    stopCameraRecording();
  } else {
    startCameraRecording();
  }
}

function startCameraRecording() {
  if (!window.MediaRecorder) {
    toast("Este navegador no soporta grabacion de video.");
    return;
  }
  const stream = state.camera.stream;
  if (!stream) {
    toast("Camara no disponible.");
    return;
  }
  const mimeType = preferredRecorderType([
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4"
  ]);
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  state.camera.chunks = [];
  state.camera.recorder = recorder;
  state.camera.recording = true;
  state.camera.discardRecording = false;
  recorder.ondataavailable = (event) => {
    if (event.data?.size) state.camera.chunks.push(event.data);
  };
  recorder.onstop = async () => {
    const chunks = state.camera.chunks.splice(0);
    const discard = state.camera.discardRecording;
    state.camera.recording = false;
    state.camera.recorder = null;
    state.camera.discardRecording = false;
    if (!discard && chunks.length) {
      const type = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunks, { type });
      const file = new File([blob], `nivra-video-${Date.now()}.${type.includes("mp4") ? "mp4" : "webm"}`, { type });
      await sendFileAttachment(file, { capture: "camera-video", deleteAfterRead: state.camera.viewOnce });
      closeModal();
    } else {
      render();
      attachCameraPreview();
    }
  };
  recorder.start(500);
  render();
  attachCameraPreview();
}

function stopCameraRecording() {
  if (state.camera.recorder?.state === "recording") {
    state.camera.recorder.stop();
  }
}

function stopCameraStream({ discardRecording = false, keepState = false } = {}) {
  if (discardRecording && state.camera.recorder?.state === "recording") {
    state.camera.discardRecording = true;
    state.camera.recorder.stop();
  }
  state.camera.stream?.getTracks().forEach((track) => track.stop());
  state.camera.stream = null;
  if (!keepState) {
    state.camera.recording = false;
    state.camera.recorder = null;
    state.camera.chunks = [];
    state.camera.discardRecording = false;
  }
}

function bindVoiceNoteButton(button) {
  if (!button) return;

  const isSyntheticMouseAfterTouch = () => Date.now() - state.voice.lastTouchAt < 700;
  const beginPress = (event) => {
    event.preventDefault();
    startVoiceNoteRecording();
  };
  const endPress = (event, options = {}) => {
    event.preventDefault();
    stopVoiceNoteRecording(options);
  };

  button.addEventListener("touchstart", (event) => {
    state.voice.lastTouchAt = Date.now();
    beginPress(event);
  }, { passive: false });
  button.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || isSyntheticMouseAfterTouch()) return;
    beginPress(event);
  });
  button.addEventListener("touchend", (event) => {
    state.voice.lastTouchAt = Date.now();
    endPress(event);
  }, { passive: false });
  button.addEventListener("touchcancel", (event) => {
    state.voice.lastTouchAt = Date.now();
    endPress(event, { cancel: true });
  }, { passive: false });
  button.addEventListener("mouseup", (event) => {
    if (event.button !== 0 || isSyntheticMouseAfterTouch()) return;
    endPress(event);
  });
  button.addEventListener("mouseleave", (event) => {
    if (isSyntheticMouseAfterTouch()) return;
    if (event.buttons !== 1 && !state.voice.recording && !state.voice.starting) return;
    endPress(event);
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (state.voice.justRecorded) {
      state.voice.justRecorded = false;
      return;
    }
    showVoiceHoldHint();
  });
}

async function startVoiceNoteRecording() {
  if (state.voice.recording || state.voice.starting) return;
  if (!selectedConversation()) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("Este navegador no soporta notas de voz.");
    return;
  }
  const startedAt = Date.now();
  const sessionId = state.voice.sessionId + 1;
  state.voice.sessionId = sessionId;
  state.voice.starting = true;
  state.voice.startedAt = startedAt;
  state.voice.recordingStartTime = startedAt;
  state.voice.stopRequested = false;
  state.voice.discardRecording = false;
  state.voice.chunks = [];
  clearVoiceHoldHint();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (sessionId !== state.voice.sessionId || state.voice.stopRequested) {
      const shortPress = state.voice.discardRecording || voiceRecordingDuration() < VOICE_NOTE_MIN_DURATION_MS;
      stream.getTracks().forEach((track) => track.stop());
      resetVoiceRecordingState();
      if (shortPress) showVoiceHoldHint();
      return;
    }
    const mimeType = preferredRecorderType([
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus"
    ]);
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.voice.stream = stream;
    state.voice.recorder = recorder;
    state.voice.starting = false;
    state.voice.recording = true;
    recorder.ondataavailable = (event) => {
      if (event.data?.size) state.voice.chunks.push(event.data);
    };
    recorder.onstop = () => handleVoiceRecordingStop(recorder, sessionId);
    recorder.start(250);
    navigator.vibrate?.(30);
    sendTypingState("recording", { force: true });
    setVoiceRecordingUi(true);
    updateVoiceRecordingHud();
    clearInterval(state.voice.timer);
    state.voice.timer = setInterval(updateVoiceRecordingHud, 250);
  } catch (error) {
    resetVoiceRecordingState();
    toast(error.message || "Permite el microfono para grabar.");
  }
}

function stopVoiceNoteRecording({ cancel = false } = {}) {
  const durationMs = voiceRecordingDuration();
  const tooShort = durationMs < VOICE_NOTE_MIN_DURATION_MS;
  if (state.voice.starting && !state.voice.recorder) {
    state.voice.stopRequested = true;
    state.voice.discardRecording = cancel || tooShort;
    state.voice.justRecorded = true;
    if (tooShort) showVoiceHoldHint();
    return;
  }
  if (!state.voice.recording) return;
  state.voice.stopRequested = true;
  state.voice.discardRecording = cancel || tooShort;
  state.voice.justRecorded = true;
  const recorder = state.voice.recorder;
  if (recorder?.state === "recording") {
    try {
      recorder.requestData?.();
    } catch {
      // Some WebView implementations throw if the recorder is already flushing.
    }
    recorder.stop();
  }
}

async function handleVoiceRecordingStop(recorder, sessionId) {
  if (sessionId !== state.voice.sessionId) return;
  const chunks = state.voice.chunks.splice(0);
  const discard = state.voice.discardRecording;
  const durationMs = voiceRecordingDuration();
  const tooShort = durationMs < VOICE_NOTE_MIN_DURATION_MS;
  resetVoiceRecordingState();
  sendTypingState("stopped", { force: true });
  if (tooShort) {
    showVoiceHoldHint();
    return;
  }
  if (discard) return;
  if (!chunks.length) {
    toast("No se capturo audio. Intenta otra vez.");
    return;
  }
  const type = recorder?.mimeType || "audio/webm";
  const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const blob = new Blob(chunks, { type });
  if (!blob.size) {
    toast("No se capturo audio. Intenta otra vez.");
    return;
  }
  const file = new File([blob], `nota-voz-${Date.now()}.${extension}`, { type });
  await sendFileAttachment(file, { voiceNote: true, capture: "voice-note", durationMs });
  render();
}

function voiceRecordingDuration() {
  const startedAt = state.voice.recordingStartTime || state.voice.startedAt || Date.now();
  return Date.now() - startedAt;
}

function resetVoiceRecordingState() {
  state.voice.stream?.getTracks().forEach((track) => track.stop());
  state.voice.stream = null;
  state.voice.recorder = null;
  state.voice.chunks = [];
  state.voice.starting = false;
  state.voice.recording = false;
  state.voice.startedAt = null;
  state.voice.recordingStartTime = null;
  state.voice.stopRequested = false;
  state.voice.discardRecording = false;
  clearInterval(state.voice.timer);
  state.voice.timer = null;
  setVoiceRecordingUi(false);
}

function setVoiceRecordingUi(active) {
  document.body.classList.toggle("recording-voice", active);
  document.querySelector("#voiceNoteBtn")?.classList.toggle("recording", active);
  let hud = document.querySelector("#voiceRecordingHud");
  if (active && !hud) {
    hud = document.createElement("div");
    hud.id = "voiceRecordingHud";
    hud.className = "recording-hud";
    hud.innerHTML = `<span></span><strong>Grabando nota de voz</strong><small data-voice-duration>Suelta para enviar</small>`;
    document.body.appendChild(hud);
  }
  if (!active) hud?.remove();
}

function showVoiceHoldHint() {
  clearVoiceHoldHint();
  let hud = document.querySelector("#voiceRecordingHud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "voiceRecordingHud";
    document.body.appendChild(hud);
  }
  hud.className = "recording-hud recording-hud-hint";
  hud.innerHTML = `<span></span><strong>Manten presionado para grabar</strong><small>La nota debe durar al menos 0.5 s</small>`;
  navigator.vibrate?.([18, 28, 18]);
  state.voice.hintTimer = setTimeout(clearVoiceHoldHint, 1200);
}

function clearVoiceHoldHint() {
  clearTimeout(state.voice.hintTimer);
  state.voice.hintTimer = null;
  const hud = document.querySelector("#voiceRecordingHud.recording-hud-hint");
  hud?.remove();
}

function updateVoiceRecordingHud() {
  const node = document.querySelector("[data-voice-duration]");
  if (!node || !state.voice.startedAt) return;
  node.textContent = `Suelta para enviar - ${formatDuration(voiceRecordingDuration())}`;
}

function renderVoiceRecordingHud() {
  return state.voice.recording
    ? `<div id="voiceRecordingHud" class="recording-hud"><span></span><strong>Grabando nota de voz</strong><small data-voice-duration>Suelta para enviar</small></div>`
    : "";
}

function preferredRecorderType(types) {
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function handleIncomingMessage(message) {
  if (!message?.id) return;
  if (state.seenMessageIds.has(message.id) && findMessage(message.id)) {
    ackDeliveredMessages([message.id]).catch(() => {});
    return;
  }
  await applyMessageEnvelope(message, { markSeen: true, notifyReceipt: true });
}

async function loadConversationHistory(conversationId, shouldRender = true) {
  if (!conversationId || !state.auth?.tokens?.accessToken) return;
  try {
    await loadLocalConversationMessages(conversationId, false);
    const history = await request(`/conversations/${conversationId}/messages?take=${MESSAGE_PAGE_SIZE}`);
    let index = 0;
    for (const message of history || []) {
      await applyMessageEnvelope(message, { markSeen: false, notifyReceipt: false, scroll: false });
      await breatheMainThread(++index);
    }
    updateConversationPaging(conversationId, state.messages.get(conversationId) || []);
    if (shouldRender) render();
  } catch {
    // History is best-effort; realtime and polling still keep the chat usable.
  }
}

async function applyMessageEnvelope(message, { markSeen, notifyReceipt, scroll = true, persistSeen = true }) {
  const recipient = message.recipients?.find((item) => item.deviceId === state.auth.device.id);
  if (!recipient) return;
  const payload = isServerSystemMessage(message, recipient)
    ? decodeServerSystemMessage(recipient)
    : await decryptEnvelope(recipient.header, recipient.ciphertext).catch(() => ({ type: "sealed", text: "Contenido cifrado no disponible en este dispositivo." }));
  if (markSeen) {
    state.seenMessageIds.add(message.id);
    if (persistSeen) saveJson("nivra.seen", [...state.seenMessageIds]);
  }

  if (payload.type === "reaction") {
    const target = findMessage(payload.targetMessageId);
    if (target) {
      target.reactions = [...(target.reactions || []), payload.emoji || "+"];
      const location = findMessageLocation(target.id);
      if (location) persistLocalMessage(location.conversationId, target).catch(() => {});
      if (location) upsertMessageNode(location.conversationId, target.id);
    }
  } else if (payload.type === "edit") {
    const target = findMessage(payload.targetMessageId);
    if (target) {
      target.payload.text = payload.newText;
      target.status = "editado";
      const location = findMessageLocation(target.id);
      if (location) persistLocalMessage(location.conversationId, target).catch(() => {});
      if (location) upsertMessageNode(location.conversationId, target.id);
    }
  } else if (payload.type === "delete") {
    const target = findMessage(payload.targetMessageId);
    if (target) {
      target.payload = { type: "text", text: "Este mensaje fue eliminado", deleted: true };
      target.status = "eliminado";
      const location = findMessageLocation(target.id);
      if (location) persistLocalMessage(location.conversationId, target).catch(() => {});
      if (location) upsertMessageNode(location.conversationId, target.id);
    }
  } else {
    pushMessage(message.conversationId, {
      id: message.id,
      payload,
      mine: message.senderUserId === state.auth.user.id,
      senderAlias: state.aliasByUserId.get(message.senderUserId),
      at: message.serverReceivedAt,
      status: "entregado",
      expiresAt: message.expiresAt,
      deleteAfterRead: message.deleteAfterRead,
      receipts: message.receipts || []
    }, { scroll });
    if (notifyReceipt) notifyIncomingMessage(message, payload);
  }

  if (notifyReceipt) {
    ackDeliveredMessages([message.id]).catch(() => {});
  }
}

async function handleMessageDeletedEvent(payload) {
  const messageId = payload?.messageId || payload?.MessageId;
  if (!messageId) return;
  const location = findMessageLocation(messageId);
  if (!location) return;
  location.message.payload = { type: "text", text: "Este mensaje fue eliminado", deleted: true };
  location.message.status = "eliminado";
  await persistLocalMessage(location.conversationId, location.message).catch(() => {});
  upsertMessageNode(location.conversationId, messageId);
}

async function handleChatClearedEvent(payload) {
  const conversationId = payload?.conversationId || payload?.ConversationId;
  if (!conversationId) return;
  await purgeLocalConversation(conversationId);
  if ((payload?.mode || payload?.Mode) === "deleted") {
    state.conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
    state.archivedConversationIds.delete(conversationId);
    saveArchivedConversations();
    if (state.selectedConversationId === conversationId) {
      selectConversation(state.conversations[0]?.id || null);
    }
    render();
  }
}

async function pollPending() {
  await syncPendingMessages("poll");
}

async function syncPendingMessages(reason = "manual", options = {}) {
  if (!state.auth?.tokens?.accessToken) return;
  const now = Date.now();
  if (state.syncInFlight || (!options.force && now - state.lastSyncAt < SYNC_MIN_INTERVAL_MS)) return;
  state.syncInFlight = true;
  state.lastSyncAt = now;
  try {
    const packet = await request("/messages/sync");
    const pending = Array.isArray(packet) ? packet : packet?.messages || [];
    const deliveredIds = [];
    let changed = false;
    let index = 0;
    for (const message of pending) {
      if (!message?.id) continue;
      if (!state.seenMessageIds.has(message.id) || !findMessage(message.id)) {
        await applyMessageEnvelope(message, { markSeen: true, notifyReceipt: false, scroll: false, persistSeen: false });
        changed = true;
      }
      deliveredIds.push(message.id);
      await breatheMainThread(++index);
    }
    if (pending.length) saveJson("nivra.seen", [...state.seenMessageIds]);
    if (deliveredIds.length) {
      await ackDeliveredMessages(deliveredIds);
    }
    if (changed) renderConversationMessages(state.selectedConversationId, { replace: false });
  } catch {
    // Fallback sync is quiet by design.
  } finally {
    state.syncInFlight = false;
  }
}

async function ackDeliveredMessages(messageIds) {
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  if (!ids.length || !state.auth?.tokens?.accessToken) return;
  let index = 0;
  for (const id of ids) {
    await request(`/messages/${id}/receipt`, { method: "POST", body: { kind: "Delivered" } }).catch(() => {});
    await breatheMainThread(++index);
  }
}

async function markVisibleMessagesRead(conversationId = state.selectedConversationId) {
  if (!conversationId || state.privacy?.readReceipts === false || document.visibilityState === "hidden") return;
  const messages = state.messages.get(conversationId) || [];
  const unread = messages.filter((message) =>
    !message.mine &&
    !message.deleteAfterRead &&
    !state.readReceiptSentIds.has(message.id));
  let index = 0;
  for (const message of unread) {
    state.readReceiptSentIds.add(message.id);
    message.readAt = message.readAt || new Date().toISOString();
    persistLocalMessage(conversationId, message).catch(() => {});
    request(`/messages/${message.id}/receipt`, { method: "POST", body: { kind: "Read" } }).catch(() => {
      state.readReceiptSentIds.delete(message.id);
    });
    await breatheMainThread(++index);
  }
}

function handleMessageReceipt(payload = {}) {
  const messageId = payload.messageId || payload.MessageId;
  const userId = payload.userId || payload.UserId;
  const deviceId = payload.deviceId || payload.DeviceId;
  const kind = String(payload.kind || payload.Kind || "").toLowerCase();
  if (!messageId || !userId || !deviceId) return;
  const location = findMessageLocation(messageId);
  if (!location) return;
  const message = location.message;
  message.receipts = message.receipts || [];
  let receipt = message.receipts.find((item) => item.userId === userId && item.deviceId === deviceId);
  if (!receipt) {
    receipt = { userId, deviceId, deliveredAt: null, readAt: null, deletedAt: null };
    message.receipts.push(receipt);
  }
  const at = payload.at || payload.At || new Date().toISOString();
  if (kind.includes("read")) {
    receipt.readAt = at;
    receipt.deliveredAt = receipt.deliveredAt || at;
  } else if (kind.includes("delivered")) {
    receipt.deliveredAt = receipt.deliveredAt || at;
  } else if (kind.includes("deleted")) {
    receipt.deletedAt = at;
  }
  message.status = messageDeliveryState(message);
  persistLocalMessage(location.conversationId, message).catch(() => {});
  upsertMessageNode(location.conversationId, message.id, { scroll: false });
}

function startPolling() {
  clearInterval(state.polling);
  state.polling = setInterval(pollPending, SYNC_POLL_MS);
  syncPendingMessages("start", { force: true }).catch(() => {});
}

function realtimeHandler(label, handler) {
  return (...args) => Promise.resolve(handler(...args)).catch((error) => {
    console.warn(`Realtime handler failed: ${label}`, error);
  });
}

function scheduleRealtimeReconnect(reason = "closed", delay = navigator.onLine === false ? 6000 : 2500) {
  if (!state.auth?.tokens?.accessToken) return;
  clearTimeout(state.realtimeReconnectTimer);
  state.realtimeReconnectTimer = setTimeout(() => {
    state.realtimeReconnectTimer = null;
    connectRealtime().catch((error) => console.warn(`Realtime reconnect failed: ${reason}`, error));
  }, delay);
}

function detachRealtimeHandlers(connection) {
  [
    "message.received",
    "message.receipt",
    "conversation.typing",
    "presence.changed",
    "MessageDeleted",
    "ChatCleared",
    "conversation.created",
    "friend.requested",
    "friend.updated",
    "story.created",
    "story.worldCreated",
    "vault.invited",
    "vault.approved",
    "vault.message",
    "vault.closed",
    "vault.left",
    "call.started",
    "call.signal",
    "call.ended",
    "call.failed",
    "device.revoked",
    "device.listChanged"
  ].forEach((eventName) => connection?.off?.(eventName));
}

async function connectRealtime() {
  const hubState = window.signalR?.HubConnectionState || {};
  if ([hubState.Connected, hubState.Connecting, hubState.Reconnecting].includes(state.connection?.state)) {
    return;
  }
  if (state.connection) {
    const previous = state.connection;
    state.connection = null;
    detachRealtimeHandlers(previous);
    await previous.stop().catch(() => {});
  }
  if (!window.signalR || !state.auth?.tokens?.accessToken) return;
  clearTimeout(state.realtimeReconnectTimer);
  state.realtimeReconnectTimer = null;
  const builder = new signalR.HubConnectionBuilder()
    .withUrl(apiUrl("/hubs/realtime"), { accessTokenFactory: () => state.auth.tokens.accessToken, withCredentials: false })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000]);
  if (signalR.LogLevel) {
    builder.configureLogging(signalR.LogLevel.None ?? signalR.LogLevel.Critical);
  }
  const connection = builder.build();

  detachRealtimeHandlers(connection);
  connection.on("message.received", realtimeHandler("message.received", handleIncomingMessage));
  connection.on("message.receipt", realtimeHandler("message.receipt", handleMessageReceipt));
  connection.on("conversation.typing", realtimeHandler("conversation.typing", handleConversationTyping));
  connection.on("presence.changed", realtimeHandler("presence.changed", handlePresenceChanged));
  connection.on("MessageDeleted", realtimeHandler("MessageDeleted", handleMessageDeletedEvent));
  connection.on("ChatCleared", realtimeHandler("ChatCleared", handleChatClearedEvent));
  connection.on("conversation.created", realtimeHandler("conversation.created", async () => {
    await bootstrap();
  }));
  connection.on("friend.requested", realtimeHandler("friend.requested", async () => {
    await bootstrap();
    toast("Nueva solicitud de amistad.");
  }));
  connection.on("friend.updated", realtimeHandler("friend.updated", async () => {
    await bootstrap();
  }));
  connection.on("story.created", realtimeHandler("story.created", async () => {
    await bootstrap();
  }));
  connection.on("story.worldCreated", realtimeHandler("story.worldCreated", async () => {
    await bootstrap();
  }));
  connection.on("vault.invited", realtimeHandler("vault.invited", async () => {
    await bootstrap();
    toast("Te invitaron a una boveda.");
  }));
  connection.on("vault.approved", realtimeHandler("vault.approved", async () => {
    await bootstrap();
    toast("Entrada a boveda aprobada.");
  }));
  connection.on("vault.message", realtimeHandler("vault.message", handleVaultRealtimeMessage));
  connection.on("vault.closed", realtimeHandler("vault.closed", async (payload) => {
    state.vaultActiveRoomId = state.vaultActiveRoomId === payload.roomId ? null : state.vaultActiveRoomId;
    state.vaultLobbyRoomId = state.vaultLobbyRoomId === payload.roomId ? null : state.vaultLobbyRoomId;
    await bootstrap();
    render();
    toast("La boveda se cerro al salir un participante.");
  }));
  connection.on("vault.left", realtimeHandler("vault.left", async () => {
    await bootstrap();
    render();
  }));
  connection.on("call.started", realtimeHandler("call.started", handleIncomingCall));
  connection.on("call.signal", realtimeHandler("call.signal", handleCallSignal));
  connection.on("call.ended", realtimeHandler("call.ended", handleCallEnded));
  connection.on("call.failed", realtimeHandler("call.failed", (payload) => {
    stopCallTones();
    resetCallState();
    render();
    toast(payload?.message || "No se pudo iniciar la llamada.");
  }));
  connection.on("device.revoked", realtimeHandler("device.revoked", (payload) => {
    if (!payload?.deviceId || payload.deviceId === state.auth?.device?.id) {
      toast("Esta sesion fue revocada.");
      clearSession();
      return;
    }
    bootstrap();
  }));
  connection.on("device.listChanged", realtimeHandler("device.listChanged", async () => {
    await bootstrap();
  }));
  connection.onreconnecting((error) => {
    if (error) console.warn("Realtime reconnecting.", error);
    toast("Reconectando en tiempo real...");
  });
  connection.onreconnected(realtimeHandler("reconnected", async () => {
    state.connection = connection;
    await joinSelectedConversation();
    await joinVaultRoomRealtime(state.vaultActiveRoomId);
    await refreshPresence();
    await bootstrap().catch(() => {});
    await syncPendingMessages("reconnected", { force: true }).catch(() => {});
    render();
  }));
  connection.onclose((error) => {
    if (error) console.warn("Realtime closed.", error);
    if (state.connection !== connection) return;
    state.connection = null;
    scheduleRealtimeReconnect("closed");
  });

  try {
    await connection.start();
    state.connection = connection;
    await joinSelectedConversation();
    await joinVaultRoomRealtime(state.vaultActiveRoomId);
    await refreshPresence();
    await syncPendingMessages("connected", { force: true }).catch(() => {});
  } catch (error) {
    state.connection = null;
    detachRealtimeHandlers(connection);
    await connection.stop().catch(() => {});
    console.warn("Realtime start deferred.", error);
    scheduleRealtimeReconnect("start", navigator.onLine === false ? 6000 : 2500);
  }
}

async function ensureRealtimeConnection() {
  if (state.connection?.state === window.signalR?.HubConnectionState.Connected) {
    return state.connection;
  }
  await connectRealtime();
  if (state.connection?.state === window.signalR?.HubConnectionState.Connected) {
    return state.connection;
  }
  throw new Error("Realtime no esta conectado.");
}

async function joinSelectedConversation() {
  if (state.connection && state.selectedConversationId) {
    await state.connection.invoke("JoinConversation", state.selectedConversationId).catch(() => {});
  }
}

async function handleVaultPin(event) {
  event.preventDefault();
  const pin = document.querySelector("#vaultPin").value;
  const meta = loadJson(vaultMetaKey());
  try {
    if (!meta) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveVaultKey(pin, salt);
      const verifier = await encryptWithKey(key, { ok: true, createdAt: new Date().toISOString() });
      saveJson(vaultMetaKey(), { salt: b64(salt), verifier });
      state.vault = { unlocked: true, key, decoded: new Map() };
      await decodeVaultItems();
    } else {
      const key = await deriveVaultKey(pin, ub64(meta.salt));
      await decryptWithKey(key, meta.verifier);
      state.vault = { unlocked: true, key, decoded: new Map() };
      await decodeVaultItems();
    }
    render();
  } catch {
    toast("PIN incorrecto.");
  }
}

async function handleVaultNote(event) {
  event.preventDefault();
  const title = document.querySelector("#vaultTitle").value.trim() || "Nota privada";
  const body = document.querySelector("#vaultBody").value.trim();
  if (!body) return;
  const encryptedMetadata = JSON.stringify(await encryptWithKey(state.vault.key, { title, body }));
  await request("/vault/items", {
    method: "POST",
    body: { kind: "Note", encryptedMetadata, parentId: null, fileObjectId: null }
  });
  await bootstrap();
  await decodeVaultItems();
  state.view = "vault";
  state.vault.unlocked = true;
  render();
}

function decryptVaultPreview(encryptedMetadata) {
  return state.vault.decoded.get(encryptedMetadata) || { title: "Elemento cifrado", body: "Metadata protegida." };
}

async function decodeVaultItems() {
  if (!state.vault.key) return;
  state.vault.decoded = new Map();
  let index = 0;
  for (const item of state.vaultItems) {
    try {
      const envelope = JSON.parse(item.encryptedMetadata);
      const decoded = await decryptWithKey(state.vault.key, envelope);
      state.vault.decoded.set(item.encryptedMetadata, decoded);
    } catch {
      state.vault.decoded.set(item.encryptedMetadata, { title: item.kind, body: "No se pudo descifrar en este dispositivo." });
    }
    await breatheMainThread(++index);
  }
}

async function togglePrivacy(key) {
  await updatePrivacy({ [key]: !state.privacy?.[key] });
}

async function updatePrivacy(patch) {
  try {
    state.privacy = await request("/privacy", { method: "PATCH", body: patch });
    render();
  } catch {
    toast("No se pudo actualizar privacidad.");
  }
}

async function handleProfile(event) {
  event.preventDefault();
  const photo = state.pendingProfilePhoto === undefined ? state.auth.user.profilePhotoDataUrl || null : state.pendingProfilePhoto;
  const user = await request("/me", {
    method: "PATCH",
    body: {
      displayName: document.querySelector("#profileName").value.trim(),
      email: document.querySelector("#profileEmail").value.trim() || null,
      phone: document.querySelector("#profilePhone").value.trim() || null,
      bio: document.querySelector("#profileBio").value.trim() || null,
      profilePhotoDataUrl: photo,
      isDiscoverable: document.querySelector("#profileDiscoverable").checked
    }
  });
  state.auth.user = user;
  state.pendingProfilePhoto = undefined;
  saveJson("nivra.auth", state.auth);
  render();
  toast("Perfil actualizado.");
}

function previewProfilePhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 280 * 1024) {
    toast("Usa una imagen menor a 280 KB.");
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.pendingProfilePhoto = reader.result;
    toast("Foto lista para guardar.");
  };
  reader.readAsDataURL(file);
}

async function startCall(type) {
  const conversation = selectedConversation();
  if (!conversation) return;
  try {
    await prepareCallMedia(type === "Video");
    const connection = await ensureRealtimeConnection();
    const call = await connection.invoke("CallUser", { type, conversationId: conversation.id, participantUserIds: [] });
    state.call.current = call;
    state.call.phase = "dialing";
    state.call.startedAt = new Date().toISOString();
    state.view = "calls";
    startCallTicker();
    playCallTone("outgoing");
    render();
    await establishCallPeers();
    await flushPendingCallSignals();
    toast(`${type === "Video" ? "Videollamada" : "Llamada"} iniciada.`);
  } catch (error) {
    stopCallMedia();
    stopCallTones();
    toast(error.message || "No se pudo iniciar llamada.");
  }
}

async function handleIncomingCall(call, options = {}) {
  if (!call?.id) return;
  if (call.initiatorUserId === state.auth.user.id && state.call.current?.id === call.id) return;
  if (call.initiatorUserId === state.auth.user.id && state.call.phase !== "idle") return;
  if (state.call.current && state.call.current.id !== call.id && state.call.phase !== "idle") {
    await sendCallSignal(call, call.initiatorUserId, "busy", "busy").catch(() => {});
    return;
  }
  state.call.current = call;
  state.call.phase = call.initiatorUserId === state.auth.user.id ? "dialing" : "incoming";
  state.call.startedAt = call.startedAt || new Date().toISOString();
  startCallTicker();
  if (state.call.phase === "incoming") {
    playCallTone("incoming");
    if (options.notify !== false) notifyIncomingCall(call);
  } else {
    playCallTone("outgoing");
  }
  render();
  if (state.call.phase !== "incoming") {
    flushPendingCallSignals().catch(() => {});
  }
}

async function acceptCall() {
  const call = state.call.current;
  if (!call) return;
  try {
    await prepareCallMedia(call.type === "Video");
    state.call.phase = "active";
    state.call.startedAt = new Date().toISOString();
    stopCallTones();
    startCallTicker();
    await Promise.all(call.participantUserIds
      .filter((userId) => userId !== state.auth.user.id)
      .map((userId) => sendCallSignal(call, userId, "accepted", { accepted: true }).catch(() => {})));
    await establishCallPeers();
    await flushPendingCallSignals();
    render();
  } catch (error) {
    toast(error.message || "No se pudo aceptar la llamada.");
  }
}

async function declineCall() {
  const call = state.call.current;
  if (!call) return;
  try {
    await sendCallSignal(call, call.initiatorUserId, "declined", "declined").catch(() => {});
    await request(`/calls/${call.id}/end`, { method: "POST" }).catch(() => {});
  } finally {
    resetCallState();
    render();
  }
}

async function endCurrentCall() {
  const call = state.call.current;
  if (!call) return;
  try {
    await request(`/calls/${call.id}/end`, { method: "POST" });
  } catch {
    // Ending locally should still close the UI.
  }
  resetCallState();
  render();
}

async function sendCallSignal(call, targetUserId, signalType, payload) {
  if (!call?.id || !targetUserId || targetUserId === state.auth.user.id) return;
  await request(`/calls/${call.id}/signal`, {
    method: "POST",
    body: {
      targetUserId,
      signalType,
      payloadCiphertext: encodeCallSignalPayload({ type: signalType, payload, at: new Date().toISOString() })
    }
  });
}

async function handleCallSignal(signal) {
  const call = state.call.current;
  const signalType = signal.signalType || signal.SignalType;
  const callId = signal.callId || signal.CallId;
  const fromUserId = signal.fromUserId || signal.FromUserId;
  if (!callId || !call || callId !== call.id) {
    if (callId) state.call.pendingSignals.push(signal);
    return;
  }
  if (signalType === "accepted") {
    if (state.call.phase === "incoming") {
      state.call.pendingSignals.push(signal);
      return;
    }
    state.call.phase = "active";
    state.call.startedAt = new Date().toISOString();
    stopCallTones();
    startCallTicker();
    await establishAcceptedCallPeer(fromUserId);
    render();
    return;
  }
  if (signalType === "declined" || signalType === "busy") {
    stopCallTones();
    toast(signalType === "busy" ? "El contacto esta en otra llamada." : "Llamada rechazada.");
    resetCallState();
    render();
    return;
  }
  if (signalType === "offer" || signalType === "answer" || signalType === "ice") {
    if (state.call.phase === "incoming") {
      state.call.pendingSignals.push(signal);
      return;
    }
    await handleWebRtcSignal(signal);
    return;
  }
  if (signalType === "muted" || signalType === "camera") {
    updateRemoteCallState(fromUserId, signalType, decodeCallSignalPayload(signal)?.payload);
    render();
  }
}

async function handleCallEnded(call) {
  if (state.call.current?.id !== call.id) return;
  stopCallTones();
  resetCallState();
  render();
  toast("Llamada finalizada.");
}

async function prepareCallMedia(withVideo) {
  stopCallMedia();
  state.call.muted = false;
  state.call.cameraOff = false;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador no expone microfono/camara.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo }).catch((error) => {
    console.warn("getUserMedia failed", error);
    throw new Error(withVideo ? "Permite camara y microfono para la videollamada." : "Permite el microfono para la llamada.");
  });
  state.call.localStream = stream;
  return stream;
}

function attachCallMedia() {
  const video = document.querySelector("#localCallVideo");
  if (video && state.call.localStream) {
    video.srcObject = state.call.localStream;
    video.play?.().catch(() => {});
  }
  for (const [userId, stream] of state.call.remoteStreams.entries()) {
    const remoteVideo = document.querySelector(`#remoteCallVideo-${safeDomId(userId)}`);
    const remoteAudio = document.querySelector(`#remoteCallAudio-${safeDomId(userId)}`);
    if (remoteVideo) {
      remoteVideo.srcObject = stream;
      remoteVideo.play?.().catch(() => {});
    }
    if (remoteAudio) {
      remoteAudio.srcObject = stream;
      remoteAudio.muted = !state.call.speaker;
      remoteAudio.play?.().catch(() => {});
    }
  }
}

function toggleCallMute() {
  state.call.muted = !state.call.muted;
  state.call.localStream?.getAudioTracks().forEach((track) => track.enabled = !state.call.muted);
  broadcastLocalCallControl("muted", state.call.muted);
  render();
}

function toggleCallCamera() {
  state.call.cameraOff = !state.call.cameraOff;
  state.call.localStream?.getVideoTracks().forEach((track) => track.enabled = !state.call.cameraOff);
  broadcastLocalCallControl("camera", state.call.cameraOff ? "off" : "on");
  render();
}

function toggleCallSpeaker() {
  state.call.speaker = !state.call.speaker;
  render();
}

function broadcastLocalCallControl(signalType, payload) {
  const call = state.call.current;
  if (!call) return;
  call.participantUserIds
    .filter((userId) => userId !== state.auth.user.id)
    .forEach((userId) => sendCallSignal(call, userId, signalType, payload).catch(() => {}));
}

async function establishCallPeers(onlyUserId = null) {
  const call = state.call.current;
  if (!call || !state.call.localStream) return;
  const peers = call.participantUserIds
    .filter((userId) => userId !== state.auth.user.id)
    .filter((userId) => !onlyUserId || userId === onlyUserId);
  for (const userId of peers) {
    ensurePeerConnection(userId);
    if (shouldCreateOfferTo(userId)) {
      await createAndSendOffer(userId);
    }
  }
}

async function establishAcceptedCallPeer(userId) {
  const peer = state.call.peers.get(userId);
  if (shouldCreateOfferTo(userId) && peer?.connection && !peer.connection.remoteDescription) {
    peer.connection.close();
    state.call.peers.delete(userId);
    state.call.remoteStreams.delete(userId);
  }
  await establishCallPeers(userId);
}

function ensurePeerConnection(userId) {
  if (!window.RTCPeerConnection) {
    toast("Este navegador no soporta WebRTC.");
    return null;
  }
  const existing = state.call.peers.get(userId);
  if (existing?.connection) return existing.connection;

  const connection = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" }
    ]
  });
  const peer = { connection, pendingIce: [] };
  state.call.peers.set(userId, peer);

  state.call.localStream?.getTracks().forEach((track) => {
    connection.addTrack(track, state.call.localStream);
  });

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      sendCallSignal(state.call.current, userId, "ice", { candidate: event.candidate.toJSON() }).catch(() => {});
    }
  };
  connection.ontrack = (event) => {
    const stream = event.streams?.[0] || state.call.remoteStreams.get(userId) || new MediaStream();
    if (!event.streams?.[0] && event.track) stream.addTrack(event.track);
    state.call.remoteStreams.set(userId, stream);
    attachCallMedia();
  };
  connection.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(connection.connectionState)) {
      state.call.remoteStreams.delete(userId);
      render();
    }
  };

  return connection;
}

function shouldCreateOfferTo(userId) {
  return String(state.auth.user.id) < String(userId);
}

async function createAndSendOffer(userId) {
  const connection = ensurePeerConnection(userId);
  if (!connection) return;
  if (connection.signalingState !== "stable") return;
  const offer = await connection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: state.call.current?.type === "Video" });
  await connection.setLocalDescription(offer);
  await sendCallSignal(state.call.current, userId, "offer", { description: connection.localDescription });
}

async function handleWebRtcSignal(signal) {
  const signalType = signal.signalType || signal.SignalType;
  const fromUserId = signal.fromUserId || signal.FromUserId;
  const payload = decodeCallSignalPayload(signal)?.payload;
  if (!fromUserId || !payload) return;
  if (!state.call.localStream) await prepareCallMedia(state.call.current?.type === "Video");
  const connection = ensurePeerConnection(fromUserId);
  if (!connection) return;
  const peer = state.call.peers.get(fromUserId);

  if (signalType === "offer") {
    if (connection.signalingState !== "stable") {
      await Promise.all([
        connection.setLocalDescription({ type: "rollback" }).catch(() => {}),
        connection.setRemoteDescription(new RTCSessionDescription(payload.description))
      ]);
    } else {
      await connection.setRemoteDescription(new RTCSessionDescription(payload.description));
    }
    await flushPeerIce(fromUserId);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await sendCallSignal(state.call.current, fromUserId, "answer", { description: connection.localDescription });
    state.call.phase = "active";
    startCallTicker();
    render();
    return;
  }

  if (signalType === "answer") {
    if (payload.description && connection.signalingState !== "stable") {
      await connection.setRemoteDescription(new RTCSessionDescription(payload.description));
      await flushPeerIce(fromUserId);
    }
    state.call.phase = "active";
    startCallTicker();
    render();
    return;
  }

  if (signalType === "ice" && payload.candidate) {
    const candidate = new RTCIceCandidate(payload.candidate);
    if (connection.remoteDescription) {
      await connection.addIceCandidate(candidate).catch(() => {});
    } else {
      peer.pendingIce.push(candidate);
    }
  }
}

async function flushPeerIce(userId) {
  const peer = state.call.peers.get(userId);
  if (!peer?.pendingIce.length) return;
  const candidates = peer.pendingIce.splice(0);
  for (const candidate of candidates) {
    await peer.connection.addIceCandidate(candidate).catch(() => {});
  }
}

async function flushPendingCallSignals() {
  const pending = state.call.pendingSignals.splice(0);
  for (const signal of pending) {
    await handleCallSignal(signal);
  }
}

function encodeCallSignalPayload(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function decodeCallSignalPayload(signal) {
  try {
    const value = signal.payloadCiphertext || signal.PayloadCiphertext || "";
    return JSON.parse(decodeURIComponent(escape(atob(value))));
  } catch {
    return null;
  }
}

function updateRemoteCallState(userId, key, value) {
  if (!userId) return;
  const stateForUser = state.call.remoteStates.get(userId) || {};
  stateForUser[key] = value;
  state.call.remoteStates.set(userId, stateForUser);
}

function resetCallState() {
  stopCallTicker();
  stopCallTones();
  closePeerConnections();
  stopCallMedia();
  state.call.current = null;
  state.call.phase = "idle";
  state.call.muted = false;
  state.call.cameraOff = false;
  state.call.speaker = true;
  state.call.startedAt = null;
  state.call.pendingSignals = [];
  state.call.remoteStates = new Map();
}

function stopCallMedia() {
  state.call.localStream?.getTracks().forEach((track) => track.stop());
  state.call.localStream = null;
}

function closePeerConnections() {
  for (const peer of state.call.peers.values()) {
    peer.connection?.close?.();
  }
  state.call.peers = new Map();
  state.call.remoteStreams = new Map();
}

function startCallTicker() {
  clearInterval(state.call.ticker);
  state.call.ticker = setInterval(() => {
    if (!state.call.current || state.call.phase === "idle") {
      stopCallTicker();
      return;
    }
    document.querySelectorAll("[data-call-status]").forEach((node) => {
      node.textContent = callStatusText();
    });
    document.querySelectorAll("[data-call-duration]").forEach((node) => {
      node.textContent = callDurationText();
    });
  }, 1000);
}

function stopCallTicker() {
  clearInterval(state.call.ticker);
  state.call.ticker = null;
}

async function refreshSession() {
  try {
    const refreshed = await refreshToken();
    if (!refreshed) throw new Error("No se pudo renovar.");
    await connectRealtime();
    toast("Sesion renovada.");
  } catch {
    toast("No se pudo renovar.");
  }
}

async function logout(options = {}) {
  const skipServer = Boolean(options?.skipServer);
  if (!skipServer) {
    await request("/auth/logout", { method: "POST", skipAuthRefresh: true }).catch(() => {});
  }
  clearSession();
}

async function revokeDevice(deviceId) {
  if (!deviceId) return;
  try {
    await request(`/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    if (deviceId === state.auth.device.id) {
      toast("Sesion cerrada en este dispositivo.");
      clearSession();
      return;
    }
    await bootstrap();
    toast("Dispositivo revocado.");
  } catch (error) {
    toast(error.message || "No se pudo revocar el dispositivo.");
  }
}

async function deleteAccount() {
  state.modal = "deleteAccount";
  render();
}

async function handleDeleteAccountSubmit(event) {
  event.preventDefault();
  const confirmation = document.querySelector("#deleteAccountConfirm")?.value.trim();
  if (confirmation !== "DELETE") return;
  await request("/data/delete-request", { method: "POST", body: { confirmation: "DELETE" } }).catch(() => {});
  clearSession();
}

function clearSession() {
  resetCallState();
  cleanupObjectUrls({ keepVisible: false });
  clearTimeout(state.searchTimer);
  clearTimeout(state.contactSearchTimer);
  clearTimeout(state.chatSearchTimer);
  clearTimeout(state.vaultInviteTimer);
  localStorage.removeItem("nivra.auth");
  state.auth = null;
  const previous = state.connection;
  state.connection = null;
  detachRealtimeHandlers(previous);
  previous?.stop().catch(() => {});
  state.pushReady = false;
  state.syncInFlight = false;
  clearInterval(state.polling);
  render();
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!options.rawBody) headers["Content-Type"] = "application/json";
  if (!options.skipAuth && state.auth?.tokens?.accessToken) {
    headers.Authorization = `Bearer ${state.auth.tokens.accessToken}`;
  }
  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers,
    body: options.rawBody || (options.body ? JSON.stringify(options.body) : undefined)
  });
  if (response.status === 401 && !options.skipAuth && !options.skipAuthRefresh && !options.authRetried) {
    const refreshed = await refreshToken();
    if (refreshed) return request(path, { ...options, authRetried: true });
    await logout({ silent: true, skipServer: true });
    const exception = new Error("Sesion expirada. Entra de nuevo.");
    exception.status = 401;
    exception.recovered = true;
    throw exception;
  }
  if (options.rawResponse && response.ok) return response;
  if (!response.ok) {
    let error = { message: `HTTP ${response.status}` };
    try {
      const errorText = await response.text();
      if (errorText) error = JSON.parse(errorText);
    } catch {}
    const exception = new Error(error.message || error.Message || error.code || "Request failed");
    exception.status = response.status;
    throw exception;
  }
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) return JSON.parse(text);
  try { return JSON.parse(text); } catch { return text; }
}

async function refreshToken() {
  const refreshTokenValue = state.auth?.tokens?.refreshToken;
  if (!refreshTokenValue) return false;
  if (!authRefreshPromise) {
    authRefreshPromise = (async () => {
      const response = await fetch(apiUrl("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refreshTokenValue })
      }).catch(() => null);
      if (!response?.ok) return false;
      const tokens = await response.json().catch(() => null);
      if (!tokens?.accessToken) return false;
      if (!state.auth?.tokens) return false;
      state.auth.tokens = tokens;
      saveJson("nivra.auth", state.auth);
      return true;
    })().finally(() => {
      authRefreshPromise = null;
    });
  }
  return authRefreshPromise;
}

async function prepareDeviceKeys({ alias = null, registration = false } = {}) {
  if (!registration) {
    const existing = await findReusableDeviceKeys(alias);
    if (existing) return materialToDeviceKeys(existing);
  }
  return createDeviceKeys();
}

async function findReusableDeviceKeys(alias) {
  const indexed = alias ? await localStore.latestDeviceKeysForAlias(alias) : await localStore.latestDeviceKeys();
  if (indexed) return indexed;

  const legacy = alias ? legacyKeyMaterialForAlias(alias) : latestLegacyKeyMaterial();
  if (legacy) {
    await localStore.putDeviceKeys(legacy).catch(() => {});
    return legacy;
  }
  return null;
}

async function createDeviceKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return materialToDeviceKeys({ publicJwk, privateJwk });
}

function materialToDeviceKeys(material) {
  const publicJwk = material.publicJwk;
  const privateJwk = material.privateJwk;
  return {
    publicJwk,
    privateJwk,
    keyBundle: {
      identityKey: JSON.stringify(publicJwk),
      signedPreKey: JSON.stringify(publicJwk),
      preKeySignature: "webcrypto-p256",
      oneTimePreKeys: []
    }
  };
}

async function saveDeviceKeys(alias, deviceId, privateJwk, publicJwk, metadata = {}) {
  const record = {
    ...metadata,
    alias,
    deviceId,
    privateJwk,
    publicJwk
  };
  await localStore.putDeviceKeys(record).catch(() => {});
  saveJson(`nivra.keys.${alias}.${deviceId}`, { privateJwk, publicJwk });
}

async function currentKeyMaterial() {
  if (!state.auth?.user?.alias || !state.auth?.device?.id) return null;
  const indexed = await localStore.getDeviceKeys(state.auth.user.alias, state.auth.device.id);
  if (indexed) return indexed;
  const legacy = loadJson(`nivra.keys.${state.auth.user.alias}.${state.auth.device.id}`);
  if (legacy?.privateJwk && legacy?.publicJwk) {
    await saveDeviceKeys(state.auth.user.alias, state.auth.device.id, legacy.privateJwk, legacy.publicJwk, { userId: state.auth.user.id });
    return { ...legacy, alias: state.auth.user.alias, deviceId: state.auth.device.id, userId: state.auth.user.id };
  }
  return null;
}

async function currentPublicKey() {
  return (await currentKeyMaterial())?.publicJwk;
}

function parsePublicJwk(value) {
  if (!value) return null;
  if (typeof value === "object" && value.kty) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed?.kty ? parsed : null;
  } catch {
    return null;
  }
}

async function encryptForPublicKey(publicJwk, payload) {
  const own = await currentKeyMaterial();
  if (!own?.privateJwk || !own?.publicJwk) throw new Error("No hay llave privada local para cifrar.");
  const privateKey = await crypto.subtle.importKey("jwk", own.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, TEXT.encode(JSON.stringify(payload)));
  return {
    ciphertext: b64(new Uint8Array(ciphertext)),
    header: JSON.stringify({ v: 1, alg: "ECDH-P256-A256GCM", senderPublicKey: own.publicJwk, iv: b64(iv) })
  };
}

async function decryptEnvelope(header, ciphertext) {
  const meta = JSON.parse(header || "{}");
  const own = await currentKeyMaterial();
  if (!own?.privateJwk) throw new Error("No hay llave privada local para descifrar.");
  const privateKey = await crypto.subtle.importKey("jwk", own.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const senderPublic = await crypto.subtle.importKey("jwk", meta.senderPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: senderPublic }, privateKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(meta.iv) }, key, ub64(ciphertext));
  return JSON.parse(READ.decode(plain));
}

async function createQrEphemeralKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["wrapKey", "unwrapKey"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk };
}

async function encryptQrPayload(publicJwk, payload) {
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, contentKey, TEXT.encode(JSON.stringify(payload)));
  const wrappedKey = await crypto.subtle.wrapKey("raw", contentKey, publicKey, { name: "RSA-OAEP" });
  return base64UrlJson({
    v: 1,
    alg: "RSA-OAEP-256+A256GCM",
    key: b64(new Uint8Array(wrappedKey)),
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext))
  });
}

async function decryptQrPayload(encryptedPayload, privateKey) {
  const envelope = typeof encryptedPayload === "string"
    ? (encryptedPayload.trim().startsWith("{") ? JSON.parse(encryptedPayload) : jsonFromBase64Url(encryptedPayload))
    : encryptedPayload;
  const contentKey = await crypto.subtle.unwrapKey(
    "raw",
    ub64(envelope.key),
    privateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(envelope.iv) }, contentKey, ub64(envelope.ciphertext));
  return JSON.parse(READ.decode(plain));
}

async function migrateLegacyKeyMaterial() {
  const records = allLegacyKeyMaterial();
  let index = 0;
  for (const record of records) {
    await localStore.putDeviceKeys(record).catch(() => {});
    await breatheMainThread(++index);
  }
}

function legacyKeyMaterialForAlias(alias) {
  return latestKeyRecord(allLegacyKeyMaterial().filter((record) => record.aliasLower === normalizeAlias(alias)));
}

function latestLegacyKeyMaterial() {
  return latestKeyRecord(allLegacyKeyMaterial());
}

function allLegacyKeyMaterial() {
  const records = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith("nivra.keys.")) continue;
      const match = key.match(/^nivra\.keys\.(.+)\.([^.]*)$/);
      const value = loadJson(key);
      if (!match || !value?.privateJwk || !value?.publicJwk) continue;
      const alias = match[1];
      const deviceId = match[2];
      records.push({
        id: deviceKeyStorageId(alias, deviceId),
        alias,
        aliasLower: normalizeAlias(alias),
        deviceId,
        privateJwk: value.privateJwk,
        publicJwk: value.publicJwk,
        createdAt: value.createdAt || new Date(0).toISOString(),
        updatedAt: value.updatedAt || new Date(0).toISOString()
      });
    }
  } catch {}
  return records;
}

async function encryptAttachment(buffer) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buffer);
  const rawKey = await crypto.subtle.exportKey("raw", key);
  return { bytes: encrypted, key: b64(new Uint8Array(rawKey)), iv: b64(iv) };
}

async function decryptAttachment(buffer, rawKey, iv) {
  const key = await crypto.subtle.importKey("raw", ub64(rawKey), { name: "AES-GCM" }, false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(iv) }, key, buffer);
}

async function deriveVaultKey(pin, salt) {
  const baseKey = await crypto.subtle.importKey("raw", TEXT.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptWithKey(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, TEXT.encode(JSON.stringify(value)));
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}

async function decryptWithKey(key, envelope) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(envelope.iv) }, key, ub64(envelope.ciphertext));
  return JSON.parse(READ.decode(plain));
}

async function directoryForUser(userId) {
  if (state.keyDirectory.has(userId)) return state.keyDirectory.get(userId);
  let alias = state.aliasByUserId.get(userId);
  if (!alias && userId) {
    const profile = await request(`/directory/users/${encodeURIComponent(userId)}`).catch(() => null);
    if (profile) {
      rememberProfile(profile, { persist: true });
      updateConversationProfileNodes(userId);
      alias = profile.alias;
    }
  }
  if (!alias) return null;
  const directory = await request(`/keys/${encodeURIComponent(alias)}`);
  cacheKeyDirectory(directory);
  return directory;
}

function cacheKeyDirectory(directory) {
  state.keyDirectory.set(directory.userId, directory);
  state.aliasByUserId.set(directory.userId, directory.alias);
}

function selectedConversation() {
  return state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
}

function selectConversation(conversationId) {
  state.selectedConversationId = conversationId || null;
  if (state.selectedConversationId) {
    saveJson("nivra.selectedConversationId", state.selectedConversationId);
  } else {
    localStorage.removeItem("nivra.selectedConversationId");
  }
}

function findDirectConversation(userId) {
  return state.conversations.find((conversation) =>
    conversation.type === "Direct" &&
    (conversation.participants || []).some((participant) => participant.userId === userId && !participant.removedAt));
}

function findKnownPerson(userId) {
  return state.directoryResults.find((item) => item.id === userId) ||
    state.chatSearch.results.find((item) => (item.id || item.userId) === userId) ||
    state.vaultInvite.results.find((item) => (item.id || item.userId) === userId) ||
    state.contacts.find((item) => item.userId === userId) ||
    state.stories.map((story) => story.owner).find((owner) => owner?.id === userId) ||
    state.vaultRooms.flatMap((room) => room.members || []).find((member) => member.userId === userId) ||
    state.profileByUserId.get(userId);
}

function mergePeople(...groups) {
  const map = new Map();
  groups.flat().filter(Boolean).forEach((person) => {
    const userId = person.id || person.userId;
    if (!userId || userId === state.auth?.user?.id) return;
    map.set(userId, { ...(map.get(userId) || {}), ...person, id: userId });
  });
  return [...map.values()];
}

function conversationPrimaryPerson(conversation) {
  const other = (conversation.participants || []).find((participant) => participant.userId !== state.auth?.user?.id && !participant.removedAt);
  if (!other) return null;
  return findKnownPerson(other.userId) || state.profileByUserId.get(other.userId) || { id: other.userId, userId: other.userId, alias: state.aliasByUserId.get(other.userId) || "Contacto" };
}

function conversationTitle(conversation) {
  const others = (conversation.participants || [])
    .filter((participant) => participant.userId !== state.auth?.user?.id && !participant.removedAt)
    .map((participant) => {
      const profile = findKnownPerson(participant.userId) || state.profileByUserId.get(participant.userId);
      return profile ? displayPerson(profile) : state.aliasByUserId.get(participant.userId) || "Contacto Nivra";
    });
  if (conversation.type === "Group") return others.length ? others.join(", ") : "Grupo Nivra";
  return others[0] || "Notas privadas";
}

function conversationSubtitle(conversation, { archived = false } = {}) {
  const typing = typingLabel(conversation.id, { compact: true });
  if (typing) return typing;
  const base = conversation.type === "Group"
    ? `${onlineParticipants(conversation).length}/${activeParticipantIds(conversation).length} en linea`
    : directPresenceLabel(conversation) || "Chat directo";
  return `${base} - ${formatTime(conversation.lastMessageAt || conversation.updatedAt)}${archived ? " - archivado" : ""}`;
}

function conversationTopbarSubtitle(conversation) {
  const typing = typingLabel(conversation.id);
  if (typing) return typing;
  if (conversation.type === "Direct") {
    return directPresenceLabel(conversation) || "Ultima vez no disponible";
  }
  return `${conversation.participants.length} participantes - ${onlineParticipants(conversation).length} en linea`;
}

function activeParticipantIds(conversation) {
  return (conversation?.participants || [])
    .filter((participant) => !participant.removedAt)
    .map((participant) => participant.userId);
}

function onlineParticipants(conversation) {
  return activeParticipantIds(conversation).filter((userId) => userId !== state.auth?.user?.id && state.presenceByUserId.get(userId)?.online);
}

function directPresenceLabel(conversation) {
  const other = (conversation?.participants || []).find((participant) => participant.userId !== state.auth?.user?.id && !participant.removedAt);
  if (!other) return null;
  const presence = state.presenceByUserId.get(other.userId);
  if (presence?.online) return "En linea";
  return presence?.lastSeenAt ? `Ultima vez ${formatTime(presence.lastSeenAt)}` : "Chat directo";
}

function typingKey(item) {
  return `${item.senderUserId}:${item.senderDeviceId || ""}`;
}

function activeTypingForConversation(conversationId) {
  const now = Date.now();
  const entries = state.typingByConversation.get(conversationId) || new Map();
  for (const [key, value] of entries.entries()) {
    if (!value.expiresAt || value.expiresAt <= now) entries.delete(key);
  }
  if (!entries.size) state.typingByConversation.delete(conversationId);
  return [...entries.values()];
}

function typingLabel(conversationId, { compact = false } = {}) {
  const entries = activeTypingForConversation(conversationId);
  if (!entries.length) return "";
  const recording = entries.find((item) => item.kind === "recording");
  const names = entries.slice(0, 2).map((item) => item.alias || "Contacto");
  const subject = names.length === 1 ? names[0] : `${names.join(", ")}${entries.length > 2 ? " +" + (entries.length - 2) : ""}`;
  const action = recording ? "grabando nota de voz" : "escribiendo";
  return compact ? `${subject} ${action}...` : `${subject} esta ${action}...`;
}

function updateTypingUi(conversationId) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  updateConversationPreview(conversationId);
  if (state.selectedConversationId === conversationId) {
    const strip = document.querySelector("#typingStrip");
    if (strip) strip.textContent = typingLabel(conversationId);
    document.querySelectorAll(`[data-topbar-subtitle="${cssEscape(conversationId)}"]`).forEach((node) => {
      node.textContent = conversationTopbarSubtitle(conversation);
    });
  }
}

function handleConversationTyping(payload = {}) {
  const conversationId = payload.conversationId;
  if (!conversationId || payload.senderDeviceId === state.auth?.device?.id) return;
  let data = {};
  try {
    data = JSON.parse(payload.encryptedState || "{}");
  } catch {
    data = { kind: payload.encryptedState || "typing" };
  }
  const entries = state.typingByConversation.get(conversationId) || new Map();
  const key = typingKey(payload);
  if (data.kind === "stopped") {
    entries.delete(key);
  } else {
    entries.set(key, {
      senderUserId: payload.senderUserId,
      senderDeviceId: payload.senderDeviceId,
      alias: state.aliasByUserId.get(payload.senderUserId) || "Contacto",
      kind: data.kind || "typing",
      expiresAt: Date.now() + 3600
    });
  }
  if (entries.size) state.typingByConversation.set(conversationId, entries);
  else state.typingByConversation.delete(conversationId);
  updateTypingUi(conversationId);
  setTimeout(() => updateTypingUi(conversationId), 3700);
}

function sendTypingState(kind = "typing", { force = false } = {}) {
  const conversationId = state.selectedConversationId;
  if (!conversationId || !state.connection) return;
  const now = Date.now();
  if (!force && kind === "typing" && now - state.lastTypingSentAt < 900) return;
  state.lastTypingSentAt = now;
  state.connection.invoke("Typing", conversationId, JSON.stringify({ kind, at: new Date().toISOString() })).catch(() => {});
  clearTimeout(state.typingStopTimer);
  if (kind !== "stopped") {
    state.typingStopTimer = setTimeout(() => sendTypingState("stopped", { force: true }), 1500);
  }
}

function handlePresenceChanged(payload = {}) {
  const userId = payload.userId || payload.UserId;
  if (!userId || userId === state.auth?.user?.id) return;
  state.presenceByUserId.set(userId, {
    online: Boolean(payload.online ?? payload.Online),
    lastSeenAt: payload.lastSeenAt || payload.LastSeenAt || new Date().toISOString()
  });
  state.conversations
    .filter((conversation) => activeParticipantIds(conversation).includes(userId))
    .forEach((conversation) => updateConversationPreview(conversation.id));
}

async function refreshPresence() {
  if (!state.connection) return;
  const userIds = conversationParticipantUserIds();
  if (!userIds.length) return;
  try {
    const items = await state.connection.invoke("Presence", userIds);
    (items || []).forEach(handlePresenceChanged);
  } catch {
    // Presence is a realtime nicety; message sync still works without it.
  }
}

function updateConversationProfileNodes(userId) {
  const touched = state.conversations.filter((conversation) =>
    (conversation.participants || []).some((participant) => participant.userId === userId));
  touched.forEach((conversation) => updateConversationPreview(conversation.id));
}

function updateConversationPreview(conversationId) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  const title = conversationTitle(conversation);
  const person = conversationPrimaryPerson(conversation);
  const subtitle = conversationSubtitle(conversation, { archived: state.archivedConversationIds.has(conversation.id) });
  document.querySelectorAll(`[data-conversation-title="${cssEscape(conversation.id)}"]`).forEach((node) => {
    node.textContent = title;
  });
  document.querySelectorAll(`[data-conversation-subtitle="${cssEscape(conversation.id)}"]`).forEach((node) => {
    node.textContent = subtitle;
  });
  document.querySelectorAll(`[data-conversation-avatar="${cssEscape(conversation.id)}"]`).forEach((node) => {
    node.replaceChildren(htmlToNode(avatarNode(person || title)));
  });
  document.querySelectorAll(`[data-topbar-title="${cssEscape(conversation.id)}"]`).forEach((node) => {
    node.textContent = title;
  });
  document.querySelectorAll(`[data-topbar-subtitle="${cssEscape(conversation.id)}"]`).forEach((node) => {
    node.textContent = conversationTopbarSubtitle(conversation);
  });
  document.querySelectorAll(`[data-topbar-avatar="${cssEscape(conversation.id)}"]`).forEach((node) => {
    node.replaceChildren(htmlToNode(avatarNode(person || title)));
  });
}

function viewTitle() {
  return { chats: "Chats", vault: "Boveda privada", calls: "Llamadas", privacy: "Privacidad", account: "Cuenta" }[state.view] || "Nivra";
}

function pushMessage(conversationId, message, { scroll = true } = {}) {
  mergeConversationMessages(conversationId, [message]);
  persistLocalMessage(conversationId, message).catch(() => {});
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (conversation && message?.at) {
    const currentAt = Date.parse(conversation.lastMessageAt || conversation.updatedAt || 0);
    const nextAt = Date.parse(message.at);
    if (Number.isFinite(nextAt) && (!Number.isFinite(currentAt) || nextAt >= currentAt)) {
      conversation.lastMessageAt = message.at;
      conversation.updatedAt = message.at;
    }
  }
  upsertMessageNode(conversationId, message.id, { scroll });
  updateConversationPreview(conversationId);
}

function mergeConversationMessages(conversationId, messages) {
  const merged = new Map((state.messages.get(conversationId) || []).map((message) => [message.id, message]));
  for (const message of messages || []) {
    if (!message?.id) continue;
    merged.set(message.id, { ...(merged.get(message.id) || {}), ...message });
  }
  state.messages.set(conversationId, [...merged.values()].sort(compareMessagesByTime));
}

function findMessage(id) {
  for (const list of state.messages.values()) {
    const found = list.find((message) => message.id === id);
    if (found) return found;
  }
  return null;
}

function findMessageLocation(id) {
  for (const [conversationId, list] of state.messages.entries()) {
    const message = list.find((item) => item.id === id);
    if (message) return { conversationId, message };
  }
  return null;
}

function sharedMediaForConversation(conversationId) {
  return (state.messages.get(conversationId) || [])
    .filter((message) => message.payload?.type === "file")
    .map((message) => ({
      ...message.payload,
      at: message.at,
      senderAlias: message.senderAlias
    }))
    .filter((item) => item.fileId)
    .reverse();
}

function fileTypeIcon(mime = "") {
  if (mime.startsWith("image/")) return "IMG";
  if (mime.startsWith("video/")) return "VID";
  if (mime.startsWith("audio/")) return "AUD";
  return "DOC";
}

function fileTypeLabel(mime = "") {
  if (mime.startsWith("image/")) return "Imagen";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  return "Archivo";
}

function isPreviewableMime(mime = "") {
  return mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/");
}

function fileMetaLabel(payload = {}) {
  const parts = [];
  if (payload.durationMs) parts.push(formatDuration(payload.durationMs));
  parts.push(formatBytes(payload.size));
  if (payload.capture === "camera-photo") parts.push("camara");
  if (payload.capture === "voice-note") parts.push("voz");
  return parts.filter(Boolean).join(" - ");
}

function formatBytes(value) {
  if (!value) return "cifrado";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(milliseconds = 0) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function extensionForMime(mime = "") {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4")) return mime.startsWith("audio/") ? "m4a" : "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("pdf")) return "pdf";
  return "bin";
}

function sanitizeFileName(value = "nivra-file.bin") {
  return String(value || "nivra-file.bin")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140) || "nivra-file.bin";
}

function callParticipants(call) {
  const ids = (call?.participantUserIds || [])
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  return ids.map((userId) => {
    if (userId === state.auth.user.id) return { ...state.auth.user, id: state.auth.user.id };
    const known = findKnownPerson(userId);
    return known
      ? { ...known, id: known.id || known.userId }
      : { id: userId, alias: state.aliasByUserId.get(userId) || "Contacto", displayName: state.aliasByUserId.get(userId) || "Contacto Nivra" };
  });
}

function callTitle(call) {
  if (!call) return "Llamada";
  const conversation = state.conversations.find((item) => item.id === call.conversationId);
  if (conversation) return conversationTitle(conversation);
  const others = callParticipants(call).filter((person) => person.id !== state.auth.user.id);
  if (others.length === 1) return displayPerson(others[0]);
  return `${others.length || 1} participantes`;
}

function callSubtitle(call) {
  const count = callParticipants(call).length;
  const type = call?.type === "Video" ? "Videollamada" : "Llamada de voz";
  return `${type} - ${count} participante${count === 1 ? "" : "s"}`;
}

function callStatusText() {
  if (state.call.phase === "incoming") return "Llamada entrante";
  if (state.call.phase === "dialing") return "Llamando...";
  if (state.call.phase === "active") return `En llamada ${callDurationText()}`;
  return "Listo";
}

function callDurationText() {
  if (!state.call.startedAt) return "00:00";
  const total = Math.max(0, Math.floor((Date.now() - new Date(state.call.startedAt).getTime()) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function PrivacyDefaults() {
  return {
    hideNotificationContent: true,
    allowForwarding: false,
    allowScreenshots: false,
    readReceipts: true,
    defaultMessageTtlSeconds: null,
    privacyPreset: "private"
  };
}

function effectiveMessageTtlSeconds() {
  const value = state.messagePolicy.ttlSeconds;
  if (value === "default") return state.privacy?.defaultMessageTtlSeconds || null;
  return value ? Number(value) : null;
}

function ttlLabel(seconds) {
  if (!seconds) return "sin expiracion";
  if (seconds < 3600) return `${seconds}s`;
  if (seconds === 3600) return "1 hora";
  if (seconds === 86400) return "1 dia";
  if (seconds === 604800) return "7 dias";
  const days = Math.round(seconds / 86400);
  return `${days} dias`;
}

function messagePolicyLabel(message) {
  const parts = [];
  if (message.deleteAfterRead) parts.push("una vez");
  if (message.expiresAt) {
    const remaining = Math.max(0, Date.parse(message.expiresAt) - Date.now());
    if (remaining > 0) parts.push(`expira en ${ttlLabel(Math.ceil(remaining / 1000))}`);
  }
  return parts.join(" - ");
}

function messageDisplayText(payload = {}) {
  if (payload.type === "file") {
    return `${payload.voiceNote ? "Nota de voz" : fileTypeLabel(payload.mime)}: ${payload.fileName || "adjunto"}`;
  }
  if (payload.type === "reaction") {
    return `Reaccion: ${payload.emoji || "+"}`;
  }
  if (payload.type === "story-response") {
    const reaction = payload.reaction ? `Reaccion ${payload.reaction}` : "";
    const text = payload.text || "";
    return [reaction, text].filter(Boolean).join(" - ") || "Respondio a tu historia";
  }
  return payload.text || "Contenido cifrado";
}

function renderMessageReceipt(message) {
  const stateName = messageDeliveryState(message);
  const labels = {
    sent: "Enviado",
    delivered: "Entregado",
    read: "Visto",
    received: message.status || "privado"
  };
  if (!message.mine) return `<span>${escapeHtml(labels.received)}</span>`;
  const checks = stateName === "sent" ? icon("check") : `${icon("check")}${icon("check")}`;
  return `<span class="receipt-state ${stateName}" title="${labels[stateName]}">${checks}<span>${labels[stateName]}</span></span>`;
}

function messageDeliveryState(message) {
  if (!message?.mine) return "received";
  const others = (message.receipts || []).filter((receipt) => receipt.userId !== state.auth?.user?.id);
  if (!others.length) return message.status === "visto" ? "read" : message.status === "entregado" ? "delivered" : "sent";
  if (others.every((receipt) => receipt.readAt)) return "read";
  if (others.every((receipt) => receipt.deliveredAt || receipt.readAt)) return "delivered";
  return "sent";
}

function deviceStaleLabel(device) {
  const last = new Date(device.lastSeenAt || device.createdAt).getTime();
  if (!Number.isFinite(last)) return "Activo";
  const ageDays = (Date.now() - last) / 86400000;
  if (ageDays >= 30) return "Inactivo 30d+";
  if (ageDays >= 2) return "Inactivo";
  return "Activo";
}

function activeVaultRoom() {
  return state.vaultRooms.find((room) => room.id === state.vaultActiveRoomId);
}

function currentVaultMember(room) {
  return room?.members?.find((member) => member.userId === state.auth.user.id);
}

function activeVaultMemberIds(room) {
  return (room.members || [])
    .filter((member) => member.status === "Active")
    .map((member) => member.userId);
}

function vaultFileExpiry(room) {
  if (room?.expiresAt) return room.expiresAt;
  if (room?.retentionMode === "BurnOnExit") return new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return null;
}

function vaultModeLabel(value) {
  return {
    PinOnly: "PIN requerido",
    InviteOnly: "Solo invitados",
    WaitingRoom: "Lobby con aprobacion"
  }[value] || value || "Privado";
}

function vaultRetentionLabel(value) {
  return {
    Persistent: "Cierre manual",
    BurnOnExit: "Se destruye al salir",
    ExpiresAfterTtl: "Expira por tiempo"
  }[value] || value || "Temporal";
}

function setReply(messageId) {
  const message = findMessage(messageId);
  if (!message) return;
  state.replyTo = {
    id: message.id,
    preview: (message.payload?.text || message.payload?.fileName || "mensaje").slice(0, 80)
  };
  updateReplyBar();
  document.querySelector("#messageInput")?.focus();
}

function saveArchivedConversations() {
  saveJson("nivra.archivedConversations", [...state.archivedConversationIds]);
}

function toggleArchiveChat(conversationId) {
  if (!conversationId) return;
  if (state.archivedConversationIds.has(conversationId)) {
    state.archivedConversationIds.delete(conversationId);
    toast("Chat desarchivado.");
  } else {
    state.archivedConversationIds.add(conversationId);
    toast("Chat archivado.");
  }
  saveArchivedConversations();
  render();
}

async function purgeLocalConversation(conversationId) {
  const accountKey = localAccountKey();
  if (accountKey) await localStore.removeConversationMessages(accountKey, conversationId).catch(() => {});
  state.messages.set(conversationId, []);
  renderConversationMessages(conversationId, { replace: true });
}

async function clearChat(conversationId, scope = "everyone") {
  if (!conversationId) return;
  const confirmed = window.confirm(scope === "everyone" ? "Vaciar este chat para todos los participantes?" : "Vaciar este chat solo en este dispositivo?");
  if (!confirmed) return;
  try {
    await request(`/api/chats/${encodeURIComponent(conversationId)}/clear`, { method: "POST", body: { scope } });
    await purgeLocalConversation(conversationId);
    toast(scope === "everyone" ? "Chat vaciado para todos." : "Chat vaciado para ti.");
  } catch (error) {
    toast(error.message || "No se pudo vaciar el chat.");
  }
}

async function deleteChat(conversationId, scope = "me") {
  if (!conversationId) return;
  const confirmed = window.confirm(scope === "everyone" ? "Eliminar este chat para todos?" : "Eliminar este chat solo para ti?");
  if (!confirmed) return;
  try {
    await request(`/api/chats/${encodeURIComponent(conversationId)}?scope=${encodeURIComponent(scope)}`, { method: "DELETE" });
    await purgeLocalConversation(conversationId);
    state.conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
    state.archivedConversationIds.delete(conversationId);
    saveArchivedConversations();
    if (state.selectedConversationId === conversationId) {
      selectConversation(state.conversations[0]?.id || null);
    }
    render();
    toast(scope === "everyone" ? "Chat eliminado para todos." : "Chat eliminado para ti.");
  } catch (error) {
    toast(error.message || "No se pudo eliminar el chat.");
  }
}

function openForwardPicker(messageId) {
  const message = findMessage(messageId);
  if (!message) return;
  const availability = forwardAvailability(message);
  if (!availability.ok) {
    toast(availability.reason);
    return;
  }
  state.forwardPicker = {
    query: "",
    selectedIds: new Set(),
    busy: false
  };
  state.modal = { type: "forwardMessage", messageId };
  render();
}

function forwardAvailability(message) {
  if (!message) return { ok: false, reason: "Mensaje no disponible." };
  if (message.status === "eliminado" || message.payload?.deleted) return { ok: false, reason: "Ese mensaje fue eliminado." };
  if (["reaction", "edit", "delete", "system"].includes(message.payload?.type)) return { ok: false, reason: "Ese evento no se puede reenviar." };
  if (message.deleteAfterRead) return { ok: false, reason: "Los mensajes de una sola vez no se pueden reenviar." };
  if (!message.mine && message.payload?.forwardingAllowed === false) return { ok: false, reason: "El remitente bloqueo el reenvio." };
  return { ok: true };
}

function forwardTargetConversations(messageId) {
  const sourceConversationId = findMessageLocation(messageId)?.conversationId;
  const query = state.forwardPicker.query.trim().toLowerCase();
  return [...state.conversations]
    .filter((conversation) => conversation.id !== sourceConversationId)
    .filter((conversation) => (conversation.participants || []).some((participant) => !participant.removedAt))
    .sort((left, right) => Date.parse(right.lastMessageAt || right.updatedAt || 0) - Date.parse(left.lastMessageAt || left.updatedAt || 0))
    .filter((conversation) => {
      if (!query) return true;
      const title = conversationTitle(conversation).toLowerCase();
      const aliases = (conversation.participants || [])
        .map((participant) => findKnownPerson(participant.userId)?.alias || state.aliasByUserId.get(participant.userId) || "")
        .join(" ")
        .toLowerCase();
      return title.includes(query) || aliases.includes(query);
    });
}

function toggleForwardSelection(conversationId) {
  if (!conversationId || state.forwardPicker.busy) return;
  if (state.forwardPicker.selectedIds.has(conversationId)) {
    state.forwardPicker.selectedIds.delete(conversationId);
  } else {
    state.forwardPicker.selectedIds.add(conversationId);
  }
  render();
}

async function forwardMessageToSelectedConversations() {
  const messageId = state.modal?.messageId;
  const targetIds = [...state.forwardPicker.selectedIds];
  if (!messageId || !targetIds.length || state.forwardPicker.busy) return;
  state.forwardPicker.busy = true;
  render();
  let sent = 0;
  let index = 0;
  for (const conversationId of targetIds) {
    const ok = await forwardMessageToConversation(messageId, conversationId, { quiet: true });
    if (ok) sent += 1;
    await breatheMainThread(++index, 2);
  }
  closeModal();
  toast(sent ? `Mensaje reenviado a ${sent} chat${sent === 1 ? "" : "s"}.` : "No se pudo reenviar.");
}

async function forwardMessageToConversation(messageId, conversationId, options = {}) {
  const message = findMessage(messageId);
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!message || !conversation) return false;
  const availability = forwardAvailability(message);
  if (!availability.ok) {
    if (!options.quiet) toast(availability.reason);
    return false;
  }
  const forwardedFrom = {
    messageId: message.id,
    senderAlias: message.mine ? state.auth.user.alias : message.senderAlias || "Contacto",
    at: message.at
  };
  try {
    if (message.payload?.type === "file") {
      const file = await fileFromForwardPayload(message.payload);
      const sentFile = await sendFileAttachmentToConversation(conversation, file, {
        quiet: true,
        voiceNote: Boolean(message.payload.voiceNote),
        capture: message.payload.capture || "forwarded-file",
        durationMs: message.payload.durationMs || null,
        forwardedFrom,
        deleteAfterRead: false
      });
      if (!sentFile) return false;
      if (!options.quiet) {
        closeModal();
        toast("Adjunto reenviado.");
      }
      return true;
    }

    const payload = {
      ...message.payload,
      replyTo: null,
      forwardedFrom
    };
    const sent = await sendPayloadToConversation(conversation, payload, "Text", null, { quiet: true, deleteAfterRead: false });
    if (!sent) return false;
    if (!options.quiet) {
      closeModal();
      toast("Mensaje reenviado.");
    }
    return true;
  } catch (error) {
    if (!options.quiet) toast(error.message || "No se pudo reenviar.");
    return false;
  }
}

async function fileFromForwardPayload(payload) {
  if (!payload?.fileId || !payload.fileKey || !payload.fileIv) {
    throw new Error("El adjunto cifrado no tiene metadata completa.");
  }
  const encrypted = await request(`/files/${payload.fileId}/blob`, { rawResponse: true });
  const bytes = await encrypted.arrayBuffer();
  const plain = await decryptAttachment(bytes, payload.fileKey, payload.fileIv);
  const mime = payload.mime || "application/octet-stream";
  const name = sanitizeFileName(payload.fileName || `nivra-${payload.fileId}.${extensionForMime(mime)}`);
  const blob = new Blob([plain], { type: mime });
  rememberMediaPreview(payload.fileId, blob, mime, name);
  return new File([blob], name, { type: mime });
}

async function editMessage(messageId) {
  const message = findMessage(messageId);
  if (!message || !message.mine) return;
  state.modal = { type: "editMessage", messageId, draft: message.payload?.text || "" };
  render();
}

async function handleEditMessageSubmit(event) {
  event.preventDefault();
  const messageId = state.modal?.messageId;
  const message = findMessage(messageId);
  if (!message || !message.mine) return;
  const next = document.querySelector("#editMessageText")?.value.trim();
  if (!next) return;
  message.payload.text = next;
  message.status = "editado";
  const location = findMessageLocation(messageId);
  if (location) persistLocalMessage(location.conversationId, message).catch(() => {});
  await sendPayload({ type: "edit", targetMessageId: messageId, newText: next }, "System");
  closeModal();
  if (location) upsertMessageNode(location.conversationId, messageId);
}

async function deleteMessage(messageId) {
  return deleteMessageForEveryone(messageId);
}

async function deleteMessageForMe(messageId) {
  const message = findMessage(messageId);
  if (!message) return;
  const location = findMessageLocation(messageId);
  if (!location) return;
  try {
    await request(`/api/messages/${encodeURIComponent(messageId)}?scope=me`, { method: "DELETE" });
  } catch {
    await request(`/messages/${messageId}/receipt`, { method: "POST", body: { kind: "Deleted" } }).catch(() => {});
  }
  await removeLocalMessage(location.conversationId, messageId).catch(() => {});
  state.messages.set(location.conversationId, (state.messages.get(location.conversationId) || []).filter((item) => item.id !== messageId));
  removeMessageNode(location.conversationId, messageId);
  toast("Mensaje eliminado para ti.");
}

async function deleteMessageForEveryone(messageId) {
  const message = findMessage(messageId);
  if (!message || !message.mine) return;
  const location = findMessageLocation(messageId);
  if (!location) return;
  message.payload = { type: "text", text: "Este mensaje fue eliminado", deleted: true };
  message.status = "eliminado";
  persistLocalMessage(location.conversationId, message).catch(() => {});
  upsertMessageNode(location.conversationId, messageId);
  await request(`/api/messages/${encodeURIComponent(messageId)}?scope=everyone`, { method: "DELETE" }).catch(() => {});
  await sendPayload({ type: "delete", targetMessageId: messageId }, "System");
}

async function openViewOnceMessage(messageId) {
  const location = findMessageLocation(messageId);
  if (!location || location.message.mine) return;
  location.message.openedAt = new Date().toISOString();
  location.message.status = "visto";
  await persistLocalMessage(location.conversationId, location.message).catch(() => {});
  request(`/messages/${messageId}/receipt`, { method: "POST", body: { kind: "Read" } }).catch(() => {});
  upsertMessageNode(location.conversationId, messageId);
  setTimeout(async () => {
    const current = findMessageLocation(messageId);
    if (!current?.message?.openedAt) return;
    current.message.payload = { type: "text", text: "Mensaje de una sola vez eliminado" };
    await removeLocalMessage(current.conversationId, messageId).catch(() => {});
    state.messages.set(current.conversationId, (state.messages.get(current.conversationId) || []).filter((message) => message.id !== messageId));
    removeMessageNode(current.conversationId, messageId);
  }, VIEW_ONCE_DELETE_DELAY_MS);
}

function isServerSystemMessage(message, recipient) {
  return message?.kind === "System" && (message.encryptedPolicy === SYSTEM_MISSED_CALL_POLICY || recipient?.header === SYSTEM_MISSED_CALL_POLICY);
}

function decodeServerSystemMessage(recipient) {
  try {
    const json = READ.decode(ub64(recipient.ciphertext));
    return JSON.parse(json);
  } catch {
    return { type: "system", title: "Aviso de sistema", text: "Evento de sistema recibido." };
  }
}

async function initializePushNotifications() {
  if (state.pushReady || state.pushRegistering || !state.auth?.tokens?.accessToken) return;
  state.pushRegistering = true;
  try {
    if (window.NIVRA_PUSH_TOKEN) {
      await registerPushToken("fcm", String(window.NIVRA_PUSH_TOKEN).trim());
      state.pushReady = true;
      return;
    }

    if (isNativeCapacitor()) {
      await initializeCapacitorPushNotifications();
      return;
    }

    await initializeWebPushNotifications();
  } finally {
    state.pushRegistering = false;
  }
}

function isNativeCapacitor() {
  const capacitor = window.Capacitor;
  if (!capacitor) return false;
  if (typeof capacitor.isNativePlatform === "function") return capacitor.isNativePlatform();
  return PLATFORM.isCapacitor && !PLATFORM.isHttp;
}

async function initializeCapacitorPushNotifications() {
  const push = window.Capacitor?.Plugins?.PushNotifications;
  if (!push) {
    console.warn("PushNotifications plugin is not available in Capacitor.");
    return;
  }

  await bindCapacitorPushListeners(push);

  let permission = await push.checkPermissions?.().catch(() => null);
  if (!permission || permission.receive !== "granted") {
    permission = await push.requestPermissions?.().catch(() => null);
  }
  if (!permission || permission.receive !== "granted") return;

  await push.register();
}

async function bindCapacitorPushListeners(push) {
  if (state.pushListenersReady) return;

  await push.addListener("registration", async (token) => {
    if (!token?.value) return;
    await registerPushToken("fcm", token.value).catch(() => {});
    state.pushReady = true;
  });

  await push.addListener("registrationError", (error) => {
    console.warn("Push registration failed.", error);
  });

  await push.addListener("pushNotificationReceived", async (notification) => {
    await handleForegroundPushNotification(notification).catch(() => {});
  });

  await push.addListener("pushNotificationActionPerformed", async (event) => {
    const data = event?.notification?.data || {};
    await handlePushNavigation(data).catch(() => {});
    await syncPendingMessages("push-action", { force: true }).catch(() => {});
    render();
  });

  state.pushListenersReady = true;
}

async function initializeWebPushNotifications() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") return;

  const registration = await navigator.serviceWorker.ready.catch(() => null);
  if (!registration) return;

  const fcmToken = await getFirebaseMessagingToken(registration).catch((error) => {
    console.warn("Firebase web push token unavailable.", error);
    return null;
  });
  if (fcmToken) {
    await registerPushToken("fcm", fcmToken);
    state.pushReady = true;
    return;
  }

  const subscription = await getStandardWebPushSubscription(registration).catch((error) => {
    console.warn("Standard Web Push subscription unavailable.", error);
    return null;
  });
  if (!subscription) return;

  await registerPushToken("webpush", serializePushSubscription(subscription));
  state.pushReady = true;
}

async function getFirebaseMessagingToken(serviceWorkerRegistration) {
  const firebaseConfig = window.NIVRA_FIREBASE_CONFIG;
  const vapidKey = window.NIVRA_FIREBASE_VAPID_KEY;
  if (!firebaseConfig || !vapidKey) return null;

  if (window.firebase?.messaging) {
    const app = window.firebase.apps?.length ? window.firebase.app() : window.firebase.initializeApp(firebaseConfig);
    const messaging = window.firebase.messaging(app);
    if (messaging.useServiceWorker) messaging.useServiceWorker(serviceWorkerRegistration);
    if (messaging.usePublicVapidKey) messaging.usePublicVapidKey(vapidKey);
    return await messaging.getToken({ vapidKey, serviceWorkerRegistration });
  }

  const appModule = await import(firebaseSdkUrl("firebase-app.js"));
  const messagingModule = await import(firebaseSdkUrl("firebase-messaging.js"));
  const app = appModule.getApps().length ? appModule.getApps()[0] : appModule.initializeApp(firebaseConfig);
  const messaging = messagingModule.getMessaging(app);
  return await messagingModule.getToken(messaging, { vapidKey, serviceWorkerRegistration });
}

function firebaseSdkUrl(file) {
  return `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/${file}`;
}

async function getStandardWebPushSubscription(serviceWorkerRegistration) {
  if (!("PushManager" in window) || window.NIVRA_ENABLE_STANDARD_WEB_PUSH !== true) return null;
  const existing = await serviceWorkerRegistration.pushManager.getSubscription();
  if (existing) return existing;

  const publicKey = window.NIVRA_WEB_PUSH_PUBLIC_KEY || window.NIVRA_FIREBASE_VAPID_KEY;
  if (!publicKey) return null;
  return await serviceWorkerRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey)
  });
}

function serializePushSubscription(subscription) {
  const json = subscription.toJSON ? subscription.toJSON() : {};
  return JSON.stringify({
    endpoint: json.endpoint || subscription.endpoint,
    keys: json.keys || {},
    expirationTime: subscription.expirationTime || null
  });
}

function base64UrlToUint8Array(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function handleForegroundPushNotification(notification = {}) {
  const data = notification?.data || {};
  if (isIncomingCallPushData(data)) {
    toast("Llamada entrante");
    await hydrateIncomingCallFromPushData(data).catch(() => {});
  } else {
    toast("Nuevo mensaje");
  }
  await syncPendingMessages("push-foreground", { force: true }).catch(() => {});
}

async function handlePushNavigation(data = {}) {
  if (isIncomingCallPushData(data)) {
    state.view = "calls";
    state.mobileChatOpen = false;
    await hydrateIncomingCallFromPushData(data).catch(() => {});
    return;
  }

  const conversationId = pushDataValue(data, "conversationId", "ConversationId");
  if (!conversationId) return;

  state.selectedConversationId = conversationId;
  state.mobileChatOpen = true;
  state.view = "chats";
  saveJson("nivra.selectedConversationId", state.selectedConversationId);
}

async function hydrateIncomingCallFromPushData(data = {}) {
  const callId = pushDataValue(data, "callId", "CallId");
  const callerUserId = pushDataValue(data, "callerId", "CallerId", "callerUserId", "CallerUserId", "initiatorUserId", "InitiatorUserId");
  if (!callId || !callerUserId || callerUserId === state.auth?.user?.id) return false;
  if (state.call.current?.id === callId) return true;
  const callerName = pushDataValue(data, "callerName", "CallerName");
  if (callerName) state.aliasByUserId.set(callerUserId, callerName);

  const call = {
    id: callId,
    conversationId: pushDataValue(data, "conversationId", "ConversationId") || null,
    initiatorUserId: callerUserId,
    type: normalizeCallType(pushDataValue(data, "callType", "CallType", "type", "Type")),
    status: "Ringing",
    participantUserIds: [callerUserId, state.auth?.user?.id].filter(Boolean),
    startedAt: new Date().toISOString()
  };

  state.view = "calls";
  await handleIncomingCall(call, { notify: false });
  return true;
}

function isIncomingCallPushData(data = {}) {
  const type = String(pushDataValue(data, "type", "Type") || "").toLowerCase();
  const callId = pushDataValue(data, "callId", "CallId");
  return Boolean(callId) && type !== "missed-call" && (type === "call" || !type || type.includes("call"));
}

function normalizeCallType(value) {
  return String(value || "").toLowerCase().includes("video") ? "Video" : "Voice";
}

function pushDataValue(data = {}, ...keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

async function registerPushToken(provider, token) {
  if (!provider || !token || !state.auth?.tokens?.accessToken) return;
  await request(PUSH_TOKEN_ENDPOINT, {
    method: "POST",
    body: { provider, token }
  });
}

function appIsBackgrounded() {
  return document.hidden || document.visibilityState !== "visible" || !document.hasFocus();
}

function showRealtimeNotification(title, options = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !appIsBackgrounded()) return;
  try {
    const notification = new Notification(title, {
      icon: "/assets/icon-192.png",
      badge: "/assets/icon-192.png",
      silent: false,
      ...options
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      handlePushNavigation(options.data || {}).catch(() => {}).finally(() => render());
    };
  } catch {
    // Browsers can reject notifications outside secure contexts.
  }
}

function notifyIncomingMessage(message, payload) {
  if (message.senderUserId === state.auth.user.id) return;
  const alias = state.aliasByUserId.get(message.senderUserId) || payload.senderAlias || "un contacto";
  const hidden = state.privacy?.hideNotificationContent;
  const body = hidden
    ? "Nuevo mensaje privado"
    : payload.type === "system"
      ? payload.text || "Nuevo evento de sistema"
      : `Nuevo mensaje de ${alias}`;
  showRealtimeNotification("Nivra", {
    body,
    tag: `nivra-message-${message.conversationId}`,
    data: { conversationId: message.conversationId }
  });
}

function notifyIncomingCall(call) {
  if (call.initiatorUserId === state.auth.user.id) return;
  const alias = state.aliasByUserId.get(call.initiatorUserId) || "un contacto";
  showRealtimeNotification("Nivra", {
    body: `${call.type === "Video" ? "Videollamada" : "Llamada"} entrante de ${alias}`,
    tag: `nivra-call-${call.id}`,
    requireInteraction: true,
    data: { callId: call.id, conversationId: call.conversationId }
  });
}

function createLoopingAudio(volume) {
  if (!RINGTONE_SRC) return null;
  try {
    const audio = new Audio(RINGTONE_SRC);
    audio.preload = "none";
    audio.loop = true;
    audio.volume = volume;
    audio.addEventListener("error", () => console.warn("Ringtone asset unavailable; using generated tone."));
    return audio;
  } catch (error) {
    console.warn("Ringtone could not be prepared; using generated tone.", error);
    return null;
  }
}

function playCallTone(kind) {
  const audio = callTones[kind];
  stopFallbackTone();
  Object.entries(callTones).forEach(([name, tone]) => {
    if (tone && name !== kind) {
      tone.pause();
      tone.currentTime = 0;
    }
  });
  if (!audio) {
    startFallbackTone(kind);
    return;
  }
  try {
    audio.currentTime = 0;
    const playPromise = audio.play();
    if (playPromise?.catch) playPromise.catch(() => startFallbackTone(kind));
  } catch (error) {
    console.warn("Ringtone playback failed; using generated tone.", error);
    startFallbackTone(kind);
  }
}

function stopCallTones() {
  Object.values(callTones).forEach((audio) => {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  });
  stopFallbackTone();
}

function startFallbackTone(kind) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  stopFallbackTone();
  try {
    const context = new AudioContext();
    context.resume?.().catch?.(() => {});
    const gain = context.createGain();
    gain.gain.value = kind === "incoming" ? 0.055 : 0.032;
    gain.connect(context.destination);
    const beep = () => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = kind === "incoming" ? 880 : 520;
      oscillator.connect(gain);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.18);
    };
    beep();
    fallbackTone = {
      context,
      timer: setInterval(beep, kind === "incoming" ? 900 : 1400)
    };
  } catch (error) {
    console.warn("Generated call tone unavailable.", error);
  }
}

function stopFallbackTone() {
  if (!fallbackTone) return;
  clearInterval(fallbackTone.timer);
  fallbackTone.context.close?.().catch?.(() => {});
  fallbackTone = null;
}

function fileKind(file) {
  if (file.type.startsWith("image/")) return "Image";
  if (file.type.startsWith("video/")) return "Video";
  if (file.type.startsWith("audio/")) return "Audio";
  return "Document";
}

function vaultMetaKey() {
  return `nivra.vault.${state.auth.user.id}`;
}

function avatarNode(entity, className = "avatar") {
  const photo = entity?.profilePhotoDataUrl;
  const label = entity?.displayName || entity?.alias || entity?.name || entity || "N";
  return photo
    ? `<img class="${className} avatar-img" src="${escapeAttr(photo)}" alt="">`
    : `<div class="${className}">${initials(label)}</div>`;
}

function displayPerson(person) {
  return person?.displayName || person?.alias || "Nivra";
}

function friendshipLabel(value) {
  return {
    friends: "amigos",
    requested: "pendiente",
    incoming: "responder",
    none: "publico"
  }[value] || value || "publico";
}

function encodeStoryText(text) {
  return encodeStoryPayload({ type: "text", text });
}

function decodeStoryText(value) {
  return decodeStoryPayload(value).text || "";
}

function encodeStoryPayload(payload) {
  return b64(TEXT.encode(JSON.stringify({ v: 2, type: "text", ...(payload || {}) })));
}

function decodeStoryPayload(value) {
  try {
    const payload = JSON.parse(READ.decode(ub64(value)));
    return payload && typeof payload === "object" ? payload : { type: "text", text: "" };
  } catch {
    try {
      const payload = JSON.parse(decodeURIComponent(escape(atob(value || ""))));
      return payload && typeof payload === "object" ? payload : { type: "text", text: "" };
    } catch {
      return { type: "text", text: "" };
    }
  }
}

function fakeQrMatrix(seed) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let html = '<div class="qr-grid">';
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 21; x++) {
      const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      hash = Math.imul(hash ^ (x + y * 31), 1103515245);
      html += `<i class="${finder || (hash & 3) === 0 ? "on" : ""}"></i>`;
    }
  }
  return `${html}</div>`;
}

function initials(value) {
  return (value || "N").split(/\s|,|-/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "N";
}

function shortId(id) {
  return id ? `${id.slice(0, 6)}...` : "unknown";
}

function safeDomId(value = "") {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatTime(value) {
  if (!value) return "Ahora";
  return new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" }).format(new Date(value));
}

function deviceName() {
  return `${navigator.platform || "Web"} Browser`;
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function escapeAttr(value = "") {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function cssEscape(value = "") {
  if (window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function htmlToNode(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild || document.createTextNode("");
}

function isNearMessagesBottom(node = document.querySelector("#messages")) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop <= node.clientHeight + MESSAGE_BOTTOM_THRESHOLD_PX;
}

function smartScrollMessages(node = document.querySelector("#messages"), { wasNearBottom = null, conversationId = state.selectedConversationId, showBadge = true } = {}) {
  if (!node) return;
  const shouldScroll = wasNearBottom ?? isNearMessagesBottom(node);
  if (shouldScroll) {
    scrollMessages({ node, force: true });
    hideNewMessagesBadge();
  } else if (showBadge && conversationId === state.selectedConversationId) {
    showNewMessagesBadge();
  }
}

function scrollMessages({ node = document.querySelector("#messages"), force = false } = {}) {
  if (!node) return;
  if (force || isNearMessagesBottom(node)) {
    node.scrollTop = node.scrollHeight;
  }
}

function showNewMessagesBadge() {
  const badge = document.querySelector("#newMessagesBadge");
  if (badge) badge.hidden = false;
}

function hideNewMessagesBadge() {
  const badge = document.querySelector("#newMessagesBadge");
  if (badge) badge.hidden = true;
}

function toast(message) {
  TOAST.textContent = message;
  TOAST.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => TOAST.classList.remove("show"), 3200);
}

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function base64UrlJson(value) {
  return b64url(TEXT.encode(JSON.stringify(value)));
}

function jsonFromBase64Url(value) {
  return JSON.parse(READ.decode(ub64url(value)));
}

function b64url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function ub64url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return ub64(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

function b64(bytes) {
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary);
}

function ub64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
