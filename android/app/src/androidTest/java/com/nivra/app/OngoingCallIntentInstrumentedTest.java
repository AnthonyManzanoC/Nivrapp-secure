package com.nivra.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.lang.reflect.Method;
import static org.junit.Assert.*;

/** Scoped synthetic registry only; never modifies the installed production profile. */
@RunWith(AndroidJUnit4.class)
public class OngoingCallIntentInstrumentedTest {
    private Context context;
    private final String user = "synthetic-ongoing-user", device = "synthetic-ongoing-device";
    private final String callId = "synthetic-ongoing-call";

    @Before public void seedOnlyTheSeparateLaboratoryPackage() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.nivra.app.experiencelab", context.getPackageName());
        assertTrue((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        JSONObject account = new JSONObject().put("userId", user).put("deviceId", device)
            .put("epoch", "synthetic-epoch").put("notificationEpoch", "synthetic-epoch");
        write(new JSONObject().put("version", 2).put("accounts", new JSONArray().put(account))
            .put("activeUserId", user).put("activeDeviceId", device).put("pendingWipes", new JSONArray()));
    }

    private void write(JSONObject registry) throws Exception {
        Method method = NivraNativePushRegistration.class.getDeclaredMethod("write", Context.class, JSONObject.class);
        method.setAccessible(true); method.invoke(null, context, registry);
    }

    private JSONObject registry() throws Exception {
        Method method = NivraNativePushRegistration.class.getDeclaredMethod("registry", Context.class);
        method.setAccessible(true); return (JSONObject) method.invoke(null, context);
    }

    @Test public void tappingOngoingNotificationProducesAnAcceptedDurableRoute() {
        Intent unsigned = new Intent(context, MainActivity.class).setAction(NivraNativePlugin.ACTION_CALL_OPEN)
            .putExtra("callId", callId).putExtra("recipientUserId", user).putExtra("recipientDeviceId", device);
        assertFalse(NivraNativePushRegistration.acceptsCallIntent(context, unsigned));
        Intent open = NivraOngoingCallService.openCallIntent(context, callId, user, device);
        assertNotNull(open);
        assertTrue(NivraNativePushRegistration.acceptsCallIntent(context, open));
        assertTrue(NivraNativePlugin.handleCallIntent(context, open));
        JSONObject route = NivraNativePushRegistration.pendingIntent(context);
        assertNotNull(route);
        assertEquals(callId, route.optString("callId"));
        assertEquals(user, route.optString("recipientUserId"));
        assertEquals(device, route.optString("recipientDeviceId"));
    }

    @Test public void activeTapDoesNotReuseTheExpiredIncomingRingCapability() throws Exception {
        Intent incoming = new Intent(context, MainActivity.class).setAction(NivraNativePlugin.ACTION_CALL_OPEN)
            .putExtra("type", "incoming-call").putExtra("callId", callId)
            .putExtra("recipientUserId", user).putExtra("recipientDeviceId", device);
        assertTrue(NivraNativePushRegistration.signCallIntent(context, incoming));
        Intent open = NivraOngoingCallService.openCallIntent(context, callId, user, device);
        assertNotNull(open);
        assertNotEquals(incoming.getStringExtra("nivraCallIntentMarker"), open.getStringExtra("nivraCallIntentMarker"));
        JSONObject registry = registry();
        String incomingKey = NivraNotificationIntentPolicy.key(user, device, callId, NivraNativePlugin.ACTION_CALL_OPEN, "");
        registry.getJSONObject("callIntentMarkers").getJSONObject(incomingKey).put("expiresAt", System.currentTimeMillis() - 1);
        write(registry);
        assertFalse(NivraNativePushRegistration.acceptsCallIntent(context, incoming));
        assertTrue(NivraNativePushRegistration.acceptsCallIntent(context, open));
        String activeKey = NivraNotificationIntentPolicy.key(user, device, callId, NivraNativePlugin.ACTION_CALL_OPEN, "open-ongoing-call");
        assertTrue(registry().getJSONObject("callIntentMarkers").getJSONObject(activeKey).getLong("expiresAt")
            > System.currentTimeMillis() + 75_000);
    }

    @Test public void missingOrDifferentAccountNeverPublishesAnUnsignedCallAction() {
        assertNull(NivraOngoingCallService.openCallIntent(context, callId, "other-user", device));
        assertNull(NivraOngoingCallService.openCallIntent(context, callId, user, "other-device"));
    }
}
