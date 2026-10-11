package com.nivra.app;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeAppUpdatePolicyTest {
    private final String url = "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v2.1.0/Nivra-2.1.0-debug.apk";
    private final String hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    @Test public void acceptsOnlyOurVersionedAssetAndBoundedMetadata() {
        assertTrue(NativeAppUpdateManager.validDescriptor("2.1.0", 22, hash, 80000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor("2.1.0", 22, hash, 80000000, url + "?redirect=bad"));
        assertFalse(NativeAppUpdateManager.validDescriptor("2.1.0", 22, hash, 80000000, "http://localhost/app.apk"));
        assertFalse(NativeAppUpdateManager.validDescriptor("2.1.0", 22, hash, 300000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor("2.1.0", 22, "xyz", 80000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor("../2.1.0", 22, hash, 80000000, url));
    }
    @Test public void formatsTheDigestWithoutSignedByteErrors() {
        assertEquals("00ff807f", NativeAppUpdateManager.hex(new byte[] { 0, (byte)255, (byte)128, 127 }));
    }
    @Test public void acceptsTheNextReleaseWithoutRelaxingItsDownloadOrigin() {
        String next = "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v2.1.1/Nivra-2.1.1-debug.apk";
        assertTrue(NativeAppUpdateManager.validDescriptor("2.1.1", 23, hash, 80000000, next));
        assertFalse(NativeAppUpdateManager.validDescriptor("2.1.1", 23, hash, 80000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor("2.1.1", 23, hash, 80000000,
            "https://nivrapp-secure.onrender.com/Nivra-2.1.1-debug.apk"));
    }
}
