package com.nivra.app;

/** Shared by Android notifications, call tombstones and account retirement. */
final class NivraPushScopePolicy {
    private NivraPushScopePolicy() { }
    static boolean matches(String user, String device, String recipientUser, String recipientDevice) {
        return user != null && !user.isEmpty() && device != null && !device.isEmpty()
            && user.equals(recipientUser) && device.equals(recipientDevice);
    }
    static String notificationTag(String user, String device) {
        String u = user == null ? "" : user, d = device == null ? "" : device;
        return "nivra-account:" + u.length() + ":" + u + ":" + d.length() + ":" + d;
    }
    static String callKey(String user, String device, String callId) { return notificationTag(user, device) + ":" + callId; }
    static boolean permitsCallAction(boolean registered, boolean active) { return registered && active; }
    static boolean currentSnapshot(String currentEpoch, String snapshotEpoch, String pendingToken, String token) {
        return currentEpoch != null && !currentEpoch.isEmpty() && currentEpoch.equals(snapshotEpoch)
            && token != null && !token.isEmpty() && token.equals(pendingToken);
    }
}
