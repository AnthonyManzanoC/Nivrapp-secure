package com.nivra.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.service.notification.StatusBarNotification;

/** Prevent the system installer from covering an incoming or live call. */
final class NivraNativeCallGuard {
    private NivraNativeCallGuard() { }
    static boolean hasCallInProgress(Context context) {
        if (NivraOngoingCallService.hasActiveCall()) return true;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        try {
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                Notification notification = active.getNotification();
                if (Notification.CATEGORY_CALL.equals(notification.category) &&
                    (notification.flags & Notification.FLAG_ONGOING_EVENT) != 0) return true;
            }
        } catch (RuntimeException ignored) { return true; }
        return false;
    }
}
