package com.nivra.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/** Keeps an explicitly started, live WebRTC call eligible for Android background audio. */
public final class NivraOngoingCallService extends Service {
    private static final String CHANNEL_ID = "nivra_active_call";
    private static final int NOTIFICATION_ID = 48102;
    private static volatile String requestedCallId = "";
    private static volatile String runningCallId = "";
    private static volatile boolean runningVideo;
    private PowerManager.WakeLock wakeLock;

    public static boolean isActive(String callId, boolean video) {
        return !callId.isEmpty() && callId.equals(requestedCallId) && callId.equals(runningCallId) && video == runningVideo;
    }

    public static void start(Context context, String callId, boolean video) {
        requestedCallId = callId;
        Intent intent = new Intent(context, NivraOngoingCallService.class)
            .putExtra("callId", callId)
            .putExtra("video", video);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException error) {
            if (callId.equals(requestedCallId)) {
                requestedCallId = "";
            }
            throw error;
        }
    }

    public static void stop(Context context, String callId) {
        // A late cleanup from a previous call must not stop its replacement.
        if (!callId.isEmpty() && !callId.equals(requestedCallId)) {
            return;
        }
        requestedCallId = "";
        context.stopService(new Intent(context, NivraOngoingCallService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String callId = intent == null ? "" : intent.getStringExtra("callId");
        if (callId == null || callId.isEmpty() || !callId.equals(requestedCallId)) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        boolean video = intent.getBooleanExtra("video", false)
            && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (video) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), types);
            runningCallId = callId;
            runningVideo = video;
            if (wakeLock == null) {
                PowerManager power = getSystemService(PowerManager.class);
                if (power != null) {
                    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Nivra:active-call");
                    wakeLock.setReferenceCounted(false);
                    wakeLock.acquire();
                }
            }
        } catch (RuntimeException ignored) {
            // Permission or foreground eligibility can change between the bridge call and startup.
            stopSelf(startId);
        }
        // A killed call process must never be restarted with a stale microphone notification.
        return START_NOT_STICKY;
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, getString(R.string.active_call_channel), NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.active_call_notification))
            .setContentIntent(content)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        requestedCallId = "";
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        runningCallId = "";
        runningVideo = false;
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
