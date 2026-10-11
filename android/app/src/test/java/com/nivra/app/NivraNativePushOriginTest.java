package com.nivra.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class NivraNativePushOriginTest {
    @Test public void acceptsOnlyPinnedProductionOrigin() {
        assertTrue(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com"));
        assertTrue(NivraNativePushRegistration.isAllowedApiOrigin("https://nivrapp-secure.onrender.com"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://attacker.test"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("http://nivra-webapp-secure.onrender.com"));
    }

    @Test public void failoverRequiresMatchingReadyClusterAndBothPushProviders() {
        String pin = new String(new char[64]).replace('\0', 'a');
        assertTrue(NivraApiFailover.compatible(pin, pin, 1, true, true, true));
        assertFalse(NivraApiFailover.compatible(pin, pin, 1, false, true, true));
        assertFalse(NivraApiFailover.compatible(pin, pin, 1, true, false, true));
        assertFalse(NivraApiFailover.compatible(pin, pin, 1, true, true, false));
        assertFalse(NivraApiFailover.compatible(pin, pin, 2, true, true, true));
        assertFalse(NivraApiFailover.compatible("", pin, 1, true, true, true));
        assertFalse(NivraApiFailover.compatible(pin, pin.replace('a', 'b'), 1, true, true, true));
    }
    @Test public void rejectsOriginCredentialAndPathTricks() {
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com.attacker.test"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://user@nivra-webapp-secure.onrender.com"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com/private"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com?token=x"));
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
