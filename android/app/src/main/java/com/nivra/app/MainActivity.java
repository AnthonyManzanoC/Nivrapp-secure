package com.nivra.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;
import android.content.pm.ApplicationInfo;
import android.view.WindowManager;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean screenCaptureAllowed;
    private boolean foreground;
    private boolean windowFocused;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NivraNativePlugin.class);
        registerPlugin(NivraScreenSharePlugin.class);
        registerPlugin(LauncherAppearancePlugin.class);
        registerPlugin(CallTranslationPlugin.class);
        super.onCreate(savedInstanceState);
        // Cover startup before the encrypted account/lock policy has restored.
        applyScreenPrivacy();
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            WebView.setWebContentsDebuggingEnabled(false);
        }
        // Stable aliases keep the installation's selection through APK upgrades.
        // Appearance must never block auth, app links, notifications or sharing.
        try { LauncherAppearanceManager.reconcile(this); } catch (RuntimeException ignored) { }
        createNotificationChannels();
        NivraNativePlugin.handleCallIntent(this, getIntent());
        NivraNativePlugin.handleShareIntent(this, getIntent());
    }

    void setScreenCaptureAllowed(boolean allowed) {
        screenCaptureAllowed = allowed;
        applyScreenPrivacy();
    }

    private void applyScreenPrivacy() {
        if (!foreground || !windowFocused || !screenCaptureAllowed) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override public void onResume() {
        super.onResume(); foreground = true; applyScreenPrivacy();
    }

    @Override public void onPause() {
        foreground = false; applyScreenPrivacy(); super.onPause();
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        windowFocused = hasFocus;
        applyScreenPrivacy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NivraNativePlugin.handleCallIntent(this, intent);
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
