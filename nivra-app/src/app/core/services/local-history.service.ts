import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { IDBPDatabase, openDB } from 'idb';
import { CallSession, ChatMessageVm, ChatPayload, Contact, Conversation, LocalProfile, Story } from '../models/nivra.models';
import { NativeSecureVaultService } from './native-secure-vault.service';

const LOCAL_DB_NAME = 'NivraDB';
const LOCAL_DB_VERSION = 12;
const NATIVE_SQLITE_DB_NAME = 'nivra_local_vault';
const LOCAL_MESSAGE_STORE = 'messages';
const LOCAL_KEY_STORE = 'deviceKeys';
const LOCAL_PROFILE_STORE = 'profilesStore';
const LOCAL_VAULT_KEY_STORE = 'localVaultKeys';
const LOCAL_CONVERSATION_STORE = 'conversations';
const LOCAL_CONTACT_STORE = 'contacts';
const LOCAL_SYNC_STORE = 'syncWatermarks';
const LOCAL_CALL_STORE = 'calls';
const LOCAL_STORY_STORE = 'stories';
const VIEW_ONCE_DELETE_DELAY_MS = 0;
const LOCAL_PURGE_LIMIT = 500;
const LOCAL_PAYLOAD_VERSION = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface LocalVaultKeyRecord {
  accountKey: string;
  key?: CryptoKey;
  keyEnvelope?: EncryptedLocalVaultKeyEnvelope | null;
  createdAt: string;
}

interface EncryptedLocalVaultKeyEnvelope {
  v: 1;
  alg: 'NIVRA-SECURE-VAULT-A256GCM';
  iv: string;
  ciphertext: string;
}

interface NativeVaultKeyRecord {
  account_key: string;
  raw_key: string;
  created_at: string;
}

interface SyncWatermarkRecord {
  accountKey: string;
  syncedAt: string;
  updatedAt: string;
}

interface EncryptedLocalPayload {
  v: typeof LOCAL_PAYLOAD_VERSION;
  alg: 'A256GCM';
  iv: string;
  ciphertext: string;
}

interface StoredChatMessage extends Omit<ChatMessageVm, 'payload'> {
  key: string;
  accountKey: string;
  payload?: ChatPayload;
  payloadEnvelope?: EncryptedLocalPayload | null;
  expiresAtMs?: number | null;
  openedAtMs?: number | null;
}

interface StoredConversation extends Conversation {
  key: string;
  accountKey: string;
}

interface StoredContact extends Contact {
  key: string;
  accountKey: string;
}

interface StoredProfile extends LocalProfile {
  userId: string;
}

interface StoredCall extends CallSession {
  key: string;
  accountKey: string;
}

interface StoredStory extends Story {
  key: string;
  accountKey: string;
}

interface ConversationMessagesPageOptions {
  before?: string | null;
  beforeId?: string | null;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class LocalHistoryService {
  private readonly secureVault = inject(NativeSecureVaultService);
  private dbPromise?: Promise<IDBPDatabase | null>;
  private sqlitePromise?: Promise<SQLiteDBConnection | null>;

  async conversationMessagesPage(
    accountKey: string,
    conversationId: string,
    options: number | ConversationMessagesPageOptions = 80,
  ): Promise<ChatMessageVm[]> {
    if (!accountKey || !conversationId) {
      return [];
    }
    const page = this.normalizeConversationMessagesPageOptions(options);
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      return this.sqliteConversationMessagesPage(sqlite, accountKey, conversationId, page.limit, page.before, page.beforeId);
    }
    const db = await this.open();
    if (!db) {
      return [];
    }
    const safeLimit = page.limit;
    const store = db.transaction(LOCAL_MESSAGE_STORE, 'readonly').objectStore(LOCAL_MESSAGE_STORE);
    const lower = [accountKey, conversationId, ''];
    const upper = [accountKey, conversationId, page.before || '\uffff'];
    const range = page.before
      ? IDBKeyRange.bound(lower, upper, false, !page.beforeId)
      : IDBKeyRange.bound(lower, upper);
    const records: StoredChatMessage[] = [];
    const now = Date.now();
    let cursor = await store.index('byConversationAt').openCursor(range, 'prev');
    while (cursor && records.length < safeLimit) {
      const record = cursor.value as StoredChatMessage;
      if (page.before && page.beforeId && record.at === page.before && record.id >= page.beforeId) {
        cursor = await cursor.continue();
        continue;
      }
      if (!this.isExpired(record, now)) {
        records.push(record);
      }
      cursor = await cursor.continue();
    }
    const active = await this.activeMessages(accountKey, records);
    return active
      .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime())
      .slice(-safeLimit);
  }

  async messageById(accountKey: string, conversationId: string, messageId: string): Promise<ChatMessageVm | null> {
    if (!accountKey || !conversationId || !messageId) {
      return null;
    }
    const key = this.messageStorageKey(accountKey, conversationId, messageId);
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      const rows = await sqlite.query('SELECT record_json FROM local_messages WHERE key = ? LIMIT 1', [key]);
      const record = this.parseSqliteRecord<StoredChatMessage>(rows.values?.[0]);
      if (!record || this.isExpired(record, Date.now())) {
        return null;
      }
      return this.toChatMessage(accountKey, record);
    }
    const db = await this.open();
    if (!db) {
      return null;
    }
    const record = await db.transaction(LOCAL_MESSAGE_STORE, 'readonly')
      .objectStore(LOCAL_MESSAGE_STORE)
      .get(key) as StoredChatMessage | undefined;
    if (!record || this.isExpired(record, Date.now())) {
      return null;
    }
    return this.toChatMessage(accountKey, record);
  }

  async accountKeysForUser(userId: string): Promise<string[]> {
    if (!userId) {
      return [];
    }
    const keys = new Set<string>([userId]);
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      const rows = await sqlite.query(
        `SELECT account_key FROM local_conversations WHERE account_key = ? OR account_key LIKE ?
         UNION SELECT account_key FROM local_messages WHERE account_key = ? OR account_key LIKE ?
         UNION SELECT account_key FROM local_contacts WHERE account_key = ? OR account_key LIKE ?
         UNION SELECT account_key FROM local_calls WHERE account_key = ? OR account_key LIKE ?`,
        [userId, `${userId}:%`, userId, `${userId}:%`, userId, `${userId}:%`, userId, `${userId}:%`],
      ).catch(() => ({ values: [] as Record<string, unknown>[] }));
      for (const row of rows.values ?? []) {
        const key = row['account_key'];
        if (typeof key === 'string' && key) {
          keys.add(key);
        }
      }
      return [...keys];
    }
    const db = await this.open();
    if (!db) {
      return [...keys];
    }
    for (const storeName of [LOCAL_CONVERSATION_STORE, LOCAL_MESSAGE_STORE, LOCAL_CONTACT_STORE, LOCAL_CALL_STORE]) {
      if (!db.objectStoreNames.contains(storeName)) {
        continue;
      }
      const records = await db.transaction(storeName, 'readonly').objectStore(storeName).getAll() as Array<{ accountKey?: string }>;
      for (const record of records) {
        const key = record.accountKey;
        if (key === userId || key?.startsWith(`${userId}:`)) {
          keys.add(key);
        }
      }
    }
    return [...keys];
  }

  async putMessage(accountKey: string, message: ChatMessageVm): Promise<void> {
    if (!accountKey || !message?.conversationId || !message.id) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      await this.sqlitePutMessage(sqlite, accountKey, message);
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const { payload, ...rest } = message;
    const record: StoredChatMessage = {
      ...rest,
      key: this.messageStorageKey(accountKey, message.conversationId, message.id),
      accountKey,
      payloadEnvelope: await this.encryptPayload(accountKey, payload),
      expiresAtMs: message.expiresAt ? Date.parse(message.expiresAt) || null : null,
      openedAtMs: null,
    };
    await db.transaction(LOCAL_MESSAGE_STORE, 'readwrite').objectStore(LOCAL_MESSAGE_STORE).put(record);
  }

  async putMessages(accountKey: string, messages: ChatMessageVm[]): Promise<void> {
    if (!accountKey || !messages.length) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      for (const message of messages) {
        await this.sqlitePutMessage(sqlite, accountKey, message);
      }
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const store = db.transaction(LOCAL_MESSAGE_STORE, 'readwrite').objectStore(LOCAL_MESSAGE_STORE);
    await Promise.all(messages.map(async (message) => {
      if (!message?.conversationId || !message.id) {
        return;
      }
      const { payload, ...rest } = message;
      const record: StoredChatMessage = {
        ...rest,
        key: this.messageStorageKey(accountKey, message.conversationId, message.id),
        accountKey,
        payloadEnvelope: await this.encryptPayload(accountKey, payload),
        expiresAtMs: message.expiresAt ? Date.parse(message.expiresAt) || null : null,
        openedAtMs: null,
      };
      await store.put(record);
    }));
  }

  async conversations(accountKey: string): Promise<Conversation[]> {
    if (!accountKey) {
      return [];
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      return this.sqliteConversations(sqlite, accountKey);
    }
    const db = await this.open();
    if (!db) {
      return [];
    }
    const records = await db.transaction(LOCAL_CONVERSATION_STORE, 'readonly')
      .objectStore(LOCAL_CONVERSATION_STORE)
      .index('byAccount')
      .getAll(accountKey) as StoredConversation[];
    return records
      .map(({ key: _key, accountKey: _accountKey, ...conversation }) => conversation)
      .sort((left, right) => this.compareConversations(left, right));
  }

  async putConversations(accountKey: string, conversations: Conversation[]): Promise<void> {
    if (!accountKey || !conversations.length) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      for (const conversation of conversations) {
        await sqlite.run(
          `INSERT OR REPLACE INTO local_conversations (key, account_key, id, updated_at, record_json)
           VALUES (?, ?, ?, ?, ?)`,
          [
            this.conversationStorageKey(accountKey, conversation.id),
            accountKey,
            conversation.id,
            conversation.updatedAt || conversation.lastMessageAt || conversation.createdAt || '',
            JSON.stringify({
              ...conversation,
              key: this.conversationStorageKey(accountKey, conversation.id),
              accountKey,
            } satisfies StoredConversation),
          ],
        );
      }
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const store = db.transaction(LOCAL_CONVERSATION_STORE, 'readwrite').objectStore(LOCAL_CONVERSATION_STORE);
    await Promise.all(conversations.map((conversation) => store.put({
      ...conversation,
      key: this.conversationStorageKey(accountKey, conversation.id),
      accountKey,
    } satisfies StoredConversation)));
  }

  async removeConversation(accountKey: string, conversationId: string): Promise<void> {
    if (!accountKey || !conversationId) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      await sqlite.run('DELETE FROM local_conversations WHERE account_key = ? AND id = ?', [accountKey, conversationId]);
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    await db.transaction(LOCAL_CONVERSATION_STORE, 'readwrite')
      .objectStore(LOCAL_CONVERSATION_STORE)
      .delete(this.conversationStorageKey(accountKey, conversationId));
  }

  async contacts(accountKey: string): Promise<Contact[]> {
    if (!accountKey) {
      return [];
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      return this.sqliteContacts(sqlite, accountKey);
    }
    const db = await this.open();
    if (!db) {
      return [];
    }
    const records = await db.transaction(LOCAL_CONTACT_STORE, 'readonly')
      .objectStore(LOCAL_CONTACT_STORE)
      .index('byAccount')
      .getAll(accountKey) as StoredContact[];
    return records
      .map(({ key: _key, accountKey: _accountKey, ...contact }) => contact)
      .sort((left, right) => (left.displayName || left.alias).localeCompare(right.displayName || right.alias));
  }

  async putContacts(accountKey: string, contacts: Contact[]): Promise<void> {
    if (!accountKey || !contacts.length) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      for (const contact of contacts) {
        await sqlite.run(
          `INSERT OR REPLACE INTO local_contacts (key, account_key, user_id, alias, record_json)
           VALUES (?, ?, ?, ?, ?)`,
          [
            this.contactStorageKey(accountKey, contact.userId),
            accountKey,
            contact.userId,
            contact.alias || '',
            JSON.stringify({
              ...contact,
              key: this.contactStorageKey(accountKey, contact.userId),
              accountKey,
            } satisfies StoredContact),
          ],
        );
      }
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const store = db.transaction(LOCAL_CONTACT_STORE, 'readwrite').objectStore(LOCAL_CONTACT_STORE);
    await Promise.all(contacts.map((contact) => store.put({
      ...contact,
      key: this.contactStorageKey(accountKey, contact.userId),
      accountKey,
    } satisfies StoredContact)));
  }

  async profiles(userIds: string[] = []): Promise<LocalProfile[]> {
    const db = await this.open();
    if (!db) {
      return [];
    }
    const ids = [...new Set(userIds.filter(Boolean))];
    const store = db.transaction(LOCAL_PROFILE_STORE, 'readonly').objectStore(LOCAL_PROFILE_STORE);
    if (!ids.length) {
      return await store.getAll() as LocalProfile[];
    }
    const records = await Promise.all(ids.map((userId) => store.get(userId) as Promise<StoredProfile | undefined>));
    return records.filter((record): record is StoredProfile => Boolean(record));
  }

  async putProfiles(profiles: LocalProfile[]): Promise<void> {
    const records = profiles
      .filter((profile): profile is LocalProfile & { userId: string } => Boolean(profile?.userId))
      .map((profile) => ({
        ...profile,
        id: profile.id || profile.userId,
        aliasLower: (profile.alias || '').trim().toLowerCase(),
        cachedAt: new Date().toISOString(),
      } satisfies StoredProfile));
    if (!records.length) {
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const store = db.transaction(LOCAL_PROFILE_STORE, 'readwrite').objectStore(LOCAL_PROFILE_STORE);
    await Promise.all(records.map((profile) => store.put(profile)));
  }

  async calls(accountKey: string): Promise<CallSession[]> {
    if (!accountKey) {
      return [];
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      const rows = await sqlite.query(
        `SELECT record_json FROM local_calls
         WHERE account_key = ?
         ORDER BY started_at DESC
         LIMIT 80`,
        [accountKey],
      ).catch(() => ({ values: [] as Record<string, unknown>[] }));
      return (rows.values ?? [])
        .map((row) => this.parseSqliteRecord<StoredCall>(row))
        .filter((record): record is StoredCall => Boolean(record))
        .map(({ key: _key, accountKey: _accountKey, ...call }) => call);
    }
    const db = await this.open();
    if (!db) {
      return [];
    }
    const records = await db.transaction(LOCAL_CALL_STORE, 'readonly')
      .objectStore(LOCAL_CALL_STORE)
      .index('byAccountStarted')
      .getAll(IDBKeyRange.bound([accountKey, ''], [accountKey, '\uffff'])) as StoredCall[];
    return records
      .map(({ key: _key, accountKey: _accountKey, ...call }) => call)
      .sort((left, right) => Date.parse(right.startedAt || '') - Date.parse(left.startedAt || ''))
      .slice(0, 80);
  }

  async putCalls(accountKey: string, calls: CallSession[]): Promise<void> {
    if (!accountKey || !calls.length) {
      return;
    }
    const records = calls
      .filter((call): call is CallSession & { id: string } => Boolean(call?.id))
      .slice(0, 80);
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      for (const call of records) {
        const record: StoredCall = {
          ...call,
          key: this.callStorageKey(accountKey, call.id),
          accountKey,
        };
        await sqlite.run(
          `INSERT OR REPLACE INTO local_calls (key, account_key, id, started_at, record_json)
           VALUES (?, ?, ?, ?, ?)`,
          [record.key, accountKey, call.id, call.startedAt || '', JSON.stringify(record)],
        );
      }
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const store = db.transaction(LOCAL_CALL_STORE, 'readwrite').objectStore(LOCAL_CALL_STORE);
    await Promise.all(records.map((call) => store.put({
      ...call,
      key: this.callStorageKey(accountKey, call.id),
      accountKey,
    } satisfies StoredCall)));
  }

  async stories(accountKey: string): Promise<Story[]> {
    if (!accountKey) {
      return [];
    }
    const db = await this.open();
    if (!db || !db.objectStoreNames.contains(LOCAL_STORY_STORE)) {
      return [];
    }
    const records = await db.transaction(LOCAL_STORY_STORE, 'readonly')
      .objectStore(LOCAL_STORY_STORE)
      .index('byAccount')
      .getAll(accountKey) as StoredStory[];
    return records
      .map(({ key: _key, accountKey: _accountKey, ...story }) => story)
      .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  }

  async putStories(accountKey: string, stories: Story[]): Promise<void> {
    if (!accountKey || !stories.length) {
      return;
    }
    const db = await this.open();
    if (!db || !db.objectStoreNames.contains(LOCAL_STORY_STORE)) {
      return;
    }
    const store = db.transaction(LOCAL_STORY_STORE, 'readwrite').objectStore(LOCAL_STORY_STORE);
    await Promise.all(stories
      .filter((story): story is Story & { id: string } => Boolean(story?.id))
      .map((story) => store.put({
        ...story,
        targetType: story.targetType ?? (story.targetId ? 'group' : 'contacts'),
        key: this.storyStorageKey(accountKey, story.id),
        accountKey,
      } satisfies StoredStory)));
  }

  async removeMessage(accountKey: string, conversationId: string, messageId: string): Promise<void> {
    if (!accountKey || !conversationId || !messageId) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      await sqlite.run('DELETE FROM local_messages WHERE key = ?', [
        this.messageStorageKey(accountKey, conversationId, messageId),
      ]);
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    await db.transaction(LOCAL_MESSAGE_STORE, 'readwrite')
      .objectStore(LOCAL_MESSAGE_STORE)
      .delete(this.messageStorageKey(accountKey, conversationId, messageId));
  }

  async removeConversationMessages(accountKey: string, conversationId: string): Promise<void> {
    if (!accountKey || !conversationId) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      await sqlite.run('DELETE FROM local_messages WHERE account_key = ? AND conversation_id = ?', [accountKey, conversationId]);
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const readStore = db.transaction(LOCAL_MESSAGE_STORE, 'readonly').objectStore(LOCAL_MESSAGE_STORE);
    const keys = await readStore.index('byConversation').getAllKeys(IDBKeyRange.only([accountKey, conversationId]));
    if (!keys.length) {
      return;
    }
    const writeStore = db.transaction(LOCAL_MESSAGE_STORE, 'readwrite').objectStore(LOCAL_MESSAGE_STORE);
    await Promise.all(keys.map((key) => writeStore.delete(key)));
  }

  async markMessagesOpened(accountKey: string, conversationId: string, messageIds: string[]): Promise<void> {
    const ids = [...new Set(messageIds.filter(Boolean))];
    if (!accountKey || !conversationId || !ids.length) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      const now = Date.now();
      for (const messageId of ids) {
        const key = this.messageStorageKey(accountKey, conversationId, messageId);
        const rows = await sqlite.query('SELECT record_json FROM local_messages WHERE key = ? LIMIT 1', [key]);
        const record = this.parseSqliteRecord<StoredChatMessage>(rows.values?.[0]);
        if (record?.deleteAfterRead && !record.openedAtMs) {
          const next = { ...record, openedAtMs: now };
          await sqlite.run(
            'UPDATE local_messages SET opened_at_ms = ?, record_json = ? WHERE key = ?',
            [now, JSON.stringify(next), key],
          );
        }
      }
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    const now = Date.now();
    const store = db.transaction(LOCAL_MESSAGE_STORE, 'readwrite').objectStore(LOCAL_MESSAGE_STORE);
    await Promise.all(ids.map(async (messageId) => {
      const key = this.messageStorageKey(accountKey, conversationId, messageId);
      const record = await store.get(key) as StoredChatMessage | undefined;
      if (record?.deleteAfterRead && !record.openedAtMs) {
        await store.put({ ...record, openedAtMs: now });
      }
    }));
  }

  async purgeExpired(accountKey: string): Promise<ChatMessageVm[]> {
    if (!accountKey) {
      return [];
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      return this.sqlitePurgeExpired(sqlite, accountKey);
    }
    const db = await this.open();
    if (!db) {
      return [];
    }
    const now = Date.now();
    const store = db.transaction(LOCAL_MESSAGE_STORE, 'readonly').objectStore(LOCAL_MESSAGE_STORE);
    const records = await store.index('byAccount').getAll(accountKey) as StoredChatMessage[];
    const expired = records
      .filter((record) => this.isExpired(record, now))
      .slice(0, LOCAL_PURGE_LIMIT);
    if (!expired.length) {
      return [];
    }
    const writeStore = db.transaction(LOCAL_MESSAGE_STORE, 'readwrite').objectStore(LOCAL_MESSAGE_STORE);
    await Promise.all(expired.map((record) => writeStore.delete(record.key)));
    return (await Promise.all(expired.map((record) => this.toChatMessage(accountKey, record))))
      .filter((message): message is ChatMessageVm => Boolean(message));
  }

  async getSyncWatermark(accountKey: string): Promise<string | null> {
    if (!accountKey) {
      return null;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      const rows = await sqlite.query('SELECT synced_at FROM local_sync_watermarks WHERE account_key = ? LIMIT 1', [accountKey]);
      const value = rows.values?.[0]?.['synced_at'];
      return typeof value === 'string' && value ? value : null;
    }
    const db = await this.open();
    if (!db) {
      return null;
    }
    const record = await db.transaction(LOCAL_SYNC_STORE, 'readonly')
      .objectStore(LOCAL_SYNC_STORE)
      .get(accountKey) as SyncWatermarkRecord | undefined;
    return record?.syncedAt ?? null;
  }

  async setSyncWatermark(accountKey: string, syncedAt: string): Promise<void> {
    if (!accountKey || !syncedAt) {
      return;
    }
    const sqlite = await this.openNativeSqlite();
    if (sqlite) {
      await sqlite.run(
        `INSERT OR REPLACE INTO local_sync_watermarks (account_key, synced_at, updated_at)
         VALUES (?, ?, ?)`,
        [accountKey, syncedAt, new Date().toISOString()],
      );
      return;
    }
    const db = await this.open();
    if (!db) {
      return;
    }
    await db.transaction(LOCAL_SYNC_STORE, 'readwrite')
      .objectStore(LOCAL_SYNC_STORE)
      .put({
        accountKey,
        syncedAt,
        updatedAt: new Date().toISOString(),
      } satisfies SyncWatermarkRecord);
  }

  async wipeAllLocalData(): Promise<void> {
    const db = await this.dbPromise?.catch(() => null);
    db?.close();
    this.dbPromise = undefined;

    const sqlite = await this.sqlitePromise?.catch(() => null);
    if (sqlite) {
      await sqlite.close().catch(() => undefined);
    }
    this.sqlitePromise = undefined;

    await Promise.all([
      this.deleteIndexedDatabases(),
      this.deleteNativeSqliteDatabase(),
    ]);
    await this.secureVault.clearSecret('local-db').catch(() => undefined);
  }

  private async open(): Promise<IDBPDatabase | null> {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      return null;
    }
    this.dbPromise ??= openDB(LOCAL_DB_NAME, LOCAL_DB_VERSION, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        const messageStore = db.objectStoreNames.contains(LOCAL_MESSAGE_STORE)
          ? transaction.objectStore(LOCAL_MESSAGE_STORE)
          : db.createObjectStore(LOCAL_MESSAGE_STORE, { keyPath: 'key' });
        if (!messageStore.indexNames.contains('byAccount')) {
          messageStore.createIndex('byAccount', 'accountKey');
        }
        if (!messageStore.indexNames.contains('byConversation')) {
          messageStore.createIndex('byConversation', ['accountKey', 'conversationId']);
        }
        if (!messageStore.indexNames.contains('byConversationAt')) {
          messageStore.createIndex('byConversationAt', ['accountKey', 'conversationId', 'at']);
        }
        if (!messageStore.indexNames.contains('byExpiry')) {
          messageStore.createIndex('byExpiry', 'expiresAtMs');
        }
        if (!messageStore.indexNames.contains('byAccountExpiry')) {
          messageStore.createIndex('byAccountExpiry', ['accountKey', 'expiresAtMs']);
        }
        if (!messageStore.indexNames.contains('byAccountOpenedAt')) {
          messageStore.createIndex('byAccountOpenedAt', ['accountKey', 'openedAtMs']);
        }

        const localVaultKeyStore = db.objectStoreNames.contains(LOCAL_VAULT_KEY_STORE)
          ? transaction.objectStore(LOCAL_VAULT_KEY_STORE)
          : db.createObjectStore(LOCAL_VAULT_KEY_STORE, { keyPath: 'accountKey' });
        if (!localVaultKeyStore.indexNames.contains('byCreated')) {
          localVaultKeyStore.createIndex('byCreated', 'createdAt');
        }

        const conversationStore = db.objectStoreNames.contains(LOCAL_CONVERSATION_STORE)
          ? transaction.objectStore(LOCAL_CONVERSATION_STORE)
          : db.createObjectStore(LOCAL_CONVERSATION_STORE, { keyPath: 'key' });
        if (!conversationStore.indexNames.contains('byAccount')) {
          conversationStore.createIndex('byAccount', 'accountKey');
        }
        if (!conversationStore.indexNames.contains('byAccountUpdated')) {
          conversationStore.createIndex('byAccountUpdated', ['accountKey', 'updatedAt']);
        }
        if (!conversationStore.indexNames.contains('byAccountType')) {
          conversationStore.createIndex('byAccountType', ['accountKey', 'type']);
        }

        const contactStore = db.objectStoreNames.contains(LOCAL_CONTACT_STORE)
          ? transaction.objectStore(LOCAL_CONTACT_STORE)
          : db.createObjectStore(LOCAL_CONTACT_STORE, { keyPath: 'key' });
        if (!contactStore.indexNames.contains('byAccount')) {
          contactStore.createIndex('byAccount', 'accountKey');
        }
        if (!contactStore.indexNames.contains('byAccountAlias')) {
          contactStore.createIndex('byAccountAlias', ['accountKey', 'alias']);
        }

        const syncStore = db.objectStoreNames.contains(LOCAL_SYNC_STORE)
          ? transaction.objectStore(LOCAL_SYNC_STORE)
          : db.createObjectStore(LOCAL_SYNC_STORE, { keyPath: 'accountKey' });
        if (!syncStore.indexNames.contains('byUpdated')) {
          syncStore.createIndex('byUpdated', 'updatedAt');
        }

        const callStore = db.objectStoreNames.contains(LOCAL_CALL_STORE)
          ? transaction.objectStore(LOCAL_CALL_STORE)
          : db.createObjectStore(LOCAL_CALL_STORE, { keyPath: 'key' });
        if (!callStore.indexNames.contains('byAccount')) {
          callStore.createIndex('byAccount', 'accountKey');
        }
        if (!callStore.indexNames.contains('byAccountStarted')) {
          callStore.createIndex('byAccountStarted', ['accountKey', 'startedAt']);
        }

        const storyStore = db.objectStoreNames.contains(LOCAL_STORY_STORE)
          ? transaction.objectStore(LOCAL_STORY_STORE)
          : db.createObjectStore(LOCAL_STORY_STORE, { keyPath: 'key' });
        if (!storyStore.indexNames.contains('byAccount')) {
          storyStore.createIndex('byAccount', 'accountKey');
        }
        if (!storyStore.indexNames.contains('byAccountTarget')) {
          storyStore.createIndex('byAccountTarget', ['accountKey', 'targetType', 'targetId']);
        }
        if (!storyStore.indexNames.contains('byAccountExpires')) {
          storyStore.createIndex('byAccountExpires', ['accountKey', 'expiresAt']);
        }

        const keyStore = db.objectStoreNames.contains(LOCAL_KEY_STORE)
          ? transaction.objectStore(LOCAL_KEY_STORE)
          : db.createObjectStore(LOCAL_KEY_STORE, { keyPath: 'id' });
        if (!keyStore.indexNames.contains('byAlias')) {
          keyStore.createIndex('byAlias', 'aliasLower');
        }
        if (!keyStore.indexNames.contains('byUser')) {
          keyStore.createIndex('byUser', 'userId');
        }
        if (!keyStore.indexNames.contains('byUpdated')) {
          keyStore.createIndex('byUpdated', 'updatedAt');
        }

        const profileStore = db.objectStoreNames.contains(LOCAL_PROFILE_STORE)
          ? transaction.objectStore(LOCAL_PROFILE_STORE)
          : db.createObjectStore(LOCAL_PROFILE_STORE, { keyPath: 'userId' });
        if (!profileStore.indexNames.contains('byAlias')) {
          profileStore.createIndex('byAlias', 'aliasLower');
        }
        if (!profileStore.indexNames.contains('byUpdated')) {
          profileStore.createIndex('byUpdated', 'updatedAt');
        }
      },
    }).catch(() => null);
    return this.dbPromise;
  }

  private async openNativeSqlite(): Promise<SQLiteDBConnection | null> {
    if (!this.shouldUseNativeSqlite()) {
      return null;
    }
    this.sqlitePromise ??= this.createNativeSqliteConnection();
    return this.sqlitePromise;
  }

  private async deleteIndexedDatabases(): Promise<void> {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      return;
    }

    const indexedDb = window.indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string | null }>>;
    };
    const names = typeof indexedDb.databases === 'function'
      ? (await indexedDb.databases()).map((database) => database.name).filter((name): name is string => Boolean(name))
      : [LOCAL_DB_NAME];

    await Promise.all([...new Set(names)].map((name) => this.deleteIndexedDatabase(name)));
  }

  private deleteIndexedDatabase(name: string): Promise<void> {
    return new Promise((resolve) => {
      const request = window.indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }

  private async deleteNativeSqliteDatabase(): Promise<void> {
    if (!this.shouldUseNativeSqlite()) {
      return;
    }

    try {
      const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
      const connection = new SQLiteConnection(CapacitorSQLite);
      await connection.clearEncryptionSecret().catch(() => undefined);
      const api = connection as unknown as {
        deleteDatabase?: (database: string, readOnly: boolean) => Promise<void>;
      };
      if (api.deleteDatabase) {
        await api.deleteDatabase(NATIVE_SQLITE_DB_NAME, false).catch(() => undefined);
        return;
      }

      const bridge = CapacitorSQLite as unknown as {
        deleteDatabase?: (options: { database: string; readonly?: boolean }) => Promise<void>;
      };
      await bridge.deleteDatabase?.({ database: NATIVE_SQLITE_DB_NAME, readonly: false }).catch(() => undefined);
    } catch {
      // Best-effort: web builds and unsupported native bridges have no SQLite database to remove.
    }
  }

  private shouldUseNativeSqlite(): boolean {
    return typeof window !== 'undefined' && Capacitor.isNativePlatform();
  }

  private async createNativeSqliteConnection(): Promise<SQLiteDBConnection | null> {
    try {
      const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
      const sqlite = new SQLiteConnection(CapacitorSQLite);
      const sqliteApi = sqlite as unknown as {
        closeConnection?: (database: string, readonly: boolean) => Promise<void>;
        deleteDatabase?: (database: string, readonly: boolean) => Promise<void>;
      };
      const existing = await sqlite.isConnection(NATIVE_SQLITE_DB_NAME, false).catch(() => ({ result: false }));
      let db = existing.result
        ? await sqlite.retrieveConnection(NATIVE_SQLITE_DB_NAME, false)
        : await this.createEncryptedNativeConnection(sqlite);
      try {
        await this.withNativeSqliteSecret(sqlite, () => db.open());
      } catch {
        await sqliteApi.closeConnection?.(NATIVE_SQLITE_DB_NAME, false).catch(() => undefined);
        await sqliteApi.deleteDatabase?.(NATIVE_SQLITE_DB_NAME, false).catch(() => undefined);
        db = await this.createEncryptedNativeConnection(sqlite);
        await this.withNativeSqliteSecret(sqlite, () => db.open());
      }
      await db.execute(`
        CREATE TABLE IF NOT EXISTS local_messages (
          key TEXT PRIMARY KEY NOT NULL,
          account_key TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          id TEXT NOT NULL,
          at TEXT NOT NULL,
          expires_at_ms INTEGER,
          opened_at_ms INTEGER,
          delete_after_read INTEGER NOT NULL DEFAULT 0,
          record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_local_messages_account ON local_messages(account_key);
        CREATE INDEX IF NOT EXISTS idx_local_messages_conversation ON local_messages(account_key, conversation_id, at);
        CREATE INDEX IF NOT EXISTS idx_local_messages_expiry ON local_messages(account_key, expires_at_ms);

        CREATE TABLE IF NOT EXISTS local_conversations (
          key TEXT PRIMARY KEY NOT NULL,
          account_key TEXT NOT NULL,
          id TEXT NOT NULL,
          updated_at TEXT,
          record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_local_conversations_account ON local_conversations(account_key, updated_at);

        CREATE TABLE IF NOT EXISTS local_contacts (
          key TEXT PRIMARY KEY NOT NULL,
          account_key TEXT NOT NULL,
          user_id TEXT NOT NULL,
          alias TEXT,
          record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_local_contacts_account ON local_contacts(account_key, alias);

        CREATE TABLE IF NOT EXISTS local_sync_watermarks (
          account_key TEXT PRIMARY KEY NOT NULL,
          synced_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS local_calls (
          key TEXT PRIMARY KEY NOT NULL,
          account_key TEXT NOT NULL,
          id TEXT NOT NULL,
          started_at TEXT,
          record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_local_calls_account ON local_calls(account_key, started_at);

        CREATE TABLE IF NOT EXISTS local_vault_keys (
          account_key TEXT PRIMARY KEY NOT NULL,
          raw_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      await sqlite.clearEncryptionSecret().catch(() => undefined);
      return db;
    } catch {
      return null;
    }
  }

  private async createEncryptedNativeConnection(sqlite: {
    createConnection: (
      database: string,
      encrypted: boolean,
      mode: string,
      version: number,
      readonly: boolean,
    ) => Promise<SQLiteDBConnection>;
    closeConnection?: (database: string, readonly: boolean) => Promise<void>;
    deleteDatabase?: (database: string, readonly: boolean) => Promise<void>;
    clearEncryptionSecret?: () => Promise<void>;
    setEncryptionSecret?: (passphrase: string) => Promise<void>;
  }): Promise<SQLiteDBConnection> {
    try {
      await this.prepareNativeSqliteSecret(sqlite);
      return await sqlite.createConnection(NATIVE_SQLITE_DB_NAME, true, 'secret', 1, false);
    } catch (secretError) {
      await sqlite.closeConnection?.(NATIVE_SQLITE_DB_NAME, false).catch(() => undefined);
      try {
        await this.prepareNativeSqliteSecret(sqlite);
        return await sqlite.createConnection(NATIVE_SQLITE_DB_NAME, true, 'encryption', 1, false);
      } catch {
        await sqlite.closeConnection?.(NATIVE_SQLITE_DB_NAME, false).catch(() => undefined);
        await sqlite.deleteDatabase?.(NATIVE_SQLITE_DB_NAME, false).catch(() => undefined);
        await this.prepareNativeSqliteSecret(sqlite);
        return sqlite.createConnection(NATIVE_SQLITE_DB_NAME, true, 'secret', 1, false);
      } finally {
        void secretError;
      }
    }
  }

  private async withNativeSqliteSecret<T>(
    sqlite: {
      clearEncryptionSecret?: () => Promise<void>;
      setEncryptionSecret?: (passphrase: string) => Promise<void>;
    },
    action: () => Promise<T>,
  ): Promise<T> {
    await this.prepareNativeSqliteSecret(sqlite);
    try {
      return await action();
    } finally {
      await sqlite.clearEncryptionSecret?.().catch(() => undefined);
    }
  }

  private async prepareNativeSqliteSecret(sqlite: {
    clearEncryptionSecret?: () => Promise<void>;
    setEncryptionSecret?: (passphrase: string) => Promise<void>;
  }): Promise<void> {
    const secret = await this.secureVault.getOrCreateSecret('local-db');
    if (!secret) {
      throw new Error('No se pudo abrir el secreto local de SQLite.');
    }
    await sqlite.clearEncryptionSecret?.().catch(() => undefined);
    await sqlite.setEncryptionSecret?.(secret);
  }

  private async sqliteConversationMessagesPage(
    sqlite: SQLiteDBConnection,
    accountKey: string,
    conversationId: string,
    limit: number,
    before: string | null = null,
    beforeId: string | null = null,
  ): Promise<ChatMessageVm[]> {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 80, 160));
    const params: Array<string | number> = [accountKey, conversationId];
    const beforeClause = before
      ? beforeId ? 'AND (at < ? OR (at = ? AND id < ?))' : 'AND at < ?'
      : '';
    if (before && beforeId) {
      params.push(before, before, beforeId);
    } else if (before) {
      params.push(before);
    }
    params.push(safeLimit);
    const rows = await sqlite.query(
      `SELECT record_json FROM local_messages
       WHERE account_key = ? AND conversation_id = ?
       ${beforeClause}
       ORDER BY at DESC
       LIMIT ?`,
      params,
    );
    const records = (rows.values ?? [])
      .map((row) => this.parseSqliteRecord<StoredChatMessage>(row))
      .filter((record): record is StoredChatMessage => Boolean(record));
    const active = await this.activeMessages(accountKey, records);
    return active
      .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime())
      .slice(-safeLimit);
  }

  private normalizeConversationMessagesPageOptions(
    options: number | ConversationMessagesPageOptions,
  ): { before: string | null; beforeId: string | null; limit: number } {
    const rawLimit = typeof options === 'number' ? options : options.limit;
    const before = typeof options === 'number' ? null : options.before;
    const beforeId = typeof options === 'number' ? null : options.beforeId;
    return {
      before: typeof before === 'string' && before ? before : null,
      beforeId: typeof beforeId === 'string' && beforeId ? beforeId : null,
      limit: Math.max(1, Math.min(Number(rawLimit) || 80, 160)),
    };
  }

  private async sqlitePutMessage(sqlite: SQLiteDBConnection, accountKey: string, message: ChatMessageVm): Promise<void> {
    if (!message?.conversationId || !message.id) {
      return;
    }
    const { payload, ...rest } = message;
    const record: StoredChatMessage = {
      ...rest,
      key: this.messageStorageKey(accountKey, message.conversationId, message.id),
      accountKey,
      payloadEnvelope: await this.encryptPayload(accountKey, payload),
      expiresAtMs: message.expiresAt ? Date.parse(message.expiresAt) || null : null,
      openedAtMs: null,
    };
    await sqlite.run(
      `INSERT OR REPLACE INTO local_messages
       (key, account_key, conversation_id, id, at, expires_at_ms, opened_at_ms, delete_after_read, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.key,
        accountKey,
        message.conversationId,
        message.id,
        message.at,
        record.expiresAtMs ?? null,
        record.openedAtMs ?? null,
        record.deleteAfterRead ? 1 : 0,
        JSON.stringify(record),
      ],
    );
  }

  private async sqliteConversations(sqlite: SQLiteDBConnection, accountKey: string): Promise<Conversation[]> {
    const rows = await sqlite.query(
      `SELECT record_json FROM local_conversations
       WHERE account_key = ?
       ORDER BY updated_at DESC`,
      [accountKey],
    );
    return (rows.values ?? [])
      .map((row) => this.parseSqliteRecord<StoredConversation>(row))
      .filter((record): record is StoredConversation => Boolean(record))
      .map(({ key: _key, accountKey: _accountKey, ...conversation }) => conversation)
      .sort((left, right) => this.compareConversations(left, right));
  }

  private async sqliteContacts(sqlite: SQLiteDBConnection, accountKey: string): Promise<Contact[]> {
    const rows = await sqlite.query(
      `SELECT record_json FROM local_contacts
       WHERE account_key = ?
       ORDER BY alias ASC`,
      [accountKey],
    );
    return (rows.values ?? [])
      .map((row) => this.parseSqliteRecord<StoredContact>(row))
      .filter((record): record is StoredContact => Boolean(record))
      .map(({ key: _key, accountKey: _accountKey, ...contact }) => contact)
      .sort((left, right) => (left.displayName || left.alias).localeCompare(right.displayName || right.alias));
  }

  private async sqlitePurgeExpired(sqlite: SQLiteDBConnection, accountKey: string): Promise<ChatMessageVm[]> {
    const rows = await sqlite.query('SELECT key, record_json FROM local_messages WHERE account_key = ?', [accountKey]);
    const now = Date.now();
    const expired = (rows.values ?? [])
      .map((row) => this.parseSqliteRecord<StoredChatMessage>(row))
      .filter((record): record is StoredChatMessage => Boolean(record))
      .filter((record) => this.isExpired(record, now))
      .slice(0, LOCAL_PURGE_LIMIT);
    for (const record of expired) {
      await sqlite.run('DELETE FROM local_messages WHERE key = ?', [record.key]);
    }
    return (await Promise.all(expired.map((record) => this.toChatMessage(accountKey, record))))
      .filter((message): message is ChatMessageVm => Boolean(message));
  }

  private parseSqliteRecord<T>(row: unknown): T | null {
    const recordJson = row && typeof row === 'object' ? (row as Record<string, unknown>)['record_json'] : null;
    if (typeof recordJson !== 'string') {
      return null;
    }
    try {
      return JSON.parse(recordJson) as T;
    } catch {
      return null;
    }
  }

  private async activeMessages(accountKey: string, records: StoredChatMessage[]): Promise<ChatMessageVm[]> {
    const now = Date.now();
    const active = (records ?? [])
      .filter((record) => !this.isExpired(record, now))
      .map((record) => this.toChatMessage(accountKey, record));
    return (await Promise.all(active))
      .filter((message): message is ChatMessageVm => Boolean(message?.id && message.conversationId && message.payload));
  }

  private async toChatMessage(accountKey: string, record: StoredChatMessage): Promise<ChatMessageVm | null> {
    const {
      key: _key,
      accountKey: _accountKey,
      expiresAtMs: _expiresAtMs,
      openedAtMs: _openedAtMs,
      payload: legacyPayload,
      payloadEnvelope,
      ...message
    } = record;
    if (legacyPayload) {
      return { ...message, payload: legacyPayload };
    }
    if (!payloadEnvelope) {
      return null;
    }
    try {
      return { ...message, payload: await this.decryptPayload(accountKey, payloadEnvelope) };
    } catch {
      return {
        ...message,
        payload: {
          type: 'system',
          title: 'Mensaje protegido',
          text: 'No se pudo abrir la copia local cifrada.',
        },
        decryptError: true,
      };
    }
  }

  private isExpired(record: StoredChatMessage, now: number): boolean {
    const expiresAtMs = Number(record.expiresAtMs || 0);
    if (expiresAtMs && expiresAtMs <= now) {
      return true;
    }
    const openedAtMs = Number(record.openedAtMs || 0);
    return Boolean(record.deleteAfterRead && openedAtMs && now - openedAtMs > VIEW_ONCE_DELETE_DELAY_MS);
  }

  private messageStorageKey(accountKey: string, conversationId: string, messageId: string): string {
    return `${accountKey}:${conversationId}:${messageId}`;
  }

  private conversationStorageKey(accountKey: string, conversationId: string): string {
    return `${accountKey}:${conversationId}`;
  }

  private contactStorageKey(accountKey: string, userId: string): string {
    return `${accountKey}:${userId}`;
  }

  private callStorageKey(accountKey: string, callId: string): string {
    return `${accountKey}:${callId}`;
  }

  private storyStorageKey(accountKey: string, storyId: string): string {
    return `${accountKey}:${storyId}`;
  }

  private async encryptPayload(accountKey: string, payload: ChatPayload): Promise<EncryptedLocalPayload> {
    const key = await this.localVaultKey(accountKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      textEncoder.encode(JSON.stringify(payload)),
    );
    return {
      v: LOCAL_PAYLOAD_VERSION,
      alg: 'A256GCM',
      iv: this.b64(iv),
      ciphertext: this.b64(new Uint8Array(ciphertext)),
    };
  }

  private async decryptPayload(accountKey: string, payload: EncryptedLocalPayload): Promise<ChatPayload> {
    const key = await this.localVaultKey(accountKey);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.ub64Buffer(payload.iv) },
      key,
      this.ub64Buffer(payload.ciphertext),
    );
    return JSON.parse(textDecoder.decode(plain)) as ChatPayload;
  }

  private async localVaultKey(accountKey: string): Promise<CryptoKey> {
    const nativeKey = await this.nativeLocalVaultKey(accountKey);
    if (nativeKey) {
      return nativeKey;
    }
    const db = await this.open();
    if (!db) {
      throw new Error('IndexedDB no esta disponible.');
    }
    const store = db.transaction(LOCAL_VAULT_KEY_STORE, 'readwrite').objectStore(LOCAL_VAULT_KEY_STORE);
    const existing = await store.get(accountKey) as LocalVaultKeyRecord | undefined;
    const protectedKey = await this.unprotectLocalVaultKey(existing);
    if (protectedKey) {
      return protectedKey;
    }
    if (existing?.key) {
      return existing.key;
    }
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const keyEnvelope = await this.protectLocalVaultRawKey(raw);
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    await store.put({
      accountKey,
      key: keyEnvelope ? undefined : key,
      keyEnvelope,
      createdAt: new Date().toISOString(),
    } satisfies LocalVaultKeyRecord);
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  private async nativeLocalVaultKey(accountKey: string): Promise<CryptoKey | null> {
    const sqlite = await this.openNativeSqlite();
    if (!sqlite) {
      return null;
    }
    const rows = await sqlite.query(
      'SELECT raw_key, created_at FROM local_vault_keys WHERE account_key = ? LIMIT 1',
      [accountKey],
    );
    const existing = rows.values?.[0] as NativeVaultKeyRecord | undefined;
    if (typeof existing?.raw_key === 'string' && existing.raw_key) {
      return crypto.subtle.importKey('raw', this.ub64Buffer(existing.raw_key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    await sqlite.run(
      'INSERT OR REPLACE INTO local_vault_keys (account_key, raw_key, created_at) VALUES (?, ?, ?)',
      [accountKey, this.b64(raw), new Date().toISOString()],
    );
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  private async protectLocalVaultRawKey(raw: Uint8Array): Promise<EncryptedLocalVaultKeyEnvelope | null> {
    const secret = await this.secureVault.getOrCreateSecret('local-db').catch(() => null);
    if (!secret) {
      if (this.secureVault.requiresProtection()) {
        throw new Error('No se pudo abrir el protector seguro del historial local.');
      }
      return null;
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', this.ub64Buffer(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, this.bytesBuffer(raw));
    return {
      v: 1,
      alg: 'NIVRA-SECURE-VAULT-A256GCM',
      iv: this.b64(iv),
      ciphertext: this.b64(new Uint8Array(ciphertext)),
    };
  }

  private async unprotectLocalVaultKey(record?: LocalVaultKeyRecord | null): Promise<CryptoKey | null> {
    if (!record?.keyEnvelope) {
      return null;
    }
    const secret = await this.secureVault.getOrCreateSecret('local-db').catch(() => null);
    if (!secret) {
      return null;
    }
    try {
      const key = await crypto.subtle.importKey('raw', this.ub64Buffer(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.ub64Buffer(record.keyEnvelope.iv) },
        key,
        this.ub64Buffer(record.keyEnvelope.ciphertext),
      );
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    } catch {
      return null;
    }
  }

  private compareConversations(left: Conversation, right: Conversation): number {
    const leftPinned = Boolean(left.pinnedAt || left.isPinned);
    const rightPinned = Boolean(right.pinnedAt || right.isPinned);
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }
    if (leftPinned && rightPinned) {
      const leftPinnedAt = Date.parse(left.pinnedAt || '') || 0;
      const rightPinnedAt = Date.parse(right.pinnedAt || '') || 0;
      if (leftPinnedAt !== rightPinnedAt) {
        return rightPinnedAt - leftPinnedAt;
      }
    }
    const leftAt = left.lastMessageAt || left.updatedAt || left.createdAt;
    const rightAt = right.lastMessageAt || right.updatedAt || right.createdAt;
    return new Date(rightAt).getTime() - new Date(leftAt).getTime();
  }

  private b64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  private ub64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private ub64Buffer(value: string): ArrayBuffer {
    const bytes = this.ub64(value);
    return this.bytesBuffer(bytes);
  }

  private bytesBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
