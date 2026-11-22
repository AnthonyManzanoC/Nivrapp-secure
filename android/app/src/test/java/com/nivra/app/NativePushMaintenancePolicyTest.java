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

    @Test public void missingRenewalRouteCanUseAnotherVerifiedNodeButRevokedCredentialsCannot() {
        assertEquals(NivraPushRegistrationWorker.Renewal.ALTERNATE, NivraPushRegistrationWorker.rejected(404));
        assertEquals(NivraPushRegistrationWorker.Renewal.ALTERNATE, NivraPushRegistrationWorker.rejected(503));
        assertEquals(NivraPushRegistrationWorker.Renewal.COMPLETE, NivraPushRegistrationWorker.rejected(401));
        assertEquals(NivraPushRegistrationWorker.Renewal.COMPLETE, NivraPushRegistrationWorker.rejected(403));
        assertEquals(NivraPushRegistrationWorker.Renewal.RETRY_LATER, NivraPushRegistrationWorker.rejected(429));
    }

    @Test public void onlyAcknowledgedRegistrationWithAnAvailableProviderFinishesRenewal() {
        assertEquals(NivraPushRegistrationWorker.Renewal.COMPLETE, NivraPushRegistrationWorker.acknowledgement(true, true));
        assertEquals(NivraPushRegistrationWorker.Renewal.RETRY_LATER, NivraPushRegistrationWorker.acknowledgement(true, false));
        assertEquals(NivraPushRegistrationWorker.Renewal.ALTERNATE, NivraPushRegistrationWorker.acknowledgement(null, true));
        assertEquals(NivraPushRegistrationWorker.Renewal.ALTERNATE, NivraPushRegistrationWorker.acknowledgement(true, "true"));
    }
}
