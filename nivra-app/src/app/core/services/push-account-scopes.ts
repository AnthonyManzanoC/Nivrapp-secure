import { openDB } from 'idb';

export interface PushAccountScope {
  userId: string;
  deviceId: string;
  hideNotificationContent: boolean;
}

/** Contains routing/privacy metadata only; no tokens, aliases or key material. */
export async function savePushAccountScopes(scopes: PushAccountScope[], active?: { userId: string; deviceId: string }): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDB('NivraPushScopes', 1, {
    upgrade(database) { database.createObjectStore('state'); },
  });
  try {
    const transaction = db.transaction('state', 'readwrite');
    const pending = (await transaction.store.get('pendingWipes') ?? []) as Array<{ userId: string; deviceId: string }>;
    const allowed = scopes.filter(scope => !pending.some(wipe => wipe.userId === scope.userId && wipe.deviceId === scope.deviceId)).slice(0, 2);
    const activeAllowed = active && allowed.some(scope => scope.userId === active.userId && scope.deviceId === active.deviceId);
    await transaction.store.put({ scopes: allowed,
      activeUserId: activeAllowed ? active.userId : '', activeDeviceId: activeAllowed ? active.deviceId : '',
    }, 'saved');
    await transaction.done;
  } finally { db.close(); }
}

export async function readPendingWebPushClick(): Promise<Record<string, string> | null> {
  return await readState('pendingClick') ?? null;
}

export async function pendingWebPushAccountWipes(): Promise<Array<{ userId: string; deviceId: string }>> {
  return await readState('pendingWipes') ?? [];
}

export async function clearPendingWebPushClick(): Promise<void> {
  const db = await openState();
  if (!db) return;
  try { await db.delete('state', 'pendingClick'); } finally { db.close(); }
}

export async function acknowledgeWebPushAccountWipe(scope: { userId: string; deviceId: string }): Promise<void> {
  const db = await openState();
  if (!db) return;
  try {
    const transaction = db.transaction('state', 'readwrite');
    const pending = await transaction.store.get('pendingWipes') as Array<{ userId: string; deviceId: string }> | undefined;
    await transaction.store.put((pending ?? []).filter(item => item.userId !== scope.userId || item.deviceId !== scope.deviceId), 'pendingWipes');
    await transaction.done;
  } finally { db.close(); }
}

export async function markWebPushAccountWipe(scope: { userId: string; deviceId: string }): Promise<void> {
  const db = await openState();
  if (!db) return;
  try {
    const transaction = db.transaction('state', 'readwrite');
    const pending = (await transaction.store.get('pendingWipes') ?? []) as Array<{ userId: string; deviceId: string }>;
    if (!pending.some(item => item.userId === scope.userId && item.deviceId === scope.deviceId)) pending.push(scope);
    await transaction.store.put(pending, 'pendingWipes');
    const saved = await transaction.store.get('saved') as { scopes: PushAccountScope[]; activeUserId: string; activeDeviceId: string } | undefined;
    if (saved) {
      saved.scopes = saved.scopes.filter(item => item.userId !== scope.userId || item.deviceId !== scope.deviceId);
      if (saved.activeUserId === scope.userId && saved.activeDeviceId === scope.deviceId) { saved.activeUserId = ''; saved.activeDeviceId = ''; }
      await transaction.store.put(saved, 'saved');
    }
    await transaction.done;
  } finally { db.close(); }
}

async function readState(key: string): Promise<any> {
  const db = await openState();
  if (!db) return null;
  try { return await db.get('state', key); } finally { db.close(); }
}

async function openState() {
  if (typeof indexedDB === 'undefined') return null;
  return openDB('NivraPushScopes', 1, {
    upgrade(database) { database.createObjectStore('state'); },
  });
}
