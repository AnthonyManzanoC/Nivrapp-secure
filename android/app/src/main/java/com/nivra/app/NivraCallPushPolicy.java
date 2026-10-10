package com.nivra.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Map;

final class NivraCallPushPolicy {
    private static final long RING_WINDOW_MS = 75_000;
    private static final String PREFS = "nivra_ended_call_pushes";

    private NivraCallPushPolicy() { }

    static boolean isTimely(String expiryValue, long sentAt, long now) {
        long expiry;
        try { expiry = expiryValue == null || expiryValue.isEmpty() ? sentAt + RING_WINDOW_MS : Long.parseLong(expiryValue); }
        catch (NumberFormatException ignored) { return false; }
        return sentAt > 0 && sentAt <= now + 30_000 && now - sentAt < RING_WINDOW_MS && expiry > now && expiry - now <= RING_WINDOW_MS + 30_000;
    }

    static boolean isCurrent(Context context, Map<String, String> data, long sentAt, long now) {
        String callId = data.get("callId");
        return callId != null && !callId.trim().isEmpty() && isTimely(data.get("expiresAt"), sentAt, now) &&
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(callId, 0) <= now - 300_000;
    }

    static void markEnded(Context context, String callId) {
        if (callId == null || callId.isEmpty()) return;
        long now = System.currentTimeMillis();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor edit = prefs.edit();
        for (Map.Entry<String, ?> value : prefs.getAll().entrySet()) {
            if (!(value.getValue() instanceof Long) || (Long) value.getValue() < now - 300_000) edit.remove(value.getKey());
        }
        edit.putLong(callId, now).apply();
    }
}
