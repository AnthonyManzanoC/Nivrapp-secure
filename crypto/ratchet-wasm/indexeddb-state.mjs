// Experimental encrypted snapshot adapter. The caller supplies a stable key
// from outside this database. It is not yet wired to the WASM session engine.
const DATABASE = 'NivraRatchetLab', STORE = 'snapshots', LIMIT = 32 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const aad = (scope, revision) => encoder.encode(JSON.stringify(['NIVRA-WASM-STATE-1', scope, revision]));
function scopeCheck(scope) {
  if (typeof scope !== 'string' || !scope || scope.length > 512) throw Error('Invalid account/device scope');
}
function revisionCheck(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw Error('Invalid state revision');
}
function transactionResult(transaction, request) {
  return new Promise((resolve, reject) => {
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(Error('State transaction aborted'));
    transaction.onerror = () => {}; // onabort reports the final outcome.
  });
}

export class EncryptedIndexedDbState {
  #db;
  #key;
  constructor(database, key) { this.#db = database; this.#key = key; }

  static async open(key) {
    if (key?.type !== 'secret' || key.algorithm?.name !== 'AES-GCM' || key.algorithm.length !== 256
        || key.extractable || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) {
      throw Error('An external non-extractable AES-256-GCM key is required');
    }
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      let rejected = false;
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'scope' });
      request.onerror = () => reject(Error('Cannot open laboratory state database'));
      request.onblocked = () => { rejected = true; reject(Error('State database upgrade blocked')); };
      request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
    });
    database.onversionchange = () => database.close();
    return new EncryptedIndexedDbState(database, key);
  }

  async read(scope) {
    scopeCheck(scope); this.#assertOpen();
    const key = this.#key;
    const transaction = this.#db.transaction(STORE, 'readonly');
    const row = await transactionResult(transaction, transaction.objectStore(STORE).get(scope));
    if (!row) return null;
    revisionCheck(row.revision);
    if (row.revision < 1 || row.scope !== scope || !(row.nonce instanceof Uint8Array) || row.nonce.length !== 12
        || !(row.ciphertext instanceof Uint8Array) || row.ciphertext.length < 16 || row.ciphertext.length > LIMIT + 16) throw Error('Invalid stored state envelope');
    let plain;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.nonce, additionalData: aad(scope, row.revision), tagLength: 128 }, key, row.ciphertext));
      return { revision: row.revision, state: JSON.parse(decoder.decode(plain)) };
    } finally { plain?.fill(0); }
  }

  async commit(scope, expectedRevision, state) {
    scopeCheck(scope); revisionCheck(expectedRevision); this.#assertOpen();
    const key = this.#key, database = this.#db;
    const serialized = JSON.stringify(state);
    if (typeof serialized !== 'string') throw Error('State must be JSON');
    const plain = encoder.encode(serialized);
    if (plain.length > LIMIT) { plain.fill(0); throw Error('State storage limit reached'); }
    const revision = expectedRevision + 1, nonce = crypto.getRandomValues(new Uint8Array(12));
    let ciphertext;
    try {
      ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(scope, revision), tagLength: 128 }, key, plain));
    } finally { plain.fill(0); }
    // Finish WebCrypto before opening IDB's transaction. Never await inside it.
    // The read/compare/write below is serialized across tabs by IndexedDB.
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
      let conflict = false;
      const store = transaction.objectStore(STORE), request = store.get(scope);
      request.onsuccess = () => {
        if ((request.result?.revision ?? 0) !== expectedRevision) { conflict = true; transaction.abort(); return; }
        store.put({ scope, revision, nonce, ciphertext });
      };
      transaction.oncomplete = () => resolve(revision);
      transaction.onabort = () => reject(Error(conflict ? 'Stale ratchet state: reopen before retrying' : 'State transaction aborted'));
      transaction.onerror = () => {};
    });
  }
  close() { this.#db?.close(); this.#db = null; this.#key = null; }
  #assertOpen() { if (!this.#db || !this.#key) throw Error('State database is closed'); }
}
