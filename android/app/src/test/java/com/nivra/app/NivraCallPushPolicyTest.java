package com.nivra.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class NivraCallPushPolicyTest {
    @Test public void recentIncomingCallIsTimelyWithoutNewServerExpiry() {
        assertTrue(NivraCallPushPolicy.isTimely(null, 100_000, 101_000));
    }
    @Test public void lateIncomingCallCannotRingAfterExpiration() {
        assertFalse(NivraCallPushPolicy.isTimely("170000", 100_000, 170_000));
        assertFalse(NivraCallPushPolicy.isTimely(null, 100_000, 176_000));
    }
    @Test public void malformedAndUnboundedExpiryCannotHoldIncomingScreen() {
        assertFalse(NivraCallPushPolicy.isTimely("oops", 100_000, 101_000));
        assertFalse(NivraCallPushPolicy.isTimely("9000000", 100_000, 101_000));
    }
    @Test public void missingFcmSentTimeDoesNotInventFreshCall() {
        assertFalse(NivraCallPushPolicy.isTimely("170000", 0, 100_000));
    }
}
