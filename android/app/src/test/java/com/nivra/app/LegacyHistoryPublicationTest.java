package com.nivra.app;

import org.junit.Test;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import static org.junit.Assert.*;

public class LegacyHistoryPublicationTest {
    private static final class Files implements LegacyHistoryMigration.Publication {
        String main = "original-plaintext";
        String backup = "original-plaintext";
        String staging = "verified-encrypted";
        final List<String> steps = new ArrayList<>();
        final String failAt;
        Files(String failAt) { this.failAt = failAt; }
        void step(String stage) throws Exception {
            steps.add(stage);
            if (stage.equals(failAt)) throw new Exception("injected-private-provider-message");
        }
        public void replace() throws Exception { step("replace"); main = staging; staging = null; }
        public void sync() throws Exception { step("sync"); }
        public void verify() throws Exception { step("verify"); assertEquals("verified-encrypted", main); }
        public void cleanup() throws Exception { step("cleanup"); backup = null; }
    }

    @Test public void removesPlaintextOnlyAfterDurablePublicationAndValidation() throws Exception {
        Files files = new Files("");
        LegacyHistoryMigration.publishVerified(files);
        assertEquals(Arrays.asList("replace", "sync", "verify", "cleanup"), files.steps);
        assertEquals("verified-encrypted", files.main);
        assertNull(files.backup);
    }

    @Test public void failedAtomicReplaceLeavesOriginalAndBackupAndDoesNotValidateOrDelete() {
        Files files = simulateFailure("replace");
        assertEquals("original-plaintext", files.main);
        assertEquals("original-plaintext", files.backup);
        assertEquals("verified-encrypted", files.staging);
        assertEquals(Arrays.asList("replace"), files.steps);
    }

    @Test public void interruptedDirectorySyncKeepsRecoverableCopyAfterAtomicReplace() {
        Files files = simulateFailure("sync");
        assertEquals("verified-encrypted", files.main);
        assertEquals("original-plaintext", files.backup);
        assertEquals(Arrays.asList("replace", "sync"), files.steps);
    }

    @Test public void failedPublishedValidationNeverDeletesTheRollbackCopy() {
        Files files = simulateFailure("verify");
        assertEquals("verified-encrypted", files.main);
        assertEquals("original-plaintext", files.backup);
        assertEquals(Arrays.asList("replace", "sync", "verify"), files.steps);
    }

    @Test public void failedCleanupKeepsValidatedEncryptedMainAndCanBeRetried() {
        Files files = simulateFailure("cleanup");
        assertEquals("verified-encrypted", files.main);
        assertEquals("original-plaintext", files.backup);
    }

    private static Files simulateFailure(String at) {
        Files files = new Files(at);
        try { LegacyHistoryMigration.publishVerified(files); fail("Expected injected failure"); }
        catch (Exception expected) { assertTrue(expected.getMessage().startsWith("injected")); }
        return files;
    }
}
