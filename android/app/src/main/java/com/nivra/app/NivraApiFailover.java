package com.nivra.app;

import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;

/** Public readiness probes never include refresh/session credentials or follow redirects. */
final class NivraApiFailover {
    static final String PRIMARY = "https://nivra-webapp-secure.onrender.com";
    static final String BACKUP = "https://nivrapp-secure.onrender.com";
    private NivraApiFailover() { }

    static boolean compatible(String expected, String actual, int protocol, boolean ready, boolean fcm, boolean webPush) {
        return expected != null && expected.matches("[a-f0-9]{64}") && expected.equals(actual)
            && protocol == 1 && ready && fcm && webPush;
    }

    static boolean probe(String origin, String fingerprint) {
        if (!NivraNativePushRegistration.isAllowedApiOrigin(origin) || fingerprint == null || !fingerprint.matches("[a-f0-9]{64}")) return false;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/health/ready").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
            connection.setRequestProperty("Cache-Control", "no-cache");
            if (connection.getResponseCode() != 200) return false;
            JSONObject value = new JSONObject(readBounded(connection, 16384));
            JSONObject push = value.optJSONObject("push");
            return compatible(fingerprint, value.optString("clusterFingerprint"), value.optInt("failoverProtocol"),
                value.optBoolean("multiInstanceReady"), push != null && push.optBoolean("fcm"), push != null && push.optBoolean("webPush"));
        } catch (Exception ignored) { return false; }
        finally { if (connection != null) connection.disconnect(); }
    }

    static String readBounded(HttpURLConnection connection, int maximum) throws Exception {
        try (java.io.InputStream input = connection.getInputStream(); java.io.ByteArrayOutputStream result = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024]; int read;
            while ((read = input.read(buffer)) != -1) {
                if (result.size() + read > maximum) throw new IllegalStateException("Invalid API response size.");
                result.write(buffer, 0, read);
            }
            return result.toString("UTF-8");
        }
    }
}
