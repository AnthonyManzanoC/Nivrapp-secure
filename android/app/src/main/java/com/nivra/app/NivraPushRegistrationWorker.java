package com.nivra.app;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class NivraPushRegistrationWorker extends Worker {
    public NivraPushRegistrationWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        JSONObject session = NivraNativePushRegistration.read(context);
        String token = NivraNativePushRegistration.pendingToken(context);
        if (session == null || token.isEmpty() || isStopped()) return Result.success();
        if (!NivraNativePushRegistration.isAllowedApiOrigin(session.optString("apiBaseUrl"))) return Result.failure();
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject();
            body.put("userId", session.getString("userId")).put("deviceId", session.getString("deviceId"))
                .put("refreshToken", session.getString("refreshToken")).put("token", token);
            connection = (HttpURLConnection) new URL(session.getString("apiBaseUrl") + "/push-tokens/native-renew").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            if (!NivraNativePushRegistration.isCurrent(context, session, token) || isStopped()) return Result.success();
            try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                String response;
                try (java.io.InputStream input = connection.getInputStream(); java.io.ByteArrayOutputStream result = new java.io.ByteArrayOutputStream()) {
                    byte[] buffer = new byte[1024];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        if (result.size() + read > 4096) throw new IllegalStateException("Invalid registration response size.");
                        result.write(buffer, 0, read);
                    }
                    response = result.toString("UTF-8");
                }
                NivraNativePushRegistration.registered(context, session, token, new JSONObject(response).optBoolean("fcmReady"));
                return Result.success();
            }
            // A rotated/revoked credential is never used to restore a session. The
            // next authenticated WebView sync supplies the current credential.
            if (status == 401 || status == 403 || status == 404) return Result.success();
            return retryBounded();
        } catch (Exception ignored) { return retryBounded(); }
        finally { if (connection != null) connection.disconnect(); }
    }

    private Result retryBounded() { return getRunAttemptCount() < 5 && !isStopped() ? Result.retry() : Result.success(); }
}
