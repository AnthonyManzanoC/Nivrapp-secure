package com.nivra.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Parcelable;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.ContactsContract;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONArray;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

@CapacitorPlugin(
    name = "NivraNative",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = NivraNativePlugin.CONTACTS)
    }
)
public class NivraNativePlugin extends Plugin {
    static final String CONTACTS = "contacts";
    static final String CHANNEL_CALLS = "nivra_calls";
    static final String ACTION_CALL_OPEN = "com.nivra.app.CALL_OPEN";
    static final String ACTION_CALL_ANSWER = "com.nivra.app.CALL_ANSWER";
    static final String ACTION_CALL_REJECT = "com.nivra.app.CALL_REJECT";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String SECURE_VAULT_PREFS = "nivra_secure_vault";
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final int MAX_DEVICE_CONTACTS = 5000;
    private static WeakReference<NivraNativePlugin> activePlugin = new WeakReference<>(null);
    private static final List<JSObject> pendingCallActions = new ArrayList<>();
    private static final List<JSObject> pendingShareIntents = new ArrayList<>();
    private static final Set<String> knownSharedUris = new HashSet<>();
    private final Map<String, SaveSession> saveSessions = new HashMap<>();
    private final ExecutorService contactsExecutor = Executors.newSingleThreadExecutor();
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private SensorManager sensorManager;
    private Sensor proximitySensor;
    private Sensor accelerometerSensor;
    private boolean raiseListenEnabled;
    private boolean raiseTalkEnabled;
    private boolean phoneNear;
    private boolean liftedRecently = true;
    private long lastLiftAt;
    private long lastRaiseEventAt;
    private final SensorEventListener raiseSensorListener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            if (event.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
                float z = event.values.length > 2 ? event.values[2] : 0;
                float y = event.values.length > 1 ? event.values[1] : 0;
                liftedRecently = Math.abs(z) > 6.5f || Math.abs(y) > 5.5f;
                if (liftedRecently) {
                    lastLiftAt = SystemClock.elapsedRealtime();
                }
                return;
            }
            if (event.sensor.getType() != Sensor.TYPE_PROXIMITY) {
                return;
            }
            float max = proximitySensor == null ? 5f : proximitySensor.getMaximumRange();
            boolean near = event.values.length > 0 && event.values[0] < Math.max(1f, max * 0.25f);
            if (near == phoneNear) {
                return;
            }
            phoneNear = near;
            if (near) {
                emitRaiseGesture();
            }
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {
        }
    };

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
        flushPendingCallActions();
        flushPendingShareIntents();
    }

    @PluginMethod
    public void setSecureScreen(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        Activity activity = getActivity();
        if (activity == null) {
            JSObject result = new JSObject();
            result.put("enabled", false);
            call.resolve(result);
            return;
        }
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            if (enabled) {
                window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            JSObject result = new JSObject();
            result.put("enabled", enabled);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setAudioFocus(PluginCall call) {
        boolean active = call.getBoolean("active", false);
        String mode = call.getString("mode", "playback");
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            JSObject result = new JSObject();
            result.put("active", false);
            call.resolve(result);
            return;
        }
        if (active) {
            requestAudioFocus(mode);
        } else {
            abandonAudioFocus();
        }
        JSObject result = new JSObject();
        result.put("active", active);
        call.resolve(result);
    }

    @PluginMethod
    public void configureRaiseGestures(PluginCall call) {
        raiseListenEnabled = call.getBoolean("listen", false);
        raiseTalkEnabled = call.getBoolean("talk", false);
        boolean enabled = raiseListenEnabled || raiseTalkEnabled;
        configureRaiseSensors(enabled);
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        result.put("hasProximitySensor", proximitySensor != null);
        result.put("hasAccelerometer", accelerometerSensor != null);
        call.resolve(result);
    }

    @PluginMethod
    public void diagnostics(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        result.put("packageName", getContext().getPackageName());
        result.put("osVersion", Build.VERSION.RELEASE);
        result.put("sdkInt", Build.VERSION.SDK_INT);
        result.put("manufacturer", Build.MANUFACTURER);
        result.put("model", Build.MODEL);
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            result.put("appVersion", info.versionName);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                result.put("appBuild", String.valueOf(info.getLongVersionCode()));
            } else {
                result.put("appBuild", String.valueOf(info.versionCode));
            }
        } catch (Exception ignored) {
            result.put("appVersion", "");
            result.put("appBuild", "");
        }
        putSigningDiagnostics(result);
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null) {
            ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(memoryInfo);
            result.put("memoryClassMb", manager.getMemoryClass());
            result.put("availableMemoryMb", memoryInfo.availMem / 1024 / 1024);
            result.put("lowMemory", memoryInfo.lowMemory);
        }
        PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (powerManager != null) {
            result.put("powerSaveMode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && powerManager.isPowerSaveMode());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                result.put("thermalStatus", powerManager.getCurrentThermalStatus());
            } else {
                result.put("thermalStatus", 0);
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void getOrCreateSecureSecret(PluginCall call) {
        String name = secureSecretName(call.getString("name", ""));
        if (!isAllowedSecureSecretName(name)) {
            call.reject("Nombre de secreto no permitido.");
            return;
        }

        try {
            String secret = readSecureSecret(name);
            boolean created = false;
            if (secret == null || secret.isEmpty()) {
                secret = createSecureSecret(name);
                created = true;
            }
            JSObject result = new JSObject();
            result.put("name", name);
            result.put("secret", secret);
            result.put("created", created);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("No se pudo abrir el secreto local seguro.", error);
        }
    }

    @PluginMethod
    public void clearSecureSecret(PluginCall call) {
        String name = secureSecretName(call.getString("name", ""));
        try {
            if (name.isEmpty() || "all".equals(name)) {
                clearAllSecureSecrets(getContext());
            } else if (isAllowedSecureSecretName(name)) {
                clearSecureSecretName(name);
            } else {
                call.reject("Nombre de secreto no permitido.");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo destruir el secreto local seguro.", error);
        }
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        String value = call.getString("value", "");
        String label = call.getString("label", "Nivra");
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText(label, value));
        }
        call.resolve();
    }

    @PluginMethod
    public void getDeviceContacts(PluginCall call) {
        boolean requestPermission = call.getBoolean("requestPermission", true);
        if (getPermissionState(CONTACTS) != PermissionState.GRANTED) {
            if (!requestPermission) {
                call.reject("Permiso de contactos no concedido.");
                return;
            }
            requestPermissionForAlias(CONTACTS, call, "deviceContactsPermissionCallback");
            return;
        }
        readDeviceContacts(call);
    }

    @PermissionCallback
    private void deviceContactsPermissionCallback(PluginCall call) {
        if (getPermissionState(CONTACTS) != PermissionState.GRANTED) {
            call.reject("Permiso de contactos no concedido.");
            return;
        }
        readDeviceContacts(call);
    }

    @PluginMethod
    public void saveFileChunkedStart(PluginCall call) {
        try {
            String fileName = sanitizeFileName(call.getString("fileName", "nivra-file.bin"));
            String mimeType = call.getString("mimeType", "application/octet-stream");
            boolean publicSave = call.getBoolean("public", false);
            String mediaKind = call.getString("mediaKind", "document");
            SaveSession session = openSaveSession(fileName, mimeType, publicSave, mediaKind);
            saveSessions.put(session.id, session);
            JSObject result = new JSObject();
            result.put("sessionId", session.id);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("No se pudo preparar el guardado del archivo.", error);
        }
    }

    @PluginMethod
    public void saveFileChunk(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        SaveSession session = saveSessions.get(sessionId);
        if (session == null) {
            call.reject("Sesion de guardado no encontrada.");
            return;
        }
        try {
            byte[] data = Base64.decode(call.getString("base64", ""), Base64.DEFAULT);
            session.output.write(data);
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo escribir el fragmento del archivo.", error);
        }
    }

    @PluginMethod
    public void saveFileChunkedFinish(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        SaveSession session = saveSessions.remove(sessionId);
        if (session == null) {
            call.reject("Sesion de guardado no encontrada.");
            return;
        }
        try {
            session.output.flush();
            session.output.close();
            finishPublicMedia(session);
            JSObject result = new JSObject();
            result.put("uri", session.uri == null ? "" : session.uri.toString());
            result.put("path", session.path == null ? "" : session.path);
            result.put("public", session.publicSave);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("No se pudo finalizar el archivo.", error);
        }
    }

    @PluginMethod
    public void saveFileChunkedAbort(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        SaveSession session = saveSessions.remove(sessionId);
        if (session != null) {
            try {
                session.output.close();
            } catch (Exception ignored) {
            }
            deleteSessionTarget(session);
        }
        call.resolve();
    }

    @PluginMethod
    public void showIncomingCall(PluginCall call) {
        Map<String, String> data = new HashMap<>();
        data.put("callId", call.getString("callId", ""));
        data.put("callerName", call.getString("callerName", "Nivra"));
        data.put("callerUserId", call.getString("callerUserId", ""));
        data.put("callType", call.getString("callType", "Voice"));
        data.put("conversationId", call.getString("conversationId", ""));
        showIncomingCallNotification(getContext(), data);
        call.resolve();
    }

    @PluginMethod
    public void clearIncomingCall(PluginCall call) {
        String callId = call.getString("callId", "");
        clearIncomingCallNotification(getContext(), callId);
        call.resolve();
    }

    @PluginMethod
    public void getPendingShareIntent(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (pendingShareIntents) {
            result.put(
                "share",
                pendingShareIntents.isEmpty() ? null : pendingShareIntents.get(pendingShareIntents.size() - 1)
            );
        }
        call.resolve(result);
    }

    @PluginMethod
    public void clearPendingShareIntent(PluginCall call) {
        String id = call.getString("id", "");
        synchronized (pendingShareIntents) {
            if (id.trim().isEmpty()) {
                pendingShareIntents.clear();
            } else {
                for (int index = pendingShareIntents.size() - 1; index >= 0; index -= 1) {
                    if (id.equals(pendingShareIntents.get(index).optString("id", ""))) {
                        pendingShareIntents.remove(index);
                    }
                }
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void readSharedFileChunk(PluginCall call) {
        String uriValue = call.getString("uri", "");
        if (uriValue.trim().isEmpty() || !isKnownSharedUri(uriValue)) {
            call.reject("Archivo compartido no disponible.");
            return;
        }

        int offset = Math.max(0, call.getInt("offset", 0));
        int length = Math.max(1, Math.min(call.getInt("length", 384 * 1024), 512 * 1024));
        Uri uri = Uri.parse(uriValue);
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) {
                call.reject("No se pudo abrir el archivo compartido.");
                return;
            }
            skipFully(input, offset);
            byte[] buffer = new byte[length];
            int total = 0;
            while (total < length) {
                int read = input.read(buffer, total, length - total);
                if (read < 0) {
                    break;
                }
                total += read;
            }

            byte[] out = total == buffer.length ? buffer : java.util.Arrays.copyOf(buffer, total);
            JSObject result = new JSObject();
            result.put("base64", Base64.encodeToString(out, Base64.NO_WRAP));
            result.put("bytesRead", total);
            result.put("eof", total < length);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("No se pudo leer el archivo compartido.", error);
        }
    }

    public static void showIncomingCallNotification(Context context, Map<String, String> data) {
        if (context == null || data == null) {
            return;
        }
        String callId = firstNonBlank(data.get("callId"), data.get("tag"), "nivra-call");
        int notificationId = notificationId(callId);
        ensureCallChannel(context);
        wakeForIncomingCall(context);

        PendingIntent openIntent = activityIntent(context, ACTION_CALL_OPEN, data, notificationId);
        PendingIntent answerIntent = receiverIntent(context, ACTION_CALL_ANSWER, data, notificationId);
        PendingIntent rejectIntent = receiverIntent(context, ACTION_CALL_REJECT, data, notificationId);
        String callerName = firstNonBlank(data.get("callerName"), data.get("title"), "Nivra");
        String callType = firstNonBlank(data.get("callType"), "Voice", "Voice");
        boolean video = "Video".equalsIgnoreCase(callType);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(callerName)
            .setContentText(video ? "Videollamada entrante" : "Llamada entrante")
            .setContentIntent(openIntent)
            .setFullScreenIntent(openIntent, true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setVibrate(new long[] { 320, 140, 320, 140, 480 })
            .setTimeoutAfter(75_000)
            .addAction(android.R.drawable.ic_menu_call, "Contestar", answerIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Rechazar", rejectIntent);

        if (!canPostNotifications(context)) {
            return;
        }
        NotificationManagerCompat.from(context).notify(notificationId, builder.build());
    }

    public static void clearIncomingCallNotification(Context context, String callId) {
        if (context == null || callId == null || callId.trim().isEmpty()) {
            return;
        }
        NotificationManagerCompat.from(context).cancel(notificationId(callId));
    }

    public static boolean handleCallIntent(Intent intent) {
        if (intent == null) {
            return false;
        }
        String action = intent.getAction();
        String mappedAction = "";
        if (ACTION_CALL_ANSWER.equals(action)) {
            mappedAction = "answer";
        } else if (ACTION_CALL_REJECT.equals(action)) {
            mappedAction = "reject";
        } else if (ACTION_CALL_OPEN.equals(action) || "com.nivra.app.OPEN_PUSH".equals(action)) {
            String pushAction = intent.getStringExtra("action");
            if ("accept".equals(pushAction)) {
                mappedAction = "answer";
            } else if ("decline".equals(pushAction) || "reject".equals(pushAction)) {
                mappedAction = "reject";
            } else if (hasCallId(intent)) {
                mappedAction = "open";
            }
        }
        if (mappedAction.isEmpty()) {
            return false;
        }
        JSObject payload = callPayload(intent, mappedAction);
        NivraNativePlugin plugin = activePlugin.get();
        if (plugin != null) {
            plugin.notifyListeners("nativeCallAction", payload, true);
            return true;
        } else {
            synchronized (pendingCallActions) {
                pendingCallActions.add(payload);
            }
        }
        return false;
    }

    public static boolean handleShareIntent(Context context, Intent intent) {
        if (context == null || intent == null || !isShareAction(intent.getAction())) {
            return false;
        }

        JSObject payload = sharePayload(context, intent);
        if (payload == null || sharePayloadIsEmpty(payload)) {
            return false;
        }

        synchronized (pendingShareIntents) {
            pendingShareIntents.add(payload);
        }

        NivraNativePlugin plugin = activePlugin.get();
        if (plugin != null) {
            plugin.notifyListeners("nativeShareIntent", payload, true);
            return true;
        }
        return false;
    }

    public static boolean hasActivePlugin() {
        return activePlugin.get() != null;
    }

    private void flushPendingCallActions() {
        synchronized (pendingCallActions) {
            for (JSObject payload : pendingCallActions) {
                notifyListeners("nativeCallAction", payload, true);
            }
            pendingCallActions.clear();
        }
    }

    private void flushPendingShareIntents() {
        synchronized (pendingShareIntents) {
            for (JSObject payload : pendingShareIntents) {
                notifyListeners("nativeShareIntent", payload, true);
            }
        }
    }

    private void putSigningDiagnostics(JSObject result) {
        try {
            PackageInfo info;
            Signature[] signatures;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info = getContext().getPackageManager().getPackageInfo(
                    getContext().getPackageName(),
                    PackageManager.GET_SIGNING_CERTIFICATES
                );
                signatures = info.signingInfo == null
                    ? new Signature[0]
                    : info.signingInfo.hasMultipleSigners()
                        ? info.signingInfo.getApkContentsSigners()
                        : info.signingInfo.getSigningCertificateHistory();
            } else {
                info = getContext().getPackageManager().getPackageInfo(
                    getContext().getPackageName(),
                    PackageManager.GET_SIGNATURES
                );
                signatures = info.signatures;
            }
            if (signatures != null && signatures.length > 0) {
                byte[] cert = signatures[0].toByteArray();
                result.put("signingSha1", digestHex("SHA-1", cert));
                result.put("signingSha256", digestHex("SHA-256", cert));
            }
        } catch (Exception ignored) {
            result.put("signingSha1", "");
            result.put("signingSha256", "");
        }
    }

    private static String digestHex(String algorithm, byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance(algorithm).digest(value);
        StringBuilder builder = new StringBuilder();
        for (byte item : digest) {
            if (builder.length() > 0) {
                builder.append(':');
            }
            builder.append(String.format("%02X", item));
        }
        return builder.toString();
    }

    private void readDeviceContacts(PluginCall call) {
        int limit = Math.max(1, Math.min(call.getInt("limit", MAX_DEVICE_CONTACTS), MAX_DEVICE_CONTACTS));
        contactsExecutor.execute(() -> {
            try {
                JSObject result = new JSObject();
                result.put("permission", "granted");
                result.put("contacts", queryDeviceContacts(limit));
                call.resolve(result);
            } catch (SecurityException error) {
                call.reject("Nivra no tiene permiso para leer contactos.", error);
            } catch (Exception error) {
                call.reject("No se pudieron leer los contactos del dispositivo.", error);
            }
        });
    }

    private JSONArray queryDeviceContacts(int limit) {
        ContentResolver resolver = getContext().getContentResolver();
        String[] projection = {
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY,
            ContactsContract.CommonDataKinds.Phone.NUMBER
        };
        Map<String, DeviceContact> contacts = new LinkedHashMap<>();

        try (Cursor cursor = resolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection,
            null,
            null,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY + " COLLATE LOCALIZED ASC"
        )) {
            if (cursor == null) {
                return new JSONArray();
            }

            while (cursor.moveToNext() && contacts.size() < limit) {
                String contactId = cursor.getString(0);
                String displayName = cursor.getString(1);
                String number = cursor.getString(2);
                if (number == null || number.trim().isEmpty()) {
                    continue;
                }
                String key = firstNonBlank(contactId, displayName, number);
                DeviceContact contact = contacts.get(key);
                if (contact == null) {
                    contact = new DeviceContact(contactId, displayName);
                    contacts.put(key, contact);
                }
                contact.addNumber(number);
            }
        }

        JSONArray items = new JSONArray();
        for (DeviceContact contact : contacts.values()) {
            items.put(contact.toJson());
        }
        return items;
    }

    private static boolean isShareAction(String action) {
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    private static JSObject sharePayload(Context context, Intent intent) {
        JSObject payload = new JSObject();
        payload.put("id", UUID.randomUUID().toString());
        payload.put("action", intent.getAction());
        payload.put("mimeType", firstNonBlank(intent.getType(), "", ""));
        payload.put("subject", charSequenceExtra(intent, Intent.EXTRA_SUBJECT));
        payload.put("text", charSequenceExtra(intent, Intent.EXTRA_TEXT));
        payload.put("at", System.currentTimeMillis());

        JSONArray files = new JSONArray();
        List<Uri> uris = sharedUris(intent);
        for (int index = 0; index < uris.size(); index += 1) {
            files.put(sharedFilePayload(context, uris.get(index), intent.getType(), index));
        }
        payload.put("files", files);
        return payload;
    }

    private static boolean sharePayloadIsEmpty(JSObject payload) {
        JSONArray files = payload.optJSONArray("files");
        return (files == null || files.length() == 0)
            && payload.optString("text", "").trim().isEmpty()
            && payload.optString("subject", "").trim().isEmpty();
    }

    private static List<Uri> sharedUris(Intent intent) {
        List<Uri> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index += 1) {
                addSharedUri(result, seen, clipData.getItemAt(index).getUri());
            }
        }

        ArrayList<Parcelable> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (streams != null) {
            for (Parcelable stream : streams) {
                if (stream instanceof Uri) {
                    addSharedUri(result, seen, (Uri) stream);
                }
            }
        }

        Parcelable stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream instanceof Uri) {
            addSharedUri(result, seen, (Uri) stream);
        }

        return result;
    }

    private static void addSharedUri(List<Uri> result, Set<String> seen, Uri uri) {
        if (uri == null) {
            return;
        }
        String value = uri.toString();
        if (seen.add(value)) {
            result.add(uri);
            synchronized (knownSharedUris) {
                knownSharedUris.add(value);
            }
        }
    }

    private static JSObject sharedFilePayload(Context context, Uri uri, String fallbackMime, int index) {
        ContentResolver resolver = context.getContentResolver();
        String mimeType = firstNonBlank(safeMimeType(resolver, uri), fallbackMime, "application/octet-stream");
        String name = "";
        long size = -1;

        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIndex >= 0) {
                    name = firstNonBlank(cursor.getString(nameIndex), "", "");
                }
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    size = cursor.getLong(sizeIndex);
                }
            }
        } catch (Exception ignored) {
        }

        if (name.trim().isEmpty()) {
            name = fileNameFromUri(uri, mimeType, index);
        }

        JSObject item = new JSObject();
        item.put("uri", uri.toString());
        item.put("name", sanitizeSharedFileName(name));
        item.put("mimeType", mimeType);
        item.put("size", size);
        return item;
    }

    private static String safeMimeType(ContentResolver resolver, Uri uri) {
        try {
            return resolver.getType(uri);
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String fileNameFromUri(Uri uri, String mimeType, int index) {
        String last = uri.getLastPathSegment();
        String clean = last == null ? "" : last.replaceAll(".*/", "").trim();
        if (!clean.isEmpty() && clean.length() <= 96) {
            return clean;
        }
        String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType);
        return "nivra-share-" + (index + 1) + (extension == null || extension.isEmpty() ? ".bin" : "." + extension);
    }

    private static String sanitizeSharedFileName(String value) {
        String cleaned = value == null ? "" : value.replaceAll("[\\\\/:*?\"<>|\\n\\r\\t]", "_").trim();
        return cleaned.isEmpty() ? "nivra-share.bin" : cleaned;
    }

    private static String charSequenceExtra(Intent intent, String key) {
        CharSequence value = intent.getCharSequenceExtra(key);
        return value == null ? "" : value.toString();
    }

    private static boolean isKnownSharedUri(String uriValue) {
        synchronized (knownSharedUris) {
            return knownSharedUris.contains(uriValue);
        }
    }

    private String createSecureSecret(String name) throws Exception {
        byte[] secretBytes = new byte[32];
        new SecureRandom().nextBytes(secretBytes);
        String secret = Base64.encodeToString(secretBytes, Base64.NO_WRAP);
        SecretKey key = getOrCreateKeystoreKey(name);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] ciphertext = cipher.doFinal(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        securePrefs().edit()
            .putString(secretPrefKey(name, "iv"), Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString(secretPrefKey(name, "ciphertext"), Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .apply();
        return secret;
    }

    private String readSecureSecret(String name) throws Exception {
        SharedPreferences prefs = securePrefs();
        String iv = prefs.getString(secretPrefKey(name, "iv"), "");
        String ciphertext = prefs.getString(secretPrefKey(name, "ciphertext"), "");
        if (iv == null || iv.isEmpty() || ciphertext == null || ciphertext.isEmpty()) {
            return "";
        }
        SecretKey key = getOrCreateKeystoreKey(name);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, Base64.decode(iv, Base64.NO_WRAP)));
        byte[] plain = cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP));
        return new String(plain, java.nio.charset.StandardCharsets.UTF_8);
    }

    private void clearSecureSecretName(String name) throws Exception {
        clearSecureSecretName(getContext(), name);
    }

    static void clearAllSecureSecrets(Context context) throws Exception {
        clearSecureSecretName(context, "local-db");
        clearSecureSecretName(context, "device-keys");
        clearSecureSecretName(context, "auth-session");
    }

    static void clearSecureSecretName(Context context, String name) throws Exception {
        context.getSharedPreferences(SECURE_VAULT_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(staticSecretPrefKey(name, "iv"))
            .remove(staticSecretPrefKey(name, "ciphertext"))
            .commit();
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        String alias = staticSecureKeystoreAlias(name);
        if (keyStore.containsAlias(alias)) {
            keyStore.deleteEntry(alias);
        }
    }

    private SecretKey getOrCreateKeystoreKey(String name) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        String alias = secureKeystoreAlias(name);
        if (keyStore.containsAlias(alias)) {
            return (SecretKey) keyStore.getKey(alias, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        generator.init(new KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private SharedPreferences securePrefs() {
        return getContext().getSharedPreferences(SECURE_VAULT_PREFS, Context.MODE_PRIVATE);
    }

    private String secureSecretName(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    private boolean isAllowedSecureSecretName(String name) {
        return "local-db".equals(name) || "device-keys".equals(name) || "auth-session".equals(name);
    }

    private String secureKeystoreAlias(String name) {
        return "nivra.secure." + name + ".v1";
    }

    private String secretPrefKey(String name, String field) {
        return "secret." + name + "." + field;
    }

    private static String staticSecureKeystoreAlias(String name) {
        return "nivra.secure." + name + ".v1";
    }

    private static String staticSecretPrefKey(String name, String field) {
        return "secret." + name + "." + field;
    }

    private static void skipFully(InputStream input, int offset) throws Exception {
        long remaining = offset;
        while (remaining > 0) {
            long skipped = input.skip(remaining);
            if (skipped > 0) {
                remaining -= skipped;
                continue;
            }
            if (input.read() < 0) {
                break;
            }
            remaining -= 1;
        }
    }

    private static void ensureCallChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel calls = new NotificationChannel(
            CHANNEL_CALLS,
            "Llamadas Nivra",
            NotificationManager.IMPORTANCE_HIGH
        );
        calls.setDescription("Llamadas y videollamadas entrantes");
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 320, 140, 320, 140, 480 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(calls);
        }
    }

    private static void wakeForIncomingCall(Context context) {
        PowerManager manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (manager == null) {
            return;
        }
        int flags = PowerManager.PARTIAL_WAKE_LOCK;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
            flags |= PowerManager.ACQUIRE_CAUSES_WAKEUP;
        }
        PowerManager.WakeLock wakeLock = manager.newWakeLock(flags, "Nivra:IncomingCall");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(8000);
    }

    private static PendingIntent activityIntent(Context context, String action, Map<String, String> data, int notificationId) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(action);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        putCallExtras(intent, data, notificationId);
        return PendingIntent.getActivity(
            context,
            notificationId + action.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static PendingIntent receiverIntent(Context context, String action, Map<String, String> data, int notificationId) {
        Intent intent = new Intent(context, NivraCallActionReceiver.class);
        intent.setAction(action);
        putCallExtras(intent, data, notificationId);
        return PendingIntent.getBroadcast(
            context,
            notificationId + action.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void putCallExtras(Intent intent, Map<String, String> data, int notificationId) {
        for (Map.Entry<String, String> entry : data.entrySet()) {
            intent.putExtra(entry.getKey(), entry.getValue());
        }
        intent.putExtra("notificationId", notificationId);
        intent.putExtra("nivraRouteIntent", "tap");
        intent.putExtra("type", firstNonBlank(data.get("type"), "incoming_call", "incoming_call"));
    }

    private static boolean canPostNotifications(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean hasCallId(Intent intent) {
        String value = intent.getStringExtra("callId");
        return value != null && !value.trim().isEmpty();
    }

    private static JSObject callPayload(Intent intent, String action) {
        JSObject payload = new JSObject();
        payload.put("action", action);
        payload.put("callId", intent.getStringExtra("callId"));
        payload.put("callerName", intent.getStringExtra("callerName"));
        payload.put("callerUserId", firstNonBlank(intent.getStringExtra("callerUserId"), intent.getStringExtra("callerId"), ""));
        payload.put("callType", intent.getStringExtra("callType"));
        payload.put("conversationId", intent.getStringExtra("conversationId"));
        payload.put("at", System.currentTimeMillis());
        return payload;
    }

    private static String firstNonBlank(String first, String second, String fallback) {
        if (first != null && !first.trim().isEmpty()) {
            return first;
        }
        if (second != null && !second.trim().isEmpty()) {
            return second;
        }
        return fallback;
    }

    private static int notificationId(String value) {
        String source = value == null || value.isEmpty() ? "nivra" : value;
        int hash = 0;
        for (int index = 0; index < source.length(); index += 1) {
            hash = ((hash << 5) - hash + source.charAt(index));
        }
        return Math.abs(hash == 0 ? 1 : hash);
    }

    private void requestAudioFocus(String mode) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage("record".equals(mode) ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA)
                .setContentType("record".equals(mode) ? AudioAttributes.CONTENT_TYPE_SPEECH : AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(focusChange -> { })
                .setWillPauseWhenDucked(true)
                .build();
            audioManager.requestAudioFocus(audioFocusRequest);
            return;
        }
        audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
    }

    private void abandonAudioFocus() {
        if (audioManager == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
            audioFocusRequest = null;
            return;
        }
        audioManager.abandonAudioFocus(null);
    }

    private void configureRaiseSensors(boolean enabled) {
        if (sensorManager == null) {
            sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        }
        if (sensorManager == null) {
            return;
        }
        sensorManager.unregisterListener(raiseSensorListener);
        phoneNear = false;
        if (!enabled) {
            return;
        }
        proximitySensor = sensorManager.getDefaultSensor(Sensor.TYPE_PROXIMITY);
        accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (accelerometerSensor != null) {
            sensorManager.registerListener(raiseSensorListener, accelerometerSensor, SensorManager.SENSOR_DELAY_NORMAL);
        }
        if (proximitySensor != null) {
            sensorManager.registerListener(raiseSensorListener, proximitySensor, SensorManager.SENSOR_DELAY_NORMAL);
        }
    }

    private void emitRaiseGesture() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastRaiseEventAt < 1200) {
            return;
        }
        boolean hasRecentLift = accelerometerSensor == null || liftedRecently || now - lastLiftAt < 1800;
        if (!hasRecentLift) {
            return;
        }
        lastRaiseEventAt = now;
        JSObject payload = new JSObject();
        payload.put("kind", raiseTalkEnabled ? "talk" : "listen");
        payload.put("near", true);
        payload.put("at", System.currentTimeMillis());
        notifyListeners("raiseGesture", payload);
    }

    private SaveSession openSaveSession(String fileName, String mimeType, boolean publicSave, String mediaKind) throws Exception {
        if (publicSave) {
            SaveSession session = openPublicMediaSession(fileName, mimeType, mediaKind);
            if (session != null) {
                return session;
            }
        }
        File dir = new File(getContext().getFilesDir(), "Nivra/Media");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("No se pudo crear el directorio privado.");
        }
        File target = new File(dir, fileName);
        return new SaveSession(UUID.randomUUID().toString(), new FileOutputStream(target), false, null, target.getAbsolutePath(), mimeType);
    }

    private SaveSession openPublicMediaSession(String fileName, String mimeType, String mediaKind) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePublicPath(mediaKind, mimeType));
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri collection = publicCollection(mediaKind, mimeType);
            Uri uri = resolver.insert(collection, values);
            if (uri == null) {
                return null;
            }
            OutputStream output = resolver.openOutputStream(uri);
            if (output == null) {
                resolver.delete(uri, null, null);
                return null;
            }
            return new SaveSession(UUID.randomUUID().toString(), output, true, uri, "", mimeType);
        }

        File dir = new File(Environment.getExternalStoragePublicDirectory(publicDirectory(mediaKind, mimeType)), "Nivra");
        if (!dir.exists() && !dir.mkdirs()) {
            return null;
        }
        File target = new File(dir, fileName);
        return new SaveSession(UUID.randomUUID().toString(), new FileOutputStream(target), true, null, target.getAbsolutePath(), mimeType);
    }

    private void finishPublicMedia(SaveSession session) {
        if (!session.publicSave) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && session.uri != null) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(session.uri, values, null, null);
            return;
        }
        if (session.path != null && !session.path.isEmpty()) {
            MediaScannerConnection.scanFile(getContext(), new String[] { session.path }, new String[] { session.mimeType }, null);
        }
    }

    private void deleteSessionTarget(SaveSession session) {
        if (session.uri != null) {
            getContext().getContentResolver().delete(session.uri, null, null);
        }
        if (session.path != null && !session.path.isEmpty()) {
            new File(session.path).delete();
        }
    }

    private Uri publicCollection(String mediaKind, String mimeType) {
        if ("image".equals(mediaKind) || mimeType.startsWith("image/")) {
            return MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }
        if ("video".equals(mediaKind) || mimeType.startsWith("video/")) {
            return MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }
        if ("audio".equals(mediaKind) || mimeType.startsWith("audio/")) {
            return MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }
        return MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    }

    private String relativePublicPath(String mediaKind, String mimeType) {
        return publicDirectory(mediaKind, mimeType) + "/Nivra";
    }

    private String publicDirectory(String mediaKind, String mimeType) {
        if ("image".equals(mediaKind) || mimeType.startsWith("image/")) {
            return Environment.DIRECTORY_PICTURES;
        }
        if ("video".equals(mediaKind) || mimeType.startsWith("video/")) {
            return Environment.DIRECTORY_MOVIES;
        }
        if ("audio".equals(mediaKind) || mimeType.startsWith("audio/")) {
            return Environment.DIRECTORY_MUSIC;
        }
        return Environment.DIRECTORY_DOWNLOADS;
    }

    private String sanitizeFileName(String value) {
        String cleaned = value == null ? "" : value.replaceAll("[\\\\/:*?\"<>|\\n\\r\\t]", "_").trim();
        return cleaned.isEmpty() ? "nivra-file.bin" : cleaned;
    }

    private static class DeviceContact {
        final String id;
        final String displayName;
        final Set<String> numbers = new LinkedHashSet<>();

        DeviceContact(String id, String displayName) {
            this.id = id == null ? "" : id;
            this.displayName = displayName == null ? "" : displayName;
        }

        void addNumber(String number) {
            String cleaned = number == null ? "" : number.trim();
            if (!cleaned.isEmpty()) {
                numbers.add(cleaned);
            }
        }

        JSObject toJson() {
            JSObject item = new JSObject();
            item.put("id", id);
            item.put("displayName", displayName);
            JSONArray tel = new JSONArray();
            for (String number : numbers) {
                tel.put(number);
            }
            item.put("tel", tel);
            return item;
        }
    }

    private static class SaveSession {
        final String id;
        final OutputStream output;
        final boolean publicSave;
        final Uri uri;
        final String path;
        final String mimeType;

        SaveSession(String id, OutputStream output, boolean publicSave, Uri uri, String path, String mimeType) {
            this.id = id;
            this.output = output;
            this.publicSave = publicSave;
            this.uri = uri;
            this.path = path;
            this.mimeType = mimeType;
        }
    }
}
