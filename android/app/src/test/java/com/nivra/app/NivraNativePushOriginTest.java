package com.nivra.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class NivraNativePushOriginTest {
    @Test public void acceptsOnlyPinnedProductionOrigin() {
        assertTrue(NivraNativePushRegistration.isAllowedApiOrigin("https://nivra-webapp-secure.onrender.com"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("https://attacker.test"));
        assertFalse(NivraNativePushRegistration.isAllowedApiOrigin("http://nivra-webapp-secure.onrender.com"));
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
