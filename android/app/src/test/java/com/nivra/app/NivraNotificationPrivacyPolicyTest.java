package com.nivra.app;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;
import static org.junit.Assert.*;

public class NivraNotificationPrivacyPolicyTest {
    @Test public void protectedConversationRedactsWithoutHidingOtherConversations() {
        assertTrue(NivraNotificationPrivacyPolicy.hide(false, Arrays.asList("private-chat"), "private-chat"));
        assertFalse(NivraNotificationPrivacyPolicy.hide(false, Arrays.asList("private-chat"), "normal-chat"));
    }
    @Test public void unreadableMetadataAndMissingConversationFailClosed() {
        assertTrue(NivraNotificationPrivacyPolicy.hide(false, null, "normal-chat"));
        assertTrue(NivraNotificationPrivacyPolicy.hide(false, Arrays.asList("*"), "normal-chat"));
        assertTrue(NivraNotificationPrivacyPolicy.hide(false, Arrays.asList("private-chat"), ""));
        assertTrue(NivraNotificationPrivacyPolicy.hide(false, Arrays.asList("private-chat"), null));
    }
    @Test public void accountGlobalPrivacyAndEmptyLegacyPolicyRemainDistinct() {
        assertTrue(NivraNotificationPrivacyPolicy.hide(true, Collections.emptyList(), "normal-chat"));
        assertFalse(NivraNotificationPrivacyPolicy.hide(false, Collections.emptyList(), "normal-chat"));
        assertFalse(NivraNotificationPrivacyPolicy.hide(false, Collections.emptyList(), null));
    }
}
