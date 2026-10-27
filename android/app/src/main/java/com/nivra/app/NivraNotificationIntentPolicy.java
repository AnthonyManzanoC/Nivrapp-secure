package com.nivra.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Routing capabilities contain no account credentials and never leave native storage. */
final class NivraNotificationIntentPolicy {
    private NivraNotificationIntentPolicy() { }
    static boolean callerEcho(String recipientUser, String callerUser) {
        return recipientUser != null && !recipientUser.isEmpty() && recipientUser.equals(callerUser);
    }
    static String key(String user, String device, String callId, String action, String command) {
        return NivraPushScopePolicy.notificationTag(user, device) + ":" + callId.length() + ":" + callId + ":" + action.length() + ":" + action
            + ":" + command.length() + ":" + command;
    }
    static boolean validMarker(String expected, String supplied, long expiry, long now) {
        return expected != null && supplied != null && expected.length() >= 32 && expiry > now
            && MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8));
    }
    static boolean sameIntent(String currentId, String acknowledgedId) {
        return currentId != null && acknowledgedId != null && currentId.equals(acknowledgedId);
    }
}
