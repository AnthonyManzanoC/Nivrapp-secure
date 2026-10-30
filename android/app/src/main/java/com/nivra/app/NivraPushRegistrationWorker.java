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
        boolean retry = false;
        for (JSONObject session : NivraNativePushRegistration.readAll(context)) {
            if (isStopped()) return Result.success();
            String token = session.optString("pendingToken");
            if (token.isEmpty() || !NivraNativePushRegistration.isCurrent(context, session, token)) continue;
            retry |= renewAccount(context, session, token);
        }
        return retry ? retryBounded() : Result.success();
    }

    private boolean renewAccount(Context context, JSONObject session, String token) {
        if (!NivraNativePushRegistration.isAllowedApiOrigin(session.optString("apiBaseUrl"))) return false;
        String currentOrigin = session.optString("apiBaseUrl");
        int first = !currentOrigin.equals(NivraApiFailover.PRIMARY) && !NivraApiFailover.probe(currentOrigin, session.optString("clusterFingerprint"))
            ? 0 : renew(context, session, token, currentOrigin);
        if (first == 1) return false;
        if (first == 2) return true;
        for (String alternate : NivraApiFailover.recoveryOrigins()) {
            if (alternate.equals(currentOrigin)) continue;
            if (isStopped() || !NivraNativePushRegistration.isCurrent(context, session, token)) return false;
            if (!NivraApiFailover.probe(alternate, session.optString("clusterFingerprint"))) continue;
            // Idempotent for the same scope/token; refresh credentials never rotate here.
            int result = renew(context, session, token, alternate);
            if (result == 1) return false;
            if (result == 2) return true;
        }
        return true;
    }

    private int renew(Context context, JSONObject session, String token, String origin) {
        if (!NivraNativePushRegistration.isAllowedApiOrigin(origin)) return 1;
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject();
            body.put("userId", session.getString("userId")).put("deviceId", session.getString("deviceId"))
                .put("refreshToken", session.getString("refreshToken")).put("token", token);
            connection = (HttpURLConnection) new URL(origin + "/push-tokens/native-renew").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Cache-Control", "no-store");
            connection.setDoOutput(true);
            if (!NivraNativePushRegistration.isCurrent(context, session, token) || isStopped()) return 1;
            try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                String response = NivraApiFailover.readBounded(connection, 4096);
                NivraNativePushRegistration.registered(context, session, token,
                    Boolean.TRUE.equals(new JSONObject(response).opt("fcmReady")));
                return 1;
            }
            // A rotated/revoked credential is never used to restore a session. The
            // next authenticated WebView sync supplies the current credential.
            if (status == 401 || status == 403 || status == 404) return 1;
            // User throttles and validation failures never trigger a different server.
            return status == 502 || status == 503 || status == 504 ? 0 : status == 429 || status >= 500 ? 2 : 1;
        } catch (Exception ignored) { return 0; }
        finally { if (connection != null) connection.disconnect(); }
    }

    private Result retryBounded() { return getRunAttemptCount() < 5 && !isStopped() ? Result.retry() : Result.success(); }
}
