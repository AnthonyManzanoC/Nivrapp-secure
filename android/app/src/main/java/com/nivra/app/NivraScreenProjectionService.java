package com.nivra.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

public final class NivraScreenProjectionService extends Service {
    private static final String CHANNEL = "nivra_screen_share";
    private static final String STOP_ACTION = "com.nivra.app.STOP_SCREEN_SHARE";
    private static final int NOTIFICATION = 48103;
    private NivraScreenShareSession session;
    private String sessionId = "";

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP_ACTION.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (session != null) return START_NOT_STICKY;
        sessionId = intent.getStringExtra("sessionId");
        Intent projectionData = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra("projectionData", Intent.class) : intent.getParcelableExtra("projectionData");
        String offer = intent.getStringExtra("offer");
        if (sessionId == null || projectionData == null || offer == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            // Consent precedes this service, and this foreground promotion precedes getMediaProjection().
            ServiceCompat.startForeground(this, NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            session = new NivraScreenShareSession(getApplicationContext(), sessionId, () -> stopSelf());
            session.start(projectionData, offer);
        } catch (RuntimeException ignored) {
            NivraScreenSharePlugin.sessionEnded(sessionId, "unavailable");
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.screen_share_channel), NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openAction = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stopAction = PendingIntent.getService(this, NOTIFICATION,
            new Intent(this, NivraScreenProjectionService.class).setAction(STOP_ACTION), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.screen_share_active))
            .setContentIntent(openAction)
            .addAction(android.R.drawable.ic_media_pause, getString(R.string.screen_share_stop), stopAction)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
    }

    @Override public void onTaskRemoved(Intent intent) { stopSelf(); super.onTaskRemoved(intent); }

    @Override public void onDestroy() {
        if (session != null) session.stop();
        session = null;
        NivraScreenSharePlugin.sessionEnded(sessionId == null ? "" : sessionId, "stopped");
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
