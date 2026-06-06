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
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

@CapacitorPlugin(name = "NivraNative")
public class NivraNativePlugin extends Plugin {
    static final String CHANNEL_CALLS = "nivra_calls";
    static final String ACTION_CALL_OPEN = "com.nivra.app.CALL_OPEN";
    static final String ACTION_CALL_ANSWER = "com.nivra.app.CALL_ANSWER";
    static final String ACTION_CALL_REJECT = "com.nivra.app.CALL_REJECT";
    private static WeakReference<NivraNativePlugin> activePlugin = new WeakReference<>(null);
    private static final List<JSObject> pendingCallActions = new ArrayList<>();
    private final Map<String, SaveSession> saveSessions = new HashMap<>();
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
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null) {
            ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(memoryInfo);
            result.put("memoryClassMb", manager.getMemoryClass());
            result.put("availableMemoryMb", memoryInfo.availMem / 1024 / 1024);
            result.put("lowMemory", memoryInfo.lowMemory);
        }
        call.resolve(result);
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
