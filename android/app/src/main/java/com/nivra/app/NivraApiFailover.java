package com.nivra.app;

import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;

/** Public readiness probes never include refresh/session credentials or follow redirects. */
final class NivraApiFailover {
    static final String PRIMARY = "https://nivrapp-secure.onrender.com";
    static final String BACKUP = "https://nivra-webapp-secure.onrender.com";
    static final String THIRD = "https://nivrapp-secure-eaqi.onrender.com";
    static String[] recoveryOrigins() {
        return new String[] { PRIMARY, BACKUP, THIRD };
    }
    static final String CLUSTER_FINGERPRINT = "c761492c31e3e9346640c94da63c476eea907d2aad8a26b6d830c60cd5d7fc64";
    private NivraApiFailover() { }

    static String canonicalFingerprint(String stored) {
        if (stored != null && !stored.isEmpty() && !stored.matches("[a-f0-9]{64}"))
            throw new IllegalArgumentException("Invalid infrastructure compatibility pin.");
        // The release's pin is authoritative, including upgrades from an older
        // cached pin. Readiness can never supply or replace this trust anchor.
        return CLUSTER_FINGERPRINT;
    }

    static boolean compatible(String stored, String actual, int protocol, boolean ready) {
        try { return canonicalFingerprint(stored).equals(actual) && protocol == 1 && ready; }
        catch (IllegalArgumentException ignored) { return false; }
    }

    static boolean coreReady(boolean apiReadyPresent, Object apiFailoverReady, Object storage, Object realtime, Object signing) {
        // 2.1 reports the individual core capabilities, before apiFailoverReady
        // was added. An explicit false, null or invalid value must fail closed.
        if (apiReadyPresent) return Boolean.TRUE.equals(apiFailoverReady);
        return Boolean.TRUE.equals(storage)
            && Boolean.TRUE.equals(realtime) && Boolean.TRUE.equals(signing);
    }

    static boolean compatibleCallProtocol(Object callProtocol, Object minimumCallProtocol) {
        if (!(callProtocol instanceof Number) || !(minimumCallProtocol instanceof Number)) return false;
        double current = ((Number) callProtocol).doubleValue();
        double minimum = ((Number) minimumCallProtocol).doubleValue();
        return Double.isFinite(current) && current == Math.floor(current) && current >= 2
            && minimum == Math.floor(minimum) && minimum >= 1 && minimum <= 2;
    }

    static boolean compatibleReadiness(String stored, Object status, Object protocol, Object callProtocol,
        Object minimumCallProtocol, Object fingerprint, boolean apiReadyPresent, Object apiReady,
        Object storage, Object realtime, Object signing) {
        return "ok".equals(status) && protocol instanceof Number && ((Number) protocol).doubleValue() == 1
            && compatibleCallProtocol(callProtocol, minimumCallProtocol)
            && fingerprint instanceof String && compatible(stored, (String) fingerprint, 1,
                coreReady(apiReadyPresent, apiReady, storage, realtime, signing));
    }

    static boolean freshAge(String value) {
        if (value == null) return true;
        try { return value.trim().matches("[0-9]+") && Long.parseLong(value.trim()) == 0; }
        catch (NumberFormatException ignored) { return false; }
    }

    static boolean probe(String origin, String fingerprint) {
        if (!NivraNativePushRegistration.isAllowedApiOrigin(origin)) return false;
        HttpURLConnection connection = null;
        try {
            canonicalFingerprint(fingerprint);
            connection = (HttpURLConnection) new URL(origin + "/health/ready").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
            connection.setRequestProperty("Cache-Control", "no-store, no-cache");
            connection.setRequestProperty("Pragma", "no-cache");
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != 200 || !freshAge(connection.getHeaderField("Age"))) return false;
            JSONObject value = new JSONObject(readBounded(connection, 16384));
            return compatibleReadiness(fingerprint, value.opt("status"), value.opt("failoverProtocol"),
                value.opt("callProtocol"), value.opt("minimumCallProtocol"), value.opt("clusterFingerprint"),
                value.has("apiFailoverReady"), value.opt("apiFailoverReady"), value.opt("sharedStorageReady"),
                value.opt("realtimeSharedReady"), value.opt("durableSigningKeyReady"));
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
