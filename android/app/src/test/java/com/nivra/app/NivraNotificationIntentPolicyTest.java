package com.nivra.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class NivraNotificationIntentPolicyTest {
    @Test public void callerMirrorNeverRingsItsOwnAccountButTheOtherSavedCalleeStillDoes() {
        assertTrue(NivraNotificationIntentPolicy.callerEcho("anthony", "anthony"));
        assertFalse(NivraNotificationIntentPolicy.callerEcho("ruth", "anthony"));
        assertFalse(NivraNotificationIntentPolicy.callerEcho("ruth", null));
        assertFalse(NivraNotificationIntentPolicy.callerEcho("", ""));
    }
    @Test public void controlCapabilityCannotCrossAccountDeviceCallOrAction() {
        String key = NivraNotificationIntentPolicy.key("ruth", "phone-ruth", "call-one", "OPEN_PUSH", "accept");
        assertNotEquals(key, NivraNotificationIntentPolicy.key("anthony", "phone-ruth", "call-one", "OPEN_PUSH", "accept"));
        assertNotEquals(key, NivraNotificationIntentPolicy.key("ruth", "old-phone", "call-one", "OPEN_PUSH", "accept"));
        assertNotEquals(key, NivraNotificationIntentPolicy.key("ruth", "phone-ruth", "call-two", "OPEN_PUSH", "accept"));
        assertNotEquals(key, NivraNotificationIntentPolicy.key("ruth", "phone-ruth", "call-one", "OPEN_PUSH", "decline"));
        assertNotEquals(key, NivraNotificationIntentPolicy.key("ruth", "phone-ruth", "call-one", "CALL_ANSWER", "accept"));
        assertNotEquals(NivraNotificationIntentPolicy.key("a", "b", "c", "a:b", "c"), NivraNotificationIntentPolicy.key("a", "b", "c", "a", "b:c"));
    }
    @Test public void onlyTheNativeIssuedUnexpiredMarkerAuthorizesThePendingIntent() {
        String token = "12345678-abcd-4321-abcd-123456789012";
        assertTrue(NivraNotificationIntentPolicy.validMarker(token, token, 2000, 1000));
        assertFalse(NivraNotificationIntentPolicy.validMarker(token, token, 1000, 1000));
        assertFalse(NivraNotificationIntentPolicy.validMarker(token, "12345678-abcd-4321-abcd-123456789013", 2000, 1000));
        assertFalse(NivraNotificationIntentPolicy.validMarker(null, token, 2000, 1000));
        assertFalse(NivraNotificationIntentPolicy.validMarker(token, null, 2000, 1000));
        assertFalse(NivraNotificationIntentPolicy.validMarker("", "", 2000, 1000));
    }
    @Test public void acknowledgingAnOlderActionCannotClearANewerDurableTap() {
        assertTrue(NivraNotificationIntentPolicy.sameIntent("tap-one", "tap-one"));
        assertFalse(NivraNotificationIntentPolicy.sameIntent("tap-two", "tap-one"));
        assertFalse(NivraNotificationIntentPolicy.sameIntent("tap-two", ""));
        assertTrue(NivraNotificationIntentPolicy.sameIntent("", "")); // Legacy clears only another legacy record.
        assertFalse(NivraNotificationIntentPolicy.sameIntent("tap-two", null));
    }
}
