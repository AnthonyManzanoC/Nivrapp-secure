package com.nivra.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

@CapacitorPlugin(name = "NivraScreenShare")
public final class NivraScreenSharePlugin extends Plugin {
    private static WeakReference<NivraScreenSharePlugin> instance = new WeakReference<>(null);
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String activeSessionId = "";
    private PluginCall pendingStart;

    @Override public void load() { instance = new WeakReference<>(this); }

    @PluginMethod
    public void start(PluginCall call) {
        main.post(() -> {
            String sessionId = call.getString("sessionId", "");
            String offer = call.getString("offer", "");
            if (!activeSessionId.isEmpty()) {
                call.reject("Ya estás compartiendo la pantalla.", "SCREEN_SHARE_BUSY");
                return;
            }
            if (!sessionId.matches("[a-zA-Z0-9_-]{8,80}") || offer.length() > 100000 || !offer.contains("m=video")) {
                call.reject("No pudimos preparar la pantalla compartida.", "SCREEN_SHARE_INVALID");
                return;
            }
            Activity activity = getActivity();
            MediaProjectionManager manager = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (activity == null || activity.isFinishing() || manager == null) {
                call.reject("Abre Nivra para compartir tu pantalla.", "SCREEN_SHARE_UNAVAILABLE");
                return;
            }
            activeSessionId = sessionId;
            pendingStart = call;
            try {
                startActivityForResult(call, manager.createScreenCaptureIntent(), "projectionConsent");
            } catch (RuntimeException ignored) {
                endSession(sessionId, "unavailable");
            }
        });
    }

    @ActivityCallback
    private void projectionConsent(PluginCall call, ActivityResult result) {
        if (call == null || !call.getString("sessionId", "").equals(activeSessionId)) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            endSession(activeSessionId, "cancelled");
            return;
        }
        String sessionId = activeSessionId;
        Intent service = new Intent(getContext(), NivraScreenProjectionService.class)
            .putExtra("sessionId", sessionId)
            .putExtra("offer", call.getString("offer", ""))
            .putExtra("projectionData", result.getData());
        try {
            ContextCompat.startForegroundService(getContext(), service);
            main.postDelayed(() -> {
                if (sessionId.equals(activeSessionId) && pendingStart != null) endSession(sessionId, "timeout");
            }, 15000);
        } catch (RuntimeException ignored) {
            endSession(sessionId, "unavailable");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            String sessionId = call.getString("sessionId", "");
            if (sessionId.isEmpty() || sessionId.equals(activeSessionId)) endSession(activeSessionId, "stopped");
            call.resolve();
        });
    }

    static void answerReady(String sessionId, String sdp) {
        NivraScreenSharePlugin plugin = instance.get();
        if (plugin == null) return;
        plugin.main.post(() -> {
            if (!sessionId.equals(plugin.activeSessionId) || plugin.pendingStart == null) return;
            JSObject result = new JSObject();
            result.put("answer", sdp);
            PluginCall call = plugin.pendingStart;
            plugin.pendingStart = null;
            call.resolve(result);
        });
    }

    static void sessionEnded(String sessionId, String reason) {
        NivraScreenSharePlugin plugin = instance.get();
        if (plugin != null) plugin.main.post(() -> plugin.endSession(sessionId, reason));
    }

    private void endSession(String sessionId, String reason) {
        if (sessionId.isEmpty() || !sessionId.equals(activeSessionId)) return;
        activeSessionId = "";
        PluginCall call = pendingStart;
        pendingStart = null;
        if (call != null) {
            call.reject(reason.equals("cancelled") || reason.equals("stopped")
                ? "Se canceló compartir pantalla." : "No pudimos iniciar la pantalla compartida. Inténtalo de nuevo.",
                reason.equals("cancelled") || reason.equals("stopped") ? "SCREEN_SHARE_CANCELLED" : "SCREEN_SHARE_FAILED");
        }
        getContext().stopService(new Intent(getContext(), NivraScreenProjectionService.class));
        JSObject event = new JSObject();
        event.put("sessionId", sessionId);
        event.put("reason", reason);
        notifyListeners("ended", event);
    }

    @Override protected void handleOnDestroy() {
        main.post(() -> endSession(activeSessionId, "app_closed"));
        super.handleOnDestroy();
    }
}
