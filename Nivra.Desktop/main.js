const { app, BrowserWindow, Menu, shell, session, ipcMain, safeStorage, net } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('url');
const { PINNED_API_ORIGINS, allowedApiOrigin } = require('./api-origins');
const { installWindowPrivacy } = require('./window-privacy');
const { isBundledEntry, isTrustedIpc } = require('./renderer-security');
const { createElectronRequest, createUpdateManager, updateErrorCode } = require('./update-manager');
const { createLauncherAppearanceManager, installLauncherAppearanceHandlers } = require('./launcher-appearance');

let mainWindow = null;
let isQuitting = false;
let trustedEntryUrl = '';
let launcherAppearance = null;
let windowPrivacy = null;

function assertTrustedRenderer(event) {
  if (!isTrustedIpc(event, mainWindow, trustedEntryUrl)) throw new Error('Untrusted IPC sender.');
}

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
  if (!fs.existsSync(filePath)) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error('NIVRA_SECURE_UNAVAILABLE');
  try {
    const encrypted = fs.readFileSync(filePath);
    if (!encrypted.length) throw new Error('Empty secure envelope');
    const secret = safeStorage.decryptString(encrypted);
    if (!secret) throw new Error('Empty secure secret');
    return secret;
  } catch {
    // Preserve the existing wrapped file and expose no provider/file details.
    throw new Error('NIVRA_SECURE_DECRYPT_FAILED');
  }
}

function writeDesktopSecureSecret(name, secret) {
  if (!safeStorage.isEncryptionAvailable()) {
    return "";
  }
  fs.mkdirSync(secureVaultDir(), { recursive: true });
  const filePath = secureSecretPath(name);
  try {
    fs.writeFileSync(filePath, safeStorage.encryptString(secret), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Another process may have initialized this installation first. Never
    // overwrite its secret; every caller must use the committed winner.
    if (error && error.code === 'EEXIST') return readDesktopSecureSecret(name);
    throw new Error('NIVRA_SECURE_WRITE_FAILED');
  }
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
  ipcMain.handle("nivra-secure-vault:get-or-create", (event, rawName, options) => {
    assertTrustedRenderer(event);
    const name = normalizeSecretName(rawName);
    assertAllowedSecretName(name);
    const existing = readDesktopSecureSecret(name);
    if (!existing && options && options.create === false) return { name, created: false, available: true };
    const created = !existing;
    const secret = existing || createDesktopSecureSecret(name);
    return { name, secret, created, available: Boolean(secret) };
  });

  ipcMain.handle("nivra-secure-vault:clear", (event, rawName) => {
    assertTrustedRenderer(event);
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
  ipcMain.handle("nivra-content-protection:set-secure-screen", (event, options) => {
    assertTrustedRenderer(event);
    const enabled = Boolean(options && options.enabled);
    if (mainWindow && !mainWindow.isDestroyed()) {
      windowPrivacy?.setProtected(enabled);
    }
    return { enabled };
  });
}

function installDesktopUpdateHandlers() {
  const updates = createUpdateManager({
    platform: process.platform,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    cacheDirectory: path.join(app.getPath('userData'), 'updates'),
    request: createElectronRequest(net),
    onState: state => {
      if (mainWindow && !mainWindow.isDestroyed() && isBundledEntry(mainWindow.webContents.getURL(), trustedEntryUrl)) {
        mainWindow.webContents.send('nivra-updates:state', state);
      }
    },
    launchInstaller: file => new Promise((resolve, reject) => {
      // The installer path comes only from the main-process verifier. No shell,
      // elevated privileges or renderer-supplied command-line arguments.
      const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    }),
  });
  for (const [channel, method] of [
    ['nivra-updates:check', 'checkForUpdate'],
    ['nivra-updates:download', 'downloadUpdate'],
    ['nivra-updates:install', 'installUpdate'],
    ['nivra-updates:get-state', 'getUpdateState'],
  ]) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedRenderer(event);
      if (args.length) throw new Error('UPDATE_INVALID_MANIFEST');
      try {
        const result = await updates[method]();
        if (method === 'installUpdate') {
          // Let IPC settle, then close normally so pending application writes can finish.
          setTimeout(() => { isQuitting = true; app.quit(); }, 250);
        }
        return result;
      } catch (error) { throw new Error(updateErrorCode(error)); }
    });
  }
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
  return launcherAppearance?.getIconPath() || path.join(__dirname, "icon.ico");
}

function resolveApiBaseUrl(webRoot) {
  return allowedApiOrigin(process.env.NIVRA_API_BASE_URL || readBundledApiBaseUrl(webRoot) || PINNED_API_ORIGINS[0], !app.isPackaged)
    || PINNED_API_ORIGINS[0];
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
      devTools: !app.isPackaged,
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false
    }
  });

  windowPrivacy = installWindowPrivacy(mainWindow);
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const indexPath = path.join(webRoot, "index.html");
  trustedEntryUrl = pathToFileURL(indexPath).href;
  const guardNavigation = (event, url, _isInPlace, isMainFrame) => {
    if (event.isMainFrame === false || isMainFrame === false) return;
    if (!isBundledEntry(event.url || url, trustedEntryUrl)) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

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
    const origins = [...PINNED_API_ORIGINS];
    const selected = allowedApiOrigin(apiBaseUrl, !app.isPackaged);
    if (selected && !origins.includes(selected)) origins.push(selected);
    session.defaultSession.webRequest.onHeadersReceived({ urls: origins.map(origin => `${origin}/*`) }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Access-Control-Allow-Origin": ["*"],
          "Access-Control-Allow-Headers": ["authorization, content-type, x-requested-with, x-nivra-device-id, x-nivra-call-protocol, x-nivra-client-version"],
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
    installDesktopUpdateHandlers();
    launcherAppearance = createLauncherAppearanceManager({
      platform: process.platform,
      isPackaged: app.isPackaged,
      userDataDirectory: app.getPath('userData'),
      bundleDirectory: path.join(__dirname, 'icons'),
      executablePath: process.execPath || app.getPath('exe'),
      desktopDirectory: app.getPath('desktop'),
      startMenuDirectory: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      shell,
      setWindowIcon: icon => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(icon);
      },
    });
    launcherAppearance.restore();
    installLauncherAppearanceHandlers({ ipcMain, assertTrustedRenderer, manager: launcherAppearance });
    installApiCorsBridge(apiBaseUrl);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const trusted = mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents
        && isBundledEntry(contents.getURL(), trustedEntryUrl)
        && details?.isMainFrame !== false
        && (!details?.requestingUrl || isBundledEntry(details.requestingUrl, trustedEntryUrl));
      callback(Boolean(trusted && ["media", "notifications", "camera", "microphone"].includes(permission)));
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
