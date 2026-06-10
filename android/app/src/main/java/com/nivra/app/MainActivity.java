package com.nivra.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NivraNativePlugin.class);
        super.onCreate(savedInstanceState);
        createNotificationChannels();
        NivraNativePlugin.handleCallIntent(getIntent());
        NivraNativePlugin.handleShareIntent(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NivraNativePlugin.handleCallIntent(intent);
        NivraNativePlugin.handleShareIntent(this, intent);
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel messages = new NotificationChannel(
            "nivra_messages",
            "Nivra",
            NotificationManager.IMPORTANCE_HIGH
        );
        messages.setDescription("Mensajes y llamadas privadas");
        messages.enableVibration(true);
        messages.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

        NotificationChannel calls = new NotificationChannel(
            NivraNativePlugin.CHANNEL_CALLS,
            "Llamadas Nivra",
            NotificationManager.IMPORTANCE_HIGH
        );
        calls.setDescription("Llamadas y videollamadas entrantes");
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 320, 140, 320, 140, 480 });
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(messages);
            manager.createNotificationChannel(calls);
        }
    }
}
