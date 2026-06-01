const { app, BrowserWindow, Menu, shell, session } = require("electron");
const fs = require("fs");
const path = require("path");

let mainWindow = null;
let isQuitting = false;

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
