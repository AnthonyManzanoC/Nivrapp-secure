package com.nivra.app;

import java.util.List;

/** Local conversation identifiers only. This policy neither reads text nor contacts a server. */
final class NivraNotificationPrivacyPolicy {
    private NivraNotificationPrivacyPolicy() { }

    static boolean hide(boolean hideAll, List<String> protectedIds, String conversationId) {
        if (hideAll || protectedIds == null || protectedIds.contains("*")) return true;
        if (conversationId == null || conversationId.isEmpty()) return !protectedIds.isEmpty();
        return protectedIds.contains(conversationId);
    }
}
