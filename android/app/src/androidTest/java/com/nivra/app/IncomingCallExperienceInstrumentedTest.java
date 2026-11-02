package com.nivra.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import static org.junit.Assert.*;

/** Synthetic native UI only. Refuses to write any installed Nivra account/profile. */
@RunWith(AndroidJUnit4.class)
public class IncomingCallExperienceInstrumentedTest {
    private Context context;
    private final String user = "synthetic-caller-recipient", device = "synthetic-device";

    @Before public void requireSeparateLaboratoryPackage() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.nivra.app.experiencelab", context.getPackageName());
        assertTrue((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
    }

    private Intent incoming(String type, boolean hidden) throws Exception {
        JSONObject account = new JSONObject().put("userId", user).put("deviceId", device)
            .put("epoch", "synthetic-epoch").put("notificationEpoch", "synthetic-epoch")
            .put("hideNotificationContent", hidden).put("protectedConversationIds", new JSONArray());
        JSONObject root = new JSONObject().put("version", 2).put("accounts", new JSONArray().put(account))
            .put("activeUserId", user).put("activeDeviceId", device).put("pendingWipes", new JSONArray());
        // Seed only an isolated encrypted notification registry; never register a token or contact an API.
        Method write = NivraNativePushRegistration.class.getDeclaredMethod("write", Context.class, JSONObject.class);
        write.setAccessible(true); write.invoke(null, context, root);
        Intent intent = new Intent(context, NivraIncomingCallActivity.class)
            .setAction(NivraNativePlugin.ACTION_CALL_OPEN).putExtra("type", "incoming-call")
            .putExtra("callId", "synthetic-" + java.util.UUID.randomUUID())
            .putExtra("recipientUserId", user).putExtra("recipientDeviceId", device)
            .putExtra("callerName", "Sofía · Prueba de diseño").putExtra("callType", type)
            .putExtra("conversationId", "synthetic-chat")
            .putExtra("expiresAt", String.valueOf(System.currentTimeMillis() + 75000));
        assertTrue(NivraNativePushRegistration.signCallIntent(context, intent));
        return intent;
    }

    private boolean contains(View view, String text) {
        if (view instanceof TextView && ((TextView)view).getText().toString().contains(text)) return true;
        if (view instanceof ViewGroup) for (int i=0;i<((ViewGroup)view).getChildCount();i++)
            if (contains(((ViewGroup)view).getChildAt(i),text)) return true;
        return false;
    }

    private void screenshot(String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        // Idle callbacks can precede the compositor's Activity transition frame.
        // Wait for the real dark call surface instead of accepting a white launch frame.
        Bitmap image = null;
        for (int attempt=0;attempt<20;attempt++) {
            if (image != null) image.recycle();
            android.os.SystemClock.sleep(150);
            image = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            if (image != null) {
                int color=image.getPixel(image.getWidth()/2,image.getHeight()/5);
                if (android.graphics.Color.red(color)<90 && android.graphics.Color.green(color)<110 && android.graphics.Color.blue(color)<120) break;
            }
        }
        assertNotNull(image);
        int color=image.getPixel(image.getWidth()/2,image.getHeight()/5);
        assertTrue("Call surface did not finish drawing", android.graphics.Color.red(color)<90 && android.graphics.Color.green(color)<110 && android.graphics.Color.blue(color)<120);
        File directory = new File(context.getExternalFilesDir(null), "call-design");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        try (FileOutputStream output = new FileOutputStream(new File(directory, name + ".png"))) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { image.recycle(); }
    }

    @Test public void voiceScreenIsNativeAndEligibleAboveTheLockScreen() throws Exception {
        try (ActivityScenario<NivraIncomingCallActivity> scenario = ActivityScenario.launch(incoming("Voice", false))) {
            scenario.onActivity(activity -> {
                int flags=activity.getWindow().getAttributes().flags;
                assertTrue((flags & WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED) != 0);
                assertTrue((flags & WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON) != 0);
                View root=activity.getWindow().getDecorView();
                assertTrue(contains(root,"Sofía"));assertTrue(contains(root,"Contestar"));
                assertTrue(contains(root,"Rechazar"));assertFalse(contains(root,"Aceptar video"));
            });
            screenshot("native-incoming-voice");
        }
    }

    @Test public void videoScreenHasItsOwnAnswerActionAndPrivacyRedactsCaller() throws Exception {
        try (ActivityScenario<NivraIncomingCallActivity> scenario = ActivityScenario.launch(incoming("Video", true))) {
            scenario.onActivity(activity -> {
                View root=activity.getWindow().getDecorView();
                assertTrue(contains(root,"VIDEOLLAMADA ENTRANTE"));assertTrue(contains(root,"Aceptar video"));
                assertFalse(contains(root,"Sofía"));
            });
            screenshot("native-incoming-video-private");
        }
    }

    @Test public void persistedCancellationRemainsScopedAfterActivityStops() throws Exception {
        Intent intent=incoming("Voice",false);
        Map<String,String> scope=new HashMap<>();scope.put("recipientUserId",user);scope.put("recipientDeviceId",device);
        String callId=intent.getStringExtra("callId");
        assertFalse(NivraCallPushPolicy.wasEnded(context,user,device,callId,System.currentTimeMillis()));
        NivraCallPushPolicy.markEnded(context,scope,callId);
        assertTrue(NivraCallPushPolicy.wasEnded(context,user,device,callId,System.currentTimeMillis()));
        assertFalse(NivraCallPushPolicy.wasEnded(context,"another-account",device,callId,System.currentTimeMillis()));
    }

    @Test public void privacyChangeRedactsAnAlreadyVisibleCallerWithoutEndingReception() throws Exception {
        try (ActivityScenario<NivraIncomingCallActivity> scenario = ActivityScenario.launch(incoming("Voice", false))) {
            scenario.onActivity(activity -> assertTrue(contains(activity.getWindow().getDecorView(), "Sofía")));
            incoming("Voice", true); // Update only the isolated test account's privacy registry.
            context.sendBroadcast(new Intent(NivraNativePushRegistration.ACTION_PRIVACY_CHANGED)
                .setPackage(context.getPackageName()).putExtra("recipientUserId", user).putExtra("recipientDeviceId", device));
            java.util.concurrent.atomic.AtomicBoolean redacted = new java.util.concurrent.atomic.AtomicBoolean();
            for (int attempt = 0; attempt < 30 && !redacted.get(); attempt++) {
                InstrumentationRegistry.getInstrumentation().waitForIdleSync();
                scenario.onActivity(activity -> {
                    View root = activity.getWindow().getDecorView();
                    redacted.set(!contains(root, "Sofía") && contains(root, "Nivra") && contains(root, "Contestar") && !activity.isFinishing());
                });
                if (!redacted.get()) android.os.SystemClock.sleep(100);
            }
            assertTrue("Privacy refresh must redact the caller while keeping reception available", redacted.get());
        }
    }
}
