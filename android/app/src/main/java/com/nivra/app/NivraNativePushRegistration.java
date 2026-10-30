package com.nivra.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.service.notification.StatusBarNotification;
import android.util.Base64;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Two independent authenticated scopes, encrypted at rest and maintained without a WebView. */
final class NivraNativePushRegistration {
    private static final String PREFS = "nivra_native_push";
    private static final String KEY = "nivra.native.push.v1";
    static final String WORK_NAME = "nivra-native-push-registration";
    static final String MAINTENANCE_WORK_NAME = "nivra-native-push-maintenance";
    static final String ACTION_PRIVACY_CHANGED = "com.nivra.app.NOTIFICATION_PRIVACY_CHANGED";
    private static final String TOKEN_REPAIR_WORK_NAME = "nivra-native-push-token-repair";
    private static final long REGISTRATION_FRESH_MS = TimeUnit.HOURS.toMillis(24);
    private NivraNativePushRegistration() { }

    /** Legacy bridge upserts only its scope; it must never remove the other account. */
    static synchronized void sync(Context context, JSObject options) throws Exception {
        JSONObject root = registry(context);
        Map<String, String> previousPrivacy = notificationPrivacySnapshots(root);
        String previousUser = root.optString("activeUserId"), previousDevice = root.optString("activeDeviceId");
        JSONArray accounts = root.optJSONArray("accounts");
        JSONObject next = registration(options, root);
        if (next == null) return; // A pending revocation cannot be revived by a stale WebView.
        int existing = indexOf(accounts, next.optString("userId"), next.optString("deviceId"));
        if (existing < 0 && accounts.length() >= 2) throw new IllegalArgumentException("Only two saved accounts are supported.");
        if (existing >= 0) accounts.put(existing, next); else accounts.put(next);
        root.put("activeUserId", next.optString("userId")).put("activeDeviceId", next.optString("deviceId"));
        write(context, root);
        clearNewlyProtectedNotifications(context, root, previousPrivacy);
        if (isScopeChange(previousUser, previousDevice, next.optString("userId"), next.optString("deviceId"))) clearCallNotifications(context, previousUser, previousDevice);
        schedule(context);
    }

    static synchronized void syncAll(Context context, JSObject options) throws Exception {
        JSONArray requested = options.optJSONArray("accounts");
        if (requested == null || requested.length() > 2) throw new IllegalArgumentException("At most two saved accounts are required.");
        JSONObject root = registry(context);
        Map<String, String> previousPrivacy = notificationPrivacySnapshots(root);
        String previousUser = root.optString("activeUserId"), previousDevice = root.optString("activeDeviceId");
        JSONArray previous = root.optJSONArray("accounts");
        JSONArray next = new JSONArray();
        for (int i = 0; i < requested.length(); i++) {
            JSONObject account = requested.optJSONObject(i);
            if (account == null) throw new IllegalArgumentException("An authenticated device session is required.");
            JSONObject value = registration(account, root);
            if (value == null) continue;
            for (int j = 0; j < next.length(); j++) {
                if (value.optString("userId").equals(next.getJSONObject(j).optString("userId")))
                    throw new IllegalArgumentException("Saved accounts must have distinct users.");
            }
            next.put(value);
        }
        String activeUser = options.optString("activeUserId", "");
        String activeDevice = options.optString("activeDeviceId", "");
        if (indexOf(next, activeUser, activeDevice) < 0) { activeUser = ""; activeDevice = ""; }
        root.put("accounts", next).put("activeUserId", activeUser).put("activeDeviceId", activeDevice);
        write(context, root);
        clearNewlyProtectedNotifications(context, root, previousPrivacy);
        if (isScopeChange(previousUser, previousDevice, activeUser, activeDevice)) clearCallNotifications(context, previousUser, previousDevice);
        for (int i = 0; i < previous.length(); i++) {
            JSONObject prior = previous.getJSONObject(i);
            if (indexOf(next, prior.optString("userId"), prior.optString("deviceId")) < 0)
                clearNotifications(context, prior.optString("userId"), prior.optString("deviceId"));
        }
        if (next.length() == 0) cancelWork(context); else schedule(context);
    }

    private static JSONObject registration(JSONObject options, JSONObject root) throws Exception {
        String api = options.optString("apiBaseUrl", "").replaceAll("/+$", "");
        if (!isAllowedApiOrigin(api)) throw new IllegalArgumentException("A secure API origin is required.");
        String user = options.optString("userId", ""), device = options.optString("deviceId", ""), refresh = options.optString("refreshToken", "");
        if (user.isEmpty() || device.isEmpty() || user.length() > 128 || device.length() > 128 || refresh.isEmpty() || refresh.length() > 4096)
            throw new IllegalArgumentException("An authenticated device session is required.");
        if (indexOf(root.optJSONArray("pendingWipes"), user, device) >= 0) return null;
        String fingerprint = NivraApiFailover.canonicalFingerprint(options.optString("clusterFingerprint", ""));
        JSONObject prior = find(root.optJSONArray("accounts"), user, device);
        if (prior != null && api.equals(prior.optString("apiBaseUrl")) && refresh.equals(prior.optString("refreshToken")) && fingerprint.equals(prior.optString("clusterFingerprint"))) {
            copyNotificationPrivacy(prior, options, prior);
            return prior;
        }
        JSONObject value = new JSONObject().put("apiBaseUrl", api).put("userId", user).put("deviceId", device)
            .put("refreshToken", refresh).put("clusterFingerprint", fingerprint).put("epoch", UUID.randomUUID().toString()).put("fcmReady", false)
            // Rotating credentials must not invalidate a still-ringing PendingIntent.
            // Removing/re-adding this slot creates a different notification epoch.
            .put("notificationEpoch", prior == null ? UUID.randomUUID().toString() : prior.optString("notificationEpoch", prior.optString("epoch")));
        String token = root.optString("routingToken", "");
        if (!token.isEmpty()) value.put("pendingToken", token);
        copyNotificationPrivacy(value, options, prior);
        return value;
    }

    private static void copyNotificationPrivacy(JSONObject target, JSONObject options, JSONObject prior) throws Exception {
        target.put("hideNotificationContent", options.has("hideNotificationContent") ? options.optBoolean("hideNotificationContent", true) : prior != null && prior.optBoolean("hideNotificationContent", false));
        Object raw = options.has("protectedConversationIds") ? options.opt("protectedConversationIds") : prior == null ? new JSONArray() : prior.opt("protectedConversationIds");
        // A legacy registration may have no policy yet; malformed metadata hides content.
        if (raw == null) raw = new JSONArray();
        JSONArray ids = raw instanceof JSONArray ? (JSONArray) raw : null;
        if (ids == null || ids.length() > 4096) { target.put("protectedConversationIds", new JSONArray().put("*")); return; }
        JSONArray validated = new JSONArray();
        for (int i = 0; i < ids.length(); i++) {
            Object id = ids.opt(i);
            if (!(id instanceof String) || ((String) id).isEmpty() || ((String) id).length() > 128) {
                target.put("protectedConversationIds", new JSONArray().put("*")); return;
            }
            validated.put(id);
        }
        target.put("protectedConversationIds", validated);
    }

    static synchronized boolean hideNotificationContent(Context context, Map<String, String> data) {
        if (context == null || data == null) return true;
        try {
            JSONObject account = find(registry(context).optJSONArray("accounts"), data.get("recipientUserId"), data.get("recipientDeviceId"));
            if (account == null) return true;
            JSONArray stored = account.optJSONArray("protectedConversationIds");
            List<String> ids = new ArrayList<>();
            if (stored != null) {
                for (int i = 0; i < stored.length(); i++) {
                    Object id = stored.opt(i);
                    if (!(id instanceof String)) return true;
                    ids.add((String) id);
                }
            } else if (account.has("protectedConversationIds")) return true;
            return NivraNotificationPrivacyPolicy.hide(account.optBoolean("hideNotificationContent", false), ids, data.get("conversationId"));
        } catch (Exception unavailable) { return true; }
    }

    private static Map<String, String> notificationPrivacySnapshots(JSONObject root) {
        Map<String, String> snapshots = new HashMap<>();
        JSONArray accounts = root.optJSONArray("accounts");
        if (accounts == null) return snapshots;
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject account = accounts.optJSONObject(i);
            if (account != null) snapshots.put(NivraPushScopePolicy.notificationTag(account.optString("userId"), account.optString("deviceId")), privacyStamp(account));
        }
        return snapshots;
    }

    private static String privacyStamp(JSONObject account) {
        return account.optBoolean("hideNotificationContent", false) + ":" + account.optString("protectedConversationIds", "[]");
    }

    private static boolean previousPrivacyHid(String stamp, String conversationId) {
        if (stamp == null) return false;
        try {
            JSONArray ids = new JSONArray(stamp.substring(stamp.indexOf(':') + 1));
            List<String> protectedIds = new ArrayList<>();
            for (int i = 0; i < ids.length(); i++) protectedIds.add(ids.getString(i));
            return NivraNotificationPrivacyPolicy.hide(stamp.startsWith("true:"), protectedIds, conversationId);
        } catch (Exception malformed) { return true; }
    }

    /** Remove already visible previews without terminating a call or invalidating its actions. */
    private static void clearNewlyProtectedNotifications(Context context, JSONObject root, Map<String, String> previousPrivacy) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        JSONArray accounts = root.optJSONArray("accounts");
        if (accounts == null) return;
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject account = accounts.optJSONObject(i);
            if (account == null) continue;
            String user = account.optString("userId"), device = account.optString("deviceId");
            String tag = NivraPushScopePolicy.notificationTag(user, device);
            if (privacyStamp(account).equals(previousPrivacy.get(tag))) continue;
            if (manager != null) try {
                for (StatusBarNotification active : manager.getActiveNotifications()) {
                    android.app.Notification notification = active.getNotification();
                    // Foreground-service notifications are mandatory; never remove their call ownership.
                    if (!tag.equals(active.getTag()) || (notification.flags & android.app.Notification.FLAG_FOREGROUND_SERVICE) != 0) continue;
                    Map<String, String> route = new HashMap<>();
                    route.put("recipientUserId", user); route.put("recipientDeviceId", device);
                    route.put("conversationId", notification.extras == null ? "" : notification.extras.getString("nivraConversationId", ""));
                    if (hideNotificationContent(context, route) && !previousPrivacyHid(previousPrivacy.get(tag), route.get("conversationId")))
                        NotificationManagerCompat.from(context).cancel(tag, active.getId());
                }
            } catch (RuntimeException ignored) { }
            context.sendBroadcast(new Intent(ACTION_PRIVACY_CHANGED).setPackage(context.getPackageName())
                .putExtra("recipientUserId", user).putExtra("recipientDeviceId", device));
        }
    }

    /** Returns only the active account for the existing foreground call bridge. */
    static synchronized JSONObject read(Context context) {
        try {
            JSONObject root = registry(context);
            return find(root.optJSONArray("accounts"), root.optString("activeUserId"), root.optString("activeDeviceId"));
        } catch (IllegalStateException unavailable) { return null; }
    }

    static synchronized List<JSONObject> readAll(Context context) {
        List<JSONObject> values = new ArrayList<>();
        try {
            JSONArray accounts = registry(context).optJSONArray("accounts");
            for (int i = 0; i < accounts.length(); i++) if (accounts.optJSONObject(i) != null) values.add(accounts.optJSONObject(i));
        } catch (IllegalStateException unavailable) { }
        return values;
    }

    private static JSONObject registry(Context context) {
        try {
            SharedPreferences state = prefs(context);
            String encrypted = state.getString("ciphertext", ""), iv = state.getString("iv", "");
            if ((encrypted == null || encrypted.isEmpty()) && (iv == null || iv.isEmpty())) return emptyRegistry();
            if (encrypted != null && !encrypted.isEmpty() && iv != null && !iv.isEmpty()) {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
                JSONObject value = new JSONObject(new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8));
                if (value.optJSONArray("accounts") != null) return value;
                // Migrate release 5's single encrypted session without rotating its credentials.
                if (!value.optString("userId").isEmpty() && !value.optString("deviceId").isEmpty()) {
                    value.put("registeredAt", state.getLong("registeredAt", 0)).put("registeredToken", state.getString("registeredToken", ""))
                        .put("pendingToken", state.getString("pendingToken", "")).put("fcmReady", state.getBoolean("fcmReady", false));
                    return emptyRegistry().put("accounts", new JSONArray().put(value)).put("activeUserId", value.optString("userId"))
                        .put("activeDeviceId", value.optString("deviceId")).put("routingToken", state.getString("registeredToken", state.getString("pendingToken", "")));
                }
            }
            throw new IllegalStateException("Invalid encrypted push registry.");
        } catch (Exception unavailable) {
            // Never replace an unreadable registry with an empty one: a brief
            // Keystore failure must preserve the other account and wipe markers.
            throw new IllegalStateException("Encrypted push registry is unavailable.", unavailable);
        }
    }

    private static JSONObject emptyRegistry() {
        try { return new JSONObject().put("version", 2).put("accounts", new JSONArray()).put("pendingWipes", new JSONArray()); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    private static void write(Context context, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        if (!prefs(context).edit().putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .remove("registeredAt").remove("registeredToken").remove("pendingToken").remove("fcmReady").commit())
            throw new IllegalStateException("Could not persist push registration.");
    }

    /** Backward compatibility: an unscoped logout clears the active account only. */
    static synchronized void clear(Context context) {
        JSONObject active = read(context);
        if (active != null) clear(context, active.optString("userId"), active.optString("deviceId"));
    }

    static synchronized void clear(Context context, String user, String device) {
        if (user == null || device == null || user.isEmpty() || device.isEmpty()) return;
        try {
            JSONObject root = registry(context);
            removeScope(root, user, device);
            write(context, root);
            clearNotifications(context, user, device);
            if (root.optJSONArray("accounts").length() == 0) cancelWork(context);
        } catch (Exception error) { throw new IllegalStateException("Could not retire push account.", error); }
    }

    static synchronized void retireForWipe(Context context, Map<String, String> data) throws Exception {
        String user = data.get("recipientUserId"), device = data.get("recipientDeviceId");
        JSONObject root = registry(context);
        if (find(root.optJSONArray("accounts"), user, device) == null) return;
        JSONArray pending = root.optJSONArray("pendingWipes");
        if (indexOf(pending, user, device) < 0) pending.put(new JSONObject().put("userId", user).put("deviceId", device));
        removeScope(root, user, device);
        // Persist the revocation before JS receives it or any notification is published.
        write(context, root);
        clearNotifications(context, user, device);
        if (root.optJSONArray("accounts").length() == 0) cancelWork(context);
    }

    static synchronized JSONArray pendingWipes(Context context) { return registry(context).optJSONArray("pendingWipes"); }
    static synchronized void acknowledgeWipe(Context context, String user, String device) throws Exception {
        JSONObject root = registry(context);
        root.put("pendingWipes", without(root.optJSONArray("pendingWipes"), user, device));
        write(context, root);
    }

    private static void removeScope(JSONObject root, String user, String device) throws Exception {
        root.put("accounts", without(root.optJSONArray("accounts"), user, device));
        JSONObject markers = root.optJSONObject("callIntentMarkers");
        if (markers != null) {
            java.util.List<String> remove = new java.util.ArrayList<>();
            java.util.Iterator<String> keys = markers.keys();
            while (keys.hasNext()) { String key = keys.next(); JSONObject marker = markers.optJSONObject(key);
                if (marker != null && user.equals(marker.optString("userId")) && device.equals(marker.optString("deviceId"))) remove.add(key); }
            for (String key : remove) markers.remove(key);
        }
        if (user.equals(root.optString("activeUserId")) && device.equals(root.optString("activeDeviceId"))) root.remove("activeUserId");
        JSONObject pending = root.optJSONObject("pendingIntent");
        if (pending != null && user.equals(pending.optString("recipientUserId")) && device.equals(pending.optString("recipientDeviceId"))) root.remove("pendingIntent");
    }

    static synchronized void savePendingIntent(Context context, JSONObject data) throws Exception {
        JSONObject root = registry(context);
        if (find(root.optJSONArray("accounts"), data.optString("recipientUserId"), data.optString("recipientDeviceId")) == null) return;
        root.put("pendingIntent", data);
        write(context, root);
    }
    static synchronized JSONObject pendingIntent(Context context) { return registry(context).optJSONObject("pendingIntent"); }
    static synchronized void clearPendingIntent(Context context, String expectedIntentId) throws Exception {
        JSONObject root = registry(context);
        JSONObject pending = root.optJSONObject("pendingIntent");
        if (pending == null || !NivraNotificationIntentPolicy.sameIntent(pending.optString("nivraIntentId"), expectedIntentId)) return;
        root.remove("pendingIntent"); write(context, root);
    }

    /** Bind a call PendingIntent to its exact recipient and command, not its exported entry activity. */
    static synchronized boolean signCallIntent(Context context, Intent intent) {
        String callId = intent.getStringExtra("callId");
        if (callId == null || callId.isEmpty()) return true;
        try {
            JSONObject root = registry(context);
            String user = intent.getStringExtra("recipientUserId"), device = intent.getStringExtra("recipientDeviceId");
            JSONObject account = find(root.optJSONArray("accounts"), user, device);
            if (account == null) return false;
            String type = intent.getStringExtra("type");
            boolean ringing = type == null || type.replace('_', '-').equalsIgnoreCase("incoming-call") || "incomingcall".equalsIgnoreCase(type);
            long now = System.currentTimeMillis(), expiry = now + (ringing ? 75_000 : 86_400_000);
            String declared = intent.getStringExtra("expiresAt");
            if (ringing && declared != null && !declared.isEmpty()) expiry = Math.min(expiry, Long.parseLong(declared));
            if (expiry <= now) return false;
            JSONObject markers = root.optJSONObject("callIntentMarkers");
            if (markers == null) markers = new JSONObject();
            java.util.List<String> expired = new java.util.ArrayList<>();
            java.util.Iterator<String> names = markers.keys();
            while (names.hasNext()) { String name = names.next(); JSONObject prior = markers.optJSONObject(name);
                if (prior == null || prior.optLong("expiresAt") <= now || find(root.optJSONArray("accounts"), prior.optString("userId"), prior.optString("deviceId")) == null) expired.add(name); }
            for (String name : expired) markers.remove(name);
            String key = NivraNotificationIntentPolicy.key(user, device, callId, intent.getAction() == null ? "" : intent.getAction(), intent.getStringExtra("action") == null ? "" : intent.getStringExtra("action"));
            JSONObject marker = markers.optJSONObject(key);
            String notificationEpoch = account.optString("notificationEpoch", account.optString("epoch"));
            if (marker == null || !notificationEpoch.equals(marker.optString("epoch"))) {
                if (markers.length() >= 96) return false;
                marker = new JSONObject().put("token", java.util.UUID.randomUUID().toString()).put("expiresAt", expiry)
                    .put("userId", user).put("deviceId", device).put("epoch", notificationEpoch);
                markers.put(key, marker); root.put("callIntentMarkers", markers); write(context, root);
            }
            intent.putExtra("nivraCallIntentMarker", marker.getString("token"));
            return true;
        } catch (Exception unavailable) { return false; }
    }

    static synchronized boolean acceptsCallIntent(Context context, Intent intent) {
        String callId = intent.getStringExtra("callId");
        if (callId == null || callId.isEmpty()) return true;
        try {
            JSONObject root = registry(context);
            String user = intent.getStringExtra("recipientUserId"), device = intent.getStringExtra("recipientDeviceId");
            JSONObject account = find(root.optJSONArray("accounts"), user, device);
            if (account == null) return false;
            JSONObject markers = root.optJSONObject("callIntentMarkers");
            String key = NivraNotificationIntentPolicy.key(user, device, callId, intent.getAction() == null ? "" : intent.getAction(), intent.getStringExtra("action") == null ? "" : intent.getStringExtra("action"));
            JSONObject marker = markers == null ? null : markers.optJSONObject(key);
            return marker != null && account.optString("notificationEpoch", account.optString("epoch")).equals(marker.optString("epoch")) && NivraNotificationIntentPolicy.validMarker(marker.optString("token"), intent.getStringExtra("nivraCallIntentMarker"), marker.optLong("expiresAt"), System.currentTimeMillis());
        } catch (Exception unavailable) { return false; }
    }

    static boolean isScopeChange(String priorUserId, String priorDeviceId, String nextUserId, String nextDeviceId) {
        return priorUserId != null && !priorUserId.isEmpty() && (!priorUserId.equals(nextUserId) || !java.util.Objects.equals(priorDeviceId, nextDeviceId));
    }

    static void clearNotifications(Context context, String user, String device) {
        clearNotifications(context, user, device, false);
    }

    private static void clearCallNotifications(Context context, String user, String device) {
        clearNotifications(context, user, device, true);
    }

    private static void clearNotifications(Context context, String user, String device, boolean callsOnly) {
        NivraNativePlugin.discardPendingCallActions(user, device);
        String tag = NivraPushScopePolicy.notificationTag(user, device);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) try {
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                if (tag.equals(active.getTag()) && (!callsOnly || android.app.Notification.CATEGORY_CALL.equals(active.getNotification().category))) NotificationManagerCompat.from(context).cancel(tag, active.getId());
            }
        } catch (RuntimeException ignored) { }
        // Call IDs are only acted on through the matching account scope.
        NivraOngoingCallService.stopScope(context, user, device);
        context.sendBroadcast(new Intent(NivraNativePlugin.ACTION_CALL_DISMISS).setPackage(context.getPackageName())
            .putExtra("scopeAll", true).putExtra("recipientUserId", user).putExtra("recipientDeviceId", device));
    }

    static synchronized void tokenChanged(Context context, String token) {
        if (token == null || token.trim().isEmpty()) return;
        try {
            JSONObject root = registry(context);
            boolean replaced = !token.equals(root.optString("routingToken"));
            root.put("routingToken", token);
            JSONArray accounts = root.optJSONArray("accounts");
            boolean pending = false;
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i);
                if (registrationFresh(token, account.optString("registeredToken"), account.optLong("registeredAt"), System.currentTimeMillis(), account.optBoolean("fcmReady")) && account.optString("pendingToken").isEmpty()) continue;
                account.put("pendingToken", token); pending = true;
            }
            write(context, root);
            if (!pending) return;
            enqueueRegistration(context, replaced ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.KEEP);
        } catch (Exception ignored) { queueTokenRepair(context); }
    }

    static boolean registrationFresh(String token, String registeredToken, long registeredAt, long now, boolean fcmReady) {
        return token != null && !token.isEmpty() && token.equals(registeredToken) && fcmReady && registeredAt > 0 && now >= registeredAt && now - registeredAt < REGISTRATION_FRESH_MS;
    }

    private static void schedule(Context context) {
        // Replace a worker holding an older account epoch even when the physical
        // FCM token did not change. KEEP could otherwise strand the newly added
        // account until the next periodic maintenance window.
        for (JSONObject account : readAll(context)) {
            if (!account.optString("pendingToken").isEmpty()) { enqueueRegistration(context, ExistingWorkPolicy.REPLACE); break; }
        }
        PeriodicWorkRequest maintenance = new PeriodicWorkRequest.Builder(NivraPushMaintenanceWorker.class, 12, TimeUnit.HOURS, 1, TimeUnit.HOURS)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(MAINTENANCE_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, maintenance);
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> tokenChanged(context, token)).addOnFailureListener(unavailable -> queueTokenRepair(context));
    }
    private static void enqueueRegistration(Context context, ExistingWorkPolicy policy) {
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(NivraPushRegistrationWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build();
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, policy, work);
    }
    private static synchronized void queueTokenRepair(Context context) {
        if (readAll(context).isEmpty()) return;
        OneTimeWorkRequest repair = new OneTimeWorkRequest.Builder(NivraPushMaintenanceWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build();
        WorkManager.getInstance(context).enqueueUniqueWork(TOKEN_REPAIR_WORK_NAME, ExistingWorkPolicy.KEEP, repair);
    }
    private static void cancelWork(Context context) {
        WorkManager work = WorkManager.getInstance(context);
        work.cancelUniqueWork(WORK_NAME); work.cancelUniqueWork(MAINTENANCE_WORK_NAME); work.cancelUniqueWork(TOKEN_REPAIR_WORK_NAME);
    }

    static synchronized boolean isCurrent(Context context, JSONObject snapshot, String token) {
        try {
            JSONObject value = find(registry(context).optJSONArray("accounts"), snapshot.optString("userId"), snapshot.optString("deviceId"));
            return value != null && NivraPushScopePolicy.currentSnapshot(value.optString("epoch"), snapshot.optString("epoch"), value.optString("pendingToken"), token);
        } catch (IllegalStateException unavailable) { return false; }
    }
    static synchronized void registered(Context context, JSONObject snapshot, String token, boolean fcmReady) throws Exception {
        JSONObject root = registry(context);
        JSONObject value = find(root.optJSONArray("accounts"), snapshot.optString("userId"), snapshot.optString("deviceId"));
        if (value == null || !NivraPushScopePolicy.currentSnapshot(value.optString("epoch"), snapshot.optString("epoch"), value.optString("pendingToken"), token)) return;
        value.put("registeredAt", System.currentTimeMillis()).put("registeredToken", token).put("fcmReady", fcmReady).remove("pendingToken");
        write(context, root);
    }
    static synchronized boolean accepts(Context context, Map<String, String> data) {
        try { return find(registry(context).optJSONArray("accounts"), data.get("recipientUserId"), data.get("recipientDeviceId")) != null; }
        catch (IllegalStateException unavailable) { return false; }
    }
    static synchronized boolean isActive(Context context, Map<String, String> data) {
        try {
            JSONObject root = registry(context);
            return NivraPushScopePolicy.matches(root.optString("activeUserId"), root.optString("activeDeviceId"), data.get("recipientUserId"), data.get("recipientDeviceId")) && accepts(context, data);
        } catch (IllegalStateException unavailable) { return false; }
    }

    private static JSONObject find(JSONArray values, String user, String device) { int index = indexOf(values, user, device); return index < 0 ? null : values.optJSONObject(index); }
    private static int indexOf(JSONArray values, String user, String device) {
        if (values == null) return -1;
        for (int i = 0; i < values.length(); i++) {
            JSONObject value = values.optJSONObject(i);
            if (value != null && NivraPushScopePolicy.matches(value.optString("userId"), value.optString("deviceId"), user, device)) return i;
        }
        return -1;
    }
    private static JSONArray without(JSONArray values, String user, String device) {
        JSONArray next = new JSONArray();
        if (values != null) for (int i = 0; i < values.length(); i++) {
            JSONObject value = values.optJSONObject(i);
            if (value != null && !NivraPushScopePolicy.matches(value.optString("userId"), value.optString("deviceId"), user, device)) next.put(value);
        }
        return next;
    }

    static boolean isAllowedApiOrigin(String value) {
        try {
            URI origin = URI.create(value);
            return "https".equalsIgnoreCase(origin.getScheme()) &&
                ("nivra-webapp-secure.onrender.com".equalsIgnoreCase(origin.getHost()) || "nivrapp-secure.onrender.com".equalsIgnoreCase(origin.getHost()) || "nivrapp-secure-eaqi.onrender.com".equalsIgnoreCase(origin.getHost())) &&
                (origin.getPort() == -1 || origin.getPort() == 443) && origin.getUserInfo() == null && origin.getRawQuery() == null && origin.getRawFragment() == null &&
                (origin.getRawPath() == null || origin.getRawPath().isEmpty());
        } catch (RuntimeException ignored) { return false; }
    }
    static void diagnostics(Context context, JSObject result) {
        List<JSONObject> accounts = readAll(context);
        long registeredAt = 0; boolean pending = false, ready = !accounts.isEmpty();
        for (JSONObject account : accounts) { registeredAt = Math.max(registeredAt, account.optLong("registeredAt")); pending |= !account.optString("pendingToken").isEmpty(); ready &= account.optBoolean("fcmReady"); }
        result.put("nativePushSessionReady", !accounts.isEmpty()); result.put("nativePushAccountCount", accounts.size());
        result.put("nativePushRegisteredAt", registeredAt); result.put("nativePushRegistrationPending", pending); result.put("nativePushFcmReady", ready);
    }
    private static SharedPreferences prefs(Context context) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private static SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
}
