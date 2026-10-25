package com.nivra.app;

import org.junit.Test;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class NativePushMaintenancePolicyTest {
    private static final long NOW = TimeUnit.DAYS.toMillis(20);

    @Test public void freshConfirmedTokenDoesNotRestartTheRegistrationQueue() {
        assertTrue(NivraNativePushRegistration.registrationFresh("routing-a", "routing-a", NOW - 1000, NOW, true));
    }

    @Test public void replacementTokenAndUnconfirmedProviderStillNeedRegistration() {
        assertFalse(NivraNativePushRegistration.registrationFresh("routing-b", "routing-a", NOW - 1000, NOW, true));
        assertFalse(NivraNativePushRegistration.registrationFresh("routing-a", "routing-a", NOW - 1000, NOW, false));
        assertFalse(NivraNativePushRegistration.registrationFresh("routing-a", "", NOW - 1000, NOW, true));
    }

    @Test public void dailyRepairCanResumeAfterTheShortRetryBudgetWasExhausted() {
        assertFalse(NivraNativePushRegistration.registrationFresh("routing-a", "routing-a", NOW - TimeUnit.HOURS.toMillis(24), NOW, true));
        assertFalse(NivraNativePushRegistration.registrationFresh("routing-a", "routing-a", 0, NOW, true));
    }

    @Test public void clockRollbackAndMissingTokenCannotClaimHealthyRegistration() {
        assertFalse(NivraNativePushRegistration.registrationFresh("routing-a", "routing-a", NOW + 1000, NOW, true));
        assertFalse(NivraNativePushRegistration.registrationFresh("", "", NOW - 1000, NOW, true));
        assertFalse(NivraNativePushRegistration.registrationFresh(null, "routing-a", NOW - 1000, NOW, true));
    }
}
