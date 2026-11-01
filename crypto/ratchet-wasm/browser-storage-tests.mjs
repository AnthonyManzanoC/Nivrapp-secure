import { EncryptedIndexedDbState } from './indexeddb-state.mjs';
const require = (condition, reason) => { if (!condition) throw Error(reason); };
const reject = async (operation, reason) => {
  let failed = false;
  try { await operation(); } catch { failed = true; }
  require(failed, reason);
};

export async function testBrowserStorage() {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const scope = JSON.stringify(['synthetic-' + crypto.randomUUID(), 'device-1']);
  let first = await EncryptedIndexedDbState.open(key), second = await EncryptedIndexedDbState.open(key);
  const snapshot = { identity: 'synthetic-private-marker', session: 'synthetic-session', outbox: [{ bytes: 'exact-retry-marker' }] };
  try {
    require(await first.read(scope) === null, 'Unknown scope must be absent');
    require(await first.commit(scope, 0, snapshot) === 1, 'Initial revision failed');
    first.close(); first = await EncryptedIndexedDbState.open(key);
    require(JSON.stringify((await first.read(scope)).state) === JSON.stringify(snapshot), 'Reopened snapshot changed');
    const races = await Promise.allSettled([first.commit(scope, 1, { ...snapshot, writer: 1 }), second.commit(scope, 1, { ...snapshot, writer: 2 })]);
    require(races.filter(result => result.status === 'fulfilled').length === 1, 'Concurrent revision accepted twice');
    require((await first.read(scope)).revision === 2, 'Concurrent write revision invalid');
    await reject(() => second.commit(scope, 1, snapshot), 'Stale writer accepted');
    require(await first.read(scope + '-another-device') === null, 'Account/device scopes mixed');
    const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const wrong = await EncryptedIndexedDbState.open(wrongKey);
    try { await reject(() => wrong.read(scope), 'Wrong storage key accepted'); } finally { wrong.close(); }

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('NivraRatchetLab', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const original = await new Promise((resolve, reject) => {
        const transaction = database.transaction('snapshots', 'readonly'), request = transaction.objectStore('snapshots').get(scope);
        request.onsuccess = () => resolve(request.result); transaction.onabort = () => reject(transaction.error);
      });
      const visible = JSON.stringify(original);
      require(!visible.includes('synthetic-private-marker') && !visible.includes('exact-retry-marker'), 'Private state visible in storage');
      for (const alter of [row => { row.ciphertext[0] ^= 1; }, row => { row.revision += 1; }, row => { row.scope = scope + '-copied'; }]) {
        const row = structuredClone(original); alter(row);
        await new Promise((resolve, reject) => {
          const transaction = database.transaction('snapshots', 'readwrite'); transaction.objectStore('snapshots').put(row);
          transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
        });
        await reject(() => first.read(row.scope), 'Altered ciphertext, revision or scope accepted');
      }
    } finally { database.close(); }
  } finally { first.close(); second.close(); }
}
