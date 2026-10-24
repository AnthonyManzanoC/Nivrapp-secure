package com.nivra.app;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.database.Cursor;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.community.database.sqlite.SQLite.UtilsSecret;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.UUID;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class LegacyHistoryMigrationInstrumentedTest {
    private static final String SECRET = "retained-test-sqlcipher-secret";
    private static final String RAW_KEY = "retained-account-aes-key-do-not-change";
    private Context sandbox;
    private File directory;
    private File database;
    private SharedPreferences preferences;

    @Before public void isolateDatabaseAndRetainedSecret() throws Exception {
        System.loadLibrary("sqlcipher");
        Context application = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String id = UUID.randomUUID().toString();
        directory = new File(application.getCacheDir(), "legacy-history-instrumented-" + id);
        assertTrue(directory.mkdirs());
        sandbox = new ContextWrapper(application) {
            @Override public File getDatabasePath(String name) {
                assertEquals(LegacyHistoryMigration.DATABASE, name);
                return new File(directory, name);
            }
        };
        database = sandbox.getDatabasePath(LegacyHistoryMigration.DATABASE);
        preferences = application.getSharedPreferences("history-migration-test-" + id, Context.MODE_PRIVATE);
        assertTrue(preferences.edit().putString("secret", SECRET).commit());
        new UtilsSecret(sandbox, preferences);
    }

    @After public void removeOnlyIsolatedFixtures() {
        if (preferences != null) preferences.edit().clear().commit();
        remove(directory);
    }

    @Test public void convertsPlaintextWithWALAndRetainsKeysEveryTableAndTypedValues() throws Exception {
        createWalFixture();
        assertTrue(new File(database.getPath() + "-wal").length() > 0);
        assertTrue(isPlaintext());
        LegacyHistoryMigration.migrate(sandbox);
        assertEncryptedContents();
        assertFalse(LegacyHistoryMigration.pending(database));
        assertFalse(new File(database.getPath() + "-shm").exists());
        assertEquals(SECRET, preferences.getString("secret", ""));
    }

    @Test public void resumesAfterSnapshotWithoutLosingPlaintextOriginalOrKey() throws Exception { interruptAndResume("snapshot"); }
    @Test public void resumesAfterExportWithoutPublishingAnUncheckedStage() throws Exception { interruptAndResume("export"); }
    @Test public void resumesAfterVerificationBeforeAtomicRename() throws Exception { interruptAndResume("verified"); }
    @Test public void resumesAfterAtomicRenameBeforeCleanupWithoutRestoringOlderRecords() throws Exception { interruptAndResume("published"); }

    @Test public void missingRetainedSecretNeverCreatesAnotherOrTouchesPlaintextDatabase() throws Exception {
        createPlainFixture(database);
        assertTrue(preferences.edit().remove("secret").commit());
        expectFailure("NIVRA_HISTORY_MIGRATION_SECRET_UNAVAILABLE");
        assertTrue(isPlaintext());
        assertFalse(preferences.contains("secret"));
        assertFalse(LegacyHistoryMigration.pending(database));
    }

    @Test public void missingDatabaseIsNeverCreatedByRecovery() throws Exception {
        expectFailure("NIVRA_HISTORY_MIGRATION_DATABASE_MISSING");
        assertFalse(database.exists());
        assertFalse(LegacyHistoryMigration.pending(database));
    }

    @Test public void corruptPlaintextHeaderNeverTriggersDefaultDeletionOrReplacement() throws Exception {
        byte[] original = "SQLite format 3\u0000truncated-private-history".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(database)) { output.write(original); output.getFD().sync(); }
        expectFailure("NIVRA_HISTORY_MIGRATION_SNAPSHOT_FAILED");
        assertTrue(database.isFile());
        byte[] retained = new byte[original.length];
        try (FileInputStream input = new FileInputStream(database)) { assertEquals(original.length, input.read(retained)); }
        assertArrayEquals(original, retained);
        assertFalse(LegacyHistoryMigration.pending(database));
    }

    @Test public void wrongRetainedSecretAfterPublicationKeepsBothFilesAndDoesNotRestoreSnapshot() throws Exception {
        interrupt("published");
        assertTrue(preferences.edit().putString("secret", "different-retained-test-secret").commit());
        expectFailure("NIVRA_HISTORY_MIGRATION_VERIFY_FAILED");
        assertTrue(LegacyHistoryMigration.pending(database));
        assertFalse(isPlaintext());
        assertEncryptedContents(); // Original retained key still reads every record.
        assertEquals("different-retained-test-secret", preferences.getString("secret", ""));
    }

    @Test public void invalidLegacySchemaIsNotReplacedWithAnEmptyOrNewDatabase() throws Exception {
        try (SQLiteDatabase plain = SQLiteDatabase.openOrCreateDatabase(database, "", null, null)) {
            plain.execSQL("CREATE TABLE unrelated_history(value TEXT)");
            plain.execSQL("INSERT INTO unrelated_history VALUES ('keep-me')");
        }
        expectFailure("NIVRA_HISTORY_MIGRATION_SNAPSHOT_FAILED");
        assertTrue(isPlaintext());
        try (SQLiteDatabase plain = open("" ); Cursor rows = plain.rawQuery("SELECT value FROM unrelated_history", null)) {
            assertTrue(rows.moveToFirst());
            assertEquals("keep-me", rows.getString(0));
        }
        assertEquals(SECRET, preferences.getString("secret", ""));
    }

    @Test public void publishedContentMismatchPreservesBothCopiesInsteadOfReintroducingRemovedRows() throws Exception {
        interrupt("published");
        try (SQLiteDatabase encrypted = SQLiteDatabase.openDatabase(database.getPath(), SECRET, null, SQLiteDatabase.OPEN_READWRITE, null)) {
            encrypted.execSQL("DELETE FROM local_messages WHERE id='message-1'");
        }
        expectFailure("NIVRA_HISTORY_MIGRATION_CONTENT_MISMATCH");
        assertTrue(LegacyHistoryMigration.pending(database));
        try (SQLiteDatabase encrypted = open(SECRET); Cursor rows = encrypted.rawQuery("SELECT count(*) FROM local_messages", null)) {
            assertTrue(rows.moveToFirst());
            assertEquals(1, rows.getInt(0));
        }
    }

    @Test public void explicitLocalWipeRemovesInterruptedPlaintextAndEncryptedTemporaryCopies() throws Exception {
        interrupt("export");
        assertTrue(LegacyHistoryMigration.pending(database));
        LegacyHistoryMigration.clearTemporaryFiles(sandbox);
        assertFalse(LegacyHistoryMigration.pending(database));
        assertFalse(new File(database.getPath() + ".legacy-encrypted-staging").exists());
        assertTrue(database.exists()); // Main DB is deleted separately by the existing wipe path.
    }

    private void interruptAndResume(String phase) throws Exception {
        interrupt(phase);
        assertTrue(LegacyHistoryMigration.pending(database));
        assertEquals(!phase.equals("published"), isPlaintext());
        assertEquals(SECRET, preferences.getString("secret", ""));
        LegacyHistoryMigration.migrate(sandbox);
        assertEncryptedContents();
        assertFalse(LegacyHistoryMigration.pending(database));
        assertFalse(new File(database.getPath() + ".legacy-encrypted-staging").exists());
    }

    private void interrupt(String phase) throws Exception {
        createPlainFixture(database);
        try {
            LegacyHistoryMigration.migrate(sandbox, step -> {
                if (phase.equals(step)) throw new Exception("simulated process interruption");
            });
            fail("Expected interruption at " + phase);
        } catch (LegacyHistoryMigration.Failure expected) {
            assertTrue(expected.code.startsWith("NIVRA_HISTORY_MIGRATION_"));
            assertFalse(expected.getMessage().contains("simulated"));
        }
    }

    private void expectFailure(String code) throws Exception {
        try { LegacyHistoryMigration.migrate(sandbox); fail("Expected safe failure"); }
        catch (LegacyHistoryMigration.Failure failure) { assertEquals(code, failure.code); }
    }

    private void createWalFixture() throws Exception {
        File live = new File(directory, "wal-fixture.db");
        try (SQLiteDatabase writer = SQLiteDatabase.openOrCreateDatabase(live, "", null, null)) {
            writer.enableWriteAheadLogging();
            writer.execSQL("PRAGMA wal_autocheckpoint=0");
            fixture(writer);
            // Snapshot only committed, idle files to reproduce a process exit
            // with uncheckpointed WAL. Both databases remain inside this test.
            copy(live, database);
            for (String suffix : new String[] { "-wal", "-shm" }) {
                File sidecar = new File(live.getPath() + suffix);
                assertTrue(sidecar.isFile());
                copy(sidecar, new File(database.getPath() + suffix));
            }
        }
    }

    private void createPlainFixture(File target) throws Exception {
        try (SQLiteDatabase plain = SQLiteDatabase.openOrCreateDatabase(target, "", null, null)) { fixture(plain); }
    }

    private void fixture(SQLiteDatabase plain) {
        plain.execSQL("CREATE TABLE local_messages(key TEXT PRIMARY KEY NOT NULL,account_key TEXT NOT NULL,conversation_id TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,expires_at_ms INTEGER,opened_at_ms INTEGER,delete_after_read INTEGER NOT NULL DEFAULT 0,record_json TEXT NOT NULL)");
        plain.execSQL("CREATE TABLE local_conversations(key TEXT PRIMARY KEY NOT NULL,account_key TEXT NOT NULL,id TEXT NOT NULL,updated_at TEXT,record_json TEXT NOT NULL)");
        plain.execSQL("CREATE TABLE local_vault_keys(account_key TEXT PRIMARY KEY NOT NULL,raw_key TEXT NOT NULL,created_at TEXT NOT NULL)");
        plain.execSQL("CREATE TABLE extra_metadata(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT COLLATE NOCASE,binary_value BLOB,numeric_value REAL,nullable_value TEXT)");
        plain.execSQL("CREATE INDEX legacy_extra_index ON extra_metadata(label)");
        plain.execSQL("CREATE VIEW legacy_extra_view AS SELECT label FROM extra_metadata");
        plain.execSQL("CREATE TRIGGER legacy_extra_trigger AFTER UPDATE ON extra_metadata BEGIN SELECT 1; END");
        plain.execSQL("INSERT INTO local_messages VALUES ('account:message-1','account','conversation','message-1','2026-10-24T10:00:00Z',NULL,NULL,0,'{\"ciphertext\":\"retained-one\"}')");
        plain.execSQL("INSERT INTO local_messages VALUES ('account:message-2','account','conversation','message-2','2026-10-24T10:01:00Z',1999999999000,0,1,'{\"ciphertext\":\"retained-two\"}')");
        plain.execSQL("INSERT INTO local_conversations VALUES ('account:conversation','account','conversation','2026-10-24T10:01:00Z','{\"title\":\"Conversación á日本語\"}')");
        plain.execSQL("INSERT INTO local_vault_keys VALUES (?,?,?)", new Object[] { "account", RAW_KEY, "2026-10-01" });
        plain.execSQL("INSERT INTO extra_metadata(label,binary_value,numeric_value,nullable_value) VALUES ('ALPHA',X'00FF1080',1.25,NULL)");
        plain.execSQL("INSERT INTO extra_metadata(label,binary_value,numeric_value,nullable_value) VALUES ('alpha',X'0080FF10',-3.5,'kept')");
        plain.setVersion(7);
        plain.execSQL("PRAGMA application_id=17419");
    }

    private void assertEncryptedContents() throws Exception {
        assertFalse(isPlaintext());
        try (SQLiteDatabase encrypted = open(SECRET)) {
            assertEquals(7, encrypted.getVersion());
            try (Cursor rows = encrypted.rawQuery("SELECT id,record_json,expires_at_ms,delete_after_read FROM local_messages ORDER BY id", null)) {
                assertTrue(rows.moveToFirst());
                assertEquals("message-1", rows.getString(0));
                assertTrue(rows.getString(1).contains("retained-one"));
                assertTrue(rows.isNull(2));
                assertTrue(rows.moveToNext());
                assertEquals("message-2", rows.getString(0));
                assertEquals(1999999999000L, rows.getLong(2));
                assertEquals(1, rows.getInt(3));
                assertFalse(rows.moveToNext());
            }
            try (Cursor rows = encrypted.rawQuery("SELECT raw_key FROM local_vault_keys WHERE account_key='account'", null)) {
                assertTrue(rows.moveToFirst()); assertEquals(RAW_KEY, rows.getString(0));
            }
            try (Cursor rows = encrypted.rawQuery("SELECT binary_value,numeric_value,nullable_value FROM extra_metadata ORDER BY id", null)) {
                assertTrue(rows.moveToFirst()); assertArrayEquals(new byte[] { 0, (byte)255, 16, (byte)128 }, rows.getBlob(0));
                assertEquals(1.25, rows.getDouble(1), 0); assertTrue(rows.isNull(2));
                assertTrue(rows.moveToNext()); assertEquals(-3.5, rows.getDouble(1), 0); assertEquals("kept", rows.getString(2));
            }
            try (Cursor schema = encrypted.rawQuery("SELECT count(*) FROM sqlite_master WHERE name IN ('legacy_extra_index','legacy_extra_view','legacy_extra_trigger','sqlite_sequence')", null)) {
                assertTrue(schema.moveToFirst()); assertEquals(4, schema.getInt(0));
            }
        }
    }

    private SQLiteDatabase open(String secret) {
        return SQLiteDatabase.openDatabase(database.getPath(), secret, null, SQLiteDatabase.OPEN_READONLY, null);
    }

    private boolean isPlaintext() throws Exception {
        byte[] header = new byte[16];
        try (FileInputStream input = new FileInputStream(database)) {
            int count = input.read(header);
            return "sqlite".equals(NivraNativePlugin.localHistoryHeaderFormat(header, count));
        }
    }

    private static void copy(File source, File destination) throws Exception {
        try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[65536]; int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            output.getFD().sync();
        }
    }

    private static void remove(File file) {
        if (file == null) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        file.delete();
    }
}
