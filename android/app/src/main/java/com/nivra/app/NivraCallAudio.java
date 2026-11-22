package com.nivra.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothHeadset;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;

/** Owns communication routing only. It never changes microphone mute or volume. */
final class NivraCallAudio {
    private static final String LEGACY_BLUETOOTH = "legacy-bluetooth";
    private static final long ROUTE_TIMEOUT_MS = 30_000;

    private final Context context;
    private final AudioManager audio;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Consumer<JSObject> listener;
    private String callId = "";
    private boolean video;
    private String choice = "";
    private String pending = "";
    private final Set<String> unavailableRoutes = new HashSet<>();
    private String errorCode = "";
    private boolean previousSpeaker;
    private boolean previousSco;
    private boolean startedSco;
    private boolean observing;
    private long revision;
    private AudioFocusRequest focus;
    private AudioManager.OnCommunicationDeviceChangedListener communicationListener;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> { };
    private final Runnable routeTimeout = () -> {
        if (callId.isEmpty() || pending.isEmpty()) return;
        try {
            if (pending.equals(currentRoute())) { pending = ""; publish(); return; }
        } catch (RuntimeException ignored) { }
        unavailableRoutes.add(pending);
        clearPending();
        choice = "";
        errorCode = "CALL_AUDIO_ROUTE_TIMEOUT";
        stopOwnedSco();
        try { applyAutomatic(); } catch (RuntimeException ignored) { }
        publish();
    };
    private final AudioDeviceCallback devices = new AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added) { deviceSetChanged(); }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { deviceSetChanged(); }
    };
    private final BroadcastReceiver legacyChanges = new BroadcastReceiver() {
        @Override public void onReceive(Context ignored, Intent intent) {
            if (callId.isEmpty()) return;
            try {
                if (AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED.equals(intent.getAction())) {
                    int state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_DISCONNECTED);
                    if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED && LEGACY_BLUETOOTH.equals(pending)) {
                        audio.setSpeakerphoneOn(false);
                        audio.setBluetoothScoOn(true);
                        clearPending();
                    } else if (state == AudioManager.SCO_AUDIO_STATE_DISCONNECTED && startedSco && pending.isEmpty()) {
                        stopOwnedSco();
                        choice = "";
                        unavailableRoutes.add(LEGACY_BLUETOOTH);
                    }
                    applyAutomatic();
                    publish();
                    return;
                }
                deviceSetChanged();
            } catch (RuntimeException failure) {
                errorCode = "CALL_AUDIO_UNAVAILABLE";
                publish();
            }
        }
    };

    NivraCallAudio(Context context, Consumer<JSObject> listener) {
        this.context = context.getApplicationContext();
        this.audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.listener = listener;
    }

    JSObject configure(String id, boolean active, boolean video) {
        if (!active) {
            if (id.isEmpty() || id.equals(callId)) release();
            return snapshot();
        }
        if (audio == null || id.isEmpty()) throw new IllegalStateException("CALL_AUDIO_UNAVAILABLE");
        if (!id.equals(callId)) {
            release();
            if (audio.getMode() == AudioManager.MODE_IN_CALL) throw new IllegalStateException("CALL_AUDIO_PHONE_BUSY");
            previousSpeaker = audio.isSpeakerphoneOn();
            previousSco = audio.isBluetoothScoOn();
            callId = id;
            this.video = video;
            try {
                audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
                requestFocus();
                observe();
            } catch (RuntimeException failure) { release(); throw failure; }
        } else this.video = video;
        applyAutomatic();
        return snapshot();
    }

    JSObject select(String id, String routeId) {
        if (callId.isEmpty() || !callId.equals(id)) throw new IllegalStateException("CALL_AUDIO_SESSION_CHANGED");
        if (!CallAudioRoutePolicy.includes(routes(), routeId)) throw new IllegalArgumentException("CALL_AUDIO_ROUTE_GONE");
        if (!routeId.equals(pending) && (!pending.isEmpty() || !routeId.equals(currentRoute())) && !apply(routeId)) {
            unavailableRoutes.add(routeId);
            throw new IllegalStateException("CALL_AUDIO_ROUTE_REJECTED");
        }
        unavailableRoutes.remove(routeId);
        errorCode = "";
        choice = routeId;
        return snapshot();
    }

    JSObject refresh() {
        if (!callId.isEmpty()) applyAutomatic();
        return snapshot();
    }

    void release() {
        if (callId.isEmpty()) return;
        callId = "";
        handler.removeCallbacks(routeTimeout);
        try { unobserve(); } catch (RuntimeException ignored) { }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.clearCommunicationDevice();
            else {
                stopOwnedSco();
                audio.setSpeakerphoneOn(previousSpeaker);
                audio.setBluetoothScoOn(previousSco);
            }
        } catch (RuntimeException ignored) { }
        // Release OUR mode request. Copying the globally observed previous mode
        // can reassert WebRTC's IN_COMMUNICATION after its tracks have stopped,
        // or impersonate another app's mode owner. MODE_NORMAL lets Android
        // restore its remaining owners and policy instead.
        try { audio.setMode(AudioManager.MODE_NORMAL); }
        catch (RuntimeException ignored) { }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focus != null) audio.abandonAudioFocusRequest(focus);
            else audio.abandonAudioFocus(focusListener);
        } catch (RuntimeException ignored) { }
        focus = null;
        choice = pending = errorCode = "";
        unavailableRoutes.clear();
    }

    private void requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener(focusListener, handler).build();
            audio.requestAudioFocus(focus);
        } else audio.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
    }

    private void observe() {
        if (observing) return;
        observing = true;
        audio.registerAudioDeviceCallback(devices, handler);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            communicationListener = device -> {
                if (callId.isEmpty()) return;
                if (device != null && deviceId(device).equals(pending)) {
                    clearPending();
                }
                publish();
            };
            audio.addOnCommunicationDeviceChangedListener(command -> handler.post(command), communicationListener);
        } else {
            IntentFilter filter = new IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
            filter.addAction(BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED);
            context.registerReceiver(legacyChanges, filter);
        }
    }

    private void unobserve() {
        if (!observing) return;
        observing = false;
        audio.unregisterAudioDeviceCallback(devices);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && communicationListener != null) {
            audio.removeOnCommunicationDeviceChangedListener(communicationListener);
            communicationListener = null;
        } else {
            try { context.unregisterReceiver(legacyChanges); } catch (RuntimeException ignored) { }
        }
    }

    private void deviceSetChanged() {
        if (callId.isEmpty()) return;
        try {
            applyAutomatic();
        } catch (RuntimeException failure) {
            clearPending();
            errorCode = "CALL_AUDIO_UNAVAILABLE";
        }
        publish();
    }

    private void applyAutomatic() {
        List<CallAudioRoutePolicy.Route> routes = routes();
        // Retry a failed device when it has actually disappeared and reappeared,
        // or when the user selects it directly. Other device events should not
        // keep interrupting the usable fallback.
        unavailableRoutes.removeIf(route -> !CallAudioRoutePolicy.includes(routes, route));
        if (!pending.isEmpty() && !CallAudioRoutePolicy.includes(routes, pending)) {
            clearPending();
            stopOwnedSco();
        }
        if (!CallAudioRoutePolicy.includes(routes, choice)) choice = "";

        String current = currentRoute();
        while (true) {
            String next = CallAudioRoutePolicy.choose(routes, video, choice, unavailableRoutes);
            if (next.isEmpty() || next.equals(pending) || (pending.isEmpty() && next.equals(current))) return;
            if (apply(next)) return;
            unavailableRoutes.add(next);
            if (next.equals(choice)) choice = "";
            errorCode = "CALL_AUDIO_ROUTE_REJECTED";
        }
    }

    private boolean apply(String route) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : audio.getAvailableCommunicationDevices()) {
                if (!deviceId(device).equals(route)) continue;
                if (!audio.setCommunicationDevice(device)) return false;
                clearPending();
                if (!route.equals(currentRoute())) waitForRoute(route);
                return true;
            }
            return false;
        }
        if (LEGACY_BLUETOOTH.equals(route)) {
            if (!audio.isBluetoothScoOn()) {
                // Keep the last usable route until SCO connects. Android can
                // take several seconds or fail to establish this connection.
                audio.startBluetoothSco();
                startedSco = true;
                waitForRoute(route);
            }
        } else {
            stopOwnedSco();
            audio.setBluetoothScoOn(false);
            audio.setSpeakerphoneOn("legacy-speaker".equals(route));
            clearPending();
        }
        return true;
    }

    private void waitForRoute(String route) {
        clearPending();
        pending = route;
        handler.postDelayed(routeTimeout, ROUTE_TIMEOUT_MS);
    }

    private void clearPending() {
        pending = "";
        handler.removeCallbacks(routeTimeout);
    }

    private void stopOwnedSco() {
        if (!startedSco) return;
        startedSco = false;
        try { audio.setBluetoothScoOn(false); } catch (RuntimeException ignored) { }
        try { audio.stopBluetoothSco(); } catch (RuntimeException ignored) { }
    }

    private String currentRoute() {
        if (audio == null) return "";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo device = audio.getCommunicationDevice();
            return device == null ? "" : deviceId(device);
        }
        if (audio.isBluetoothScoOn()) return LEGACY_BLUETOOTH;
        if (audio.isSpeakerphoneOn()) return "legacy-speaker";
        for (CallAudioRoutePolicy.Route route : routes()) if ("wired".equals(route.kind) || "usb".equals(route.kind)) return route.id;
        return "legacy-earpiece";
    }

    private List<CallAudioRoutePolicy.Route> routes() {
        List<CallAudioRoutePolicy.Route> routes = new ArrayList<>();
        if (audio == null) return routes;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : audio.getAvailableCommunicationDevices()) {
                String kind = kind(device.getType());
                if (!device.isSink() || kind.isEmpty() || ("bluetooth".equals(kind) && !bluetoothAllowed())) continue;
                routes.add(new CallAudioRoutePolicy.Route(deviceId(device), kind, label(device, kind)));
            }
            return routes;
        }
        boolean earpiece = false;
        boolean speaker = false;
        boolean wired = false;
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            String kind = kind(device.getType());
            if ("earpiece".equals(kind)) earpiece = true;
            if ("speaker".equals(kind)) speaker = true;
            if (("wired".equals(kind) || "usb".equals(kind)) && !wired) {
                routes.add(new CallAudioRoutePolicy.Route("legacy-wired", kind, label(device, kind)));
                wired = true;
            }
        }
        // Legacy routing cannot bypass an inserted cable to force the handset.
        if (earpiece && !wired) routes.add(new CallAudioRoutePolicy.Route("legacy-earpiece", "earpiece", "Auricular del teléfono"));
        if (speaker) routes.add(new CallAudioRoutePolicy.Route("legacy-speaker", "speaker", "Altavoz"));
        if (bluetoothConnected()) routes.add(new CallAudioRoutePolicy.Route(LEGACY_BLUETOOTH, "bluetooth", "Bluetooth"));
        return routes;
    }

    private boolean bluetoothAllowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean bluetoothConnected() {
        if (!bluetoothAllowed() || !audio.isBluetoothScoAvailableOffCall()) return false;
        try {
            BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            return adapter != null && adapter.getProfileConnectionState(BluetoothProfile.HEADSET) == BluetoothProfile.STATE_CONNECTED;
        } catch (RuntimeException ignored) { return false; }
    }

    private JSObject snapshot() {
        JSObject state = new JSObject();
        state.put("revision", ++revision);
        state.put("callId", callId);
        state.put("supported", audio != null);
        state.put("selectedRouteId", callId.isEmpty() ? "" : currentRoute());
        state.put("pendingRouteId", pending);
        state.put("bluetoothPermission", bluetoothAllowed());
        state.put("errorCode", errorCode);
        JSONArray available = new JSONArray();
        for (CallAudioRoutePolicy.Route route : routes()) {
            JSObject item = new JSObject();
            item.put("id", route.id); item.put("kind", route.kind); item.put("label", route.label);
            available.put(item);
        }
        state.put("routes", available);
        return state;
    }

    private void publish() {
        try { listener.accept(snapshot()); } catch (RuntimeException ignored) { }
    }

    private static String deviceId(AudioDeviceInfo device) { return "android:" + device.getId(); }

    static String kind(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "earpiece";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "speaker";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
            case AudioDeviceInfo.TYPE_HEARING_AID: return "bluetooth";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "wired";
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "usb";
            default: return "";
        }
    }

    private static String label(AudioDeviceInfo device, String kind) {
        if ("earpiece".equals(kind)) return "Auricular del teléfono";
        if ("speaker".equals(kind)) return "Altavoz";
        String product = String.valueOf(device.getProductName()).trim();
        if (!product.isEmpty() && !"null".equals(product)) return product.substring(0, Math.min(product.length(), 80));
        return "bluetooth".equals(kind) ? "Bluetooth" : "usb".equals(kind) ? "Auriculares USB" : "Auriculares con cable";
    }
}
