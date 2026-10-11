package com.nivra.app;

import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class NivraNativePushOriginTest {
    @Test public void acceptsOnlyPinnedProductionOrigin() {
        assertTrue(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com"));
        assertTrue(NivraNativePushRegistration.isAllowedApiOrigin("https://nivrapp-secure.onrender.com"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://attacker.test"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("http://nivra-webapp-secure.onrender.com"));
    }

    @Test public void failoverRequiresTheCompiledClusterAndCurrentCoreReadiness() {
        String pin = NivraApiFailover.CLUSTER_FINGERPRINT;
        assertTrue(NivraApiFailover.compatible(pin, pin, 1, true));
        assertFalse(NivraApiFailover.compatible(pin, pin, 1, false));
        assertFalse(NivraApiFailover.compatible(pin, pin, 2, true));
        assertFalse(NivraApiFailover.compatible(pin, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, true));
        assertFalse(NivraApiFailover.compatible(pin, pin.toUpperCase(java.util.Locale.ROOT), 1, true));
        assertFalse(NivraApiFailover.compatible("invalid", pin, 1, true));
    }

    @Test public void compiledPinBootstrapsAndReplacesTheOlderReleaseCache() {
        String pin = NivraApiFailover.CLUSTER_FINGERPRINT;
        assertEquals(pin, NivraApiFailover.canonicalFingerprint(""));
        assertTrue(NivraApiFailover.compatible("", pin, 1, true));
        String historicalPin = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assertEquals(pin, NivraApiFailover.canonicalFingerprint(historicalPin));
        assertTrue(NivraApiFailover.compatible(historicalPin, pin, 1, true));
        assertFalse(NivraApiFailover.compatible(historicalPin, historicalPin, 1, true));
    }

    @Test public void safeTokenUpsertDoesNotRequireEitherPushDeliveryProvider() {
        assertTrue(NivraApiFailover.coreReady(true, true, false, false, false));
        // The live 2.1 backup has these three core capabilities while FCM is off.
        assertTrue(NivraApiFailover.coreReady(false, null, true, true, true));
        assertFalse(NivraApiFailover.coreReady(true, false, false, true, true));
        assertFalse(NivraApiFailover.coreReady(false, null, true, false, true));
        assertFalse(NivraApiFailover.coreReady(false, null, true, true, false));
        assertFalse(NivraApiFailover.coreReady(false, null, true, true, null));
        assertFalse(NivraApiFailover.coreReady(true, "true", "true", true, true));
    }

    @Test public void explicitCoreDenialCannotFallBackToIndividualFields() {
        assertFalse(NivraApiFailover.coreReady(true, false, true, true, true));
        assertFalse(NivraApiFailover.coreReady(true, null, true, true, true));
        assertFalse(NivraApiFailover.coreReady(true, JSONObject.NULL, true, true, true));
        assertFalse(NivraApiFailover.coreReady(true, "true", true, true, true));
        assertFalse(NivraApiFailover.coreReady(true, 1, true, true, true));
    }

    @Test public void callProtocolNeedsTypedIntegralCompatibility() {
        assertTrue(NivraApiFailover.compatibleCallProtocol(2, 2));
        assertTrue(NivraApiFailover.compatibleCallProtocol(2, 1));
        assertTrue(NivraApiFailover.compatibleCallProtocol(3, 2));
        for (Object value : new Object[] { null, "2", false, 1, 2.5, Double.NaN, Double.POSITIVE_INFINITY })
            assertFalse(NivraApiFailover.compatibleCallProtocol(value, 2));
        for (Object value : new Object[] { null, "2", false, 0, 1.5, 3, Double.NaN, Double.POSITIVE_INFINITY })
            assertFalse(NivraApiFailover.compatibleCallProtocol(2, value));
    }

    @Test public void cachedAndMalformedAgeHeadersCannotApproveFailover() {
        assertTrue(NivraApiFailover.freshAge(null));
        assertTrue(NivraApiFailover.freshAge("0"));
        for (String value : new String[] { "1", "-1", "invalid", "", "9999999999999999999999" })
            assertFalse(NivraApiFailover.freshAge(value));
    }

    @Test public void oldBackupReadinessNeedsTypedCoreFieldsAndDatabaseHealth() {
        String pin = NivraApiFailover.CLUSTER_FINGERPRINT;
        assertTrue(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 2, pin, false, null, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "unavailable", 1, 2, 2, pin, false, null, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", "1", 2, 2, pin, false, null, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1.5, 2, 2, pin, false, null, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 2, pin, false, null, "true", true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 2, pin, false, null, true, null, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 2, null, true, true, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 2, "unknown-cluster", true, true, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 2, pin, true, false, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 2, pin, true, JSONObject.NULL, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, "2", 2, pin, true, true, true, true, true));
        assertFalse(NivraApiFailover.compatibleReadiness("", "ok", 1, 2, 3, pin, true, true, true, true, true));
    }
    @Test public void rejectsOriginCredentialAndPathTricks() {
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com.attacker.test"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://user@nivra-webapp-secure.onrender.com"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com/private"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com?token=x"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivrapp-secure.onrender.com:8443"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivrapp-secure.onrender.com#fragment"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivrapp-secure.onrender.com/health/ready"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivrapp-secure.onrender.com?next=https://attacker.test"));
    }

    @Test public void refreshWithinSameAccountAndDeviceDoesNotClearCallNotifications() {
        assertFalse(NivraNativePushRegistration.isScopeChange("alice", "phone-a", "alice", "phone-a"));
        assertFalse(NivraNativePushRegistration.isScopeChange("", "", "alice", "phone-a"));
    }

    @Test public void switchingAccountOrDeviceClearsFormerCallNotifications() {
        assertTrue(NivraNativePushRegistration.isScopeChange("alice", "phone-a", "bob", "phone-b"));
        assertTrue(NivraNativePushRegistration.isScopeChange("alice", "phone-a", "alice", "phone-new"));
    }
}
