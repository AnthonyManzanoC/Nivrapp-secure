package com.nivra.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannels();
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
            "nivra_calls",
            "Llamadas Nivra",
            NotificationManager.IMPORTANCE_HIGH
        );
        calls.setDescription("Llamadas y videollamadas entrantes");
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 320, 140, 320, 140, 480 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(messages);
            manager.createNotificationChannel(calls);
        }
    }
}
