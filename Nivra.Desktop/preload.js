const { contextBridge, ipcRenderer } = require("electron");

const allowedSecretNames = new Set(["device-keys", "local-db", "auth-session", "all"]);

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function assertAllowedName(name) {
  if (!allowedSecretNames.has(name)) {
    throw new Error("Secure secret name is not allowed.");
  }
}

contextBridge.exposeInMainWorld("nivraSecureVault", {
  async getOrCreateSecret(name) {
    const normalized = normalizeName(name);
    assertAllowedName(normalized);
    if (normalized === "all") {
      throw new Error("Cannot create a bulk secure secret.");
    }
    return ipcRenderer.invoke("nivra-secure-vault:get-or-create", normalized);
  },
  async clearSecret(name) {
    const normalized = normalizeName(name);
    assertAllowedName(normalized);
    return ipcRenderer.invoke("nivra-secure-vault:clear", normalized);
  }
});

contextBridge.exposeInMainWorld("nivraContentProtection", {
  async setSecureScreen(options) {
    return ipcRenderer.invoke("nivra-content-protection:set-secure-screen", {
      enabled: Boolean(options && options.enabled)
    });
  }
});

contextBridge.exposeInMainWorld('nivraDesktopUpdates', {
  checkForUpdate: () => ipcRenderer.invoke('nivra-updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('nivra-updates:download'),
  installUpdate: () => ipcRenderer.invoke('nivra-updates:install'),
  getUpdateState: () => ipcRenderer.invoke('nivra-updates:get-state'),
  onUpdateState(listener) {
    if (typeof listener !== 'function') throw new TypeError('Update listener must be a function.');
    const phases = new Set(['idle', 'downloading', 'ready', 'error', 'installing']);
    const handler = (_event, state) => {
      if (!state || !phases.has(state.phase) || !Number.isFinite(state.progress)) return;
      listener({
        phase: state.phase, progress: Math.max(0, Math.min(100, Math.floor(state.progress))),
        ...(typeof state.error === 'string' && /^UPDATE_[A-Z_]+$/.test(state.error) ? { error: state.error } : {}),
      });
    };
    ipcRenderer.on('nivra-updates:state', handler);
    return () => ipcRenderer.removeListener('nivra-updates:state', handler);
  },
});

const launcherIcons = new Set(['original', 'emerald', 'ivory']);
contextBridge.exposeInMainWorld('nivraLauncherAppearance', {
  getState: () => ipcRenderer.invoke('nivra-launcher:get-state'),
  setIcon(icon) {
    if (typeof icon !== 'string' || !launcherIcons.has(icon)) throw new TypeError('LAUNCHER_INVALID_ICON');
    return ipcRenderer.invoke('nivra-launcher:set-icon', icon);
  },
});
