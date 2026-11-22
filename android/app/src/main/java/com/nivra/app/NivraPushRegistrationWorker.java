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
    enum Renewal { COMPLETE, ALTERNATE, RETRY_LATER }

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
        String fingerprint = session.optString("clusterFingerprint");
        if (currentOrigin.equals(NivraApiFailover.PRIMARY) || NivraApiFailover.probe(currentOrigin, fingerprint)) {
            Renewal result = renew(context, session, token, currentOrigin);
            if (result != Renewal.ALTERNATE) return result == Renewal.RETRY_LATER;
        }
        for (String alternate : NivraApiFailover.recoveryOrigins()) {
            if (alternate.equals(currentOrigin)) continue;
            if (isStopped() || !NivraNativePushRegistration.isCurrent(context, session, token)) return false;
            if (!NivraApiFailover.probe(alternate, fingerprint)) continue;
            // Idempotent for the same scope/token; refresh credentials never rotate here.
            Renewal result = renew(context, session, token, alternate);
            if (result != Renewal.ALTERNATE) return result == Renewal.RETRY_LATER;
        }
        return true;
    }

    private Renewal renew(Context context, JSONObject session, String token, String origin) {
        if (!NivraNativePushRegistration.isAllowedApiOrigin(origin)) return Renewal.COMPLETE;
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
            if (!NivraNativePushRegistration.isCurrent(context, session, token) || isStopped()) return Renewal.COMPLETE;
            try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                JSONObject response = new JSONObject(NivraApiFailover.readBounded(connection, 4096));
                Object registered = response.opt("registered"), readiness = response.opt("fcmReady");
                Renewal result = acknowledgement(registered, readiness);
                if (result != Renewal.ALTERNATE)
                    NivraNativePushRegistration.registered(context, session, token, result == Renewal.COMPLETE);
                return result;
            }
            return rejected(status);
        } catch (Exception ignored) { return Renewal.ALTERNATE; }
        finally { if (connection != null) connection.disconnect(); }
    }

    static Renewal rejected(int status) {
        // This route answers 401 for a stale or revoked credential. A 404 can come
        // from an older node without the route. Throttles keep the current backoff.
        if (status == 404 || status == 502 || status == 503 || status == 504) return Renewal.ALTERNATE;
        return status == 429 || status >= 500 ? Renewal.RETRY_LATER : Renewal.COMPLETE;
    }

    static Renewal acknowledgement(Object registered, Object fcmReady) {
        if (!Boolean.TRUE.equals(registered) || !(fcmReady instanceof Boolean)) return Renewal.ALTERNATE;
        return Boolean.TRUE.equals(fcmReady) ? Renewal.COMPLETE : Renewal.RETRY_LATER;
    }

    private Result retryBounded() { return getRunAttemptCount() < 5 && !isStopped() ? Result.retry() : Result.success(); }
}
