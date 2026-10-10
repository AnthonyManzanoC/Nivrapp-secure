package com.nivra.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Registration survives WebView/process sleep; credentials remain in Android Keystore. */
final class NivraNativePushRegistration {
    private static final String PREFS = "nivra_native_push";
    private static final String KEY = "nivra.native.push.v1";
    static final String WORK_NAME = "nivra-native-push-registration";

    private NivraNativePushRegistration() { }

    static synchronized void sync(Context context, JSObject options) throws Exception {
        String api = options.optString("apiBaseUrl", "").replaceAll("/+$", "");
        if (!isAllowedApiOrigin(api))
            throw new IllegalArgumentException("A secure API origin is required.");
        String user = options.optString("userId", "");
        String device = options.optString("deviceId", "");
        String refresh = options.optString("refreshToken", "");
        if (user.isEmpty() || device.isEmpty() || refresh.isEmpty() || refresh.length() > 4096)
            throw new IllegalArgumentException("An authenticated device session is required.");
        JSONObject prior = read(context);
        if (prior != null && isScopeChange(prior.optString("userId"), prior.optString("deviceId"), user, device))
            clearNotifications(context);
        boolean same = prior != null && api.equals(prior.optString("apiBaseUrl")) &&
            user.equals(prior.optString("userId")) && device.equals(prior.optString("deviceId")) &&
            refresh.equals(prior.optString("refreshToken"));
        if (!same) {
            JSONObject value = new JSONObject();
            value.put("apiBaseUrl", api).put("userId", user).put("deviceId", device)
                .put("refreshToken", refresh).put("epoch", UUID.randomUUID().toString());
            write(context, value);
        }
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> tokenChanged(context, token));
    }

    static synchronized JSONObject read(Context context) {
        try {
            SharedPreferences prefs = prefs(context);
            String encrypted = prefs.getString("ciphertext", "");
            String iv = prefs.getString("iv", "");
            if (encrypted == null || encrypted.isEmpty() || iv == null || iv.isEmpty()) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception ignored) { return null; }
    }

    private static void write(Context context, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        if (!prefs(context).edit().putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
            throw new IllegalStateException("Could not persist push registration.");
    }

    static synchronized void clear(Context context) {
        prefs(context).edit().clear().commit();
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        clearNotifications(context);
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY)) store.deleteEntry(KEY);
        } catch (Exception ignored) { }
    }

    static boolean isScopeChange(String priorUserId, String priorDeviceId, String nextUserId, String nextDeviceId) {
        return priorUserId != null && !priorUserId.isEmpty() &&
            (!priorUserId.equals(nextUserId) || !java.util.Objects.equals(priorDeviceId, nextDeviceId));
    }

    private static void clearNotifications(Context context) {
        NivraNativePlugin.discardPendingCallActions();
        NotificationManagerCompat.from(context).cancelAll();
        // Logging out or changing the authenticated device also releases the
        // former account's foreground call service. Credential rotation within
        // the same account/device never reaches this cleanup.
        NivraOngoingCallService.stop(context, "");
        context.sendBroadcast(new Intent(NivraNativePlugin.ACTION_CALL_DISMISS)
            .setPackage(context.getPackageName()).putExtra("all", true));
    }

    static synchronized void tokenChanged(Context context, String token) {
        if (token == null || token.trim().isEmpty()) return;
        // The token is a routing address, not a session credential. It can be queued
        // before login, but no network request is made without the encrypted session.
        prefs(context).edit().putString("pendingToken", token).commit();
        if (read(context) == null) return;
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(NivraPushRegistrationWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build();
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, work);
    }

    static synchronized String pendingToken(Context context) { return prefs(context).getString("pendingToken", ""); }

    static synchronized boolean isCurrent(Context context, JSONObject snapshot, String token) {
        JSONObject value = read(context);
        return value != null && value.optString("epoch").equals(snapshot.optString("epoch")) &&
            token.equals(pendingToken(context));
    }

    static synchronized void registered(Context context, JSONObject snapshot, String token, boolean fcmReady) {
        if (!isCurrent(context, snapshot, token)) return;
        prefs(context).edit().putLong("registeredAt", System.currentTimeMillis())
            .putBoolean("fcmReady", fcmReady).remove("pendingToken").commit();
    }

    static boolean accepts(Context context, java.util.Map<String, String> data) {
        JSONObject session = read(context);
        if (session == null) return false;
        String recipientUser = data.get("recipientUserId");
        String recipientDevice = data.get("recipientDeviceId");
        return recipientUser != null && recipientUser.equals(session.optString("userId")) &&
            recipientDevice != null && recipientDevice.equals(session.optString("deviceId"));
    }

    static boolean isAllowedApiOrigin(String value) {
        try {
            URI origin = URI.create(value);
            return "https".equalsIgnoreCase(origin.getScheme()) &&
                "nivra-webapp-secure.onrender.com".equalsIgnoreCase(origin.getHost()) &&
                (origin.getPort() == -1 || origin.getPort() == 443) && origin.getUserInfo() == null &&
                origin.getRawQuery() == null && origin.getRawFragment() == null &&
                (origin.getRawPath() == null || origin.getRawPath().isEmpty());
        } catch (RuntimeException ignored) { return false; }
    }

    static void diagnostics(Context context, JSObject result) {
        SharedPreferences prefs = prefs(context);
        result.put("nativePushSessionReady", read(context) != null);
        result.put("nativePushRegisteredAt", prefs.getLong("registeredAt", 0));
        result.put("nativePushRegistrationPending", !pendingToken(context).isEmpty());
        result.put("nativePushFcmReady", prefs.getBoolean("fcmReady", false));
    }

    private static SharedPreferences prefs(Context context) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private static SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
}
