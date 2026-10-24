package com.nivra.app;

import org.junit.Test;
import javax.crypto.AEADBadTagException;
import static org.junit.Assert.*;

public class NativeSecureVaultErrorTest {
    private static class UserNotAuthenticatedException extends Exception { }
    private static class KeyPermanentlyInvalidatedException extends Exception { }

    @Test public void distinguishesAnUnavailableDeviceFromAnInvalidatedKeyWithoutProviderMessages() {
        assertEquals("NIVRA_KEYSTORE_LOCKED", NivraNativePlugin.secureSecretErrorCode(new UserNotAuthenticatedException()));
        assertEquals("NIVRA_KEYSTORE_KEY_INVALIDATED", NivraNativePlugin.secureSecretErrorCode(new KeyPermanentlyInvalidatedException()));
    }

    @Test public void preservesAuthenticatedDecryptionFailureAcrossWrappedNativeExceptions() {
        Throwable failure = new Exception("PRIVATE_PROVIDER_DETAILS", new AEADBadTagException("PRIVATE_ENVELOPE_CONTENTS"));
        assertEquals("NIVRA_SECURE_DECRYPT_FAILED", NivraNativePlugin.secureSecretErrorCode(failure));
    }

    @Test public void arbitraryMessagesCannotBecomeDiagnosticCodes() {
        assertEquals("NIVRA_SECURE_UNAVAILABLE", NivraNativePlugin.secureSecretErrorCode(new Exception("secret value and a private file path")));
        assertEquals("NIVRA_SECURE_UNAVAILABLE", NivraNativePlugin.secureSecretErrorCode(null));
    }

    @Test public void headerInspectionOnlyIdentifiesPlainSqliteAndNeverTreatsTruncatedOrOpaqueBytesAsReadableHistory() {
        byte[] plain = "SQLite format 3\u0000".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        assertEquals("sqlite", NivraNativePlugin.localHistoryHeaderFormat(plain, 16));
        assertEquals("encrypted-or-unknown", NivraNativePlugin.localHistoryHeaderFormat(plain, 15));
        assertEquals("encrypted-or-unknown", NivraNativePlugin.localHistoryHeaderFormat(new byte[16], 16));
        assertEquals("encrypted-or-unknown", NivraNativePlugin.localHistoryHeaderFormat(null, 0));
    }
}
