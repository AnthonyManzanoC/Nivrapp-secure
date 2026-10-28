const PREFIX = 'nivra.privateChats.v1:';
const MAX_CHATS = 1000;
export const privateChatLockStorageKey = (userId: string): string => PREFIX + encodeURIComponent(userId);

/** Local routing metadata only. '*' means an unreadable policy: hide content. */
export function readPrivateChatLocks(userId: string): readonly string[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(privateChatLockStorageKey(userId));
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (value?.v !== 1 || value.userId !== userId || !Array.isArray(value.ids) || value.ids.length > MAX_CHATS
      || value.ids.some((id: unknown) => typeof id !== 'string' || !id || id.length > 128 || id === '*')) return ['*'];
    return [...new Set<string>(value.ids)];
  } catch { return ['*']; }
}

export function writePrivateChatLocks(userId: string, ids: readonly string[]): void {
  if (!userId || ids.length > MAX_CHATS || ids.some(id => !id || id.length > 128 || id === '*')) throw new Error('No se pudo guardar la protección del chat.');
  localStorage.setItem(privateChatLockStorageKey(userId), JSON.stringify({ v: 1, userId, ids: [...new Set(ids)] }));
}
