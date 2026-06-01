const PLATFORM = detectPlatform();
const API_BASE_URL = resolveApiBaseUrl(PLATFORM);
const APP = document.querySelector("#app");
const TOAST = document.querySelector("#toast");
const TEXT = new TextEncoder();
const READ = new TextDecoder();
const LOCAL_DB_NAME = "NivraDB";
const LOCAL_DB_VERSION = 5;
const LOCAL_MESSAGE_STORE = "messages";
const LOCAL_KEY_STORE = "deviceKeys";
const LOCAL_PROFILE_STORE = "profilesStore";
const VIEW_ONCE_DELETE_DELAY_MS = 15000;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const SYSTEM_MISSED_CALL_POLICY = "system:missed-call";
const RINGTONE_SRC = "";
const QR_LOGIN_TTL_MS = 2 * 60 * 1000;
const SYNC_POLL_VISIBLE_MS = 9000;
const SYNC_POLL_BACKGROUND_MS = 45000;
const SYNC_MIN_INTERVAL_MS = 1200;
const BOOTSTRAP_QUEUE_DELAY_MS = 650;
const BOOTSTRAP_VISIBLE_MIN_INTERVAL_MS = 1800;
const BOOTSTRAP_BACKGROUND_MIN_INTERVAL_MS = 12000;
const MESSAGE_PAGE_SIZE = 50;
const CHAT_DOM_LIMIT = 50;
const LOCAL_PURGE_LIMIT = 500;
const ACK_BATCH_SIZE = 200;
const MAX_SEEN_MESSAGE_IDS = 5000;
const MESSAGE_BOTTOM_THRESHOLD_PX = 100;
const MESSAGE_SCROLL_DEBOUNCE_MS = 120;
const SEARCH_DEBOUNCE_MS = 600;
const SEARCH_MIN_CHARS = 2;
const MAIN_THREAD_YIELD_EVERY = 8;
const MAX_CALL_HISTORY = 80;
const MESSAGE_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢"];
const STORY_REACTIONS = [
  { key: "heart", value: "\u2764\uFE0F" },
  { key: "laugh", value: "\uD83D\uDE02" },
  { key: "wow", value: "\uD83D\uDE2E" },
  { key: "sad", value: "\uD83D\uDE22" },
  { key: "fire", value: "\uD83D\uDD25" }
];
const STORY_TEXT_DURATION_MS = 7000;
const STORY_MEDIA_DURATION_MS = 15000;
const LONG_PRESS_MS = 520;
const VOICE_NOTE_MIN_DURATION_MS = 500;
const PUSH_TOKEN_ENDPOINT = "/push-tokens";
const FIREBASE_SDK_VERSION = window.NIVRA_FIREBASE_SDK_VERSION || "12.14.0";
const FIREBASE_APP_NAME = "nivra-web-push";
const FIREBASE_RESETTABLE_IDB_NAMES = ["fcm_token_details_db", "firebase-installations-database"];
const REQUEST_TIMEOUT_MS = 20000;
const UPLOAD_REQUEST_TIMEOUT_MS = 120000;
const QR_AUTHORIZE_TIMEOUT_MS = 12000;
const CALL_SIGNAL_TIMEOUT_MS = 8000;
const CALL_END_REQUEST_TIMEOUT_MS = 8000;
const CALL_RING_TIMEOUT_MS = 45000;
const PROFILE_REFRESH_MIN_MS = 5 * 60 * 1000;
const PUSH_REGISTRATION_RETRY_DELAYS_MS = [5000, 15000, 60000, 180000];
const PUSH_PROMPT_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_CALL_PUSH_TYPES = new Set(["end-call", "missed-call", "call-ended"]);

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
      const timeout = setTimeout(() => finish(null), 5000);
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
        if (!messageStore.indexNames.contains("byAccountExpiry")) {
          messageStore.createIndex("byAccountExpiry", ["accountKey", "expiresAtMs"]);
        }
        if (!messageStore.indexNames.contains("byAccountOpenedAt")) {
          messageStore.createIndex("byAccountOpenedAt", ["accountKey", "openedAtMs"]);
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
    }).then((db) => {
      if (!db) this.dbPromise = null;
      return db;
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
    const recordsByKey = new Map();
    const addRecords = (records = []) => {
      for (const record of records || []) {
        if (record?.key && record.accountKey === accountKey) recordsByKey.set(record.key, record);
      }
    };

    const readStore = () => db.transaction(LOCAL_MESSAGE_STORE, "readonly").objectStore(LOCAL_MESSAGE_STORE);
    const indexNames = readStore().indexNames;
    if (indexNames.contains("byAccountExpiry")) {
      const expiryRange = IDBKeyRange.bound([accountKey, 0], [accountKey, now]);
      addRecords(await idbCursorRecords(readStore().index("byAccountExpiry"), expiryRange, "next", LOCAL_PURGE_LIMIT));
    }
    if (indexNames.contains("byAccountOpenedAt") && recordsByKey.size < LOCAL_PURGE_LIMIT) {
      const openedCutoff = Math.max(0, now - VIEW_ONCE_DELETE_DELAY_MS);
      const openedRange = IDBKeyRange.bound([accountKey, 0], [accountKey, openedCutoff]);
      addRecords(await idbCursorRecords(readStore().index("byAccountOpenedAt"), openedRange, "next", LOCAL_PURGE_LIMIT - recordsByKey.size));
    }
    if (!indexNames.contains("byAccountExpiry") || !indexNames.contains("byAccountOpenedAt")) {
      addRecords(await idbRequest(readStore().index("byAccount").getAll(accountKey)));
    }

    const expired = [...recordsByKey.values()].filter((record) => this.isExpired(record, now)).slice(0, LOCAL_PURGE_LIMIT);
    if (!expired.length) return [];
    const writeStore = db.transaction(LOCAL_MESSAGE_STORE, "readwrite").objectStore(LOCAL_MESSAGE_STORE);
    await Promise.all(expired.map((record) => idbRequest(writeStore.delete(record.key))));
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
  searchByView: {
    chats: "",
    world: "",
    vault: "",
    calls: "",
    privacy: "",
    account: ""
  },
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
  callHistory: [],
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
    startedAt: null,
    minimized: false,
    ticker: null,
    ringTimeout: null,
    ending: false
  },
  endedCallIds: new Set(),
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
  storyPlayback: {
    ownerId: null,
    storyIds: [],
    index: 0,
    paused: false,
    timer: null,
    ticker: null,
    startedAt: 0,
    remainingMs: 0,
    durationMs: 0
  },
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
  messageDomWindows: new Map(),
  mediaCache: new Map(),
  objectUrls: new Set(),
  seenMessageIds: new Set((loadJson("nivra.seen") || []).slice(-MAX_SEEN_MESSAGE_IDS)),
  keyDirectory: new Map(),
  aliasByUserId: new Map(),
  profileByUserId: new Map(),
  profileRefreshAtByUserId: new Map(),
  archivedConversationIds: new Set(loadJson("nivra.archivedConversations") || []),
  replyTo: null,
  contextMenu: null,
  connection: null,
  polling: null,
  syncInFlight: false,
  bootstrapPromise: null,
  bootstrapQueued: false,
  bootstrapTimer: null,
  bootstrapPendingReason: "",
  lastBootstrapCompletedAt: 0,
  lastSyncAt: 0,
  messageScrollTimer: null,
  realtimeReconnectTimer: null,
  pushReady: false,
  pushLocalReady: false,
  pushRegistering: false,
  pushListenersReady: false,
  webPushForegroundReady: false,
  pushPermission: "unknown",
  pushServerReady: null,
  pushError: "",
  pushTokenError: "",
  pushTokenRetryAfter: 0,
  localNotificationsReady: false,
  pushRegistration: null,
  pushRetryTimer: null,
  pushRetryAttempt: 0,
  launchPush: null,
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
  viewEpoch: 0,
  renderFrame: null,
  messageLoadSeq: 0,
  messageLoadSession: null,
  pendingPhoneAlias: null,
  firebasePhone: {
    app: null,
    auth: null,
    authModule: null,
    compat: false,
    recaptchaVerifier: null,
    recaptchaElement: null,
    confirmationResult: null,
    phone: "",
    busy: false
  },
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
  document.body.classList.toggle("modal-open", Boolean(state.modal || state.activeStory));
  document.body.classList.toggle("auth-open", !state.auth?.tokens?.accessToken);
}

async function init() {
  await localStore.open().catch(() => null);
  await migrateLegacyKeyMaterial().catch(() => {});
  setupVisualViewportKeyboard();
  applyLaunchParams();
  registerServiceWorker().catch(() => {});
  bindIncomingCallOverlayEvents();
  listenForServiceWorkerMessages();
  setupConnectivityListeners();
  startLocalMessageRetention();
  render();
  if (state.auth?.tokens?.accessToken) {
    await bootstrap();
    await refreshPushPermissionState().catch(() => {});
    if (state.launchPush) {
      const launchPush = state.launchPush;
      state.launchPush = null;
      await handlePushNavigation(launchPush, { action: launchPush.pushAction || "" }).catch(() => {});
    }
    await initializePushNotifications({ requestPermission: false }).catch(() => {});
    await connectRealtime();
    startPolling();
  }
}

function applyLaunchParams() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const conversationId = params.get("conversationId");
  const callId = params.get("callId");
  if (view && ["chats", "world", "vault", "calls", "privacy", "account"].includes(view)) {
    state.view = view;
  }
  if (conversationId) {
    state.view = "chats";
    state.selectedConversationId = conversationId;
    state.mobileChatOpen = true;
    saveJson("nivra.selectedConversationId", conversationId);
  }
  if (callId) {
    state.view = "calls";
    state.launchPush = {
      type: params.get("type") || "incoming_call",
      callId,
      conversationId: conversationId || "",
      callerId: params.get("callerId") || params.get("callerUserId") || "",
      callerUserId: params.get("callerUserId") || params.get("callerId") || "",
      callerName: params.get("callerName") || "",
      callType: params.get("callType") || params.get("type") || "",
      pushAction: params.get("pushAction") || ""
    };
  }
}

function setupVisualViewportKeyboard() {
  if (setupVisualViewportKeyboard.ready) return;
  setupVisualViewportKeyboard.ready = true;
  const root = document.documentElement;
  const apply = () => {
    const viewport = window.visualViewport;
    const height = Math.max(320, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight));
    const layoutHeight = window.innerHeight || height;
    const keyboardBottom = viewport
      ? Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
      : 0;
    root.style.setProperty("--app-viewport-height", `${height}px`);
    root.style.setProperty("--keyboard-bottom", `${keyboardBottom}px`);
    document.body.classList.toggle("keyboard-open", keyboardBottom > 80);
  };
  window.visualViewport?.addEventListener("resize", apply, { passive: true });
  window.visualViewport?.addEventListener("scroll", apply, { passive: true });
  window.addEventListener("resize", apply, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(apply, 80), { passive: true });
  apply();
}

function listenForServiceWorkerMessages() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "nivra.push-click") return;
    handlePushNavigation(event.data?.data || {}, { action: event.data?.action || "" })
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
    startPolling();
    connectRealtime().catch(() => {});
    refreshPushPermissionState().catch(() => {});
    initializePushNotifications({ requestPermission: false }).catch(() => {});
    flushPushTokenRegistration().catch(() => {});
    syncPendingMessages("online", { force: true }).catch(() => {});
  });
  window.addEventListener("offline", () => {
    startPolling();
    toast("Sin conexion. Nivra guardara lo recibido localmente.");
  });
  document.addEventListener("visibilitychange", () => {
    startPolling();
    if (document.visibilityState === "visible" && state.auth?.tokens?.accessToken) {
      connectRealtime().catch(() => {});
      refreshPushPermissionState().catch(() => render());
      initializePushNotifications({ requestPermission: false }).catch(() => {});
      flushPushTokenRegistration().catch(() => {});
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

function trimSeenMessageIds() {
  while (state.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
    const oldest = state.seenMessageIds.values().next().value;
    state.seenMessageIds.delete(oldest);
  }
}

function persistSeenMessages() {
  trimSeenMessageIds();
  saveJson("nivra.seen", [...state.seenMessageIds]);
}

function rememberSeenMessage(messageId, { persist = true } = {}) {
  if (!messageId) return false;
  if (state.seenMessageIds.has(messageId)) return false;
  state.seenMessageIds.add(messageId);
  trimSeenMessageIds();
  if (persist) persistSeenMessages();
  return true;
}

function cancelActiveMessageLoad(reason = "cancelled") {
  const session = state.messageLoadSession;
  if (!session) return;
  session.reason = reason;
  session.controller?.abort?.();
  state.messageLoadSession = null;
}

function beginMessageLoadSession(conversationId, reason = "history") {
  cancelActiveMessageLoad("superseded");
  const controller = new AbortController();
  const session = {
    id: ++state.messageLoadSeq,
    conversationId,
    controller,
    signal: controller.signal,
    reason
  };
  state.messageLoadSession = session;
  return session;
}

function finishMessageLoadSession(session) {
  if (state.messageLoadSession?.id === session?.id) {
    state.messageLoadSession = null;
  }
}

function isMessageLoadSessionActive(session) {
  if (!session) return true;
  return state.messageLoadSession?.id === session.id &&
    !session.signal?.aborted &&
    session.conversationId === state.selectedConversationId &&
    state.view === "chats";
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

async function loadLocalConversationMessages(conversationId, shouldRender = true, options = {}) {
  const accountKey = localAccountKey();
  if (!accountKey || !conversationId) return;
  const session = options.session || null;
  const messages = await localStore.conversationMessagesPage(accountKey, conversationId, { limit: MESSAGE_PAGE_SIZE });
  if (!isMessageLoadSessionActive(session)) return;
  if (messages.length) {
    mergeConversationMessages(conversationId, messages);
  } else if (!state.messages.has(conversationId)) {
    state.messages.set(conversationId, []);
  }
  const paging = messagePagingState(conversationId);
  if (paging) {
    paging.loading = false;
    paging.exhausted = messages.length < MESSAGE_PAGE_SIZE;
    paging.oldestAt = oldestLoadedMessageAt(conversationId);
  }
  if (shouldRender && isMessageLoadSessionActive(session) && !renderConversationMessages(conversationId, { replace: true, scroll: "bottom" })) render();
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
  if (!("serviceWorker" in navigator) || !["http:", "https:"].includes(window.location.protocol)) {
    return Promise.resolve(null);
  }
  const register = () => navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((registration) => {
      registration.update?.().catch?.(() => {});
      return registration;
    })
    .catch((error) => {
      console.warn("Service worker registration failed.", error);
      return null;
    });
  if (document.readyState === "complete") return register();
  return new Promise((resolve) => {
    window.addEventListener("load", () => register().then(resolve), { once: true });
  });
}

function bootstrapDelayMs(options = {}) {
  if (options.force) return 0;
  const minInterval = document.visibilityState === "visible"
    ? BOOTSTRAP_VISIBLE_MIN_INTERVAL_MS
    : BOOTSTRAP_BACKGROUND_MIN_INTERVAL_MS;
  const elapsed = Date.now() - (state.lastBootstrapCompletedAt || 0);
  return Math.max(BOOTSTRAP_QUEUE_DELAY_MS, minInterval - elapsed);
}

function scheduleBootstrap(reason = "scheduled", options = {}) {
  if (!state.auth?.tokens?.accessToken) return;
  state.bootstrapPendingReason = reason;
  clearTimeout(state.bootstrapTimer);
  state.bootstrapTimer = setTimeout(() => {
    state.bootstrapTimer = null;
    const nextReason = state.bootstrapPendingReason || reason;
    state.bootstrapPendingReason = "";
    bootstrap({ reason: nextReason }).catch(() => {});
  }, options.delayMs ?? bootstrapDelayMs(options));
}

async function bootstrap(options = {}) {
  if (state.bootstrapPromise) {
    state.bootstrapQueued = true;
    return state.bootstrapPromise;
  }

  clearTimeout(state.bootstrapTimer);
  state.bootstrapTimer = null;
  state.bootstrapPendingReason = "";
  state.bootstrapPromise = bootstrapCore(options).finally(() => {
    state.bootstrapPromise = null;
    state.lastBootstrapCompletedAt = Date.now();
    const runQueued = state.bootstrapQueued && state.auth?.tokens?.accessToken;
    state.bootstrapQueued = false;
    if (runQueued) {
      scheduleBootstrap("queued", { delayMs: BOOTSTRAP_QUEUE_DELAY_MS });
    }
  });
  return state.bootstrapPromise;
}

async function bootstrapCore(_options = {}) {
  try {
    state.callHistory = loadCallHistory();
    await loadLocalAccountMessages(false);
    if (state.selectedConversationId && state.messages.has(state.selectedConversationId)) {
      render();
    }
    const [data, entitlements] = await Promise.all([
      request("/sync/bootstrap"),
      request("/monetization/entitlements").catch(() => null)
    ]);
    state.conversations = data.conversations || [];
    state.contacts = data.contacts || [];
    state.friendRequests = data.friendRequests || [];
    state.stories = data.stories || [];
    state.devices = data.devices || [];
    state.privacy = data.privacySettings || data.privacy || data.user?.privacySettings || null;
    if (entitlements) state.entitlements = entitlements;
    rememberProfile(state.auth.user, { persist: true });
    rememberProfiles(state.contacts, { persist: true });
    state.contacts.forEach((contact) => {
      state.aliasByUserId.set(contact.userId, contact.alias);
    });
    state.stories.forEach((story) => {
      if (story.owner?.id && story.owner?.alias) rememberProfile(story.owner, { persist: true });
    });
    state.vaultItems = data.vaultItems || [];
    state.vaultRooms = data.vaultRooms || [];
    state.vaultRooms.forEach((room) => {
      if (room.owner?.id && room.owner?.alias) rememberProfile(room.owner, { persist: true });
      (room.members || []).forEach((member) => rememberProfile(member, { persist: true }));
    });
    await hydrateConversationProfilesFromCache();
    let bootstrapMessageIndex = 0;
    for (const message of data.messages || []) {
      await applyMessageEnvelope(message, { markSeen: false, notifyReceipt: false, scroll: false });
      await breatheMainThread(++bootstrapMessageIndex);
    }
    let bootstrapDeletionIndex = 0;
    for (const deleted of data.deletedMessages || []) {
      const messageId = deleted.messageId || deleted.MessageId;
      const conversationId = deleted.conversationId || deleted.ConversationId;
      if (messageId && conversationId) await removeMessageEverywhere(conversationId, messageId);
      await breatheMainThread(++bootstrapDeletionIndex);
    }
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
  const now = Date.now();
  ids.forEach((userId) => {
    const lastRefreshAt = state.profileRefreshAtByUserId.get(userId) || 0;
    if (now - lastRefreshAt < PROFILE_REFRESH_MIN_MS) return;
    state.profileRefreshAtByUserId.set(userId, now);
    request(`/directory/users/${encodeURIComponent(userId)}`)
      .then((profile) => {
        const before = JSON.stringify(state.profileByUserId.get(userId) || {});
        const stored = rememberProfile(profile, { persist: true });
        if (stored && before !== JSON.stringify(stored)) {
          updateConversationProfileNodes(userId);
        }
      })
      .catch(() => {
        state.profileRefreshAtByUserId.delete(userId);
      });
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
  const renderedView = state.lastRenderedView || state.view;
  document.querySelectorAll("input[id], textarea[id], select[id]").forEach((node) => {
    if (node.type === "file") return;
    if (node.id === "globalSearch") {
      setSearchQueryForView(renderedView, node.value);
      return;
    }
    state.drafts[node.id] = node.type === "checkbox" ? node.checked : node.value;
  });
  return snapshot;
}

function restoreTransientInputs(snapshot = {}) {
  document.querySelectorAll("input[id], textarea[id], select[id]").forEach((node) => {
    if (node.type === "file") return;
    if (node.id === "globalSearch") {
      const value = currentSearchQuery();
      if (node.value !== value) node.value = value;
      return;
    }
    if (!(node.id in state.drafts)) return;
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

function prepareDomForRender(previousView, nextView) {
  closeFloatingMenu();
  clearTimeout(state.messageScrollTimer);
  state.messageScrollTimer = null;
  detachDomMediaNodes();

  if (!previousView || previousView === nextView) return;
  state.viewEpoch += 1;
  state.searchRequestSeq += 1;
  state.vaultInviteSearchRequestSeq += 1;

  if (previousView === "chats") {
    cancelActiveMessageLoad("view-change");
    sendTypingState("stopped", { force: true });
    resetVoiceRecordingState();
    clearVoiceHoldHint();
  }

  if (previousView === "world" && nextView !== "world") {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }

  if (previousView === "vault" && nextView !== "vault") {
    clearTimeout(state.vaultInviteTimer);
    state.vaultInviteTimer = null;
  }
}

function detachDomMediaNodes() {
  document.querySelectorAll("video, audio").forEach((node) => {
    try {
      node.pause?.();
      if ("srcObject" in node) node.srcObject = null;
      node.removeAttribute("src");
      node.load?.();
    } catch {
      // Detached media elements are best-effort cleanup before the DOM swap.
    }
  });
}

function scheduleRender() {
  if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    render();
  });
}

function render() {
  if (state.renderFrame) {
    cancelAnimationFrame(state.renderFrame);
    state.renderFrame = null;
  }
  const transient = captureTransientInputs();
  prepareDomForRender(state.lastRenderedView, state.view);
  syncShellClasses();
  if (!state.auth?.tokens?.accessToken) {
    renderAuth();
    restoreTransientInputs(transient);
    cleanupObjectUrls({ keepVisible: false });
    state.lastRenderedView = null;
    return;
  }

  const notificationPrompt = renderNotificationPrompt();
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
      <main class="main ${notificationPrompt ? "has-notification-prompt" : ""}">
        ${renderTopbar()}
        ${notificationPrompt}
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

  syncIncomingCallOverlay();
  bindAppEvents();
  syncStoryPlaybackUi();
  restoreTransientInputs(transient);
  cleanupObjectUrls({ keepVisible: true });
  state.lastRenderedView = state.view;
}

function renderAuth() {
  const mode = state.pendingPhoneAlias ? "phoneAlias" : defaultAuthMode();
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
          <button class="tab-btn ${mode === "phone" || mode === "phoneAlias" ? "active" : ""}" data-auth-tab="phone" type="button">Telefono</button>
          <button class="tab-btn ${mode === "qr" ? "active" : ""}" data-auth-tab="qr" type="button">QR</button>
        </div>
        <form id="authForm" data-mode="${mode}">
          <div class="field auth-alias-field ${mode === "phone" || mode === "qr" ? "hidden" : ""}">
            <label for="alias">Alias</label>
            <input id="alias" class="input" autocomplete="username" placeholder="tu_alias" ${mode === "login" || mode === "register" || mode === "phoneAlias" ? "required" : ""}>
          </div>
          <div class="field auth-password-field ${mode === "phone" || mode === "phoneAlias" || mode === "qr" ? "hidden" : ""}">
            <label for="password">Password</label>
            <input id="password" class="input" type="password" autocomplete="current-password" placeholder="Minimo 10 caracteres" ${mode === "login" || mode === "register" ? "required" : ""}>
          </div>
          <div id="displayNameWrap" class="field ${mode === "register" || mode === "phoneAlias" ? "" : "hidden"}">
            <label for="displayName">Nombre visible</label>
            <input id="displayName" class="input" placeholder="Como te veran tus contactos">
          </div>
          <div id="phoneWrap" class="field ${mode === "phone" ? "" : "hidden"}">
            <label for="phoneLogin">Telefono</label>
            <div class="inline-field">
              <input id="phoneLogin" class="input" inputmode="tel" autocomplete="tel" placeholder="+57 300 000 0000">
              <button class="btn ghost" type="button" id="sendOtpBtn" ${state.firebasePhone.busy ? `disabled aria-busy="true"` : ""}>${state.firebasePhone.busy ? "Enviando" : "Codigo"}</button>
            </div>
            <div id="phoneRecaptcha" class="recaptcha-slot"></div>
          </div>
          <div id="otpWrap" class="field ${mode === "phone" ? "" : "hidden"}">
            <label for="otpCode">Codigo</label>
            <input id="otpCode" class="input" inputmode="numeric" autocomplete="one-time-code" placeholder="000000">
          </div>
          <div id="phoneAliasWrap" class="field phone-alias-note ${mode === "phoneAlias" ? "" : "hidden"}">
            <label>Telefono verificado</label>
            <div class="verified-phone">${escapeHtml(state.pendingPhoneAlias?.phone || "")}</div>
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
  return mode === "register" ? "Crear Nivra" : mode === "qr" ? "Regenerar QR" : mode === "phoneAlias" ? "Terminar cuenta" : mode === "phone" ? "Verificar codigo" : "Continuar";
}

function setAuthMode(mode) {
  if (mode !== "phoneAlias") state.pendingPhoneAlias = null;
  if (mode !== "phone" && mode !== "phoneAlias") {
    clearFirebasePhoneChallenge();
    resetFirebaseRecaptchaVerifier({ clear: true }).catch(() => {});
  }
  document.querySelectorAll("[data-auth-tab]").forEach((tab) => tab.classList.toggle("active", tab.dataset.authTab === mode || (mode === "phoneAlias" && tab.dataset.authTab === "phone")));
  const form = document.querySelector("#authForm");
  if (!form) return;
  form.dataset.mode = mode;
  document.querySelector("#displayNameWrap")?.classList.toggle("hidden", mode !== "register" && mode !== "phoneAlias");
  document.querySelector("#phoneWrap")?.classList.toggle("hidden", mode !== "phone");
  document.querySelector("#otpWrap")?.classList.toggle("hidden", mode !== "phone");
  document.querySelector("#phoneAliasWrap")?.classList.toggle("hidden", mode !== "phoneAlias");
  document.querySelector("#qrLoginBox")?.classList.toggle("hidden", mode !== "qr");
  document.querySelector(".auth-alias-field")?.classList.toggle("hidden", mode === "phone" || mode === "qr");
  document.querySelector(".auth-password-field")?.classList.toggle("hidden", mode === "phone" || mode === "phoneAlias" || mode === "qr");
  const alias = document.querySelector("#alias");
  const password = document.querySelector("#password");
  if (alias) alias.required = mode === "login" || mode === "register" || mode === "phoneAlias";
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

function searchPlaceholder(view = state.view) {
  return {
    chats: "Buscar chats, usuarios o grupos",
    world: "Buscar personas o historias",
    vault: "Buscar notas o archivos",
    calls: "Buscar llamadas",
    privacy: "Buscar privacidad",
    account: "Buscar cuenta"
  }[view] || "Buscar";
}

function searchQueryForView(view = state.view) {
  return state.searchByView?.[view] ?? (view === state.view ? state.query || "" : "");
}

function currentSearchQuery() {
  return searchQueryForView(state.view);
}

function setSearchQueryForView(view, query) {
  const value = String(query || "");
  if (!state.searchByView) state.searchByView = {};
  state.searchByView[view || state.view] = value;
  if ((view || state.view) === state.view) state.query = value;
}

function normalizedSearchQuery(view = state.view) {
  return searchQueryForView(view).trim().toLowerCase();
}

function textMatchesSearch(value, query) {
  return !query || String(value || "").toLowerCase().includes(query);
}

function activateView(view, options = {}) {
  if (!view) return;
  setSearchQueryForView(state.view, currentSearchQuery());
  state.view = view;
  state.query = searchQueryForView(view);
  if (options.mobileChatOpen !== undefined) {
    state.mobileChatOpen = Boolean(options.mobileChatOpen);
  } else if (view !== "chats") {
    state.mobileChatOpen = false;
  }
  if (options.renderAfter !== false) render();
  if (view === "world" && isRemoteSearchQueryReady(searchQueryForView("world"))) {
    scheduleDirectorySearch();
  }
}

function handleGlobalSearchInput(event) {
  const view = state.view;
  setSearchQueryForView(view, event.target.value);
  switch (view) {
    case "world":
      if (isRemoteSearchQueryReady(searchQueryForView("world"))) {
        scheduleDirectorySearch();
      } else {
        state.searchRequestSeq += 1;
        state.directoryResults = [];
      }
      scheduleRender();
      break;
    case "chats":
    case "vault":
    case "calls":
    case "privacy":
    case "account":
    default:
      scheduleRender();
      break;
  }
}

function personSearchText(person = {}) {
  return [
    displayPerson(person),
    person.alias,
    person.userAlias,
    person.phone,
    person.email,
    person.bio
  ].filter(Boolean).join(" ");
}

function conversationSearchText(conversation) {
  const people = (conversation.participants || [])
    .map((participant) => findKnownPerson(participant.userId) || state.profileByUserId.get(participant.userId) || { alias: state.aliasByUserId.get(participant.userId) })
    .map(personSearchText)
    .join(" ");
  return [conversationTitle(conversation), conversation.type, conversationSubtitle(conversation, { archived: state.archivedConversationIds.has(conversation.id) }), people].join(" ");
}

function filteredConversations() {
  const query = normalizedSearchQuery("chats");
  return state.conversations.filter((conversation) => textMatchesSearch(conversationSearchText(conversation), query));
}

function filteredDirectoryPeople() {
  const query = normalizedSearchQuery("world");
  return state.directoryResults.filter((person) => textMatchesSearch(personSearchText(person), query));
}

function storySearchText(story = {}) {
  const payload = decodeStoryPayload(story.encryptedPayload);
  return [
    story.caption,
    story.visibility,
    payload.text,
    payload.media?.mime,
    personSearchText(story.owner)
  ].filter(Boolean).join(" ");
}

function filteredStories() {
  const query = normalizedSearchQuery("world");
  return state.stories.filter((story) => textMatchesSearch(storySearchText(story), query));
}

function storyOwnerId(story = {}) {
  return story.owner?.id || story.ownerId || story.ownerUserId || "";
}

function groupStoriesByOwner(stories = []) {
  const groups = new Map();
  for (const story of stories || []) {
    const ownerId = storyOwnerId(story);
    if (!ownerId) continue;
    const group = groups.get(ownerId) || {
      ownerId,
      owner: story.owner,
      stories: []
    };
    group.owner = { ...(group.owner || {}), ...(story.owner || {}) };
    group.stories.push(story);
    groups.set(ownerId, group);
  }

  return [...groups.values()]
    .map((group) => {
      group.stories = group.stories
        .slice()
        .sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
      group.latest = group.stories[group.stories.length - 1];
      group.unviewedCount = group.stories.filter((story) => !story.viewedByMe && storyOwnerId(story) !== state.auth?.user?.id).length;
      return group;
    })
    .sort((left, right) => Date.parse(right.latest?.createdAt || 0) - Date.parse(left.latest?.createdAt || 0));
}

function vaultItemSearchText(item = {}) {
  const meta = decryptVaultPreview(item.encryptedMetadata);
  return [item.kind, meta.title, meta.body, item.updatedAt].filter(Boolean).join(" ");
}

function filteredVaultItems() {
  const query = normalizedSearchQuery("vault");
  return state.vaultItems.filter((item) => textMatchesSearch(vaultItemSearchText(item), query));
}

function vaultRoomSearchText(room = {}) {
  const members = (room.members || []).map(personSearchText).join(" ");
  return [room.name, room.accessMode, room.retentionMode, room.encryptedWelcome, members].filter(Boolean).join(" ");
}

function filteredVaultRooms() {
  const query = normalizedSearchQuery("vault");
  return state.vaultRooms.filter((room) => textMatchesSearch(vaultRoomSearchText(room), query));
}

function filteredCallHistory() {
  const query = normalizedSearchQuery("calls");
  const current = state.call.current ? [callHistoryRecord(state.call.current, { live: true })] : [];
  const records = [...current, ...(state.callHistory || [])];
  const deduped = [...new Map(records.filter(Boolean).map((record) => [record.id, record])).values()];
  return deduped.filter((record) => textMatchesSearch(callSearchText(record), query));
}

function callSearchText(record = {}) {
  const people = (record.participants || []).map(personSearchText).join(" ");
  return [record.title, record.subtitle, record.type, record.status, record.direction, people, record.startedAt, record.endedAt].filter(Boolean).join(" ");
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
        <input class="input" id="globalSearch" placeholder="${escapeAttr(searchPlaceholder(state.view))}" value="${escapeAttr(currentSearchQuery())}">
      </div>
      <div class="list">${renderSideList()}</div>
    </aside>
  `;
}

function renderSideList() {
  if (state.view === "chats") {
    const query = normalizedSearchQuery("chats");
    const rawQuery = searchQueryForView("chats");
    const conversations = filteredConversations();
    if (!conversations.length) {
      const globalAction = query
        ? `<button class="btn ghost full" data-global-person-search="${escapeAttr(rawQuery)}">${icon("globe")}<span>Buscar "${escapeHtml(rawQuery)}" en la red global</span></button>`
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
      ? `<button class="quick-create" data-global-person-search="${escapeAttr(rawQuery)}">${icon("globe")}<span>Buscar "${escapeHtml(rawQuery)}" en la red global</span></button>`
      : "";
    return renderedConversations + globalAction;
  }

  if (state.view === "world") {
    const people = filteredDirectoryPeople().slice(0, 12);
    const stories = filteredStories().slice(0, 8);
    const incoming = state.friendRequests.filter((request) => request.status === "Pending" && request.to.id === state.auth.user.id);
    if (!people.length && !stories.length && !incoming.length) {
      return `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Mundo listo</h2><p>Busca personas publicas o publica una instantanea.</p></div>`;
    }
    return `
      ${incoming.length ? `<div class="side-section-title">Pendientes</div>${incoming.map(renderFriendRequestListItem).join("")}` : ""}
      ${people.length ? `<div class="side-section-title">Busquedas</div>${people.map(renderPersonListItem).join("")}` : ""}
      ${stories.length ? `<div class="side-section-title">Historias</div>${stories.map(renderStoryListItem).join("")}` : ""}
    `;
  }

  if (state.view === "vault") {
    const items = filteredVaultItems();
    return items.length
      ? items.map(renderVaultSideItem).join("")
      : `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Boveda vacia</h2><p>Crea notas o guarda archivos cifrados desde un chat.</p></div>`;
  }

  if (state.view === "calls") {
    const calls = filteredCallHistory();
    return calls.length
      ? calls.map(renderCallHistorySideItem).join("")
      : `<div class="empty"><img src="assets/nivra-mark.svg" alt=""><h2>Lista limpia</h2><p>Las llamadas se inician desde un chat o desde el panel principal.</p></div>`;
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

function renderStoryListItem(story) {
  const payload = decodeStoryPayload(story.encryptedPayload);
  const title = story.caption || payload.text || "Instantanea";
  return `
    <button class="list-item" data-view-story="${story.id}">
      ${avatarNode(story.owner)}
      <div>
        <div class="item-title">${escapeHtml(title)}</div>
        <div class="item-sub">@${escapeHtml(story.owner?.alias || "mundo")} - ${formatTime(story.expiresAt)}</div>
      </div>
    </button>
  `;
}

function renderVaultSideItem(item) {
  const meta = decryptVaultPreview(item.encryptedMetadata);
  return `
    <div class="list-item">
      <div class="avatar">V</div>
      <div>
        <div class="item-title">${escapeHtml(meta.title || item.kind)}</div>
        <div class="item-sub">${escapeHtml(item.kind)} - ${formatTime(item.updatedAt)}</div>
      </div>
    </div>
  `;
}

function renderCallHistorySideItem(call) {
  return `
    <div class="list-item">
      <div class="avatar">${call.type === "Video" ? "V" : "L"}</div>
      <div>
        <div class="item-title">${escapeHtml(call.title || "Llamada")}</div>
        <div class="item-sub">${escapeHtml(call.status || "Finalizada")} - ${formatTime(call.startedAt)}</div>
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

function renderNotificationPrompt() {
  const capability = notificationCapabilityStatus();
  if (!shouldShowNotificationPrompt(capability)) return "";

  const denied = capability.permission === "denied";
  const busy = state.pushRegistering;
  const title = denied ? "Notificaciones bloqueadas" : "Activar notificaciones";
  const detail = denied
    ? "Permitelas en los ajustes del navegador o del sistema para recibir llamadas y mensajes fuera de Nivra."
    : capability.native
      ? "Recibe llamadas y mensajes aunque la app este en segundo plano o cerrada."
      : "Recibe mensajes y llamadas aunque esta ventana no este abierta.";
  const error = state.pushError ? `<span class="notification-error">${escapeHtml(state.pushError)}</span>` : "";
  const action = denied
    ? ""
    : `<button class="btn primary" id="enableNotificationsBtn" ${busy ? `disabled aria-busy="true"` : ""}>${icon(busy ? "sync" : "bell")}<span>${busy ? "Activando" : "Activar"}</span></button>`;

  return `
    <section class="notification-prompt" role="status">
      <div class="notification-icon">${icon(denied ? "shield" : "bell")}</div>
      <div>
        <strong>${title}</strong>
        <span>${detail}</span>
        ${error}
      </div>
      <div class="notification-actions">
        ${action}
        <button class="btn ghost" id="dismissNotificationsBtn">Ahora no</button>
      </div>
    </section>
  `;
}

function shouldShowNotificationPrompt(capability = notificationCapabilityStatus()) {
  if (!state.auth?.tokens?.accessToken || !capability.supported || state.pushReady) return false;
  if (state.pushLocalReady && !state.pushError) return false;
  if (capability.permission === "granted" && !state.pushError && !state.pushRegistration) return false;
  if (isNotificationPromptDismissed() && !state.pushError) return false;
  return true;
}

function notificationCapabilityStatus() {
  if (window.NIVRA_PUSH_TOKEN) {
    return { supported: true, native: true, permission: "granted", reason: "" };
  }
  if (isNativeCapacitor()) {
    const supported = Boolean(window.Capacitor?.Plugins?.PushNotifications);
    return {
      supported,
      native: true,
      permission: normalizePushPermission(state.pushPermission),
      reason: supported ? "" : "El plugin nativo de push no esta instalado."
    };
  }

  const hasNotification = "Notification" in window;
  const hasServiceWorker = "serviceWorker" in navigator;
  const secureEnough = window.isSecureContext || PLATFORM.isLocalhost;
  const supported = hasNotification && hasServiceWorker && ["http:", "https:"].includes(window.location.protocol) && secureEnough;
  return {
    supported,
    native: false,
    permission: hasNotification ? Notification.permission : "unsupported",
    reason: supported ? "" : "Este navegador necesita HTTPS y service worker para push."
  };
}

function pushStatusLabel() {
  const capability = notificationCapabilityStatus();
  if (!capability.supported) return capability.reason || "No disponible en este dispositivo.";
  if (state.pushRegistering) return "Activando notificaciones...";
  if (state.pushReady && state.pushServerReady === false) return "Dispositivo registrado; falta configurar FCM en el servidor.";
  if (state.pushReady) return "Activas en este dispositivo.";
  if (state.pushLocalReady && state.pushTokenError) return state.pushTokenError;
  if (state.pushLocalReady) return "Avisos locales activos; falta registrar FCM para recibir con la app cerrada.";
  if (capability.permission === "denied") return "Bloqueadas por el navegador o el sistema.";
  if (capability.permission === "granted") return "Permiso concedido; pendiente registrar el token.";
  return "Pendientes de permiso.";
}

function pushPromptDismissKey() {
  const userId = state.auth?.user?.id || "anon";
  const deviceId = state.auth?.device?.id || "device";
  return `nivra.pushPromptDismissed.${userId}.${deviceId}`;
}

function isNotificationPromptDismissed() {
  const dismissedAt = Number(loadJson(pushPromptDismissKey()) || 0);
  return dismissedAt > 0 && Date.now() - dismissedAt < PUSH_PROMPT_DISMISS_MS;
}

function dismissNotificationPrompt() {
  saveJson(pushPromptDismissKey(), Date.now());
  state.pushError = "";
  render();
}

function clearNotificationPromptDismissal() {
  localStorage.removeItem(pushPromptDismissKey());
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

  const messages = visibleChatMessages(conversation.id);
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

function chatDomWindowState(conversationId) {
  if (!conversationId) return null;
  let windowState = state.messageDomWindows.get(conversationId);
  if (!windowState) {
    windowState = { start: null };
    state.messageDomWindows.set(conversationId, windowState);
  }
  return windowState;
}

function clampChatDomWindow(conversationId, { stickToBottom = false } = {}) {
  const messages = state.messages.get(conversationId) || [];
  const windowState = chatDomWindowState(conversationId);
  if (!windowState) return null;
  const maxStart = Math.max(0, messages.length - CHAT_DOM_LIMIT);
  if (stickToBottom || windowState.start === null || windowState.start === undefined) {
    windowState.start = maxStart;
  } else {
    windowState.start = Math.max(0, Math.min(windowState.start, maxStart));
  }
  return windowState;
}

function visibleChatMessages(conversationId, options = {}) {
  const messages = state.messages.get(conversationId) || [];
  const windowState = clampChatDomWindow(conversationId, options);
  const start = windowState?.start || 0;
  return messages.slice(start, start + CHAT_DOM_LIMIT);
}

function isLatestChatDomWindow(conversationId) {
  const messages = state.messages.get(conversationId) || [];
  const windowState = clampChatDomWindow(conversationId);
  return !windowState || windowState.start >= Math.max(0, messages.length - CHAT_DOM_LIMIT);
}

function resetChatDomWindow(conversationId) {
  if (!conversationId) return;
  state.messageDomWindows.set(conversationId, { start: null });
  clampChatDomWindow(conversationId, { stickToBottom: true });
}

function renderMessageWindowNodes(container, messages) {
  container.replaceChildren();
  if (!messages.length) {
    container.insertAdjacentHTML("beforeend", emptyChatHtml());
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    fragment.appendChild(htmlToNode(renderMessage(message)));
  }
  container.appendChild(fragment);
}

function renderConversationMessages(conversationId, { replace = false, scroll = true } = {}) {
  if (!conversationId || conversationId !== state.selectedConversationId) return false;
  const container = document.querySelector("#messages");
  if (!container) return false;
  const wasNearBottom = isNearMessagesBottom(container);
  const oldTop = container.scrollTop;
  const oldHeight = container.scrollHeight;
  const stickToBottom = scroll === "bottom" || (scroll && wasNearBottom && isLatestChatDomWindow(conversationId));
  const messages = visibleChatMessages(conversationId, { stickToBottom });
  renderMessageWindowNodes(container, messages);
  bindMessageGestureMenu();
  if (scroll === "bottom" || (scroll && wasNearBottom && isLatestChatDomWindow(conversationId))) {
    scrollMessages({ node: container, force: true });
    hideNewMessagesBadge();
  } else if (scroll) {
    container.scrollTop = Math.min(oldTop + Math.max(0, container.scrollHeight - oldHeight), container.scrollHeight);
  }
  if (!replace && scroll && !wasNearBottom) showNewMessagesBadge();
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
    renderConversationMessages(conversationId, { replace: true, scroll: false });
    return true;
  }
  const messages = state.messages.get(conversationId) || [];
  const index = messages.findIndex((item) => item.id === messageId);
  const windowState = clampChatDomWindow(conversationId, { stickToBottom: scroll && wasNearBottom });
  const inWindow = index >= (windowState?.start || 0) && index < (windowState?.start || 0) + CHAT_DOM_LIMIT;
  if (!inWindow) {
    if (scroll) showNewMessagesBadge();
    return false;
  }
  return renderConversationMessages(conversationId, {
    replace: true,
    scroll: scroll && wasNearBottom ? "bottom" : false
  });
}

function removeMessageNode(conversationId, messageId) {
  if (!conversationId || conversationId !== state.selectedConversationId || !messageId) return false;
  return renderConversationMessages(conversationId, { replace: true, scroll: false });
}

async function loadOlderConversationMessages(conversationId, { renderAfter = true } = {}) {
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
    updateConversationPaging(conversationId, page);
    if (renderAfter) renderConversationMessages(conversationId, { replace: true, scroll: false });
    markVisibleMessagesRead(conversationId).catch(() => {});
    return older.length;
  } catch (error) {
    console.warn("No se pudo cargar mas historial local.", error);
  } finally {
    paging.loading = false;
  }
  return 0;
}

function prependMessageNodes(conversationId, messages) {
  if (!conversationId || conversationId !== state.selectedConversationId || !messages?.length) return false;
  mergeConversationMessages(conversationId, messages);
  const windowState = clampChatDomWindow(conversationId);
  if (windowState) windowState.start = Math.max(0, (windowState.start || 0) - CHAT_DOM_LIMIT);
  return renderConversationMessages(conversationId, { replace: true, scroll: false });
}

async function showPreviousMessageWindow(conversationId) {
  if (!conversationId || conversationId !== state.selectedConversationId) return;
  const windowState = clampChatDomWindow(conversationId);
  if (!windowState) return;
  if (windowState.start > 0) {
    windowState.start = Math.max(0, windowState.start - CHAT_DOM_LIMIT);
    renderConversationMessages(conversationId, { replace: true, scroll: false });
    const container = document.querySelector("#messages");
    if (container) container.scrollTop = 8;
    return;
  }
  const loaded = await loadOlderConversationMessages(conversationId, { renderAfter: false });
  if (loaded > 0) {
    windowState.start = 0;
    renderConversationMessages(conversationId, { replace: true, scroll: false });
    const container = document.querySelector("#messages");
    if (container) container.scrollTop = 8;
  }
}

function showNextMessageWindow(conversationId) {
  if (!conversationId || conversationId !== state.selectedConversationId) return;
  const messages = state.messages.get(conversationId) || [];
  const windowState = clampChatDomWindow(conversationId);
  if (!windowState) return;
  const maxStart = Math.max(0, messages.length - CHAT_DOM_LIMIT);
  if (windowState.start >= maxStart) {
    hideNewMessagesBadge();
    return;
  }
  windowState.start = Math.min(maxStart, windowState.start + CHAT_DOM_LIMIT);
  renderConversationMessages(conversationId, { replace: true, scroll: false });
  const container = document.querySelector("#messages");
  if (container) container.scrollTop = 8;
  if (windowState.start >= maxStart) hideNewMessagesBadge();
}

function bindMessagesScrollLoader() {
  const container = document.querySelector("#messages");
  if (!container || container.dataset.scrollLoaderBound === "1") return;
  container.dataset.scrollLoaderBound = "1";
  container.addEventListener("scroll", () => {
    if (isNearMessagesBottom(container) && isLatestChatDomWindow(state.selectedConversationId)) hideNewMessagesBadge();
    clearTimeout(state.messageScrollTimer);
    state.messageScrollTimer = setTimeout(() => {
      if (container.scrollTop <= 4) {
        showPreviousMessageWindow(state.selectedConversationId).catch(() => {});
      } else if (isNearMessagesBottom(container)) {
        showNextMessageWindow(state.selectedConversationId);
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
      { label: "Vaciar para mi", iconName: "trash", action: () => clearChat(conversationId, "me") },
      { label: "Vaciar para todos", iconName: "trash", action: () => clearChat(conversationId, "everyone"), danger: true },
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
  const people = filteredDirectoryPeople().slice(0, 16);
  const storyGroups = groupStoriesByOwner(filteredStories()).slice(0, 24);
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
          <div class="story-grid story-group-grid">${storyGroups.length ? storyGroups.map(renderStoryGroupCard).join("") : `<p class="muted">Aun no hay instantaneas visibles.</p>`}</div>
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

function renderStoryGroupCard(group) {
  const latest = group.latest || group.stories?.[group.stories.length - 1];
  const payload = decodeStoryPayload(latest?.encryptedPayload);
  const mediaLabel = payload.media ? fileTypeLabel(payload.media.mime) : null;
  const firstUnseen = group.stories.find((story) => !story.viewedByMe) || group.stories[0] || latest;
  const total = group.stories.length;
  const unread = group.unviewedCount;
  return `
    <button class="story-card story-group-card ${unread ? "unread" : ""}" data-view-story-group="${escapeAttr(group.ownerId)}" data-story-id="${escapeAttr(firstUnseen?.id || latest?.id || "")}">
      <div class="story-head">
        <div class="story-avatar-stack">
          ${avatarNode(group.owner)}
          ${total > 1 ? `<span>${total}</span>` : ""}
        </div>
        <div>
          <strong>${escapeHtml(displayPerson(group.owner))}</strong>
          <span>${unread ? `${unread} nueva${unread === 1 ? "" : "s"}` : "Vistas"} - ${formatTime(latest?.expiresAt)}</span>
        </div>
      </div>
      <p>${escapeHtml(latest?.caption || payload.text || "Instantanea")}</p>
      <div class="story-meta"><span>${mediaLabel || (latest?.viewOnce ? "Una vez" : "Normal")}</span><span>${latest?.viewCount || 0} vistas</span></div>
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
  const rooms = filteredVaultRooms();
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
          <div class="stack">${renderVaultRooms(rooms)}</div>
        </div>
      </div>
    </div>
  `;
}

function renderVaultItems() {
  const items = filteredVaultItems();
  if (!items.length) return `<p class="muted">Aun no hay elementos guardados.</p>`;
  return items.map((item) => {
    const meta = decryptVaultPreview(item.encryptedMetadata);
    return `<div class="card"><strong>${escapeHtml(meta.title || item.kind)}</strong><p>${escapeHtml(meta.body || "Elemento cifrado")}</p><span class="muted">${formatTime(item.updatedAt)}</span></div>`;
  }).join("");
}

function renderVaultRooms(rooms = filteredVaultRooms()) {
  if (!rooms.length) return `<p class="muted">Aun no hay salas compartidas.</p>`;
  return rooms.map((room) => `
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
        <button class="btn ghost" type="button" id="qrScanFileBtn" ${state.qrScanner.busy ? "disabled" : ""}>${icon("image")}<span>Imagen</span></button>
        <button class="btn primary" type="button" id="restartQrScannerBtn" ${state.qrScanner.busy ? "disabled" : ""}>${icon("sync")}<span>Reintentar</span></button>
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
      ${mode === "group" ? `<div class="modal-actions"><button class="btn primary full" id="createGroupChatBtn" ${state.chatSearch.selectedIds.size ? "" : "disabled"}>Crear grupo (${state.chatSearch.selectedIds.size})</button></div>` : ""}
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
  const playback = state.storyPlayback || {};
  const storyIds = playback.storyIds?.length ? playback.storyIds : (story?.id ? [story.id] : []);
  const playbackIndex = Math.max(0, storyIds.indexOf(story?.id));
  const canGoPrev = playbackIndex > 0;
  const canGoNext = playbackIndex >= 0 && playbackIndex < storyIds.length - 1;
  const progressBars = storyIds.map((storyId, index) => `
    <span class="story-progress-segment ${index < playbackIndex ? "done" : ""} ${index === playbackIndex ? "active" : ""}">
      <span data-story-progress="${index}" style="width:${index < playbackIndex ? 100 : 0}%"></span>
    </span>
  `).join("");
  const quickReactionButtons = STORY_REACTIONS.map((item) => `
    <button class="story-quick-reaction ${item.value === selectedReaction ? "selected" : ""}" type="button" data-story-quick-reaction="${escapeAttr(item.key)}" aria-label="Responder con reaccion" ${responseBusy ? "disabled" : ""}>${escapeHtml(item.value)}</button>
  `).join("");
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
        <div class="story-progress">${progressBars}</div>
        <div class="story-viewer-head">
          ${avatarNode(story.owner, "mini-avatar")}
          <div><strong>${escapeHtml(displayPerson(story.owner))}</strong><span>${formatTime(story.expiresAt)}</span></div>
          <div class="story-viewer-controls">
            <button class="btn icon" type="button" id="storyPrevBtn" title="Anterior" aria-label="Anterior" ${canGoPrev ? "" : "disabled"}>${icon("chevron-left")}</button>
            <button class="btn icon" type="button" id="storyPauseBtn" title="${playback.paused ? "Continuar" : "Pausar"}" aria-label="${playback.paused ? "Continuar" : "Pausar"}">${icon(playback.paused ? "play" : "pause")}</button>
            <button class="btn icon" type="button" id="storyNextBtn" title="Siguiente" aria-label="Siguiente" ${canGoNext ? "" : "disabled"}>${icon("chevron-right")}</button>
          </div>
          <button class="btn icon" data-close-modal title="Cerrar" aria-label="Cerrar">${icon("x")}</button>
        </div>
        <div class="story-viewer-body">
          ${mediaHtml}
          <p>${escapeHtml(payload?.text || story.text || story.caption || "Instantanea")}</p>
        </div>
        ${story.owner?.id !== state.auth.user.id ? `
          <div class="story-response-bar">
            <div class="story-quick-reactions" role="group" aria-label="Reacciones rapidas">
              ${quickReactionButtons}
            </div>
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
  const ending = Boolean(state.call.ending);
  const endLabel = ending ? "Cerrando" : isGroupCall(call) && call.initiatorUserId !== state.auth.user.id ? "Salir" : "Colgar";
  const endingAttrs = ending ? `disabled aria-busy="true"` : "";
  return `
    <section class="call-layer ${isVideo ? "video" : "voice"} ${isIncoming ? "incoming" : ""} ${state.call.minimized ? "call-minimized" : ""}" aria-label="Llamada">
      <div class="call-shell">
        <div class="call-ambient"></div>
        <header class="call-header">
          <button class="btn ghost" id="minimizeCallBtn">${icon("message")}<span>Chat</span></button>
          <div>
            <strong data-call-status>${escapeHtml(status)}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <button class="btn danger" id="endCallTopBtn" ${endingAttrs}>${icon("phone-off")}<span>${endLabel}</span></button>
        </header>
        <div class="call-stage ${isVideo ? "video-stage" : "voice-stage"}">
          ${isVideo ? renderVideoCallStage(participants) : renderVoiceCallStage(participants, title)}
        </div>
        <footer class="call-controls">
          ${isIncoming ? `
            <button class="call-action accept" id="acceptCallBtn">${icon(isVideo ? "video" : "phone")}<span>Aceptar</span></button>
            <button class="call-action decline" id="declineCallBtn" ${endingAttrs}>${icon("phone-off")}<span>${ending ? "Cerrando" : "Rechazar"}</span></button>
          ` : `
            <button class="call-action ${state.call.muted ? "active" : ""}" id="toggleMuteBtn">${icon(state.call.muted ? "mic-off" : "mic")}<span>${state.call.muted ? "Silenciado" : "Micro"}</span></button>
            ${isVideo ? `<button class="call-action ${state.call.cameraOff ? "active" : ""}" id="toggleCameraBtn">${icon(state.call.cameraOff ? "video-off" : "video")}<span>${state.call.cameraOff ? "Camara off" : "Camara"}</span></button>` : ""}
            <button class="call-action ${state.call.speaker ? "active" : ""}" id="toggleSpeakerBtn">${icon("volume")}<span>Audio</span></button>
            <button class="call-action decline" id="endCallBtn" ${endingAttrs}>${icon("phone-off")}<span>${endLabel}</span></button>
          `}
        </footer>
      </div>
    </section>
  `;
}

function bindIncomingCallOverlayEvents() {
  const overlay = document.querySelector("#incomingCallOverlay");
  if (!overlay || overlay.dataset.bound === "true") return;
  overlay.dataset.bound = "true";
  document.querySelector("#incomingAcceptBtn")?.addEventListener("click", () => {
    acceptCall().catch((error) => toast(error.message || "No se pudo contestar."));
  });
  document.querySelector("#incomingDeclineBtn")?.addEventListener("click", (event) => {
    declineCall(event).catch((error) => toast(error.message || "No se pudo rechazar."));
  });
}

function syncIncomingCallOverlay() {
  const overlay = document.querySelector("#incomingCallOverlay");
  if (!overlay) return;
  const call = state.call.current;
  const visible = Boolean(call && state.call.phase === "incoming");
  overlay.classList.toggle("hidden", !visible);
  overlay.classList.toggle("call-minimized", visible && state.call.minimized);
  overlay.setAttribute("aria-hidden", visible ? "false" : "true");
  if (!visible) return;

  const participants = callParticipants(call);
  const caller = participants.find((person) => person.id !== state.auth?.user?.id) || participants[0] || {};
  const name = displayPerson(caller);
  const type = call.type === "Video" ? "Videollamada entrante" : "Llamada entrante";
  const avatar = document.querySelector("#incomingCallAvatar");
  document.querySelector("#incomingCallType").textContent = type;
  document.querySelector("#incomingCallName").textContent = name;
  document.querySelector("#incomingCallStatus").textContent = "Quiere hablar contigo ahora.";
  if (avatar) {
    if (caller.profilePhotoDataUrl) {
      avatar.innerHTML = `<img src="${escapeAttr(caller.profilePhotoDataUrl)}" alt="">`;
    } else {
      avatar.textContent = initials(name);
    }
  }
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
  const callHistory = filteredCallHistory();
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
        <div class="card span-12">
          <h3>Historial</h3>
          <div class="call-roster">${callHistory.length ? callHistory.map(renderCallHistoryCard).join("") : `<p class="muted">Aun no hay llamadas registradas en este dispositivo.</p>`}</div>
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

function renderCallHistoryCard(call) {
  const canRejoin = canRejoinCall(call);
  return `
    <div class="person-card compact-person">
      <div class="avatar">${call.type === "Video" ? "V" : "L"}</div>
      <div>
        <strong>${escapeHtml(call.title || "Llamada")}</strong>
        <span>${escapeHtml(call.subtitle || call.status || "Historial")} - ${formatTime(call.startedAt)}</span>
      </div>
      ${canRejoin ? `<button class="btn primary" data-rejoin-call="${escapeAttr(call.id)}">${icon("phone")}<span>Reentrar</span></button>` : ""}
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
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
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
    pause: '<path d="M8 5v14"/><path d="M16 5v14"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
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
        <div class="card span-5">
          <h3>Notificaciones</h3>
          <p>${escapeHtml(pushStatusLabel())}</p>
          ${state.pushError || state.pushTokenError ? `<p class="notification-error">${escapeHtml(state.pushError || state.pushTokenError)}</p>` : ""}
          <div class="stack">
            <button class="btn primary" id="enableNotificationsAccountBtn" ${state.pushRegistering ? `disabled aria-busy="true"` : ""}>${icon(state.pushRegistering ? "sync" : "bell")}<span>${state.pushReady ? "Reparar registro" : state.pushLocalReady ? "Reintentar FCM" : "Activar notificaciones"}</span></button>
            <button class="btn ghost" id="testNotificationBtn" ${state.pushReady || notificationCapabilityStatus().permission === "granted" ? "" : "disabled"}>${icon("bell")}<span>Probar aviso</span></button>
          </div>
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
      activateView(button.dataset.view);
    });
  });
  document.querySelector("#globalSearch")?.addEventListener("input", handleGlobalSearchInput);
  document.querySelector("#newChatBtn")?.addEventListener("click", openNewChatDialog);
  document.querySelector("#contactsBtn")?.addEventListener("click", () => openContactsDialog("mine"));
  document.querySelector("#contactsEmptyBtn")?.addEventListener("click", () => openContactsDialog("mine"));
  document.querySelectorAll("[data-global-person-search]").forEach((button) => {
    button.addEventListener("click", () => openContactsDialog("discover", button.dataset.globalPersonSearch || currentSearchQuery()));
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
    button.addEventListener("click", () => openConversationFromList(button.dataset.openConversation).catch(() => {}));
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
  document.querySelectorAll("[data-view-story-group]").forEach((button) => {
    button.addEventListener("click", () => openStoryGroup(button.dataset.viewStoryGroup, button.dataset.storyId).catch((error) => toast(error.message || "No se pudo abrir historia.")));
  });
  document.querySelector("#syncBtn")?.addEventListener("click", async () => {
    await bootstrap();
    await pollPending();
    toast("Sincronizado.");
  });
  document.querySelector("#enableNotificationsBtn")?.addEventListener("click", enableNotificationsFromUserAction);
  document.querySelector("#enableNotificationsAccountBtn")?.addEventListener("click", enableNotificationsFromUserAction);
  document.querySelector("#dismissNotificationsBtn")?.addEventListener("click", dismissNotificationPrompt);
  document.querySelector("#testNotificationBtn")?.addEventListener("click", testNotificationDelivery);
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
  document.querySelectorAll("[data-story-quick-reaction]").forEach((button) => {
    button.addEventListener("click", (event) => sendQuickStoryReaction(event, button.dataset.storyQuickReaction));
  });
  document.querySelector("#storyPrevBtn")?.addEventListener("click", () => openAdjacentStory(-1).catch(() => {}));
  document.querySelector("#storyPauseBtn")?.addEventListener("click", toggleStoryPlayback);
  document.querySelector("#storyNextBtn")?.addEventListener("click", () => openAdjacentStory(1).catch(() => {}));
  bindStoryMediaEvents();
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
  document.querySelectorAll("[data-rejoin-call]").forEach((button) => {
    button.addEventListener("click", () => rejoinCall(button.dataset.rejoinCall));
  });
  document.querySelector("#acceptCallBtn")?.addEventListener("click", acceptCall);
  document.querySelector("#declineCallBtn")?.addEventListener("click", declineCall);
  document.querySelector("#endCallBtn")?.addEventListener("click", endCurrentCall);
  document.querySelector("#endCallTopBtn")?.addEventListener("click", endCurrentCall);
  document.querySelector("#toggleMuteBtn")?.addEventListener("click", toggleCallMute);
  document.querySelector("#toggleCameraBtn")?.addEventListener("click", toggleCallCamera);
  document.querySelector("#toggleSpeakerBtn")?.addEventListener("click", toggleCallSpeaker);
  document.querySelector("#minimizeCallBtn")?.addEventListener("click", () => {
    minimizeActiveCallToChat();
  });
  document.querySelector(".call-layer.call-minimized")?.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    restoreActiveCallLayer();
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

  if (mode === "phoneAlias") {
    await completePhoneAlias();
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
  state.pendingPhoneAlias = null;
  const phone = document.querySelector("#phoneLogin")?.value.trim();
  if (!phone) return;
  setPhoneAuthBusy(true);
  try {
    const session = await getFirebasePhoneAuthSession();
    const verifier = await getFirebaseRecaptchaVerifier(session);
    state.firebasePhone.confirmationResult = await session.signInWithPhoneNumber(phone, verifier);
    state.firebasePhone.phone = phone;
    document.querySelector("#otpCode")?.focus();
    toast("Codigo SMS enviado por Firebase.");
  } catch (error) {
    const forceClear = String(error?.code || error?.message || "").toLowerCase().includes("already been rendered");
    await resetFirebaseRecaptchaVerifier({ clear: forceClear });
    toast(firebasePhoneAuthErrorMessage(error, "No se pudo enviar el codigo SMS."));
  } finally {
    setPhoneAuthBusy(false);
  }
}

async function verifyPhoneOtp() {
  const phone = document.querySelector("#phoneLogin")?.value.trim();
  const code = document.querySelector("#otpCode")?.value.trim();
  if (!phone || !code) {
    toast("Telefono y codigo son obligatorios.");
    return;
  }
  if (!state.firebasePhone.confirmationResult) {
    toast("Primero pide el codigo SMS de Firebase.");
    return;
  }
  setPhoneAuthBusy(true);
  try {
    const credential = await state.firebasePhone.confirmationResult.confirm(code);
    const firebaseToken = await credential.user.getIdToken();
    const keys = await prepareDeviceKeys({ registration: true });
    const response = await request("/api/auth/phone/verify-firebase", {
      method: "POST",
      body: { firebaseToken, deviceName: deviceName(), keyBundle: keys.keyBundle },
      skipAuth: true
    });
    if (response?.requiresAlias) {
      state.pendingPhoneAlias = {
        token: response.phoneSetupToken,
        expiresAt: response.phoneSetupExpiresAt,
        phone: response.phone || state.firebasePhone.phone || phone,
        keys
      };
      clearFirebasePhoneChallenge();
      setAuthMode("phoneAlias");
      document.querySelector("#alias")?.focus();
      toast("Telefono verificado. Escoge tu alias para terminar.");
      return;
    }
    const auth = response?.auth || response;
    clearFirebasePhoneChallenge();
    await completeAuth(auth, keys);
  } catch (error) {
    toast(firebasePhoneAuthErrorMessage(error, "No se pudo entrar por telefono."));
  } finally {
    setPhoneAuthBusy(false);
  }
}

async function completePhoneAlias() {
  const pending = state.pendingPhoneAlias;
  const alias = document.querySelector("#alias")?.value.trim();
  const displayName = document.querySelector("#displayName")?.value.trim();
  if (!pending?.token || !pending?.keys || !alias) {
    toast("Escoge tu alias para terminar la cuenta.");
    return;
  }
  try {
    const auth = await request("/auth/phone/complete-alias", {
      method: "POST",
      body: {
        phoneSetupToken: pending.token,
        alias,
        displayName: displayName || alias,
        deviceName: deviceName(),
        keyBundle: pending.keys.keyBundle
      },
      skipAuth: true
    });
    state.pendingPhoneAlias = null;
    await completeAuth(auth, pending.keys);
  } catch (error) {
    toast(error.message || "No se pudo terminar la cuenta.");
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
  const publicKey = base64UrlJson(ephemeral.publicJwk);
  const serverChallenge = await request("/auth/qr/start", {
    method: "POST",
    body: {
      deviceName: deviceName(),
      keyBundle: null,
      publicKey
    },
    skipAuth: true
  });
  const query = new URLSearchParams({
    qr_login_id: serverChallenge.qrId,
    qr_code: serverChallenge.code
  });
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(apiUrl(`/hubs/realtime?${query.toString()}`), { withCredentials: false })
    .withAutomaticReconnect()
    .build();
  detachQrLoginHandlers(connection);
  connection.on("QrAuthorized", async (authorization) => {
    await handleQrLoginAuthorized(authorization, ephemeral, connection);
  });
  connection.on("auth.qrAuthorized", async (authorization) => {
    await handleQrLoginAuthorized(authorization, ephemeral, connection);
  });
  connection.on("qr-login-success", async (encryptedPayload) => {
    await handleQrLoginSuccess(encryptedPayload, ephemeral, connection);
  });
  await connection.start();
  const challenge = buildQrLinkChallenge(serverChallenge, ephemeral.publicJwk, ephemeral.publicSpki);
  state.qrLogin = { ...challenge, connection, ephemeral, active: true };
  renderQrChallenge(state.qrLogin);
}

async function completeAuth(auth, keys) {
  state.auth = auth;
  saveJson("nivra.auth", auth);
  await saveDeviceKeys(auth.user.alias, auth.device.id, keys.privateJwk, keys.publicJwk, { userId: auth.user.id });
  await bootstrap();
  if (state.launchPush) {
    const launchPush = state.launchPush;
    state.launchPush = null;
    await handlePushNavigation(launchPush, { action: launchPush.pushAction || "" }).catch(() => {});
  }
  await refreshPushPermissionState().catch(() => {});
  await initializePushNotifications({ requestPermission: false }).catch(() => {});
  await connectRealtime();
  await syncPendingMessages("auth", { force: true }).catch(() => {});
  startPolling();
  render();
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
      window.QRCode.toCanvas(canvas, qrText, { width: 196, margin: 2, errorCorrectionLevel: "L", color: { dark: "#04100d", light: "#f4fbf7" } }).catch(() => {
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
    const qr = window.qrcode(0, "L");
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
  connection?.off?.("QrAuthorized");
  connection?.off?.("auth.qrAuthorized");
  connection?.off?.("qr-login-success");
}

function buildQrLinkChallenge(serverChallenge, publicJwk, publicSpki = "") {
  const createdAt = new Date();
  const expiresAt = serverChallenge?.expiresAt ? new Date(serverChallenge.expiresAt) : new Date(createdAt.getTime() + QR_LOGIN_TTL_MS);
  const qrId = serverChallenge?.qrId || "";
  const code = serverChallenge?.code || "";
  const syncToken = serverChallenge?.syncToken || `${qrId}.${code}`;
  const publicKey = base64UrlJson(publicJwk);
  const payload = {
    v: 3,
    type: "nivra-qr-login",
    qrId,
    code,
    publicKey,
    publicSpki,
    expiresAt: expiresAt.toISOString()
  };
  const query = new URLSearchParams({
    v: String(payload.v),
    type: payload.type,
    qrId,
    code,
    pk: publicSpki || publicKey,
    k: publicSpki ? "spki" : "jwk",
    exp: payload.expiresAt
  });
  const qrData = `nivra://login/qr?${query.toString()}`;
  const expiresTimer = setTimeout(() => {
    if (state.qrLogin?.qrId === qrId) {
      stopQrLogin().catch(() => {});
      setAuthMode("qr");
      toast("QR renovado por seguridad.");
    }
  }, Math.max(1000, expiresAt.getTime() - Date.now()));
  return {
    ...payload,
    qrData,
    shortCode: code || syncToken.slice(-6).toUpperCase(),
    status: "Escanealo desde Cuenta -> Vincular dispositivo.",
    expiresTimer
  };
}

async function handleQrLoginSuccess(encryptedPayload, ephemeral, connection) {
  if (!state.qrLogin?.active) return;
  try {
    const payload = await decryptQrPayload(encryptedPayload, ephemeral.privateKey);
    if (!payload?.auth?.tokens?.accessToken || !payload?.keyMaterial?.privateJwk) {
      throw new Error("El paquete QR no contiene una sesion valida.");
    }
    await finishQrImportedAuth(payload.auth, payload.keyMaterial, connection);
  } catch (error) {
    toast(error.message || "No se pudo desbloquear el QR.");
  }
}

async function handleQrLoginAuthorized(authorization, ephemeral, connection) {
  if (!state.qrLogin?.active) return;
  try {
    const auth = authorization?.auth || authorization?.Auth;
    const encryptedPayload = authorization?.encryptedPayload || authorization?.EncryptedPayload;
    if (!auth?.tokens?.accessToken || !encryptedPayload) {
      throw new Error("La autorizacion QR no contiene una sesion valida.");
    }
    const payload = await decryptQrPayload(encryptedPayload, ephemeral.privateKey);
    if (!payload?.keyMaterial?.privateJwk) {
      throw new Error("El paquete QR no contiene llaves locales.");
    }
    await finishQrImportedAuth(auth, payload.keyMaterial, connection);
  } catch (error) {
    toast(error.message || "No se pudo desbloquear el QR.");
  }
}

async function finishQrImportedAuth(auth, keyMaterial, connection) {
  detachQrLoginHandlers(connection);
  await connection.stop().catch(() => {});
  state.qrLogin = null;
  state.auth = auth;
  saveJson("nivra.auth", auth);
  await saveDeviceKeys(
    auth.user.alias,
    auth.device.id,
    keyMaterial.privateJwk,
    keyMaterial.publicJwk,
    { userId: auth.user.id, importedFromQr: true }
  );
  await bootstrap();
  await refreshPushPermissionState().catch(() => {});
  await initializePushNotifications({ requestPermission: false }).catch(() => {});
  await connectRealtime();
  startPolling();
  render();
  toast("Dispositivo vinculado.");
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
    activateView("chats", { mobileChatOpen: true, renderAfter: false });
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
  const query = searchQueryForView("world").trim();
  if (!isRemoteSearchQueryReady(query)) {
    state.directoryResults = [];
    if (state.view === "world") render();
    return;
  }
  const requestSeq = ++state.searchRequestSeq;
  const viewEpoch = state.viewEpoch;
  try {
    const result = await request(`/directory/search?q=${encodeURIComponent(query)}`);
    if (requestSeq !== state.searchRequestSeq || state.viewEpoch !== viewEpoch) return;
    state.directoryResults = result.people || [];
    state.directoryResults.forEach((person) => state.aliasByUserId.set(person.id, person.alias));
    if (state.view === "world") render();
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
  if (state.activeStory) resetStoryPlayback();
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
    try {
      await reader.start(
        { facingMode: { ideal: "environment" } },
        {
          fps: 7,
          qrbox: (width, height) => {
            const size = Math.min(width, height, 300);
            return { width: size, height: size };
          },
          aspectRatio: 1,
          disableFlip: true,
          experimentalFeatures: { useBarCodeDetectorIfSupported: true }
        },
        (decodedText) => {
          handleQrScanResult(decodedText).catch((error) => {
            console.warn("QR scan handling failed.", error);
          });
        }
      );
    } catch (error) {
      state.qrScanner.reader = null;
      try { reader.clear?.(); } catch {}
      throw error;
    }
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
    try { reader.clear?.(); } catch {}
  }
  if (state.qrScanner.raf) {
    cancelAnimationFrame(state.qrScanner.raf);
    state.qrScanner.raf = null;
  }
  if (state.qrScanner.stream) {
    state.qrScanner.stream.getTracks().forEach((track) => track.stop());
    state.qrScanner.stream = null;
  }
  const video = document.querySelector("#qrScannerVideo");
  if (video) {
    try {
      video.pause?.();
      video.srcObject = null;
      video.classList.add("hidden");
      video.load?.();
    } catch {}
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
  let tempReader = null;
  try {
    const reader = state.qrScanner.reader?.scanFile
      ? state.qrScanner.reader
      : window.Html5Qrcode
        ? (tempReader = new Html5Qrcode("qrScannerRegion"))
        : null;
    if (reader?.scanFile) {
      const result = await reader.scanFile(file, true);
      await handleQrScanResult(result);
      return;
    }
    throw new Error("La lectura por imagen requiere html5-qrcode.");
  } catch (error) {
    setQrScannerStatus(error.message || "No pude leer ese QR.");
  } finally {
    try { tempReader?.clear?.(); } catch {}
    event.target.value = "";
  }
}

async function handleQrScanResult(decodedText) {
  if (state.qrScanner.busy) return;
  state.qrScanner.busy = true;
  setQrScannerStatus("QR leido. Deteniendo camara...");
  try {
    const challenge = parseQrLoginData(decodedText);
    await stopQrScanner();
    setQrScannerStatus("QR leido. Vinculando dispositivo...");
    await authorizeQrLogin(challenge);
    state.modal = null;
    state.qrScanner.busy = false;
    render();
    toast("Dispositivo vinculado.");
  } catch (error) {
    state.qrScanner.busy = false;
    const message = error.message || "No se pudo vincular el dispositivo.";
    toast(message);
    setQrScannerStatus(`${message} Reintentando escaner...`);
    await stopQrScanner().catch(() => {});
    setTimeout(() => {
      if (state.modal?.type !== "qrScanner" || state.qrScanner.busy) return;
      startQrScanner().catch((restartError) => {
        state.qrScanner.busy = false;
        setQrScannerStatus(restartError.message || "No se pudo abrir la camara.");
      });
    }, 700);
  }
}

function parseQrLoginData(raw) {
  const text = String(raw || "").trim();
  let encoded = text;
  let payload = null;
  try {
    const url = new URL(text);
    const directPublicKey = url.searchParams.get("publicKey") || url.searchParams.get("pk") || "";
    const directQrId = url.searchParams.get("qrId") || url.searchParams.get("qr_login_id") || "";
    const directCode = url.searchParams.get("code") || url.searchParams.get("qr_code") || "";
    if (directPublicKey && (directQrId || url.searchParams.get("syncToken"))) {
      const keyKind = (url.searchParams.get("k") || url.searchParams.get("keyType") || (url.searchParams.has("publicKey") ? "jwk" : "spki")).toLowerCase();
      payload = {
        v: Number(url.searchParams.get("v") || 3),
        type: url.searchParams.get("type") || "nivra-qr-login",
        qrId: directQrId,
        code: directCode,
        syncToken: url.searchParams.get("syncToken") || "",
        publicKey: keyKind === "jwk" ? directPublicKey : "",
        publicSpki: keyKind === "spki" ? directPublicKey : "",
        expiresAt: url.searchParams.get("expiresAt") || url.searchParams.get("exp") || ""
      };
    } else {
      encoded = url.searchParams.get("data") || url.hash.replace(/^#/, "") || text;
    }
  } catch {}
  if (!payload) {
    try {
      payload = encoded.startsWith("{") ? JSON.parse(encoded) : jsonFromBase64Url(encoded);
    } catch {
      throw new Error("Ese QR no pertenece a Nivra.");
    }
  }
  if (payload?.type !== "nivra-qr-login" || (!payload.publicKey && !payload.publicSpki) || (!payload.connectionId && (!payload.qrId || !payload.code) && !payload.syncToken)) {
    throw new Error("QR de vinculacion invalido.");
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error("Ese QR ya vencio. Genera uno nuevo.");
  }
  if ((!payload.qrId || !payload.code) && payload.syncToken) {
    const parts = String(payload.syncToken).split(".");
    payload.qrId = parts[0];
    payload.code = parts[1];
  }
  return {
    ...payload,
    publicJwk: payload.publicKey ? jsonFromBase64Url(payload.publicKey) : null
  };
}

async function authorizeQrLogin(challenge) {
  const keyMaterial = await currentKeyMaterial();
  if (!state.auth?.tokens?.accessToken || !keyMaterial?.privateJwk) {
    throw new Error("Necesitas una sesion activa y una llave local para vincular.");
  }
  const payload = {
    keyMaterial,
    sourceDeviceName: deviceName(),
    linkedAt: new Date().toISOString()
  };
  const publicMaterial = challenge.publicJwk || challenge.publicSpki;
  const sealed = await encryptQrPayload(publicMaterial, challenge.qrId && challenge.code ? payload : { ...payload, auth: state.auth });
  if (challenge.qrId && challenge.code) {
    await request("/api/auth/qr-login", {
      method: "POST",
      timeoutMs: QR_AUTHORIZE_TIMEOUT_MS,
      body: {
        qrId: challenge.qrId,
        code: challenge.code,
        encryptedPayload: sealed
      }
    });
    return;
  }

  await request("/api/auth/authorize-qr", {
    method: "POST",
    timeoutMs: QR_AUTHORIZE_TIMEOUT_MS,
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
    activateView("chats", { mobileChatOpen: true, renderAfter: false });
    closeModal();
    await loadConversationHistory(conversation.id, true);
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
    activateView("world", { renderAfter: false });
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

async function openStoryGroup(ownerId, storyId = null) {
  const groups = groupStoriesByOwner(filteredStories().length ? filteredStories() : state.stories);
  const group = groups.find((item) => item.ownerId === ownerId);
  if (!group?.stories?.length) return;
  clearStoryPlaybackTimers();
  const target = group.stories.find((story) => story.id === storyId) ||
    group.stories.find((story) => !story.viewedByMe) ||
    group.stories[0];
  state.storyPlayback = {
    ...state.storyPlayback,
    ownerId,
    storyIds: group.stories.map((story) => story.id),
    index: Math.max(0, group.stories.findIndex((story) => story.id === target.id)),
    paused: false,
    startedAt: 0,
    remainingMs: 0,
    durationMs: 0
  };
  await viewStory(target.id, { preservePlayback: true });
}

async function viewStory(storyId, options = {}) {
  try {
    if (!options.preservePlayback) {
      const localStory = state.stories.find((item) => item.id === storyId);
      const ownerId = storyOwnerId(localStory);
      if (ownerId) {
        const group = groupStoriesByOwner(state.stories).find((item) => item.ownerId === ownerId);
        state.storyPlayback = {
          ...state.storyPlayback,
          ownerId,
          storyIds: group?.stories?.map((story) => story.id) || [storyId],
          index: Math.max(0, group?.stories?.findIndex((story) => story.id === storyId) ?? 0),
          paused: false
        };
      }
    }
    const story = await request(`/stories/${storyId}/view`, { method: "POST" });
    const payload = decodeStoryPayload(story.encryptedPayload);
    const text = payload.text || story.caption || "Instantanea";
    const openedStory = { ...story, payload, text };
    resetStoryResponseDraft();
    state.stories = [openedStory, ...state.stories.filter((item) => item.id !== story.id)];
    state.activeStory = openedStory;
    render();
    startStoryPlayback(openedStory);
    loadActiveStoryMedia().catch(() => {});
    bootstrap().then(() => {
      if (state.activeStory?.id !== story.id) return;
      const freshStory = state.stories.find((item) => item.id === story.id) || story;
      state.activeStory = {
        ...freshStory,
        payload,
        text: payload.text || freshStory.caption || text,
        mediaUrl: state.activeStory.mediaUrl
      };
      render();
      syncStoryPlaybackUi();
      loadActiveStoryMedia().catch(() => {});
    }).catch(() => {});
  } catch (error) {
    toast(error.message || "No se pudo abrir historia.");
  }
}

function storyDurationFor(story = state.activeStory) {
  const payload = story?.payload || decodeStoryPayload(story?.encryptedPayload);
  const mime = payload?.media?.mime || "";
  return /^(audio|video)\//.test(mime) ? STORY_MEDIA_DURATION_MS : STORY_TEXT_DURATION_MS;
}

function clearStoryPlaybackTimers() {
  clearTimeout(state.storyPlayback?.timer);
  clearInterval(state.storyPlayback?.ticker);
  if (state.storyPlayback) {
    state.storyPlayback.timer = null;
    state.storyPlayback.ticker = null;
  }
}

function resetStoryPlayback() {
  clearStoryPlaybackTimers();
  state.storyPlayback = {
    ownerId: null,
    storyIds: [],
    index: 0,
    paused: false,
    timer: null,
    ticker: null,
    startedAt: 0,
    remainingMs: 0,
    durationMs: 0
  };
}

function startStoryPlayback(story = state.activeStory) {
  if (!story?.id) return;
  clearStoryPlaybackTimers();
  const storyIds = state.storyPlayback.storyIds?.length ? state.storyPlayback.storyIds : [story.id];
  const index = Math.max(0, storyIds.indexOf(story.id));
  const durationMs = storyDurationFor(story);
  state.storyPlayback = {
    ...state.storyPlayback,
    storyIds,
    index,
    paused: false,
    startedAt: Date.now(),
    remainingMs: durationMs,
    durationMs
  };
  state.storyPlayback.timer = setTimeout(() => openAdjacentStory(1).catch(() => {}), durationMs);
  state.storyPlayback.ticker = setInterval(updateStoryProgressUi, 150);
  updateStoryProgressUi();
}

function pauseStoryPlayback({ pauseMedia = true } = {}) {
  if (!state.activeStory || state.storyPlayback.paused) return;
  const elapsed = Date.now() - (state.storyPlayback.startedAt || Date.now());
  state.storyPlayback.remainingMs = Math.max(500, (state.storyPlayback.remainingMs || state.storyPlayback.durationMs || storyDurationFor()) - elapsed);
  state.storyPlayback.paused = true;
  clearStoryPlaybackTimers();
  if (pauseMedia) document.querySelector("[data-story-active-media]")?.pause?.();
  updateStoryProgressUi();
}

function resumeStoryPlayback({ playMedia = true } = {}) {
  if (!state.activeStory || !state.storyPlayback.paused) return;
  const remainingMs = Math.max(500, state.storyPlayback.remainingMs || storyDurationFor());
  state.storyPlayback.paused = false;
  state.storyPlayback.startedAt = Date.now();
  state.storyPlayback.remainingMs = remainingMs;
  clearStoryPlaybackTimers();
  state.storyPlayback.timer = setTimeout(() => openAdjacentStory(1).catch(() => {}), remainingMs);
  state.storyPlayback.ticker = setInterval(updateStoryProgressUi, 150);
  if (playMedia) document.querySelector("[data-story-active-media]")?.play?.().catch(() => {});
  updateStoryProgressUi();
}

function toggleStoryPlayback() {
  if (state.storyPlayback.paused) resumeStoryPlayback();
  else pauseStoryPlayback();
  render();
}

async function openAdjacentStory(direction) {
  const storyIds = state.storyPlayback.storyIds || [];
  if (!state.activeStory || !storyIds.length) return;
  const currentIndex = storyIds.indexOf(state.activeStory.id);
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= storyIds.length) {
    if (direction > 0) closeModal();
    return;
  }
  state.storyPlayback.index = nextIndex;
  state.storyPlayback.paused = false;
  await viewStory(storyIds[nextIndex], { preservePlayback: true });
}

function updateStoryProgressUi() {
  if (!state.activeStory) return;
  const playback = state.storyPlayback;
  const storyIds = playback.storyIds?.length ? playback.storyIds : [state.activeStory.id];
  const index = Math.max(0, storyIds.indexOf(state.activeStory.id));
  const elapsed = playback.paused ? 0 : Date.now() - (playback.startedAt || Date.now());
  const remaining = playback.paused
    ? playback.remainingMs
    : Math.max(0, (playback.remainingMs || playback.durationMs || storyDurationFor()) - elapsed);
  const duration = playback.durationMs || storyDurationFor();
  const currentPercent = Math.max(0, Math.min(100, ((duration - remaining) / duration) * 100));
  document.querySelectorAll("[data-story-progress]").forEach((bar) => {
    const barIndex = Number(bar.dataset.storyProgress);
    const width = barIndex < index ? 100 : barIndex > index ? 0 : currentPercent;
    bar.style.width = `${width}%`;
  });
}

function syncStoryPlaybackUi() {
  if (!state.activeStory) return;
  updateStoryProgressUi();
}

function bindStoryMediaEvents() {
  const media = document.querySelector("[data-story-active-media]");
  if (!media || media.dataset.storyMediaBound === "1") return;
  media.dataset.storyMediaBound = "1";
  media.addEventListener("pause", () => {
    if (!media.ended) pauseStoryPlayback({ pauseMedia: false });
  });
  media.addEventListener("play", () => resumeStoryPlayback({ playMedia: false }));
  media.addEventListener("ended", () => openAdjacentStory(1).catch(() => {}));
  if (!state.storyPlayback.paused) {
    media.play?.().catch(() => {});
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
  const viewEpoch = state.viewEpoch;
  const cacheKey = `story:${story.id}`;
  const cached = state.mediaCache.get(cacheKey);
  if (cached?.url) {
    if (state.viewEpoch !== viewEpoch || state.activeStory?.id !== story.id) return;
    state.activeStory = { ...state.activeStory, mediaUrl: cached.url };
    render();
    return;
  }
  const encrypted = await request(`/stories/${encodeURIComponent(story.id)}/media`, { rawResponse: true });
  const bytes = await encrypted.arrayBuffer();
  const plain = await decryptAttachment(bytes, media.fileKey, media.fileIv);
  if (state.viewEpoch !== viewEpoch || state.activeStory?.id !== story.id) return;
  const blob = new Blob([plain], { type: media.mime || "application/octet-stream" });
  const url = rememberMediaPreview(cacheKey, blob, media.mime, media.fileName || "historia");
  if (state.viewEpoch === viewEpoch && state.activeStory?.id === story.id) {
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
    return `<video class="story-media"${cacheAttr} data-story-active-media src="${escapeAttr(url)}" controls playsinline></video>`;
  }
  return `<audio class="story-audio"${cacheAttr} data-story-active-media src="${escapeAttr(url)}" controls></audio>`;
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

async function sendQuickStoryReaction(event, reactionKey) {
  event.preventDefault();
  if (!state.activeStory || state.storyResponse.sending) return;
  const reaction = STORY_REACTIONS.find((item) => item.key === reactionKey)?.value;
  if (!reaction) return;
  state.storyResponse.reaction = reaction;
  state.storyResponse.reactionsOpen = false;
  await sendStoryResponse({ reaction, text: "" });
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
    selectConversation(conversation.id);
    activateView("chats", { mobileChatOpen: true, renderAfter: false });
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
    activateView("vault", { renderAfter: false });
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
  const activeMembers = (room.members || []).filter((member) => member.status === "Active");
  const directories = await directoriesForUsers(activeMembers.map((member) => member.userId));
  for (const member of activeMembers) {
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

    const directory = directories.get(member.userId) || await directoryForVaultMember(member).catch(() => null);
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

    rememberSeenMessage(response.id);
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
  const activeParticipants = (conversation.participants || []).filter((participant) => !participant.removedAt);
  const directories = await directoriesForUsers(activeParticipants.map((participant) => participant.userId));
  const ownDirectory = await ownKeyDirectory().catch(() => null);
  for (const participant of activeParticipants) {
    if (participant.userId === state.auth.user.id) {
      const usedDeviceIds = new Set();
      for (const device of ownDirectory?.devices || []) {
        const publicKey = parsePublicJwk(device.keyBundle?.identityKey);
        if (!device.deviceId || !publicKey || usedDeviceIds.has(device.deviceId)) continue;
        const sealed = await encryptForPublicKey(publicKey, payload);
        recipients.push({
          userId: participant.userId,
          deviceId: device.deviceId,
          ciphertext: sealed.ciphertext,
          header: sealed.header,
          fileObjectId
        });
        usedDeviceIds.add(device.deviceId);
        await breatheMainThread(++index);
      }
      if (!usedDeviceIds.has(state.auth.device.id)) {
        const own = await encryptForPublicKey(await currentPublicKey(), payload);
        recipients.push({
          userId: participant.userId,
          deviceId: state.auth.device.id,
          ciphertext: own.ciphertext,
          header: own.header,
          fileObjectId
        });
        await breatheMainThread(++index);
      }
      continue;
    }

    const directory = directories.get(participant.userId) || await directoryForUser(participant.userId).catch(() => null);
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
  const session = beginMessageLoadSession(conversationId);
  try {
    await loadLocalConversationMessages(conversationId, shouldRender, { session });
    if (!isMessageLoadSessionActive(session)) return;
    const history = await request(`/conversations/${conversationId}/messages?take=${MESSAGE_PAGE_SIZE}`, { signal: session.signal });
    let index = 0;
    for (const message of history || []) {
      if (!isMessageLoadSessionActive(session)) return;
      await applyMessageEnvelope(message, { markSeen: false, notifyReceipt: false, scroll: false, session });
      if (!isMessageLoadSessionActive(session)) return;
      await breatheMainThread(++index);
    }
    await reconcileConversationHistory(conversationId, history || []);
    updateConversationPaging(conversationId, state.messages.get(conversationId) || []);
    if (shouldRender && isMessageLoadSessionActive(session)) renderConversationMessages(conversationId, { replace: true, scroll: "bottom" }) || render();
  } catch (error) {
    if (error?.name === "AbortError") return;
    // History is best-effort; realtime and polling still keep the chat usable.
  } finally {
    finishMessageLoadSession(session);
  }
}

async function reconcileConversationHistory(conversationId, history) {
  if (!conversationId) return;
  const local = state.messages.get(conversationId) || [];
  if (!local.length) return;
  const serverIds = new Set((history || []).map((message) => message?.id).filter(Boolean));
  const oldestServerAt = history?.[0]?.serverReceivedAt || null;
  const stale = history?.length
    ? local.filter((message) => compareMessageAt(message.at, oldestServerAt) >= 0 && !serverIds.has(message.id))
    : local;
  if (!stale.length) return;
  const staleIds = new Set(stale.map((message) => message.id));
  state.messages.set(conversationId, local.filter((message) => !staleIds.has(message.id)));
  let index = 0;
  for (const message of stale) {
    await removeLocalMessage(conversationId, message.id).catch(() => {});
    await breatheMainThread(++index);
  }
}

async function applyMessageEnvelope(message, { markSeen, notifyReceipt, scroll = true, persistSeen = true, session = null }) {
  if (!isMessageLoadSessionActive(session)) return false;
  if (session && message.conversationId !== session.conversationId) return false;
  const recipient = message.recipients?.find((item) => item.deviceId === state.auth.device.id);
  if (!recipient) return false;
  const payload = isServerSystemMessage(message, recipient)
    ? decodeServerSystemMessage(recipient)
    : await decryptEnvelope(recipient.header, recipient.ciphertext).catch(() => ({ type: "sealed", text: "Contenido cifrado no disponible en este dispositivo." }));
  if (!isMessageLoadSessionActive(session)) return false;
  if (markSeen) {
    rememberSeenMessage(message.id, { persist: persistSeen });
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
      const location = findMessageLocation(target.id);
      if (location) await removeMessageEverywhere(location.conversationId, target.id);
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
  return true;
}

async function handleMessageDeletedEvent(payload) {
  const messageId = payload?.messageId || payload?.MessageId;
  if (!messageId) return;
  const location = findMessageLocation(messageId);
  const conversationId = payload?.conversationId || payload?.ConversationId || location?.conversationId;
  if (!conversationId) return;
  const reason = String(payload?.reason || payload?.Reason || "").toLowerCase();
  const deviceId = payload?.deviceId || payload?.DeviceId || "";
  if (reason === "view_once" && deviceId === state.auth?.device?.id && location?.message?.openedAt) {
    return;
  }
  await removeMessageEverywhere(conversationId, messageId);
}

async function removeMessageEverywhere(conversationId, messageId) {
  if (!conversationId || !messageId) return;
  await removeLocalMessage(conversationId, messageId).catch(() => {});
  const list = state.messages.get(conversationId) || [];
  const next = list.filter((message) => message.id !== messageId);
  if (next.length !== list.length) {
    state.messages.set(conversationId, next);
  }
  removeMessageNode(conversationId, messageId);
  updateConversationPreview(conversationId);
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
    if (pending.length) persistSeenMessages();
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
  for (let offset = 0; offset < ids.length; offset += ACK_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + ACK_BATCH_SIZE);
    await request("/messages/sync/ack", {
      method: "POST",
      body: { messageIds: batch }
    }).catch(async () => {
      let index = 0;
      for (const id of batch) {
        await request(`/messages/${id}/receipt`, { method: "POST", body: { kind: "Delivered" } }).catch(() => {});
        await breatheMainThread(++index);
      }
    });
    await yieldToMainThread();
  }
}

async function markVisibleMessagesRead(conversationId = state.selectedConversationId) {
  if (!conversationId || state.privacy?.readReceipts === false || document.visibilityState === "hidden") return;
  const messages = state.messages.get(conversationId) || [];
  const visibleIds = new Set([...document.querySelectorAll("#messages [data-message-id]")].map((node) => node.dataset.messageId).filter(Boolean));
  const unread = messages.filter((message) =>
    !message.mine &&
    !message.deleteAfterRead &&
    (!visibleIds.size || visibleIds.has(message.id)) &&
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

function startPolling(options = {}) {
  clearInterval(state.polling);
  state.polling = null;
  const interval = pollingIntervalMs();
  if (!interval) return;
  state.polling = setInterval(pollPending, interval);
  const shouldSyncNow = options.immediate ?? document.visibilityState === "visible";
  if (shouldSyncNow) syncPendingMessages("start", { force: true }).catch(() => {});
}

function pollingIntervalMs() {
  if (!state.auth?.tokens?.accessToken || navigator.onLine === false) return 0;
  return document.visibilityState === "visible"
    ? SYNC_POLL_VISIBLE_MS
    : SYNC_POLL_BACKGROUND_MS;
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
    "incomingCall",
    "call.started",
    "call.signal",
    "call.ended",
    "CallEnded",
    "call.rejected",
    "CallRejected",
    "call.timeout",
    "CallTimeout",
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
  connection.on("conversation.created", realtimeHandler("conversation.created", (payload) => {
    scheduleBootstrap("conversation-created");
    notifyRealtimeUpdate("Nuevo chat disponible.", {
      type: "conversation",
      conversationId: payload?.id || "",
      tag: "nivra-conversation"
    }, { foregroundToast: false });
  }));
  connection.on("friend.requested", realtimeHandler("friend.requested", () => {
    scheduleBootstrap("friend-requested");
    notifyRealtimeUpdate("Nueva solicitud de amistad.", {
      type: "friend_request",
      tag: "nivra-friend-request"
    });
  }));
  connection.on("friend.updated", realtimeHandler("friend.updated", () => {
    scheduleBootstrap("friend-updated");
  }));
  connection.on("story.created", realtimeHandler("story.created", (payload) => {
    scheduleBootstrap("story-created");
    if (payload?.owner?.id !== state.auth?.user?.id) {
      notifyRealtimeUpdate("Nueva historia disponible.", {
        type: "story",
        storyId: payload?.id || "",
        tag: "nivra-story"
      }, { foregroundToast: false });
    }
  }));
  connection.on("story.worldCreated", realtimeHandler("story.worldCreated", (payload) => {
    scheduleBootstrap("story-world-created");
    if (payload?.owner?.id !== state.auth?.user?.id) {
      notifyRealtimeUpdate("Nueva historia en Mundo.", {
        type: "story",
        storyId: payload?.id || "",
        tag: "nivra-story-world"
      }, { foregroundToast: false });
    }
  }));
  connection.on("vault.invited", realtimeHandler("vault.invited", () => {
    scheduleBootstrap("vault-invited");
    notifyRealtimeUpdate("Te invitaron a una boveda.", {
      type: "vault_invited",
      tag: "nivra-vault"
    });
  }));
  connection.on("vault.approved", realtimeHandler("vault.approved", () => {
    scheduleBootstrap("vault-approved");
    notifyRealtimeUpdate("Entrada a boveda aprobada.", {
      type: "vault_approved",
      tag: "nivra-vault"
    });
  }));
  connection.on("vault.message", realtimeHandler("vault.message", handleVaultRealtimeMessage));
  connection.on("vault.closed", realtimeHandler("vault.closed", async (payload) => {
    state.vaultActiveRoomId = state.vaultActiveRoomId === payload.roomId ? null : state.vaultActiveRoomId;
    state.vaultLobbyRoomId = state.vaultLobbyRoomId === payload.roomId ? null : state.vaultLobbyRoomId;
    scheduleBootstrap("vault-closed", { delayMs: 0 });
    render();
    toast("La boveda se cerro al salir un participante.");
  }));
  connection.on("vault.left", realtimeHandler("vault.left", () => {
    scheduleBootstrap("vault-left", { delayMs: 0 });
    render();
  }));
  connection.on("incomingCall", realtimeHandler("incomingCall", handleIncomingCall));
  connection.on("call.started", realtimeHandler("call.started", handleIncomingCall));
  connection.on("call.signal", realtimeHandler("call.signal", handleCallSignal));
  connection.on("call.ended", realtimeHandler("call.ended", handleCallEnded));
  connection.on("CallEnded", realtimeHandler("CallEnded", handleCallEnded));
  connection.on("call.rejected", realtimeHandler("call.rejected", handleCallRejected));
  connection.on("CallRejected", realtimeHandler("CallRejected", handleCallRejected));
  connection.on("call.timeout", realtimeHandler("call.timeout", handleCallTimeout));
  connection.on("CallTimeout", realtimeHandler("CallTimeout", handleCallTimeout));
  connection.on("call.failed", realtimeHandler("call.failed", (payload) => {
    cleanupCallState({ historyStatus: "Fallida" });
    render();
    toast(payload?.message || "No se pudo iniciar la llamada.");
  }));
  connection.on("device.revoked", realtimeHandler("device.revoked", (payload) => {
    if (!payload?.deviceId || payload.deviceId === state.auth?.device?.id) {
      toast("Esta sesion fue revocada.");
      clearSession();
      return;
    }
    scheduleBootstrap("device-revoked");
  }));
  connection.on("device.listChanged", realtimeHandler("device.listChanged", () => {
    scheduleBootstrap("device-list-changed");
  }));
  connection.onreconnecting((error) => {
    if (error) console.warn("Realtime reconnecting.", error);
    toast("Reconectando en tiempo real...");
  });
  connection.onreconnected(realtimeHandler("reconnected", async () => {
    state.connection = connection;
    startPolling();
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
    startPolling();
    scheduleRealtimeReconnect("closed");
  });

  try {
    await connection.start();
    state.connection = connection;
    startPolling();
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
  const viewEpoch = state.viewEpoch;
  try {
    if (!meta) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveVaultKey(pin, salt);
      const verifier = await encryptWithKey(key, { ok: true, createdAt: new Date().toISOString() });
      saveJson(vaultMetaKey(), { salt: b64(salt), verifier });
      state.vault = { unlocked: true, key, decoded: new Map() };
      await decodeVaultItems(viewEpoch);
    } else {
      const key = await deriveVaultKey(pin, ub64(meta.salt));
      await decryptWithKey(key, meta.verifier);
      state.vault = { unlocked: true, key, decoded: new Map() };
      await decodeVaultItems(viewEpoch);
    }
    if (state.viewEpoch !== viewEpoch) return;
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
  activateView("vault", { renderAfter: false });
  const viewEpoch = state.viewEpoch;
  await decodeVaultItems(viewEpoch);
  if (state.viewEpoch !== viewEpoch) return;
  state.vault.unlocked = true;
  render();
}

function decryptVaultPreview(encryptedMetadata) {
  return state.vault.decoded.get(encryptedMetadata) || { title: "Elemento cifrado", body: "Metadata protegida." };
}

async function decodeVaultItems(expectedEpoch = state.viewEpoch) {
  if (!state.vault.key) return;
  state.vault.decoded = new Map();
  let index = 0;
  for (const item of state.vaultItems) {
    if (state.viewEpoch !== expectedEpoch) return;
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

function isGroupCall(call = state.call.current) {
  return (call?.participantUserIds || []).filter(Boolean).length > 2;
}

function canRejoinCall(call) {
  if (!call?.id || state.call.current?.id === call.id) return false;
  if (!call.live) return false;
  if (call.endedAt) return false;
  return (call.participantUserIds || []).includes(state.auth?.user?.id);
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
    state.call.minimized = false;
    rememberCall(call, { status: "Llamando" });
    activateView("calls", { renderAfter: false });
    startCallTicker();
    scheduleCallTimeout(call);
    playCallTone("outgoing");
    render();
    await establishCallPeers();
    await flushPendingCallSignals();
    toast(`${type === "Video" ? "Videollamada" : "Llamada"} iniciada.`);
  } catch (error) {
    const call = state.call.current;
    cleanupCallState({ historyStatus: "Fallida", remember: Boolean(call) });
    if (call?.id) {
      request(`/calls/${call.id}/end`, { method: "POST", timeoutMs: CALL_END_REQUEST_TIMEOUT_MS }).catch(() => {});
    }
    toast(error.message || "No se pudo iniciar llamada.");
  }
}

async function rejoinCall(callId) {
  if (!callId || state.call.current) return;
  try {
    const call = await request(`/calls/${encodeURIComponent(callId)}`);
    if (!call || call.status === "Ended" || call.endedAt) {
      toast("Esa sala de llamada ya finalizo.");
      state.callHistory = (state.callHistory || []).map((item) => item.id === callId ? { ...item, live: false, status: "Finalizada", endedAt: item.endedAt || new Date().toISOString() } : item);
      saveCallHistory();
      render();
      return;
    }
    state.call.current = call;
    state.call.phase = "active";
    state.call.startedAt = call.startedAt || new Date().toISOString();
    state.call.minimized = false;
    clearCallTimeout();
    await prepareCallMedia(call.type === "Video");
    activateView("calls", { mobileChatOpen: false, renderAfter: false });
    startCallTicker();
    rememberCall(call, { status: "Activa", live: true });
    render();
    await Promise.all(call.participantUserIds
      .filter((userId) => userId !== state.auth.user.id)
      .map((userId) => sendCallSignal(call, userId, "accepted", { accepted: true, rejoined: true }).catch(() => {})));
    await establishCallPeers();
    await flushPendingCallSignals();
    toast("Volviste a la llamada.");
  } catch (error) {
    resetCallState({ remember: false });
    toast(error.message || "No se pudo volver a la llamada.");
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
  state.call.minimized = false;
  rememberCall(call, { status: state.call.phase === "incoming" ? "Entrante" : "Llamando" });
  startCallTicker();
  scheduleCallTimeout(call);
  if (state.call.phase === "incoming") {
    playCallTone("incoming");
    navigator.vibrate?.([320, 140, 320]);
    if (options.notify !== false) notifyIncomingCall(call);
  } else {
    playCallTone("outgoing");
  }
  syncIncomingCallOverlay();
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
    state.call.minimized = false;
    clearCallTimeout();
    stopCallTones();
    syncIncomingCallOverlay();
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

function minimizeActiveCallToChat() {
  const call = state.call.current;
  if (!call) return;
  state.call.minimized = true;
  if (call.conversationId) {
    selectConversation(call.conversationId);
  }
  activateView("chats", { mobileChatOpen: true, renderAfter: false });
  render();
  requestAnimationFrame(() => document.querySelector("#messageInput")?.focus?.());
}

function restoreActiveCallLayer() {
  if (!state.call.current) return;
  state.call.minimized = false;
  activateView("calls", { mobileChatOpen: false, renderAfter: false });
  render();
}

async function declineCall(event) {
  event?.preventDefault?.();
  const call = state.call.current;
  if (!call) return;
  if (state.call.ending) return;
  state.call.ending = true;
  disableCallEndControls();
  rememberEndedCallId(call.id);
  clearCallNotificationByData({ callId: call.id, tag: `nivra-call-${call.id}` }).catch(() => {});
  cleanupCallState({ historyStatus: "Rechazada" });
  render();
  sendCallSignal(call, call.initiatorUserId, "declined", "declined", { timeoutMs: CALL_SIGNAL_TIMEOUT_MS }).catch(() => {});
  if (!isGroupCall(call)) {
    request(`/calls/${call.id}/end`, { method: "POST", timeoutMs: CALL_END_REQUEST_TIMEOUT_MS }).catch(() => {});
  }
}

async function endCurrentCall(event) {
  event?.preventDefault?.();
  const call = state.call.current;
  if (!call) return;
  if (state.call.ending) return;
  state.call.ending = true;
  disableCallEndControls();
  if (isGroupCall(call) && call.initiatorUserId !== state.auth.user.id) {
    leaveGroupCallRoom(call);
    return;
  }
  rememberEndedCallId(call.id);
  clearCallNotificationByData({ callId: call.id, tag: `nivra-call-${call.id}` }).catch(() => {});
  cleanupCallState();
  render();
  request(`/calls/${call.id}/end`, { method: "POST", timeoutMs: CALL_END_REQUEST_TIMEOUT_MS }).catch(() => {});
}

function leaveGroupCallRoom(call = state.call.current) {
  if (!call) return;
  rememberEndedCallId(call.id);
  cleanupCallState({ historyStatus: "Disponible para volver", keepLive: true });
  render();
  toast("Saliste de la llamada. Puedes reentrar mientras siga activa.");
  Promise.all(call.participantUserIds
    .filter((userId) => userId !== state.auth.user.id)
    .map((userId) => sendCallSignal(call, userId, "left", { left: true }, { timeoutMs: CALL_SIGNAL_TIMEOUT_MS }).catch(() => {})))
    .catch(() => {});
}

async function sendCallSignal(call, targetUserId, signalType, payload, options = {}) {
  if (!call?.id || !targetUserId || targetUserId === state.auth.user.id) return;
  await request(`/calls/${call.id}/signal`, {
    method: "POST",
    timeoutMs: options.timeoutMs ?? CALL_SIGNAL_TIMEOUT_MS,
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
    clearCallTimeout();
    stopCallTones();
    startCallTicker();
    await establishAcceptedCallPeer(fromUserId);
    render();
    return;
  }
  if (signalType === "declined" || signalType === "busy") {
    if (isGroupCall(call)) {
      updateRemoteCallState(fromUserId, signalType, true);
      closePeerConnectionForUser(fromUserId);
      toast(signalType === "busy" ? "Un participante esta en otra llamada." : "Un participante rechazo la llamada.");
      render();
      return;
    }
    stopCallTones();
    toast(signalType === "busy" ? "El contacto esta en otra llamada." : "Llamada rechazada.");
    cleanupCallState({ historyStatus: signalType === "busy" ? "Ocupada" : "Rechazada" });
    render();
    return;
  }
  if (signalType === "left") {
    updateRemoteCallState(fromUserId, "left", true);
    closePeerConnectionForUser(fromUserId);
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

async function handleCallEnded(call, options = {}) {
  const callId = call?.id || call?.Id || call?.callId || call?.CallId;
  if (!callId) return;
  rememberEndedCallId(callId);
  if (state.call.current?.id === callId) {
    cleanupCallState({ historyStatus: options.historyStatus || terminalCallHistoryStatus(call) });
    render();
    toast(options.toast || "Llamada finalizada.");
    clearCallNotificationByData({ callId, tag: `nivra-call-${callId}` }).catch(() => {});
    return;
  }
  await clearCallNotificationByData({ callId, tag: `nivra-call-${callId}` }).catch(() => {});
  if (state.call.current?.id !== callId) {
    markCallHistoryEnded(callId, options.historyStatus || terminalCallHistoryStatus(call));
    render();
    return;
  }
  cleanupCallState({ historyStatus: options.historyStatus || terminalCallHistoryStatus(call) });
  render();
  toast(options.toast || "Llamada finalizada.");
}

function handleCallRejected(call) {
  return handleCallEnded(call, { historyStatus: "Rechazada", toast: "Llamada rechazada." });
}

function handleCallTimeout(call) {
  return handleCallEnded(call, { historyStatus: "Perdida", toast: "Llamada sin respuesta." });
}

function terminalCallHistoryStatus(call) {
  const type = String(call?.type || call?.Type || call?.status || call?.Status || "").toLowerCase();
  if (type.includes("reject") || type.includes("rechaz")) return "Rechazada";
  if (type.includes("timeout") || type.includes("missed") || type.includes("perdid")) return "Perdida";
  return "Finalizada";
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

  if (signalType === "offer") {
    if (connection.signalingState !== "stable") {
      await connection.setLocalDescription({ type: "rollback" }).catch(() => {});
      await setRemoteDescriptionAndFlush(fromUserId, connection, payload.description);
    } else {
      await setRemoteDescriptionAndFlush(fromUserId, connection, payload.description);
    }
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await sendCallSignal(state.call.current, fromUserId, "answer", { description: connection.localDescription });
    state.call.phase = "active";
    clearCallTimeout();
    startCallTicker();
    render();
    return;
  }

  if (signalType === "answer") {
    if (payload.description && connection.signalingState !== "stable") {
      await setRemoteDescriptionAndFlush(fromUserId, connection, payload.description);
    }
    state.call.phase = "active";
    clearCallTimeout();
    startCallTicker();
    render();
    return;
  }

  if (signalType === "ice" && payload.candidate) {
    await addOrQueueRemoteIceCandidate(fromUserId, payload.candidate);
  }
}

async function setRemoteDescriptionAndFlush(userId, connection, description) {
  if (!connection || !description) return;
  await connection.setRemoteDescription(new RTCSessionDescription(description));
  await flushPeerIce(userId);
}

function hasRemoteDescription(connection) {
  return Boolean(connection?.remoteDescription?.type);
}

async function addOrQueueRemoteIceCandidate(userId, candidateInit) {
  const peer = state.call.peers.get(userId);
  if (!peer?.connection || !candidateInit) return;
  const candidate = new RTCIceCandidate(candidateInit);
  if (!hasRemoteDescription(peer.connection)) {
    peer.pendingIce.push(candidate);
    return;
  }
  try {
    await peer.connection.addIceCandidate(candidate);
  } catch (error) {
    if (!hasRemoteDescription(peer.connection)) {
      peer.pendingIce.push(candidate);
      return;
    }
    console.warn("Remote ICE candidate could not be added.", error);
  }
}

async function flushPeerIce(userId) {
  const peer = state.call.peers.get(userId);
  if (!peer?.pendingIce.length) return;
  if (!hasRemoteDescription(peer.connection)) return;
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

function resetCallState(options = {}) {
  cleanupCallState(options);
}

function cleanupCallState(options = {}) {
  if (state.call.current && options.remember !== false) {
    rememberCall(state.call.current, {
      status: options.historyStatus || (state.call.phase === "incoming" ? "Perdida" : "Finalizada"),
      endedAt: options.keepLive ? null : new Date().toISOString(),
      live: Boolean(options.keepLive)
    });
  }
  stopCallTicker();
  clearCallTimeout();
  stopCallTones();
  stopCallMedia();
  closePeerConnections();
  state.call.current = null;
  state.call.phase = "idle";
  state.call.muted = false;
  state.call.cameraOff = false;
  state.call.speaker = true;
  state.call.startedAt = null;
  state.call.minimized = false;
  state.call.pendingSignals = [];
  state.call.remoteStates = new Map();
  state.call.ending = false;
  syncIncomingCallOverlay();
}

window.cleanupCallState = cleanupCallState;

function disableCallEndControls() {
  document.querySelectorAll("#endCallBtn, #endCallTopBtn, #declineCallBtn, #incomingDeclineBtn").forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
}

function scheduleCallTimeout(call) {
  clearCallTimeout();
  if (!call?.id || !["incoming", "dialing"].includes(state.call.phase)) return;
  state.call.ringTimeout = setTimeout(() => {
    handleLocalCallTimeout(call.id).catch((error) => console.warn("Call timeout cleanup failed.", error));
  }, CALL_RING_TIMEOUT_MS);
}

function clearCallTimeout() {
  clearTimeout(state.call.ringTimeout);
  state.call.ringTimeout = null;
}

async function handleLocalCallTimeout(callId) {
  const call = state.call.current;
  if (!call || call.id !== callId || !["incoming", "dialing"].includes(state.call.phase)) return;
  const phase = state.call.phase;
  const historyStatus = phase === "incoming" ? "Perdida" : "Sin respuesta";
  rememberEndedCallId(call.id);
  clearCallNotificationByData({ callId: call.id, tag: `nivra-call-${call.id}` }).catch(() => {});
  cleanupCallState({ historyStatus });
  render();
  toast(phase === "incoming" ? "Llamada perdida." : "Llamada sin respuesta.");
  if (!isGroupCall(call) || call.initiatorUserId === state.auth?.user?.id) {
    request(`/calls/${call.id}/end`, { method: "POST", timeoutMs: CALL_END_REQUEST_TIMEOUT_MS }).catch(() => {});
  }
}

function stopMediaStream(stream) {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Media tracks can already be ended by the browser.
    }
  });
}

function detachCallMediaNodes() {
  document.querySelectorAll("#localCallVideo, [data-remote-video], [data-remote-audio]").forEach((node) => {
    try {
      node.pause?.();
      if ("srcObject" in node) node.srcObject = null;
      node.removeAttribute("src");
      node.load?.();
    } catch {
      // Best effort: some mobile WebViews throw while tearing down media nodes.
    }
  });
}

function stopCallMedia() {
  stopMediaStream(state.call.localStream);
  for (const stream of state.call.remoteStreams.values()) {
    stopMediaStream(stream);
  }
  state.call.localStream = null;
  state.call.remoteStreams = new Map();
  detachCallMediaNodes();
}

function closePeerConnectionForUser(userId) {
  const peer = state.call.peers.get(userId);
  if (peer?.connection) {
    try {
      peer.connection.onicecandidate = null;
      peer.connection.ontrack = null;
      peer.connection.onconnectionstatechange = null;
      peer.connection.getReceivers?.().forEach((receiver) => {
        try { receiver.track?.stop?.(); } catch {}
      });
      peer.connection.close?.();
    } catch {}
  }
  state.call.peers.delete(userId);
  const stream = state.call.remoteStreams.get(userId);
  stopMediaStream(stream);
  state.call.remoteStreams.delete(userId);
}

function closePeerConnections() {
  for (const peer of state.call.peers.values()) {
    const connection = peer.connection;
    if (!connection) continue;
    try {
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.onconnectionstatechange = null;
      connection.getSenders?.().forEach((sender) => {
        try { sender.track?.stop?.(); } catch {}
      });
      connection.getReceivers?.().forEach((receiver) => {
        try { receiver.track?.stop?.(); } catch {}
      });
      connection.close?.();
    } catch {
      // Closing a peer is local cleanup; the server end signal is sent before this path.
    }
    peer.pendingIce = [];
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
  if (state.voice.recording || state.voice.starting) {
    stopVoiceNoteRecording({ cancel: true });
    clearInterval(state.voice.timer);
    state.voice.timer = null;
    setVoiceRecordingUi(false);
  } else {
    resetVoiceRecordingState();
  }
  clearVoiceHoldHint();
  closeFloatingMenu();
  stopCameraStream({ discardRecording: true, keepState: true });
  stopQrScanner().catch(() => {});
  stopQrLogin().catch(() => {});
  resetStoryPlayback();
  cleanupObjectUrls({ keepVisible: false });
  clearTimeout(state.searchTimer);
  state.searchTimer = null;
  clearTimeout(state.contactSearchTimer);
  state.contactSearchTimer = null;
  clearTimeout(state.chatSearchTimer);
  state.chatSearchTimer = null;
  clearTimeout(state.vaultInviteTimer);
  state.vaultInviteTimer = null;
  clearTimeout(state.messageScrollTimer);
  state.messageScrollTimer = null;
  clearTimeout(state.realtimeReconnectTimer);
  state.realtimeReconnectTimer = null;
  clearTimeout(state.bootstrapTimer);
  state.bootstrapTimer = null;
  state.bootstrapQueued = false;
  state.bootstrapPendingReason = "";
  clearTimeout(state.typingStopTimer);
  state.typingStopTimer = null;
  localStorage.removeItem("nivra.auth");
  state.auth = null;
  const previous = state.connection;
  state.connection = null;
  detachRealtimeHandlers(previous);
  previous?.stop().catch(() => {});
  clearTimeout(state.pushRetryTimer);
  state.pushRegistration = null;
  state.pushRetryTimer = null;
  state.pushRetryAttempt = 0;
  state.pushReady = false;
  state.pushLocalReady = false;
  state.pushPermission = "unknown";
  state.pushServerReady = null;
  state.pushError = "";
  state.pushTokenError = "";
  state.pushTokenRetryAfter = 0;
  state.webPushForegroundReady = false;
  state.syncInFlight = false;
  state.callHistory = [];
  state.modal = null;
  state.activeStory = null;
  state.replyTo = null;
  cancelActiveMessageLoad("logout");
  clearInterval(state.polling);
  state.polling = null;
  render();
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!options.rawBody) headers["Content-Type"] = "application/json";
  if (!options.skipAuth && state.auth?.tokens?.accessToken) {
    headers.Authorization = `Bearer ${state.auth.tokens.accessToken}`;
  }
  const timeoutMs = options.timeoutMs ?? (options.rawBody ? UPLOAD_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  let timeoutId = null;
  let controller = null;
  let signal = options.signal;
  if (!signal && timeoutMs > 0) {
    controller = new AbortController();
    signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method: options.method || "GET",
      headers,
      body: options.rawBody || (options.body ? JSON.stringify(options.body) : undefined),
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError" && controller) {
      const exception = new Error("La conexion tardo demasiado. Reintentando cuando vuelva la red.");
      exception.status = 408;
      throw exception;
    }
    if (error?.name === "AbortError") throw error;
    const exception = new Error(navigator.onLine === false ? "Sin conexion. Reintentaremos al volver la red." : "No se pudo conectar con Nivra.");
    exception.cause = error;
    throw exception;
  } finally {
    clearTimeout(timeoutId);
  }
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
  await yieldToMainThread();
  const own = await currentKeyMaterial();
  if (!own?.privateJwk || !own?.publicJwk) throw new Error("No hay llave privada local para cifrar.");
  const privateKey = await crypto.subtle.importKey("jwk", own.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  await yieldToMainThread();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, TEXT.encode(JSON.stringify(payload)));
  return {
    ciphertext: b64(new Uint8Array(ciphertext)),
    header: JSON.stringify({ v: 1, alg: "ECDH-P256-A256GCM", senderPublicKey: own.publicJwk, iv: b64(iv) })
  };
}

async function decryptEnvelope(header, ciphertext) {
  await yieldToMainThread();
  const meta = JSON.parse(header || "{}");
  const own = await currentKeyMaterial();
  if (!own?.privateJwk) throw new Error("No hay llave privada local para descifrar.");
  const privateKey = await crypto.subtle.importKey("jwk", own.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const senderPublic = await crypto.subtle.importKey("jwk", meta.senderPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: senderPublic }, privateKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  await yieldToMainThread();
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
  const publicSpki = b64url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, publicSpki };
}

async function importQrEncryptionPublicKey(publicMaterial) {
  if (typeof publicMaterial === "string") {
    return crypto.subtle.importKey("spki", ub64url(publicMaterial), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
  }
  if (publicMaterial?.spki) {
    return crypto.subtle.importKey("spki", ub64url(publicMaterial.spki), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
  }
  return crypto.subtle.importKey("jwk", publicMaterial, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
}

async function encryptQrPayload(publicMaterial, payload) {
  const publicKey = await importQrEncryptionPublicKey(publicMaterial);
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
  await yieldToMainThread();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buffer);
  await yieldToMainThread();
  const rawKey = await crypto.subtle.exportKey("raw", key);
  return { bytes: encrypted, key: b64(new Uint8Array(rawKey)), iv: b64(iv) };
}

async function decryptAttachment(buffer, rawKey, iv) {
  await yieldToMainThread();
  const key = await crypto.subtle.importKey("raw", ub64(rawKey), { name: "AES-GCM" }, false, ["decrypt"]);
  await yieldToMainThread();
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(iv) }, key, buffer);
}

async function deriveVaultKey(pin, salt) {
  await yieldToMainThread();
  const baseKey = await crypto.subtle.importKey("raw", TEXT.encode(pin), "PBKDF2", false, ["deriveKey"]);
  await yieldToMainThread();
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptWithKey(key, value) {
  await yieldToMainThread();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, TEXT.encode(JSON.stringify(value)));
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}

async function decryptWithKey(key, envelope) {
  await yieldToMainThread();
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

async function ownKeyDirectory() {
  const userId = state.auth?.user?.id;
  if (!userId) return null;
  const cached = state.keyDirectory.get(userId);
  const activeDeviceCount = (state.devices || []).filter((device) => !device.revokedAt).length;
  if (cached && (!activeDeviceCount || (cached.devices || []).length >= activeDeviceCount)) return cached;
  const alias = state.auth?.user?.alias;
  if (!alias) return null;
  const directory = await request(`/keys/${encodeURIComponent(alias)}`);
  cacheKeyDirectory(directory);
  return directory;
}

async function directoriesForUsers(userIds = []) {
  const ids = [...new Set((userIds || []).filter((id) => id && id !== state.auth?.user?.id))];
  const missing = ids.filter((id) => !state.keyDirectory.has(id));
  if (missing.length) {
    const directories = await request("/keys/batch", {
      method: "POST",
      body: { userIds: missing }
    }).catch(() => null);
    (directories || []).forEach(cacheKeyDirectory);
  }
  return new Map(ids
    .map((id) => [id, state.keyDirectory.get(id)])
    .filter(([, directory]) => directory));
}

function cacheKeyDirectory(directory) {
  if (!directory?.userId) return;
  state.keyDirectory.set(directory.userId, directory);
  state.aliasByUserId.set(directory.userId, directory.alias);
}

function selectedConversation() {
  return state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
}

async function openConversationFromList(conversationId) {
  if (!conversationId) return;
  selectConversation(conversationId);
  activateView("chats", { mobileChatOpen: true, renderAfter: false });
  render();
  loadConversationHistory(conversationId, true).catch(() => {});
  await joinSelectedConversation();
}

function selectConversation(conversationId) {
  const nextId = conversationId || null;
  if (nextId !== state.selectedConversationId) {
    cancelActiveMessageLoad("conversation-change");
    state.replyTo = null;
    resetChatDomWindow(nextId);
  }
  state.selectedConversationId = nextId;
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
  return { chats: "Chats", world: "Mundo", vault: "Boveda privada", calls: "Llamadas", privacy: "Privacidad", account: "Cuenta" }[state.view] || "Nivra";
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

function callHistoryStorageKey() {
  return state.auth?.user?.id ? `nivra.callHistory.${state.auth.user.id}` : "nivra.callHistory";
}

function loadCallHistory() {
  const scoped = loadJson(callHistoryStorageKey());
  if (Array.isArray(scoped)) return scoped.slice(0, MAX_CALL_HISTORY);
  const legacy = loadJson("nivra.callHistory");
  return Array.isArray(legacy) ? legacy.slice(0, MAX_CALL_HISTORY) : [];
}

function saveCallHistory() {
  if (!state.auth?.user?.id) return;
  saveJson(callHistoryStorageKey(), (state.callHistory || []).slice(0, MAX_CALL_HISTORY));
}

function callHistoryRecord(call, patch = {}) {
  if (!call?.id) return null;
  const status = patch.status || call.status || (state.call.phase === "incoming" ? "Entrante" : state.call.phase === "dialing" ? "Llamando" : "Activa");
  const startedAt = call.startedAt || state.call.startedAt || new Date().toISOString();
  const participants = callParticipants(call);
  return {
    id: call.id,
    conversationId: call.conversationId || null,
    initiatorUserId: call.initiatorUserId || null,
    type: call.type || "Voice",
    status,
    direction: call.initiatorUserId === state.auth?.user?.id ? "saliente" : "entrante",
    participantUserIds: call.participantUserIds || participants.map((person) => person.id || person.userId).filter(Boolean),
    participants,
    title: callTitle(call),
    subtitle: callSubtitle(call),
    startedAt,
    endedAt: patch.endedAt || call.endedAt || null,
    live: Boolean(patch.live)
  };
}

function rememberCall(call, patch = {}) {
  const record = callHistoryRecord(call, patch);
  if (!record) return;
  const next = [record, ...(state.callHistory || []).filter((item) => item.id !== record.id)]
    .sort((left, right) => Date.parse(right.startedAt || 0) - Date.parse(left.startedAt || 0))
    .slice(0, MAX_CALL_HISTORY);
  state.callHistory = next;
  saveCallHistory();
}

function markCallHistoryEnded(callId, status = "Finalizada") {
  if (!callId) return;
  let changed = false;
  state.callHistory = (state.callHistory || []).map((item) => {
    if (item.id !== callId) return item;
    changed = true;
    return {
      ...item,
      status,
      live: false,
      endedAt: item.endedAt || new Date().toISOString()
    };
  });
  if (changed) saveCallHistory();
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
    await request(`/api/messages/${encodeURIComponent(messageId)}?forEveryone=false`, { method: "DELETE" });
  } catch {
    await request(`/messages/${messageId}/receipt`, { method: "POST", body: { kind: "Deleted" } }).catch(() => {});
  }
  await removeMessageEverywhere(location.conversationId, messageId);
  toast("Mensaje eliminado para ti.");
}

async function deleteMessageForEveryone(messageId) {
  const message = findMessage(messageId);
  if (!message || !message.mine) return;
  const location = findMessageLocation(messageId);
  if (!location) return;
  try {
    await request(`/api/messages/${encodeURIComponent(messageId)}?forEveryone=true`, { method: "DELETE" });
    await removeMessageEverywhere(location.conversationId, messageId);
    toast("Mensaje eliminado para todos.");
  } catch (error) {
    toast(error.message || "No se pudo eliminar para todos.");
  }
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
    await removeMessageEverywhere(current.conversationId, messageId);
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

async function initializePushNotifications(options = {}) {
  if (!state.auth?.tokens?.accessToken) return false;
  const requestPermission = Boolean(options.requestPermission);
  const force = Boolean(options.force);
  await refreshPushPermissionState().catch(() => {});

  if (state.pushRegistration && !state.pushRegistering) {
    const flushed = await flushPushTokenRegistration().catch(() => false);
    if (flushed || (state.pushReady && !force)) return Boolean(state.pushReady);
  }
  if (state.pushReady && !force) return true;
  if (state.pushRegistering) return false;

  state.pushRegistering = true;
  state.pushError = "";
  scheduleRender();
  try {
    if (window.NIVRA_PUSH_TOKEN) {
      return await queuePushTokenRegistration("fcm", String(window.NIVRA_PUSH_TOKEN).trim());
    }

    if (isNativeCapacitor()) {
      return await initializeCapacitorPushNotifications({ requestPermission });
    }

    return await initializeWebPushNotifications({ requestPermission, force });
  } catch (error) {
    state.pushReady = false;
    state.pushError = error?.message || "No se pudieron activar las notificaciones.";
    console.warn("Push initialization failed.", error);
    return false;
  } finally {
    state.pushRegistering = false;
    scheduleRender();
  }
}

async function enableNotificationsFromUserAction() {
  clearNotificationPromptDismissal();
  state.pushReady = false;
  state.pushError = "";
  render();
  const ok = await initializePushNotifications({ requestPermission: true, force: true }).catch((error) => {
    state.pushError = error?.message || "No se pudieron activar las notificaciones.";
    return false;
  });
  await refreshPushPermissionState().catch(() => {});
  render();
  if (ok) {
    toast(pushActivationSuccessMessage());
  } else {
    toast(pushActivationFailureMessage());
  }
}

function pushActivationSuccessMessage() {
  if (state.pushReady && state.pushServerReady === false) return "Permiso listo. Falta configurar FCM en el servidor.";
  if (state.pushReady) return "Notificaciones activadas.";
  if (state.pushLocalReady) return "Avisos locales listos. FCM remoto queda pendiente.";
  return "Permiso de notificaciones listo.";
}

function pushActivationFailureMessage() {
  const capability = notificationCapabilityStatus();
  if (!capability.supported) return capability.reason || "Este dispositivo no soporta notificaciones push.";
  if (capability.permission === "denied") return "Notificaciones bloqueadas. Activalas en ajustes del sistema o navegador.";
  return state.pushError || "No se pudo completar el registro de notificaciones.";
}

async function refreshPushPermissionState() {
  if (window.NIVRA_PUSH_TOKEN) {
    state.pushPermission = "granted";
    return state.pushPermission;
  }
  if (isNativeCapacitor()) {
    const push = window.Capacitor?.Plugins?.PushNotifications;
    const permission = await push?.checkPermissions?.().catch(() => null);
    state.pushPermission = normalizePushPermission(permission?.receive);
    return state.pushPermission;
  }
  state.pushPermission = "Notification" in window ? Notification.permission : "unsupported";
  return state.pushPermission;
}

function normalizePushPermission(value) {
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  if (value === "prompt" || value === "prompt-with-rationale" || value === "default") return "default";
  if (value === "unsupported") return "unsupported";
  return value || "default";
}

function isNativeCapacitor() {
  const capacitor = window.Capacitor;
  if (!capacitor) return false;
  if (typeof capacitor.isNativePlatform === "function") return capacitor.isNativePlatform();
  return PLATFORM.isCapacitor && !PLATFORM.isHttp;
}

async function initializeCapacitorPushNotifications(options = {}) {
  const push = window.Capacitor?.Plugins?.PushNotifications;
  if (!push) {
    console.warn("PushNotifications plugin is not available in Capacitor.");
    state.pushError = "El plugin nativo de push no esta disponible.";
    return false;
  }

  await initializeCapacitorLocalNotifications();
  await bindCapacitorPushListeners(push);

  let permission = await push.checkPermissions?.().catch(() => null);
  if (!permission || permission.receive !== "granted") {
    if (!options.requestPermission) {
      state.pushPermission = normalizePushPermission(permission?.receive);
      return false;
    }
    permission = await push.requestPermissions?.().catch(() => null);
  }
  state.pushPermission = normalizePushPermission(permission?.receive);
  if (!permission || permission.receive !== "granted") return false;

  state.pushLocalReady = true;
  state.pushError = "";
  await push.register();
  const ready = await waitForPushReady();
  if (!ready && !state.pushTokenError) {
    state.pushTokenError = "Permiso activo; token FCM nativo pendiente.";
  }
  return ready || state.pushLocalReady;
}

async function bindCapacitorPushListeners(push) {
  if (state.pushListenersReady) return;

  await push.addListener("registration", async (token) => {
    if (!token?.value) return;
    state.pushTokenError = "";
    await queuePushTokenRegistration("fcm", token.value);
  });

  await push.addListener("registrationError", (error) => {
    state.pushReady = false;
    state.pushTokenError = error?.message || "No se pudo obtener token FCM nativo.";
    console.warn("Push registration failed.", error);
  });

  await push.addListener("pushNotificationReceived", async (notification) => {
    if (appIsBackgrounded()) {
      await showCapacitorLocalNotification(notification).catch(() => {});
    }
    await handleForegroundPushNotification(notification).catch(() => {});
  });

  await push.addListener("pushNotificationActionPerformed", async (event) => {
    const data = extractPushData(event?.notification || {});
    const action = event?.actionId || event?.action || "";
    await handlePushNavigation(data, { action }).catch(() => {});
    await syncPendingMessages("push-action", { force: true }).catch(() => {});
    render();
  });

  state.pushListenersReady = true;
}

async function initializeCapacitorLocalNotifications() {
  const local = window.Capacitor?.Plugins?.LocalNotifications;
  if (!local || state.localNotificationsReady) return;
  await local.requestPermissions?.().catch(() => null);
  await local.createChannel?.({
    id: "nivra_messages",
    name: "Nivra",
    description: "Mensajes y llamadas privadas",
    importance: 5,
    visibility: 1,
    sound: "default",
    vibration: true
  }).catch(() => {});
  await local.createChannel?.({
    id: "nivra_calls",
    name: "Llamadas Nivra",
    description: "Llamadas y videollamadas entrantes",
    importance: 5,
    visibility: 1,
    sound: "default",
    vibration: true
  }).catch(() => {});
  await local.registerActionTypes?.({
    types: [{
      id: "NIVRA_INCOMING_CALL",
      actions: [
        { id: "accept", title: "Contestar" },
        { id: "decline", title: "Rechazar", destructive: true }
      ]
    }]
  }).catch(() => {});
  await local.addListener?.("localNotificationActionPerformed", async (event) => {
    const data = extractPushData(event?.notification || {});
    const action = event?.actionId || event?.action || "";
    await handlePushNavigation(data, { action }).catch(() => {});
    await syncPendingMessages("local-notification-action", { force: true }).catch(() => {});
    render();
  });
  state.localNotificationsReady = true;
}

async function showCapacitorLocalNotification(notification = {}) {
  const local = window.Capacitor?.Plugins?.LocalNotifications;
  if (!local) return;
  const data = extractPushData(notification);
  if (isTerminalCallPushData(data)) {
    await handleTerminalCallPush(data, { toast: false }).catch(() => {});
    return;
  }
  const isCall = isIncomingCallPushData(data);
  const title = notification.title || notification?.notification?.title || "Nivra";
  const body = notification.body ||
    notification?.notification?.body ||
    (isCall ? "Llamada entrante" : "Nuevo mensaje privado");
  await local.schedule({
    notifications: [{
      id: notificationNumericId(pushDataValue(data, "callId", "messageId", "conversationId") || Date.now()),
      title,
      body,
      channelId: isCall ? "nivra_calls" : "nivra_messages",
      sound: "default",
      actionTypeId: isCall ? "NIVRA_INCOMING_CALL" : "",
      extra: data,
      schedule: { at: new Date(Date.now() + 1) }
    }]
  });
}

function notificationNumericId(value) {
  const text = String(value || Date.now());
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}

function rememberEndedCallId(callId) {
  if (!callId) return;
  state.endedCallIds.add(String(callId));
  if (state.endedCallIds.size <= 300) return;
  const oldest = state.endedCallIds.values().next().value;
  if (oldest) state.endedCallIds.delete(oldest);
}

async function handleTerminalCallPush(data = {}, options = {}) {
  const callId = pushDataValue(data, "callId", "CallId");
  if (!callId) return;
  rememberEndedCallId(callId);
  markCallHistoryEnded(callId, normalizePushType(pushDataValue(data, "type", "Type")) === "missed-call" ? "Perdida" : "Finalizada");
  if (state.call.current?.id !== callId) {
    await clearCallNotificationByData(data).catch(() => {});
    return;
  }
  cleanupCallState({ historyStatus: options.historyStatus || "Finalizada" });
  if (options.toast !== false) toast("Llamada finalizada.");
  render();
  clearCallNotificationByData(data).catch(() => {});
}

async function clearCallNotificationByData(data = {}) {
  const callId = pushDataValue(data, "callId", "CallId");
  if (!callId) return;
  const tag = pushDataValue(data, "tag", "Tag");
  const tags = new Set([tag, `nivra-call-${callId}`, `nivra-missed-call-${callId}`].filter(Boolean));
  const local = window.Capacitor?.Plugins?.LocalNotifications;
  if (local) {
    const id = notificationNumericId(callId);
    await Promise.all([
      local.cancel?.({ notifications: [{ id }] }).catch(() => {}),
      local.removeDeliveredNotifications?.({ notifications: [{ id }] }).catch(() => {})
    ]);
  }

  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  if (!registration?.getNotifications) return;
  let notifications = await registration.getNotifications({ includeTriggered: true }).catch(() => null);
  if (!notifications) notifications = await registration.getNotifications().catch(() => []);
  for (const notification of notifications || []) {
    const notificationData = notification.data || {};
    const notificationCallId = pushDataValue(notificationData, "callId", "CallId");
    if (notificationCallId === callId || tags.has(notification.tag)) {
      notification.close();
    }
  }
}

function waitForPushReady(timeoutMs = 8000) {
  if (state.pushReady) return Promise.resolve(true);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (state.pushReady) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 250);
  });
}

async function initializeWebPushNotifications(options = {}) {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return false;
  if (!window.isSecureContext && !PLATFORM.isLocalhost) {
    state.pushError = "El navegador exige HTTPS para notificaciones push.";
    return false;
  }

  let permission = Notification.permission;
  if (permission !== "granted") {
    if (!options.requestPermission) {
      state.pushPermission = permission;
      return false;
    }
    permission = await Notification.requestPermission();
  }
  state.pushPermission = permission;
  if (permission !== "granted") return false;

  await registerServiceWorker().catch(() => null);
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  if (!registration) {
    state.pushError = "El service worker no quedo listo para recibir push.";
    return false;
  }

  state.pushLocalReady = true;
  state.pushError = "";

  const fcmRegistration = await getFirebaseMessagingRegistration(registration, { force: options.force }).catch((error) => {
    console.warn("Firebase web push registration unavailable.", error);
    state.pushTokenError = firebaseMessagingErrorMessage(error);
    state.pushTokenRetryAfter = shouldBackoffFirebaseTokenRequest(error) ? Date.now() + 5 * 60 * 1000 : 0;
    return null;
  });
  if (fcmRegistration?.token) {
    state.pushTokenError = "";
    state.pushTokenRetryAfter = 0;
    return await queuePushTokenRegistration(fcmRegistration.provider, fcmRegistration.token);
  }

  const subscription = await getStandardWebPushSubscription(registration).catch((error) => {
    console.warn("Standard Web Push subscription unavailable.", error);
    return null;
  });
  if (!subscription) {
    if (!state.pushTokenError) {
      state.pushTokenError = "Avisos locales activos; falta token FCM/Web Push para recibir con la app cerrada.";
    }
    return true;
  }

  state.pushTokenError = "";
  return await queuePushTokenRegistration("webpush", serializePushSubscription(subscription));
}

async function getFirebaseMessagingRegistration(serviceWorkerRegistration, options = {}) {
  if (!options.force && state.pushTokenRetryAfter && Date.now() < state.pushTokenRetryAfter) return null;
  const firebaseConfig = window.NIVRA_FIREBASE_CONFIG;
  const vapidKey = String(window.NIVRA_FIREBASE_VAPID_KEY || "").trim();
  if (!isFirebaseWebConfigReady(firebaseConfig, vapidKey)) return null;

  // VAPID publica de Firebase Console > Cloud Messaging > Certificados push web.
  // Nunca uses aqui el JSON Admin SDK: esa llave privada vive solo en backend.
  const tokenOptions = firebaseMessagingTokenOptions(serviceWorkerRegistration, vapidKey);
  try {
    return await requestFirebaseMessagingRegistration(firebaseConfig, tokenOptions, serviceWorkerRegistration);
  } catch (error) {
    if (!shouldResetFirebaseMessagingState(error)) throw error;
    console.warn("Firebase web push registration failed; resetting local messaging state before one clean retry.", error);
    await resetFirebaseMessagingState(serviceWorkerRegistration).catch((resetError) => {
      console.warn("Firebase messaging state reset did not complete.", resetError);
    });
    return await requestFirebaseMessagingRegistration(firebaseConfig, tokenOptions, serviceWorkerRegistration);
  }
}

async function requestFirebaseMessagingRegistration(firebaseConfig, tokenOptions, serviceWorkerRegistration) {
  if (window.firebase?.messaging) {
    const app = await getCompatFirebaseApp(firebaseConfig);
    const messaging = window.firebase.messaging(app);
    if (messaging.useServiceWorker) messaging.useServiceWorker(serviceWorkerRegistration);
    if (messaging.usePublicVapidKey) messaging.usePublicVapidKey(tokenOptions.vapidKey);
    bindWebForegroundMessaging(null, messaging);
    const token = await messaging.getToken(tokenOptions);
    return token ? { provider: "fcm", token } : null;
  }

  const appModule = await import(firebaseSdkUrl("firebase-app.js"));
  const messagingModule = await import(firebaseSdkUrl("firebase-messaging.js"));
  if (messagingModule.isSupported) {
    const supported = await messagingModule.isSupported();
    if (!supported) return null;
  }
  const app = await getModularFirebaseApp(appModule, firebaseConfig);
  const messaging = messagingModule.getMessaging(app);
  bindWebForegroundMessaging(messagingModule, messaging);
  const fidRegistration = await registerFirebaseMessagingFid(messagingModule, messaging, tokenOptions).catch((error) => {
    console.warn("Firebase FID registration fallback unavailable.", error);
    return null;
  });
  if (fidRegistration) return fidRegistration;
  const token = await messagingModule.getToken(messaging, tokenOptions);
  return token ? { provider: "fcm", token } : null;
}

async function getFirebasePhoneAuthSession() {
  const firebaseConfig = window.NIVRA_FIREBASE_CONFIG;
  if (!isFirebaseAuthConfigReady(firebaseConfig)) {
    throw new Error("Firebase Phone Auth no esta configurado en esta app.");
  }

  if (window.firebase?.auth) {
    const app = await getCompatFirebaseApp(firebaseConfig);
    const auth = window.firebase.auth(app);
    auth.useDeviceLanguage?.();
    state.firebasePhone.app = app;
    state.firebasePhone.auth = auth;
    state.firebasePhone.authModule = null;
    state.firebasePhone.compat = true;
    return {
      app,
      auth,
      compat: true,
      signInWithPhoneNumber: (phone, verifier) => auth.signInWithPhoneNumber(phone, verifier),
      createRecaptchaVerifier: (elementId, parameters) => new window.firebase.auth.RecaptchaVerifier(elementId, parameters, app)
    };
  }

  const appModule = await import(firebaseSdkUrl("firebase-app.js"));
  const authModule = await import(firebaseSdkUrl("firebase-auth.js"));
  const app = await getModularFirebaseApp(appModule, firebaseConfig);
  const auth = authModule.getAuth(app);
  if (authModule.useDeviceLanguage) {
    authModule.useDeviceLanguage(auth);
  } else {
    auth.useDeviceLanguage?.();
  }

  state.firebasePhone.app = app;
  state.firebasePhone.auth = auth;
  state.firebasePhone.authModule = authModule;
  state.firebasePhone.compat = false;
  return {
    app,
    auth,
    authModule,
    compat: false,
    signInWithPhoneNumber: (phone, verifier) => authModule.signInWithPhoneNumber(auth, phone, verifier),
    createRecaptchaVerifier: (elementId, parameters) => new authModule.RecaptchaVerifier(auth, elementId, parameters)
  };
}

async function getFirebaseRecaptchaVerifier(session) {
  const element = ensureFirebaseRecaptchaContainer();
  const verifier = window.recaptchaVerifier || state.firebasePhone.recaptchaVerifier;
  const verifierElement = window.recaptchaElement || state.firebasePhone.recaptchaElement;
  if (verifier && verifierElement === element && document.body.contains(element)) {
    state.firebasePhone.recaptchaVerifier = verifier;
    state.firebasePhone.recaptchaElement = element;
    window.recaptchaVerifier = verifier;
    window.recaptchaElement = element;
    return verifier;
  }

  if (verifier) await resetFirebaseRecaptchaVerifier({ clear: true });
  element.innerHTML = "";
  const nextVerifier = session.createRecaptchaVerifier("phoneRecaptcha", {
    size: "invisible",
    callback: () => {},
    "expired-callback": () => resetFirebaseRecaptchaVerifier().catch(() => {})
  });
  window.recaptchaVerifier = nextVerifier;
  window.recaptchaElement = element;
  window.recaptchaWidgetId = await nextVerifier.render?.();
  state.firebasePhone.recaptchaVerifier = nextVerifier;
  state.firebasePhone.recaptchaElement = element;
  return nextVerifier;
}

function ensureFirebaseRecaptchaContainer() {
  let element = document.querySelector("#phoneRecaptcha");
  if (element) return element;

  element = document.createElement("div");
  element.id = "phoneRecaptcha";
  element.className = "recaptcha-slot";
  document.querySelector("#phoneWrap")?.appendChild(element) || document.body.appendChild(element);
  return element;
}

async function resetFirebaseRecaptchaVerifier({ clear = false } = {}) {
  const verifier = window.recaptchaVerifier || state.firebasePhone.recaptchaVerifier;
  if (!verifier) {
    state.firebasePhone.recaptchaVerifier = null;
    state.firebasePhone.recaptchaElement = null;
    window.recaptchaVerifier = null;
    window.recaptchaElement = null;
    window.recaptchaWidgetId = null;
    return;
  }

  if (clear) {
    try {
      verifier.clear?.();
    } catch {}
    state.firebasePhone.recaptchaVerifier = null;
    state.firebasePhone.recaptchaElement = null;
    window.recaptchaVerifier = null;
    window.recaptchaElement = null;
    window.recaptchaWidgetId = null;
    ensureFirebaseRecaptchaContainer().innerHTML = "";
    return;
  }

  try {
    const widgetId = window.recaptchaWidgetId ?? await verifier.render?.();
    if (widgetId !== undefined && widgetId !== null) {
      window.recaptchaWidgetId = widgetId;
      window.grecaptcha?.reset?.(widgetId);
    }
  } catch {
    try {
      verifier.clear?.();
    } catch {}
    window.recaptchaVerifier = null;
    window.recaptchaElement = null;
    window.recaptchaWidgetId = null;
  }

  state.firebasePhone.recaptchaVerifier = window.recaptchaVerifier || null;
  state.firebasePhone.recaptchaElement = window.recaptchaElement || null;
}

function clearFirebasePhoneChallenge() {
  state.firebasePhone.confirmationResult = null;
  state.firebasePhone.phone = "";
}

function setPhoneAuthBusy(busy) {
  state.firebasePhone.busy = busy;
  const button = document.querySelector("#sendOtpBtn");
  if (button) {
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
    button.textContent = busy ? "Enviando" : "Codigo";
  }
}

function isFirebaseAuthConfigReady(firebaseConfig) {
  return Boolean(firebaseConfig?.apiKey &&
    firebaseConfig?.authDomain &&
    firebaseConfig?.projectId &&
    firebaseConfig?.appId);
}

function firebasePhoneAuthErrorMessage(error, fallback) {
  const code = String(error?.code || error?.message || "").toLowerCase();
  if (code.includes("invalid-phone-number")) return "Revisa el numero con codigo de pais, por ejemplo +593...";
  if (code.includes("captcha-check-failed") || code.includes("missing-app-credential") || code.includes("invalid-app-credential")) return "No se pudo validar reCAPTCHA. Reintenta el envio del codigo.";
  if (code.includes("app-not-authorized") || code.includes("unauthorized-domain")) return "Este dominio no esta autorizado en Firebase Authentication.";
  if (code.includes("too-many-requests") || code.includes("quota-exceeded")) return "Firebase bloqueo temporalmente los SMS por demasiados intentos. Espera un momento.";
  if (code.includes("invalid-verification-code")) return "Ese codigo no coincide. Revisalo e intenta otra vez.";
  if (code.includes("code-expired")) return "Ese codigo vencio. Pide uno nuevo.";
  if (code.includes("network-request-failed")) return "No hay conexion estable con Firebase. Revisa internet e intenta otra vez.";
  return error?.message || fallback;
}

async function registerFirebaseMessagingFid(messagingModule, messaging, tokenOptions) {
  if (!messagingModule.register || !messagingModule.onRegistered) return null;
  return await new Promise((resolve, reject) => {
    let unsubscribe = null;
    let timeout = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        unsubscribe?.();
      } catch {}
      callback(value);
    };
    timeout = setTimeout(() => finish(reject, new Error("Firebase FID registration timed out.")), 30000);
    try {
      unsubscribe = messagingModule.onRegistered(messaging, (fid) => {
        const token = String(fid || "").trim();
        if (token) finish(resolve, { provider: "fcm-fid", token });
      });
      messagingModule.register(messaging, tokenOptions).catch((error) => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function getCompatFirebaseApp(firebaseConfig) {
  const firebase = window.firebase;
  const existing = (firebase.apps || []).find((app) => app.name === FIREBASE_APP_NAME);
  if (existing && firebaseOptionsMatch(existing.options || {}, firebaseConfig)) return existing;
  if (existing?.delete) {
    await existing.delete().catch(() => {});
  }
  const stillExisting = (firebase.apps || []).find((app) => app.name === FIREBASE_APP_NAME);
  if (stillExisting && firebaseOptionsMatch(stillExisting.options || {}, firebaseConfig)) return stillExisting;
  return firebase.initializeApp(firebaseConfig, stillExisting ? `${FIREBASE_APP_NAME}-${Date.now()}` : FIREBASE_APP_NAME);
}

async function getModularFirebaseApp(appModule, firebaseConfig) {
  const existing = appModule.getApps().find((app) => app.name === FIREBASE_APP_NAME);
  if (existing && firebaseOptionsMatch(existing.options || {}, firebaseConfig)) return existing;
  if (existing && appModule.deleteApp) {
    await appModule.deleteApp(existing).catch(() => {});
  }
  const stillExisting = appModule.getApps().find((app) => app.name === FIREBASE_APP_NAME);
  if (stillExisting && firebaseOptionsMatch(stillExisting.options || {}, firebaseConfig)) return stillExisting;
  return appModule.initializeApp(firebaseConfig, stillExisting ? `${FIREBASE_APP_NAME}-${Date.now()}` : FIREBASE_APP_NAME);
}

function firebaseOptionsMatch(current, expected) {
  return ["apiKey", "projectId", "messagingSenderId", "appId"].every((key) =>
    String(current?.[key] || "") === String(expected?.[key] || "")
  );
}

function shouldResetFirebaseMessagingState(error) {
  return shouldBackoffFirebaseTokenRequest(error);
}

async function resetFirebaseMessagingState(serviceWorkerRegistration) {
  const subscription = await serviceWorkerRegistration?.pushManager?.getSubscription?.().catch(() => null);
  if (subscription) {
    await subscription.unsubscribe().catch(() => false);
  }
  await Promise.all(FIREBASE_RESETTABLE_IDB_NAMES.map((name) => deleteIndexedDbDatabase(name)));
}

function deleteIndexedDbDatabase(name) {
  return new Promise((resolve) => {
    if (!window.indexedDB?.deleteDatabase) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(false), 3000);
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
      request.onblocked = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

function firebaseMessagingTokenOptions(serviceWorkerRegistration, vapidKey) {
  return {
    vapidKey,
    serviceWorkerRegistration
  };
}

function isFirebaseWebConfigReady(firebaseConfig, vapidKey) {
  return Boolean(firebaseConfig?.apiKey &&
    firebaseConfig?.projectId &&
    firebaseConfig?.messagingSenderId &&
    firebaseConfig?.appId &&
    String(firebaseConfig.appId).includes(":web:") &&
    String(vapidKey || "").trim().length > 20);
}

function firebaseMessagingErrorMessage(error) {
  const text = `${error?.code || ""} ${error?.message || error || ""}`.toLowerCase();
  if (text.includes("permission")) return "Permiso activo, pero el navegador no autorizo el token FCM.";
  if (text.includes("401") || text.includes("unauthorized") || text.includes("authentication credential") || text.includes("token-subscribe-failed")) {
    return "Avisos locales activos. Firebase rechazo el registro web (401); revisa API key web, VAPID publica y dominio autorizado para avisos con la app cerrada.";
  }
  if (text.includes("not-supported") || text.includes("unsupported")) return "Avisos locales activos. Este navegador no soporta FCM Web Push remoto.";
  return "Avisos locales activos; no se obtuvo token remoto FCM/Web Push.";
}

function shouldBackoffFirebaseTokenRequest(error) {
  const text = `${error?.code || ""} ${error?.message || error || ""}`.toLowerCase();
  return text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("authentication credential") ||
    text.includes("token-subscribe-failed");
}

function firebaseSdkUrl(file) {
  return `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/${file}`;
}

function bindWebForegroundMessaging(messagingModule, messaging) {
  if (state.webPushForegroundReady || !messaging) return;
  try {
    if (messagingModule?.onMessage) {
      messagingModule.onMessage(messaging, (payload) => handleForegroundPushNotification(payload).catch(() => {}));
      state.webPushForegroundReady = true;
      return;
    }
    if (messaging.onMessage) {
      messaging.onMessage((payload) => handleForegroundPushNotification(payload).catch(() => {}));
      state.webPushForegroundReady = true;
    }
  } catch (error) {
    console.warn("Firebase foreground listener unavailable.", error);
  }
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
  const data = extractPushData(notification);
  if (isTerminalCallPushData(data)) {
    await handleTerminalCallPush(data).catch(() => {});
    await syncPendingMessages("push-call-ended", { force: true }).catch(() => {});
    return;
  }
  if (isIncomingCallPushData(data)) {
    toast("Llamada entrante");
    const hydrated = await hydrateIncomingCallFromPushData(data).catch(() => false);
    if (!hydrated) toast("Esa llamada ya finalizo.");
  } else {
    notifyForegroundPushMessage(data, notification);
    toast("Nuevo mensaje");
  }
  await syncPendingMessages("push-foreground", { force: true }).catch(() => {});
}

function notifyForegroundPushMessage(data = {}, notification = {}) {
  const conversationId = pushDataValue(data, "conversationId", "ConversationId");
  const body = state.privacy?.hideNotificationContent
    ? "Nuevo mensaje privado"
    : notification?.body || notification?.notification?.body || "Nuevo mensaje privado";
  if (appIsBackgrounded()) {
    showRealtimeNotification("Nivra", {
      body,
      tag: conversationId ? `nivra-message-${conversationId}` : "nivra-message",
      data
    });
  }
}

async function handlePushNavigation(data = {}, options = {}) {
  if (isTerminalCallPushData(data)) {
    await handleTerminalCallPush(data, { toast: false }).catch(() => {});
    return;
  }

  if (isIncomingCallPushData(data)) {
    const hydrated = await hydrateIncomingCallFromPushData(data).catch(() => false);
    if (!hydrated) {
      await clearCallNotificationByData(data).catch(() => {});
      toast("Esa llamada ya finalizo.");
      return;
    }
    activateView("calls", { mobileChatOpen: false, renderAfter: false });
    if (hydrated && options.action === "accept") {
      window.setTimeout(() => acceptCall().catch(() => {}), 0);
    }
    if (hydrated && options.action === "decline") {
      window.setTimeout(() => declineCall().catch(() => {}), 0);
    }
    return;
  }

  const conversationId = pushDataValue(data, "conversationId", "ConversationId");
  if (!conversationId) {
    const targetView = pushDataTargetView(data);
    if (targetView) activateView(targetView, { mobileChatOpen: false, renderAfter: false });
    return;
  }

  selectConversation(conversationId);
  activateView("chats", { mobileChatOpen: true, renderAfter: false });
  saveJson("nivra.selectedConversationId", state.selectedConversationId);
}

function pushDataTargetView(data = {}) {
  if (isTerminalCallPushData(data)) return "";
  const type = normalizePushType(pushDataValue(data, "type", "Type"));
  if (type.includes("story") || type.includes("friend")) return "world";
  if (type.includes("vault")) return "vault";
  if (type.includes("call")) return "calls";
  return "";
}

async function hydrateIncomingCallFromPushData(data = {}) {
  const callId = pushDataValue(data, "callId", "CallId");
  if (!callId || state.endedCallIds.has(String(callId))) {
    await clearCallNotificationByData(data).catch(() => {});
    return false;
  }

  const serverCall = await fetchActiveCallForPush(callId);
  if (!serverCall) {
    rememberEndedCallId(callId);
    await clearCallNotificationByData(data).catch(() => {});
    markCallHistoryEnded(callId);
    return false;
  }

  if (state.call.current?.id === callId) return true;

  const callerUserId = pushDataValue(
    serverCall,
    "initiatorUserId",
    "InitiatorUserId",
    "callerId",
    "CallerId",
    "callerUserId",
    "CallerUserId"
  ) || pushDataValue(data, "callerId", "CallerId", "callerUserId", "CallerUserId", "initiatorUserId", "InitiatorUserId");
  if (!callerUserId || callerUserId === state.auth?.user?.id) return false;

  const participantUserIds = serverCall.participantUserIds || serverCall.ParticipantUserIds || [callerUserId, state.auth?.user?.id].filter(Boolean);
  if (state.auth?.user?.id && !participantUserIds.includes(state.auth.user.id)) return false;

  const callerName = pushDataValue(data, "callerName", "CallerName");
  if (callerName) state.aliasByUserId.set(callerUserId, callerName);

  const call = {
    id: callId,
    conversationId: pushDataValue(serverCall, "conversationId", "ConversationId") || pushDataValue(data, "conversationId", "ConversationId") || null,
    initiatorUserId: callerUserId,
    type: normalizeCallType(pushDataValue(serverCall, "type", "Type") || pushDataValue(data, "callType", "CallType", "type", "Type")),
    status: pushDataValue(serverCall, "status", "Status") || "Ringing",
    participantUserIds,
    startedAt: pushDataValue(serverCall, "startedAt", "StartedAt") || new Date().toISOString()
  };

  activateView("calls", { mobileChatOpen: false, renderAfter: false });
  await handleIncomingCall(call, { notify: false });
  return true;
}

function isIncomingCallPushData(data = {}) {
  const type = normalizePushType(pushDataValue(data, "type", "Type"));
  const callId = pushDataValue(data, "callId", "CallId");
  return Boolean(callId) && !TERMINAL_CALL_PUSH_TYPES.has(type) && (type === "call" || !type || type.includes("call"));
}

function isTerminalCallPushData(data = {}) {
  const type = normalizePushType(pushDataValue(data, "type", "Type"));
  const callId = pushDataValue(data, "callId", "CallId");
  return Boolean(callId) && TERMINAL_CALL_PUSH_TYPES.has(type);
}

function normalizePushType(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

async function fetchActiveCallForPush(callId) {
  try {
    const call = await request(`/calls/${encodeURIComponent(callId)}`);
    return isEndedCallResponse(call) ? null : call;
  } catch (error) {
    console.warn("Incoming call push verification failed.", error);
    return null;
  }
}

function isEndedCallResponse(call) {
  const status = String(call?.status || call?.Status || "").toLowerCase();
  return !call || status === "ended" || status === "finalizada" || Boolean(call.endedAt || call.EndedAt);
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

function extractPushData(notification = {}) {
  return notification?.data ||
    notification?.extra ||
    notification?.notification?.data ||
    notification?.notification?.extra ||
    {};
}

async function registerPushToken(provider, token) {
  if (!provider || !token || !state.auth?.tokens?.accessToken) return;
  const response = await request(PUSH_TOKEN_ENDPOINT, {
    method: "POST",
    body: { provider, token }
  });
  if (response && Object.prototype.hasOwnProperty.call(response, "serverReady")) {
    state.pushServerReady = Boolean(response.serverReady);
  }
  return response;
}

async function queuePushTokenRegistration(provider, token) {
  const normalizedToken = String(token || "").trim();
  const normalizedProvider = String(provider || "").trim();
  if (!normalizedProvider || !normalizedToken || !state.auth?.tokens?.accessToken) return false;
  state.pushRegistration = { provider: normalizedProvider, token: normalizedToken };
  return flushPushTokenRegistration();
}

async function flushPushTokenRegistration() {
  if (!state.auth?.tokens?.accessToken || !state.pushRegistration) return false;
  clearTimeout(state.pushRetryTimer);
  state.pushRetryTimer = null;
  try {
    await registerPushToken(state.pushRegistration.provider, state.pushRegistration.token);
    state.pushReady = true;
    state.pushError = "";
    state.pushTokenError = "";
    state.pushRetryAttempt = 0;
    state.pushRegistration = null;
    scheduleRender();
    return true;
  } catch (error) {
    state.pushReady = false;
    state.pushError = error?.message || "Registro de notificaciones pendiente.";
    schedulePushTokenRegistrationRetry(error);
    scheduleRender();
    return false;
  }
}

function schedulePushTokenRegistrationRetry(error) {
  if (!state.auth?.tokens?.accessToken || !state.pushRegistration) return;
  clearTimeout(state.pushRetryTimer);
  const index = Math.min(state.pushRetryAttempt, PUSH_REGISTRATION_RETRY_DELAYS_MS.length - 1);
  const delay = PUSH_REGISTRATION_RETRY_DELAYS_MS[index];
  state.pushRetryAttempt = Math.min(state.pushRetryAttempt + 1, PUSH_REGISTRATION_RETRY_DELAYS_MS.length - 1);
  console.warn("Push token registration deferred.", error);
  state.pushRetryTimer = setTimeout(() => {
    state.pushRetryTimer = null;
    flushPushTokenRegistration().catch(() => {});
  }, delay);
}

function appIsBackgrounded() {
  return document.hidden || document.visibilityState !== "visible" || !document.hasFocus();
}

function showRealtimeNotification(title, options = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !appIsBackgrounded()) return;
  const notificationOptions = {
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    silent: false,
    ...options
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        if (registration?.showNotification) return registration.showNotification(title, notificationOptions);
        return showWindowNotification(title, notificationOptions);
      })
      .catch(() => showWindowNotification(title, notificationOptions));
    return;
  }
  showWindowNotification(title, notificationOptions);
}

function showWindowNotification(title, options = {}) {
  try {
    const { actions: _actions, vibrate: _vibrate, ...windowOptions } = options;
    const notification = new Notification(title, {
      ...windowOptions
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

function notifyRealtimeUpdate(body, data = {}, options = {}) {
  if (appIsBackgrounded()) {
    showRealtimeNotification("Nivra", {
      body,
      tag: data.tag || "nivra-update",
      data
    });
    return;
  }
  if (options.foregroundToast !== false) toast(body);
}

async function testNotificationDelivery() {
  await refreshPushPermissionState().catch(() => {});
  if (notificationCapabilityStatus().permission !== "granted") {
    await enableNotificationsFromUserAction();
    if (notificationCapabilityStatus().permission !== "granted") return;
  }

  const data = {
    type: "message",
    conversationId: state.selectedConversationId || "",
    tag: "nivra-test"
  };
  if (isNativeCapacitor()) {
    await initializeCapacitorLocalNotifications().catch(() => {});
    await showCapacitorLocalNotification({
      title: "Nivra",
      body: "Aviso de prueba listo.",
      data
    }).catch(() => {});
    toast("Aviso de prueba enviado.");
    return;
  }

  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (registration?.showNotification) {
      await registration.showNotification("Nivra", {
        body: "Aviso de prueba listo.",
        icon: "/assets/icon-192.png",
        badge: "/assets/icon-192.png",
        tag: "nivra-test",
        data
      });
      toast("Aviso de prueba enviado.");
      return;
    }
  }

  try {
    const notification = new Notification("Nivra", {
      body: "Aviso de prueba listo.",
      icon: "/assets/icon-192.png",
      tag: "nivra-test",
      data
    });
    notification.onclick = () => notification.close();
    toast("Aviso de prueba enviado.");
  } catch {
    toast("El navegador bloqueo el aviso de prueba.");
  }
}

function notifyIncomingMessage(message, payload) {
  if (message.senderUserId === state.auth.user.id) return;
  const alias = state.aliasByUserId.get(message.senderUserId) || payload.senderAlias || "un contacto";
  const body = incomingMessageNotificationBody(message, payload, alias);
  if (!appIsBackgrounded()) {
    if (state.view !== "chats" || state.selectedConversationId !== message.conversationId) {
      toast(body);
    }
    return;
  }
  showRealtimeNotification("Nivra", {
    body,
    tag: `nivra-message-${message.conversationId}`,
    data: {
      type: "message",
      conversationId: message.conversationId,
      messageId: message.id || "",
      senderUserId: message.senderUserId || "",
      tag: `nivra-message-${message.conversationId}`
    }
  });
}

function incomingMessageNotificationBody(message, payload = {}, alias = "un contacto") {
  if (state.privacy?.hideNotificationContent) return "Nuevo mensaje privado";
  if (payload.type === "system") return payload.text || "Nuevo evento de sistema";
  if (payload.type === "reaction") return `${alias} reacciono ${payload.emoji || ""}`.trim();
  if (payload.type === "story-response") return `${alias} respondio a tu historia`;
  if (payload.type === "file") {
    if (payload.voiceNote) return `${alias} envio una nota de voz`;
    return `${alias} envio ${fileTypeLabel(payload.mime).toLowerCase()}`;
  }
  return `Nuevo mensaje de ${alias}`;
}

function notifyIncomingCall(call) {
  if (call.initiatorUserId === state.auth.user.id) return;
  const alias = state.aliasByUserId.get(call.initiatorUserId) || "un contacto";
  showRealtimeNotification("Nivra", {
    body: `${call.type === "Video" ? "Videollamada" : "Llamada"} entrante de ${alias}`,
    tag: `nivra-call-${call.id}`,
    requireInteraction: true,
    renotify: true,
    actions: [
      { action: "accept", title: "Contestar" },
      { action: "decline", title: "Rechazar" }
    ],
    vibrate: [320, 140, 320, 140, 480],
    data: {
      type: "incoming_call",
      callId: call.id,
      conversationId: call.conversationId || "",
      callerId: call.initiatorUserId,
      callerUserId: call.initiatorUserId,
      callerName: alias,
      callType: call.type
    }
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
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {}
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
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not persist ${key}.`, error);
  }
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
