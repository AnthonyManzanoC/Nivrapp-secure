import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const LIMIT = 32 * 1024 * 1024;
const aad = (scope, revision) => Buffer.from(JSON.stringify(['NIVRA-PILOT-STATE-1', scope, revision]));

/** Laboratory adapter, not SQLCipher or a production key vault. The caller must
 * supply a stable 256-bit key from outside this database and close the adapter. */
export class EncryptedPilotState {
  #db;
  #key;
  constructor(filename, key) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error('A 256-bit external storage key is required');
    this.#key = Buffer.from(key);
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS ratchet_state (
        scope TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
        nonce BLOB NOT NULL CHECK(length(nonce)=12), ciphertext BLOB NOT NULL,
        tag BLOB NOT NULL CHECK(length(tag)=16));`);
  }
  read(scope) {
    this.#assertScope(scope);
    const row = this.#db.prepare('SELECT revision, nonce, ciphertext, tag FROM ratchet_state WHERE scope=?').get(scope);
    if (!row) return null;
    if (row.ciphertext.length > LIMIT || !Number.isSafeInteger(row.revision)) throw new Error('Invalid stored ratchet state');
    const cipher = createDecipheriv('aes-256-gcm', this.#key, row.nonce);
    cipher.setAAD(aad(scope, row.revision));
    cipher.setAuthTag(row.tag);
    let plain;
    try {
      plain = Buffer.concat([cipher.update(row.ciphertext), cipher.final()]);
      return { revision: row.revision, state: JSON.parse(plain.toString('utf8')) };
    } finally { plain?.fill(0); }
  }
  commit(scope, expectedRevision, state) {
    this.#assertScope(scope);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid revision');
    const plain = Buffer.from(JSON.stringify(state));
    try {
      if (plain.length > LIMIT) throw new Error('Pilot state storage limit reached');
      const revision = expectedRevision + 1;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
      cipher.setAAD(aad(scope, revision));
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.#db.prepare('SELECT revision FROM ratchet_state WHERE scope=?').get(scope);
        if ((current?.revision ?? 0) !== expectedRevision) throw new Error('Stale ratchet state: reopen before retrying');
        this.#db.prepare(`INSERT INTO ratchet_state(scope,revision,nonce,ciphertext,tag) VALUES(?,?,?,?,?)
          ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, nonce=excluded.nonce,
          ciphertext=excluded.ciphertext, tag=excluded.tag`).run(scope, revision, nonce, ciphertext, tag);
        this.#db.exec('COMMIT');
        return revision;
      } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    } finally { plain.fill(0); }
  }
  close() { this.#db.close(); this.#key.fill(0); }
  #assertScope(scope) {
    if (typeof scope !== 'string' || !scope || scope.length > 512) throw new Error('Invalid account/device scope');
  }
}
