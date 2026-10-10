package com.nivra.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Downloads only a release from our repository. Android remains the installer. */
final class NativeAppUpdateManager {
    interface UpdateListener { void onState(JSONObject state); }
    private final Activity activity;
    private final Context context;
    private final UpdateListener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled;
    private volatile boolean destroyed;
    private volatile HttpURLConnection connection;
    private volatile JSObject state = state("idle", 0, "");
    private volatile File readyFile;
    private volatile int targetBuild;
    private volatile String targetHash = "";
    private volatile long targetSize;
    private volatile boolean installing;
    private boolean allowed;
    private long installGeneration;

    NativeAppUpdateManager(Activity activity, Context context, UpdateListener listener) {
        this.activity = activity;
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    synchronized JSONObject readState() { return state; }

    synchronized void setAllowed(boolean value) {
        allowed = value;
        if (!value) installGeneration++;
    }

    synchronized void startDownload(JSObject descriptor, PluginCall call) {
        if (destroyed || installing || !allowed || "downloading".equals(state.optString("phase"))) { call.reject("UPDATE_BUSY"); return; }
        String version = descriptor.optString("version");
        String hash = descriptor.optString("sha256").toLowerCase(java.util.Locale.ROOT);
        int build = descriptor.optInt("versionCode", 0);
        long size = descriptor.optLong("size", 0);
        String url = descriptor.optString("url");
        if (!validDescriptor(version, build, hash, size, url)) { call.reject("UPDATE_INVALID"); return; }
        try {
            if (build <= installedBuild()) { call.reject("UPDATE_DOWNGRADE"); return; }
        } catch (Exception error) { call.reject("UPDATE_INVALID"); return; }
        cancelled = false;
        readyFile = null;
        targetBuild = build; targetHash = hash; targetSize = size;
        publish("downloading", 0, "");
        call.resolve(state);
        worker.execute(() -> download(url, build, hash, size));
    }

    static boolean validDescriptor(String version, int build, String hash, long size, String url) {
        if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+") || build <= 0 || !hash.matches("[a-f0-9]{64}")
            || size <= 0 || size > 256L * 1024 * 1024) return false;
        return url.equals("https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v" + version
            + "/Nivra-" + version + "-debug.apk");
    }

    private void download(String url, int build, String hash, long size) {
        File part = null;
        try {
            File directory = new File(context.getCacheDir(), "nivra-updates");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("UPDATE_STORAGE");
            // This directory contains only our disposable installer downloads.
            File[] previous = directory.listFiles();
            if (previous != null) for (File file : previous) if (file.isFile()) file.delete();
            part = new File(directory, "release-" + build + ".part");
            connection = openDownload(new URL(url));
            long advertised = connection.getContentLengthLong();
            if (advertised > 0 && advertised != size) throw new Exception("UPDATE_INVALID");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long bytes = 0; int lastProgress = -1;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(part)) {
                byte[] buffer = new byte[64 * 1024]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (cancelled || destroyed) throw new Exception("UPDATE_CANCELLED");
                    bytes += count;
                    if (bytes > size) throw new Exception("UPDATE_INVALID");
                    digest.update(buffer, 0, count); output.write(buffer, 0, count);
                    int progress = (int)(bytes * 100 / size);
                    if (progress != lastProgress) { lastProgress = progress; publish("downloading", progress, ""); }
                }
                output.getFD().sync();
            }
            if (bytes != size || !hex(digest.digest()).equals(hash)) throw new Exception("UPDATE_INVALID");
            verifyArchive(part, build);
            synchronized (this) {
                if (cancelled || destroyed) throw new Exception("UPDATE_CANCELLED");
                File apk = new File(directory, "release-" + build + ".apk");
                if (!part.renameTo(apk)) throw new Exception("UPDATE_STORAGE");
                readyFile = apk;
                publish("ready", 100, "");
            }
        } catch (Exception error) {
            if (part != null) part.delete();
            readyFile = null;
            publish(cancelled || destroyed ? "idle" : "error", 0, safeError(error));
        } finally {
            HttpURLConnection current = connection; connection = null;
            if (current != null) current.disconnect();
        }
    }

    private HttpURLConnection openDownload(URL next) throws Exception {
        for (int redirects = 0; redirects < 6; redirects++) {
            String host = next.getHost();
            if (!"https".equals(next.getProtocol()) || next.getUserInfo() != null
                || (next.getPort() != -1 && next.getPort() != 443)
                || !(host.equals("github.com") || host.equals("release-assets.githubusercontent.com")
                    || host.equals("objects.githubusercontent.com"))) throw new Exception("UPDATE_INVALID");
            HttpURLConnection request = (HttpURLConnection) next.openConnection();
            connection = request;
            request.setInstanceFollowRedirects(false);
            request.setConnectTimeout(15000); request.setReadTimeout(20000);
            request.setRequestProperty("Accept", "application/octet-stream");
            request.setRequestProperty("User-Agent", "Nivra-Android-Updater");
            int status = request.getResponseCode();
            if (status == 200) return request;
            String location = request.getHeaderField("Location"); request.disconnect();
            if (status < 300 || status > 399 || location == null) throw new Exception("UPDATE_NETWORK");
            next = new URL(next, location);
        }
        throw new Exception("UPDATE_NETWORK");
    }

    synchronized void install(PluginCall call) {
        if (destroyed || installing || !allowed) { call.reject("UPDATE_BUSY"); return; }
        if (readyFile == null || !readyFile.isFile()) { call.reject("UPDATE_NOT_READY"); return; }
        installing = true;
        final File apk = readyFile;
        final int build = targetBuild;
        final String hash = targetHash;
        final long size = targetSize;
        final long generation = ++installGeneration;
        worker.execute(() -> {
            try {
                // Check again before handing the package to Android, including tampering since download.
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream input = new java.io.FileInputStream(apk)) {
                    byte[] buffer = new byte[64 * 1024]; int count;
                    while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
                }
                if (apk.length() != size || !hex(digest.digest()).equals(hash)) throw new Exception("UPDATE_INVALID");
                verifyArchive(apk, build);
                activity.runOnUiThread(() -> {
                    synchronized (this) { try {
                        if (destroyed || generation != installGeneration || !allowed || readyFile != apk || !apk.isFile()
                            || activity.isFinishing() || NivraNativeCallGuard.hasCallInProgress(context)) {
                            call.reject("UPDATE_BUSY"); return;
                        }
                        if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
                            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + context.getPackageName())));
                            publish("permission", 100, ""); call.resolve(state); return;
                        }
                        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
                        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        activity.startActivity(intent);
                        // Keep ready state: dismissing the system installer allows a safe retry.
                        publish("ready", 100, ""); call.resolve(state);
                    } catch (Exception error) { publish("error", 0, "UPDATE_INSTALL"); call.reject("UPDATE_INSTALL"); }
                    finally { installing = false; } }
                });
            } catch (Exception error) { synchronized (this) {
                installing = false;
                if (!destroyed && generation == installGeneration) publish("error", 0, safeError(error));
                call.reject(generation == installGeneration ? safeError(error) : "UPDATE_CANCELLED");
            } }
        });
    }

    @SuppressWarnings("deprecation")
    private void verifyArchive(File apk, int build) throws Exception {
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (archive == null || !context.getPackageName().equals(archive.packageName)
            || versionCode(archive) != build || build <= versionCode(installed)) throw new Exception("UPDATE_INVALID");
        Signature[] ours = Build.VERSION.SDK_INT >= 28 ? installed.signingInfo.getApkContentsSigners() : installed.signatures;
        Signature[] theirs = Build.VERSION.SDK_INT >= 28 ? archive.signingInfo.getApkContentsSigners() : archive.signatures;
        if (ours == null || theirs == null || ours.length != 1 || theirs.length != 1
            || !Arrays.equals(ours[0].toByteArray(), theirs[0].toByteArray())) throw new Exception("UPDATE_SIGNATURE");
    }

    @SuppressWarnings("deprecation")
    private long installedBuild() throws Exception { return versionCode(context.getPackageManager().getPackageInfo(context.getPackageName(), 0)); }
    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(); for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return result.toString(); }
    private static String safeError(Exception error) {
        String message = error.getMessage();
        return message != null && message.matches("UPDATE_(INVALID|SIGNATURE|STORAGE|CANCELLED)") ? message : "UPDATE_NETWORK";
    }
    private static JSObject state(String phase, int progress, String error) {
        JSObject result = new JSObject(); result.put("phase", phase); result.put("progress", progress); result.put("error", error); return result;
    }
    private synchronized void publish(String phase, int progress, String error) {
        state = state(phase, progress, error);
        if (!destroyed) activity.runOnUiThread(() -> { if (!destroyed) listener.onState(state); });
    }
    synchronized void cancel(PluginCall call) {
        installGeneration++;
        if ("downloading".equals(state.optString("phase"))) {
            cancelled = true;
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
            // Keep busy until the worker closes its file; a retry cannot reuse a cancelled task's file.
        } else {
            if (readyFile != null) readyFile.delete(); readyFile = null; publish("idle", 0, "");
        }
        call.resolve(state);
    }
    synchronized void destroy() { destroyed = true; cancelled = true; allowed = false; installGeneration++; HttpURLConnection current = connection; if (current != null) current.disconnect(); worker.shutdownNow(); }
}
