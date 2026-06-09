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
