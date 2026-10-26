import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NativeDeviceService } from './native-device.service';
import { acknowledgeWebPushAccountWipe, markWebPushAccountWipe, pendingWebPushAccountWipes } from './push-account-scopes';

export interface AccountWipeScope { userId: string; deviceId: string; }

@Injectable({ providedIn: 'root' })
export class DeviceWipeService {
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly history = inject(LocalHistoryService);
  private readonly native = inject(NativeDeviceService);
  private readonly wiping = new Map<string, Promise<void>>();

  async nukeDevice(reason = 'FORCE_WIPE'): Promise<void> {
    const session = this.auth.session();
    if (!session) return this.processPendingAccountWipes();
    return this.wipeAccount({ userId: session.user.id, deviceId: session.device.id }, reason);
  }

  async processPendingAccountWipes(): Promise<void> {
    const pending = new Map<string, AccountWipeScope>();
    for (const scope of [...await this.native.pendingPushAccountWipes(), ...await pendingWebPushAccountWipes()]) {
      pending.set(JSON.stringify([scope.userId, scope.deviceId]), scope);
    }
    for (const scope of pending.values()) {
      await this.wipeAccount(scope);
    }
  }

  wipeAccount(scope: AccountWipeScope, reason = 'FORCE_WIPE'): Promise<void> {
    if (!scope.userId || !scope.deviceId) return Promise.reject(new Error('Falta la cuenta que se debe limpiar.'));
    const key = JSON.stringify([scope.userId, scope.deviceId]);
    const existing = this.wiping.get(key);
    if (existing) return existing;
    const operation = this.cleanAccount(scope, reason).finally(() => this.wiping.delete(key));
    this.wiping.set(key, operation);
    return operation;
  }

  private async cleanAccount(scope: AccountWipeScope, reason: string): Promise<void> {
    // Invalidate credentials before the first data deletion. The other saved
    // account and the shared DB/Keystore protectors remain usable throughout.
    await markWebPushAccountWipe(scope);
    await this.native.clearPushRegistration(scope);
    // A delayed command for a retired device cannot erase a replacement session
    // for the same user. That session owns the shared account history now.
    const hasReplacement = async () => (await this.auth.storedSessionCredentials()).some(saved =>
      saved.user.id === scope.userId && saved.device.id !== scope.deviceId);
    if (await hasReplacement()) {
      await this.native.acknowledgePushAccountWipe(scope);
      await acknowledgeWebPushAccountWipe(scope);
      return;
    }
    await this.auth.removeStoredAccount(scope.userId, scope.deviceId, reason);
    if (await hasReplacement()) return;
    await this.crypto.destroyLocalDeviceKeysForUser(scope.userId);
    if (await hasReplacement()) return;
    await this.history.wipeAccountData(scope.userId);
    if (await hasReplacement()) return;
    // These owner caches are outside the history database. Match complete keys,
    // never a substring of another account or a shared installation protector.
    const userId = scope.userId;
    const encoded = encodeURIComponent(userId);
    for (const key of [
      `nivra.broadcasts.v1.${userId}`, `nivra.launcher.account.v1.${encoded}`,
      `nivra.chatLaunchCache.v1.${encoded}`, `nivra.chatLaunchCache.v2.${encoded}`,
      `nivra.contactHashes.${userId}`, `nivra.contactPhones.${userId}`,
      `nivra.radar.contactJoined.${userId}`, `nivra.radar.seen.${userId}`,
      `nivra.callHistory.${userId}`, `nivra.selectedConversationId.${userId}`,
      `nivra.pinnedConversations.${userId}`, `nivra.archivedConversations.${userId}`, `nivra.mutedConversations.${userId}`,
      `nivra.blockedConversations.${userId}`,
      `nivra.settings.v2.${userId}`, `nivra.vault.${userId}`,
      `nivra.appLock.v1.${userId}`, `nivra.panicPin.v1.${userId}`, `nivra.accountLock.v1.${userId}`,
      `nivra.appLock.attempts.v1.${userId}`,
      `nivra.platformUnlock.v1:${encodeURIComponent(window.location.origin)}:${encoded}`,
    ]) localStorage.removeItem(key);
    // A failed cleanup leaves the native marker intact, blocking activation
    // and retrying on next launch rather than silently acknowledging a wipe.
    await this.native.acknowledgePushAccountWipe(scope);
    await acknowledgeWebPushAccountWipe(scope);
  }
}
