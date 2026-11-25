package com.nivra.app;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class NivraNativeDiagnosticsTest {
    @Test public void deniedNotificationServiceDegradesWithoutTerminatingStartup() {
        assertFalse(NivraNativePlugin.readNotificationCapability(() -> {
            throw new SecurityException("Notification service denied package access during update");
        }));
        assertTrue(NivraNativePlugin.readNotificationCapability(() -> true));
    }

    @Test public void notificationServiceCanBeUnavailableOrDisabled() {
        assertFalse(NivraNativePlugin.readNotificationCapability(() -> {
            throw new IllegalStateException("Notification service unavailable");
        }));
        assertFalse(NivraNativePlugin.readNotificationCapability(() -> false));
    }
}
