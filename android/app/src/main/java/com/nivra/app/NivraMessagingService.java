package com.nivra.app;

import android.Manifest;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Process;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

import io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService;

public class NivraMessagingService extends MessagingService {
    private static final String CHANNEL_MESSAGES = "nivra_messages";
    private static final String CHANNEL_CALLS = "nivra_calls";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        Map<String, String> data = remoteMessage.getData();
        if (data == null || data.isEmpty() || isAppInForeground()) {
            return;
        }

        ensureNotificationChannels();
        String type = normalizeType(data.get("type"));
        String callId = stringValue(data, "callId");
        if (type.equals("end-call") || type.equals("call-ended") || type.equals("call-rejected")) {
            cancelNotification(notificationId(callId.isEmpty() ? stringValue(data, "tag") : callId));
            return;
        }

        showNotification(remoteMessage, data, type);
    }

    private void showNotification(RemoteMessage remoteMessage, Map<String, String> data, String type) {
        if (!canPostNotifications()) {
            return;
        }

        String callId = stringValue(data, "callId");
        String tag = firstNonBlank(stringValue(data, "tag"), callId, stringValue(data, "messageId"), "nivra-event");
        boolean incomingCall = type.equals("incoming-call") || type.equals("incomingcall");
        boolean missedCall = type.equals("missed-call");
        boolean isCall = incomingCall || missedCall || type.contains("call");
        int id = notificationId(isCall && !callId.isEmpty() ? callId : tag);

        PendingIntent openIntent = openIntent(remoteMessage, data, "tap", id);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, isCall ? CHANNEL_CALLS : CHANNEL_MESSAGES)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Nivra")
            .setContentText(bodyForType(type))
            .setContentIntent(openIntent)
            .setAutoCancel(!incomingCall)
            .setOngoing(incomingCall)
            .setOnlyAlertOnce(!incomingCall)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPriority(incomingCall ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_HIGH)
            .setCategory(incomingCall ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_MESSAGE);

        if (incomingCall) {
            builder
                .setVibrate(new long[] { 320, 140, 320, 140, 480 })
                .setTimeoutAfter(75000)
                .addAction(android.R.drawable.ic_menu_call, "Contestar", openIntent(remoteMessage, data, "accept", id))
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Rechazar", declineIntent(callId, id));
        }

        NotificationManagerCompat.from(this).notify(id, builder.build());
    }

    private PendingIntent openIntent(RemoteMessage remoteMessage, Map<String, String> data, String action, int notificationId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction("com.nivra.app.OPEN_PUSH");
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        for (Map.Entry<String, String> entry : data.entrySet()) {
            intent.putExtra(entry.getKey(), entry.getValue());
        }
        intent.putExtra("action", action);
        intent.putExtra("nivraRouteIntent", "tap");
        intent.putExtra("google.message_id", firstNonBlank(remoteMessage.getMessageId(), stringValue(data, "tag"), String.valueOf(notificationId), "nivra-event"));
        return PendingIntent.getActivity(
            this,
            notificationId + action.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private PendingIntent declineIntent(String callId, int notificationId) {
        Intent intent = new Intent(this, NivraNotificationActionReceiver.class);
        intent.setAction("com.nivra.app.DECLINE_CALL");
        intent.putExtra("callId", callId);
        intent.putExtra("notificationId", notificationId);
        return PendingIntent.getBroadcast(
            this,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void cancelNotification(int notificationId) {
        NotificationManagerCompat.from(this).cancel(notificationId);
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isAppInForeground() {
        ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null || manager.getRunningAppProcesses() == null) {
            return false;
        }
        int pid = Process.myPid();
        for (ActivityManager.RunningAppProcessInfo processInfo : manager.getRunningAppProcesses()) {
            if (processInfo.pid == pid) {
                return processInfo.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
            }
        }
        return false;
    }

    private void ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel messages = new NotificationChannel(
            CHANNEL_MESSAGES,
            "Nivra",
            NotificationManager.IMPORTANCE_HIGH
        );
        messages.setDescription("Mensajes privados de Nivra");
        messages.enableVibration(true);
        messages.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

        NotificationChannel calls = new NotificationChannel(
            CHANNEL_CALLS,
            "Llamadas Nivra",
            NotificationManager.IMPORTANCE_HIGH
        );
        calls.setDescription("Llamadas entrantes de Nivra");
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 320, 140, 320, 140, 480 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(messages);
            manager.createNotificationChannel(calls);
        }
    }

    private String bodyForType(String type) {
        if (type.equals("incoming-call") || type.equals("incomingcall")) {
            return "Llamada entrante";
        }
        if (type.equals("missed-call")) {
            return "Llamada perdida";
        }
        if (type.contains("call")) {
            return "Actualizacion de llamada";
        }
        if (type.equals("message")) {
            return "Nuevo mensaje privado";
        }
        return "Nueva actividad privada";
    }

    private String normalizeType(String type) {
        return type == null ? "" : type.replace('_', '-').toLowerCase();
    }

    private String stringValue(Map<String, String> data, String key) {
        String value = data.get(key);
        return value == null ? "" : value;
    }

    private String firstNonBlank(String first, String second, String third, String fallback) {
        if (first != null && !first.trim().isEmpty()) {
            return first;
        }
        if (second != null && !second.trim().isEmpty()) {
            return second;
        }
        if (third != null && !third.trim().isEmpty()) {
            return third;
        }
        return fallback;
    }

    private int notificationId(String value) {
        String source = value == null || value.isEmpty() ? "nivra" : value;
        int hash = 0;
        for (int index = 0; index < source.length(); index += 1) {
            hash = ((hash << 5) - hash + source.charAt(index));
        }
        return Math.abs(hash == 0 ? 1 : hash);
    }
}
