package com.nivra.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class NivraPushScopePolicyTest {
    @Test public void eitherSavedAccountRequiresBothExactRecipientIds() {
        assertTrue(NivraPushScopePolicy.matches("alice", "phone", "alice", "phone"));
        assertTrue(NivraPushScopePolicy.matches("bob", "phone", "bob", "phone"));
        assertFalse(NivraPushScopePolicy.matches("alice", "phone", "bob", "phone"));
        assertFalse(NivraPushScopePolicy.matches("alice", "phone", "alice", "old-phone"));
        assertFalse(NivraPushScopePolicy.matches("alice", "phone", "alice", null));
        assertFalse(NivraPushScopePolicy.matches("", "", "", ""));
    }

    @Test public void sameMessageOrCallIdCannotCollideBetweenAccounts() {
        assertNotEquals(NivraPushScopePolicy.notificationTag("alice", "phone"), NivraPushScopePolicy.notificationTag("bob", "phone"));
        assertNotEquals(NivraPushScopePolicy.callKey("alice", "phone", "shared-call"), NivraPushScopePolicy.callKey("bob", "phone", "shared-call"));
        assertNotEquals(NivraPushScopePolicy.notificationTag("a:b", "c"), NivraPushScopePolicy.notificationTag("a", "b:c"));
        assertNotEquals(NivraPushScopePolicy.notificationTag("alice", "phone"), NivraPushScopePolicy.notificationTag("alice", "replacement"));
    }

    @Test public void lateResponseCannotRenewRotatedOrRetiredGeneration() {
        assertTrue(NivraPushScopePolicy.currentSnapshot("alice-v2", "alice-v2", "shared-fcm", "shared-fcm"));
        assertTrue(NivraPushScopePolicy.currentSnapshot("bob-v1", "bob-v1", "shared-fcm", "shared-fcm"));
        assertFalse(NivraPushScopePolicy.currentSnapshot("alice-v3", "alice-v2", "shared-fcm", "shared-fcm"));
        assertFalse(NivraPushScopePolicy.currentSnapshot("", "alice-v2", "shared-fcm", "shared-fcm"));
        assertFalse(NivraPushScopePolicy.currentSnapshot("alice-v2", "alice-v2", "new-fcm", "shared-fcm"));
        assertFalse(NivraPushScopePolicy.currentSnapshot("alice-v2", "alice-v2", "", ""));
    }

    @Test public void savedInactiveCallDoesNotAuthorizeAnswerOrReject() {
        assertTrue(NivraPushScopePolicy.permitsCallAction(true, true));
        assertFalse(NivraPushScopePolicy.permitsCallAction(true, false));
        assertFalse(NivraPushScopePolicy.permitsCallAction(false, true));
        assertFalse(NivraPushScopePolicy.permitsCallAction(false, false));
    }
}
