package com.nivra.app;

import android.content.Context;
import android.database.Cursor;
import android.system.Os;
import android.system.OsConstants;

import com.getcapacitor.community.database.sqlite.SQLite.UtilsSecret;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

import net.zetetic.database.sqlcipher.SQLiteDatabase;
import net.zetetic.database.sqlcipher.SQLiteStatement;

/** One fixed, app-private database; no path, key or record crosses the JS bridge. */
final class LegacyHistoryMigration {
    static final String DATABASE = "nivra_local_vaultSQLite.db";
    private static final Object LOCK = new Object();
    private static final String BACKUP = ".legacy-plaintext-backup";
    private static final String STAGING = ".legacy-encrypted-staging";

    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }

    static boolean pending(File database) {
        return new File(database.getPath() + BACKUP).isFile();
    }

    static void clearTemporaryFiles(Context context) throws Exception {
        synchronized (LOCK) {
            File original = context.getDatabasePath(DATABASE);
            deleteTemporaryDatabase(new File(original.getPath() + STAGING));
            deleteTemporaryDatabase(new File(original.getPath() + BACKUP));
            if (original.getParentFile().isDirectory()) syncDirectory(original.getParentFile());
        }
    }

    static void migrate(Context context) throws Failure {
        migrate(context, step -> { });
    }

    // Package-private fault injection is used by isolated instrumentation. It
    // cannot be selected or configured through the Capacitor bridge.
    interface Checkpoint { void reached(String step) throws Exception; }

    static void migrate(Context context, Checkpoint checkpoint) throws Failure {
        synchronized (LOCK) {
            File original = context.getDatabasePath(DATABASE);
            File backup = new File(original.getPath() + BACKUP);
            File staging = new File(original.getPath() + STAGING);
            String phase = "NIVRA_HISTORY_MIGRATION_PREPARE_FAILED";
            try {
                // Read ONLY the already retained SQLCipher secret. A missing or
                // inaccessible protector must never produce a replacement key.
                String secret;
                try { secret = UtilsSecret.getPassphrase(); }
                catch (Exception unavailable) { throw new Failure("NIVRA_HISTORY_MIGRATION_SECRET_UNAVAILABLE"); }
                if (secret == null || secret.isEmpty()) throw new Failure("NIVRA_HISTORY_MIGRATION_SECRET_UNAVAILABLE");
                if (!original.isFile()) throw new Failure("NIVRA_HISTORY_MIGRATION_DATABASE_MISSING");
                System.loadLibrary("sqlcipher");

                // A crash after atomic publication leaves the encrypted main
                // and its plaintext rollback copy. Validate both before cleanup;
                // never replace a published database from an old backup.
                if (!isPlaintext(original)) {
                    if (!backup.isFile()) return;
                    phase = "NIVRA_HISTORY_MIGRATION_VERIFY_FAILED";
                    byte[] expected = fingerprint(backup, "", false);
                    requireEqual(expected, fingerprint(original, secret, true));
                    phase = "NIVRA_HISTORY_MIGRATION_CLEANUP_FAILED";
                    deleteTemporaryDatabase(staging);
                    deleteTemporaryDatabase(backup);
                    syncDirectory(original.getParentFile());
                    return;
                }

                phase = "NIVRA_HISTORY_MIGRATION_SNAPSHOT_FAILED";
                byte[] expected;
                // WAL is checkpointed before copying, then DELETE journal mode
                // and an exclusive read transaction keep the snapshot coherent.
                // No native plugin connection may remain open when called.
                try (SQLiteDatabase source = openExisting(original, "", false)) {
                    try (Cursor wal = source.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null)) {
                        if (!wal.moveToFirst() || wal.getInt(0) != 0
                            || wal.getInt(1) != wal.getInt(2)) {
                            throw new Failure("NIVRA_HISTORY_MIGRATION_DATABASE_BUSY");
                        }
                    }
                    try (Cursor mode = source.rawQuery("PRAGMA journal_mode=DELETE", null)) {
                        if (!mode.moveToFirst() || !"delete".equalsIgnoreCase(mode.getString(0))) {
                            throw new Failure("NIVRA_HISTORY_MIGRATION_DATABASE_BUSY");
                        }
                    }
                    source.beginTransaction();
                    try {
                        expected = fingerprint(source, false);
                        durableCopy(original, backup);
                        requireEqual(expected, fingerprint(backup, "", false));
                        source.setTransactionSuccessful();
                    } finally { source.endTransaction(); }
                }
                byte[] originalBytes = fileDigest(original);
                checkpoint.reached("snapshot");

                // Work only on our own temporary files. The original and its
                // verified rollback copy remain untouched throughout export.
                phase = "NIVRA_HISTORY_MIGRATION_EXPORT_FAILED";
                deleteTemporaryDatabase(staging);
                exportEncrypted(backup, staging, secret);
                syncFile(staging);
                checkpoint.reached("export");
                phase = "NIVRA_HISTORY_MIGRATION_VERIFY_FAILED";
                if (isPlaintext(staging)) throw new Failure(phase);
                requireEqual(expected, fingerprint(staging, secret, true));
                checkpoint.reached("verified");

                // Detect any writer that escaped JS connection shutdown. WAL
                // sidecars must not be allowed to replay plaintext on the new DB.
                if (!MessageDigest.isEqual(originalBytes, fileDigest(original))
                    || hasNonemptySidecar(original, "-wal") || hasNonemptySidecar(original, "-journal")
                    || new File(original.getPath() + "-shm").exists()) {
                    throw new Failure("NIVRA_HISTORY_MIGRATION_DATABASE_BUSY");
                }
                phase = "NIVRA_HISTORY_MIGRATION_PUBLISH_FAILED";
                publishVerified(new Publication() {
                    @Override public void replace() throws Exception {
                        // POSIX rename in the same directory replaces atomically;
                        // unlike the plugin's encryption mode it never deletes
                        // the original before a potentially failing move.
                        Os.rename(staging.getPath(), original.getPath());
                        checkpoint.reached("published");
                    }
                    @Override public void sync() throws Exception { syncDirectory(original.getParentFile()); }
                    @Override public void verify() throws Exception {
                        requireEqual(expected, fingerprint(original, secret, true));
                    }
                    @Override public void cleanup() throws Exception {
                        deleteTemporaryDatabase(backup);
                        syncDirectory(original.getParentFile());
                    }
                });
            } catch (Failure failure) { throw failure; }
            catch (Exception | LinkageError failure) {
                // Do not forward SQL, paths, key material or provider messages.
                throw new Failure(phase);
            }
        }
    }

    interface Publication {
        void replace() throws Exception;
        void sync() throws Exception;
        void verify() throws Exception;
        void cleanup() throws Exception;
    }

    static void publishVerified(Publication publication) throws Exception {
        publication.replace();
        publication.sync();
        publication.verify();
        // Cleanup is unreachable on ANY publication or validation failure.
        // A restart can verify the encrypted main against the retained copy.
        publication.cleanup();
    }

    private static SQLiteDatabase openExisting(File file, String secret, boolean readOnly) throws Exception {
        if (!file.isFile()) throw new Failure("NIVRA_HISTORY_MIGRATION_DATABASE_MISSING");
        return SQLiteDatabase.openDatabase(file.getPath(), secret, null,
            readOnly ? SQLiteDatabase.OPEN_READONLY : SQLiteDatabase.OPEN_READWRITE,
            (database, corruption) -> { /* Preserve evidence and every recovery copy. */ }, null);
    }

    private static void exportEncrypted(File source, File target, String secret) throws Exception {
        if (!target.createNewFile()) throw new Failure("NIVRA_HISTORY_MIGRATION_EXPORT_FAILED");
        restrict(target);
        try (SQLiteDatabase encrypted = openExisting(target, secret, false)) {
            try (SQLiteStatement attach = encrypted.compileStatement("ATTACH DATABASE ? AS plaintext KEY ''")) {
                attach.bindString(1, source.getPath());
                attach.execute();
            }
            try {
                encrypted.rawExecSQL("SELECT sqlcipher_export('main', 'plaintext')");
                int version;
                int applicationId;
                try (Cursor cursor = encrypted.rawQuery("PRAGMA plaintext.user_version", null)) {
                    if (!cursor.moveToFirst()) throw new Failure("NIVRA_HISTORY_MIGRATION_EXPORT_FAILED");
                    version = cursor.getInt(0);
                }
                try (Cursor cursor = encrypted.rawQuery("PRAGMA plaintext.application_id", null)) {
                    if (!cursor.moveToFirst()) throw new Failure("NIVRA_HISTORY_MIGRATION_EXPORT_FAILED");
                    applicationId = cursor.getInt(0);
                }
                encrypted.setVersion(version);
                encrypted.execSQL("PRAGMA application_id=" + applicationId);
            } finally { encrypted.rawExecSQL("DETACH DATABASE plaintext"); }
        }
    }

    private static byte[] fingerprint(File file, String secret, boolean encrypted) throws Exception {
        try (SQLiteDatabase database = openExisting(file, secret, true)) { return fingerprint(database, encrypted); }
    }

    private static byte[] fingerprint(SQLiteDatabase database, boolean encrypted) throws Exception {
        try (Cursor integrity = database.rawQuery("PRAGMA integrity_check", null)) {
            if (!integrity.moveToFirst() || !"ok".equals(integrity.getString(0)) || integrity.moveToNext()) {
                throw new Failure("NIVRA_HISTORY_MIGRATION_INTEGRITY_FAILED");
            }
        }
        if (encrypted) {
            // SQLCipher returns zero rows on success; every error row is fatal.
            try (Cursor integrity = database.rawQuery("PRAGMA cipher_integrity_check", null)) {
                if (integrity.moveToFirst()) throw new Failure("NIVRA_HISTORY_MIGRATION_INTEGRITY_FAILED");
            }
        }
        // Do not accept a random SQLite file or a partially exported history.
        for (String sql : new String[] {
            "SELECT key,account_key,conversation_id,id,at,expires_at_ms,opened_at_ms,delete_after_read,record_json FROM local_messages LIMIT 0",
            "SELECT key,account_key,id,updated_at,record_json FROM local_conversations LIMIT 0",
            "SELECT account_key,raw_key,created_at FROM local_vault_keys LIMIT 0"
        }) {
            try (Cursor ignored = database.rawQuery(sql, null)) { ignored.getColumnCount(); }
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (String pragma : new String[] { "PRAGMA user_version", "PRAGMA application_id" }) {
            try (Cursor rows = database.rawQuery(pragma, null)) { digestRows(digest, rows); }
        }
        List<String> tables = new ArrayList<>();
        // Includes indexes, triggers, views and sqlite_sequence; skips only
        // optimizer statistics which SQLCipher intentionally need not export.
        try (Cursor schema = database.rawQuery("SELECT type,name,tbl_name,sql FROM sqlite_master "
            + "WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type,name", null)) {
            while (schema.moveToNext()) {
                digestRow(digest, schema);
                if ("table".equals(schema.getString(0))) tables.add(schema.getString(1));
            }
        }
        for (String table : tables) {
            String name = "\"" + table.replace("\"", "\"\"") + "\"";
            int columns;
            try (Cursor metadata = database.rawQuery("SELECT * FROM " + name + " LIMIT 0", null)) {
                columns = metadata.getColumnCount();
                for (String column : metadata.getColumnNames()) bytes(digest, column.getBytes(StandardCharsets.UTF_8));
            }
            StringBuilder ordering = new StringBuilder();
            for (int index = 1; index <= columns; index++) {
                if (index > 1) ordering.append(',');
                ordering.append(index).append(" COLLATE BINARY");
            }
            // SQLite's typed ordering plus length prefixes makes the content
            // fingerprint deterministic, including NULL/BLOBs and duplicates.
            try (Cursor rows = database.rawQuery("SELECT * FROM " + name + " ORDER BY " + ordering, null)) {
                digestRows(digest, rows);
            }
        }
        return digest.digest();
    }

    private static void digestRows(MessageDigest digest, Cursor rows) {
        long count = 0;
        while (rows.moveToNext()) { digestRow(digest, rows); count++; }
        digest.update(ByteBuffer.allocate(8).putLong(count).array());
    }

    private static void digestRow(MessageDigest digest, Cursor row) {
        digest.update(ByteBuffer.allocate(4).putInt(row.getColumnCount()).array());
        for (int index = 0; index < row.getColumnCount(); index++) {
            int type = row.getType(index);
            digest.update((byte) type);
            switch (type) {
                case Cursor.FIELD_TYPE_NULL: break;
                case Cursor.FIELD_TYPE_INTEGER: digest.update(ByteBuffer.allocate(8).putLong(row.getLong(index)).array()); break;
                case Cursor.FIELD_TYPE_FLOAT: digest.update(ByteBuffer.allocate(8).putDouble(row.getDouble(index)).array()); break;
                case Cursor.FIELD_TYPE_BLOB: bytes(digest, row.getBlob(index)); break;
                default: bytes(digest, row.getString(index).getBytes(StandardCharsets.UTF_8));
            }
        }
    }

    private static void bytes(MessageDigest digest, byte[] value) {
        digest.update(ByteBuffer.allocate(8).putLong(value.length).array());
        digest.update(value);
    }

    private static void requireEqual(byte[] expected, byte[] actual) throws Failure {
        if (!MessageDigest.isEqual(expected, actual)) throw new Failure("NIVRA_HISTORY_MIGRATION_CONTENT_MISMATCH");
    }

    private static boolean isPlaintext(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] header = new byte[16];
            int count = 0;
            while (count < header.length) {
                int read = input.read(header, count, header.length - count);
                if (read < 0) break;
                count += read;
            }
            return "sqlite".equals(NivraNativePlugin.localHistoryHeaderFormat(header, count));
        }
    }

    private static void durableCopy(File original, File backup) throws Exception {
        File copying = new File(backup.getPath() + ".copying");
        // Only migration-owned temporary files are replaced or removed.
        try (FileInputStream input = new FileInputStream(original);
             FileOutputStream output = new FileOutputStream(copying, false)) {
            restrict(copying);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            output.getFD().sync();
        }
        requireEqual(fileDigest(original), fileDigest(copying));
        Os.rename(copying.getPath(), backup.getPath());
        syncDirectory(original.getParentFile());
    }

    private static byte[] fileDigest(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return digest.digest();
    }

    private static boolean hasNonemptySidecar(File database, String suffix) {
        File sidecar = new File(database.getPath() + suffix);
        return sidecar.isFile() && sidecar.length() > 0;
    }

    private static void restrict(File file) throws Exception {
        if (!file.setReadable(false, false) || !file.setWritable(false, false)
            || !file.setReadable(true, true) || !file.setWritable(true, true)) {
            throw new Failure("NIVRA_HISTORY_MIGRATION_PERMISSION_FAILED");
        }
    }

    private static void syncFile(File file) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file, true)) { output.getFD().sync(); }
    }

    private static void syncDirectory(File directory) throws Exception {
        if (!directory.isDirectory()) throw new Failure("NIVRA_HISTORY_MIGRATION_SYNC_FAILED");
        FileDescriptor descriptor = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
        try { Os.fsync(descriptor); } finally { Os.close(descriptor); }
    }

    private static void deleteTemporaryDatabase(File file) throws Exception {
        for (String suffix : new String[] { "-wal", "-shm", "-journal", ".copying", "" }) {
            File temporary = new File(file.getPath() + suffix);
            if (temporary.exists() && !temporary.delete()) throw new Failure("NIVRA_HISTORY_MIGRATION_CLEANUP_FAILED");
        }
    }
}
