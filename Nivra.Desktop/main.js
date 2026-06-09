const { app, BrowserWindow, Menu, shell, session, ipcMain, safeStorage } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let mainWindow = null;
let isQuitting = false;

const SECURE_SECRET_NAMES = new Set(["device-keys", "local-db", "auth-session"]);

function secureVaultDir() {
  return path.join(app.getPath("userData"), "secure-vault");
}

function secureSecretPath(name) {
  return path.join(secureVaultDir(), `${name}.bin`);
}

function normalizeSecretName(name) {
  return String(name || "").trim().toLowerCase();
}

function assertAllowedSecretName(name) {
  if (!SECURE_SECRET_NAMES.has(name)) {
    throw new Error("Secure secret name is not allowed.");
  }
}

function readDesktopSecureSecret(name) {
  const filePath = secureSecretPath(name);
  if (!fs.existsSync(filePath) || !safeStorage.isEncryptionAvailable()) {
    return "";
  }
  const encrypted = fs.readFileSync(filePath);
  return safeStorage.decryptString(encrypted);
}

function writeDesktopSecureSecret(name, secret) {
  if (!safeStorage.isEncryptionAvailable()) {
    return "";
  }
  fs.mkdirSync(secureVaultDir(), { recursive: true });
  const filePath = secureSecretPath(name);
  fs.writeFileSync(filePath, safeStorage.encryptString(secret), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows ACLs are handled by the user profile; chmod is best effort across platforms.
  }
  return secret;
}

function createDesktopSecureSecret(name) {
  const secret = crypto.randomBytes(32).toString("base64");
  return writeDesktopSecureSecret(name, secret);
}

function clearDesktopSecureSecret(name) {
  const filePath = secureSecretPath(name);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort crypto-shredding: removing the wrapped secret makes local envelopes unusable.
  }
}

function installSecureVaultHandlers() {
  ipcMain.handle("nivra-secure-vault:get-or-create", (_event, rawName) => {
    const name = normalizeSecretName(rawName);
    assertAllowedSecretName(name);
    const existing = readDesktopSecureSecret(name);
    const created = !existing;
    const secret = existing || createDesktopSecureSecret(name);
    return { name, secret, created, available: Boolean(secret) };
  });

  ipcMain.handle("nivra-secure-vault:clear", (_event, rawName) => {
    const name = normalizeSecretName(rawName);
    if (!name || name === "all") {
      SECURE_SECRET_NAMES.forEach(clearDesktopSecureSecret);
      return { cleared: true };
    }
    assertAllowedSecretName(name);
    clearDesktopSecureSecret(name);
    return { cleared: true };
  });
}

function installContentProtectionHandlers() {
  ipcMain.handle("nivra-content-protection:set-secure-screen", (_event, options) => {
    const enabled = Boolean(options && options.enabled);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setContentProtection(enabled);
    }
    return { enabled };
  });
}

function readBundledApiBaseUrl(webRoot) {
  try {
    const config = fs.readFileSync(path.join(webRoot, "native-config.js"), "utf8");
    const direct = config.match(/NIVRA_NATIVE_API_BASE_URL\s*=\s*["']([^"']+)["']/);
    const fallback = config.match(/NIVRA_NATIVE_API_BASE_URL\s*=\s*[^|]*\|\|\s*["']([^"']+)["']/);
    return direct?.[1] || fallback?.[1] || "";
  } catch {
    return "";
  }
}

function resolveWebRoot() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "wwwroot"),
        path.join(process.resourcesPath, "browser")
      ]
    : [
        path.join(__dirname, "wwwroot"),
        path.join(__dirname, "..", "nivra-app", "dist", "nivra-app", "browser"),
        path.join(__dirname, "..", "Nivra.Api", "wwwroot")
      ];

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || candidates[0];
}

function resolveWindowIcon() {
  return path.join(__dirname, "icon.ico");
}

function resolveApiBaseUrl(webRoot) {
  return (process.env.NIVRA_API_BASE_URL || readBundledApiBaseUrl(webRoot) || "https://nivra-webapp-secure.onrender.com").replace(/\/+$/, "");
}

function createWindow(webRoot, apiBaseUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 680,
    title: "Nivra",
    icon: resolveWindowIcon(),
    backgroundColor: "#070b0d",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const indexPath = path.join(webRoot, "index.html");

  const query = apiBaseUrl
    ? { electron: "1", apiBaseUrl }
    : { electron: "1" };

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.on("close", () => {
    if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });

  mainWindow.loadFile(indexPath, { query });
}

function installApiCorsBridge(apiBaseUrl) {
  try {
    const apiOrigin = new URL(apiBaseUrl).origin;
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${apiOrigin}/*`] }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Access-Control-Allow-Origin": ["*"],
          "Access-Control-Allow-Headers": ["authorization, content-type, x-requested-with"],
          "Access-Control-Allow-Methods": ["GET, POST, PUT, PATCH, DELETE, OPTIONS"]
        }
      });
    });
  } catch {
    // Keep the desktop shell bootable even if a bad env URL is passed.
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const webRoot = resolveWebRoot();
    const apiBaseUrl = resolveApiBaseUrl(webRoot);

    installSecureVaultHandlers();
    installContentProtectionHandlers();
    installApiCorsBridge(apiBaseUrl);
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(["media", "notifications", "camera", "microphone"].includes(permission));
    });

    createWindow(webRoot, apiBaseUrl);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(webRoot, apiBaseUrl);
    });
  });
}

app.on("window-all-closed", () => {
  isQuitting = true;
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});
