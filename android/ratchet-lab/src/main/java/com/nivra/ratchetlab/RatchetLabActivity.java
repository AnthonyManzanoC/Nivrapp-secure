package com.nivra.ratchetlab;

import android.app.Activity;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import androidx.webkit.WebViewAssetLoader;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Collections;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Offline, separate application ID. No production application classes/data. */
public final class RatchetLabActivity extends Activity {
    public static volatile String outcome;
    private static final String ALIAS = "NivraRatchetLabWrappingV1";
    private static final Set<String> ASSETS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList("/assets/lab.html", "/assets/lab.mjs", "/assets/web-device.mjs",
        "/assets/pkg/web/nivra_ratchet_wasm.js", "/assets/pkg/web/nivra_ratchet_wasm_bg.wasm",
        "/assets/pkg/web/nivra_ratchet_olm.js", "/assets/pkg/web/nivra_ratchet_olm_bg.wasm")));
    private SQLiteDatabase database;
    private WebView web;
    private SharedPreferences preferences;
    private File file;
    private String phase;
    private NativeState stateBridge;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); outcome = null;
        try {
            phase = getIntent().getStringExtra("phase");
            if (!"1".equals(phase) && !"2".equals(phase)) throw new IllegalStateException("Invalid test phase");
            preferences = getSharedPreferences("ratchet_lab_v1", MODE_PRIVATE);
            file = getDatabasePath("ratchet_lab.db");
            if ("1".equals(phase) && !preferences.edit().putString("runId", UUID.randomUUID().toString()).commit()) throw new IllegalStateException("Metadata write failed");
            openDatabase("1".equals(phase));
            web = new WebView(this);
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true); settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
            settings.setDomStorageEnabled(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSupportMultipleWindows(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            var loader = new WebViewAssetLoader.Builder().addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
            web.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    var uri = request.getUrl();
                    if (!"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost()) || !ASSETS.contains(uri.getPath()))
                        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                    WebResourceResponse response = loader.shouldInterceptRequest(uri);
                    if (response != null) {
                        if (uri.getPath().endsWith(".wasm")) response.setMimeType("application/wasm");
                        if (uri.getPath().endsWith(".js") || uri.getPath().endsWith(".mjs")) response.setMimeType("application/javascript");
                        var headers = new HashMap<String, String>();
                        headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
                        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'");
                        response.setResponseHeaders(headers);
                    }
                    return response;
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onConsoleMessage(ConsoleMessage message) {
                    if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) android.util.Log.e("NivraRatchetLab", message.message());
                    return true;
                }
            });
            stateBridge = new NativeState(); web.addJavascriptInterface(stateBridge, "RatchetNativeState");
            setContentView(web); web.loadUrl("https://appassets.androidplatform.net/assets/lab.html");
        } catch (Exception error) { outcome = "FAIL native initialization: " + error.getClass().getSimpleName(); }
    }

    private void openDatabase(boolean create) throws Exception {
        System.loadLibrary("sqlcipher");
        KeyStore vault = KeyStore.getInstance("AndroidKeyStore"); vault.load(null);
        String wrapped = preferences.getString("wrapped", null), iv = preferences.getString("iv", null);
        byte[] secret = null;
        byte[] aad = ("NIVRA-RATCHET-LAB-SQLCIPHER-1|" + getPackageName()).getBytes(StandardCharsets.UTF_8);
        try {
        if (wrapped == null || iv == null) {
            if (!create || file.exists() || wrapped != null || iv != null) throw new IllegalStateException("Retained key unavailable");
            if (!vault.containsAlias(ALIAS)) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
                generator.generateKey();
            }
            secret = new byte[32]; new SecureRandom().nextBytes(secret);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, vault.getKey(ALIAS, null)); cipher.updateAAD(aad);
            if (!preferences.edit().putString("wrapped", Base64.encodeToString(cipher.doFinal(secret), Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).commit()) throw new IllegalStateException("Key envelope write failed");
        } else {
            if (!vault.containsAlias(ALIAS)) throw new IllegalStateException("Keystore key unavailable");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, vault.getKey(ALIAS, null), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))); cipher.updateAAD(aad);
            secret = cipher.doFinal(Base64.decode(wrapped, Base64.NO_WRAP));
        }
            if (secret.length != 32 || !create && !file.exists()) throw new IllegalStateException("Stored database unavailable");
            File parent = file.getParentFile(); if (!parent.exists() && !parent.mkdirs()) throw new IllegalStateException("Database directory unavailable");
            database = SQLiteDatabase.openDatabase(file.getPath(), Base64.encodeToString(secret, Base64.NO_WRAP), null,
                create ? SQLiteDatabase.CREATE_IF_NECESSARY : SQLiteDatabase.OPEN_READWRITE, null);
            database.enableWriteAheadLogging(); database.execSQL("PRAGMA synchronous=FULL");
            database.execSQL("CREATE TABLE IF NOT EXISTS snapshots(scope TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), state TEXT NOT NULL)");
        } finally { if (secret != null) Arrays.fill(secret, (byte) 0); }
    }

    public final class NativeState {
        @JavascriptInterface public synchronized String info() {
            try { return new JSONObject().put("phase", phase).put("runId", preferences.getString("runId", ""))
                .put("alicePublic", preferences.getString("alicePublic", "")).put("retryHash", preferences.getString("retryHash", "")).toString(); }
            catch (Exception error) { return "{}"; }
        }
        @JavascriptInterface public synchronized boolean remember(String name, String value) {
            return ("alicePublic".equals(name) || "retryHash".equals(name)) && value != null && value.length() <= 256 && preferences.edit().putString(name, value).commit();
        }
        @JavascriptInterface public synchronized String read(String scope) {
            try {
                checkScope(scope);
                try (Cursor cursor = database.rawQuery("SELECT revision,state FROM snapshots WHERE scope=?", new String[] { scope })) {
                    if (!cursor.moveToFirst()) return "{\"ok\":true,\"row\":null}";
                    // Keep the original JSON text. Re-encoding nested objects in
                    // Java can change context order and exact retry bytes.
                    return new JSONObject().put("ok", true).put("row", new JSONObject().put("revision", cursor.getLong(0)).put("stateJson", cursor.getString(1))).toString();
                }
            } catch (Exception error) { return "{\"ok\":false,\"code\":\"STATE_READ_FAILED\"}"; }
        }
        @JavascriptInterface public synchronized String commit(String scope, double expected, String encoded) {
            try {
                checkScope(scope);
                if (!Double.isFinite(expected) || expected < 0 || expected >= 9007199254740991d || Math.floor(expected) != expected
                    || encoded == null || encoded.getBytes(StandardCharsets.UTF_8).length > 32 * 1024 * 1024) throw new IllegalStateException("State bounds");
                new JSONObject(encoded);
                boolean conflict = false;
                database.beginTransaction();
                try {
                    long current = 0;
                    try (Cursor cursor = database.rawQuery("SELECT revision FROM snapshots WHERE scope=?", new String[] { scope })) { if (cursor.moveToFirst()) current = cursor.getLong(0); }
                    if (current != (long) expected) conflict = true;
                    else {
                        database.execSQL("INSERT INTO snapshots(scope,revision,state) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,state=excluded.state", new Object[] { scope, current + 1, encoded });
                        database.setTransactionSuccessful();
                    }
                } finally { database.endTransaction(); }
                return conflict ? "{\"ok\":false,\"code\":\"STATE_CONFLICT\"}" : new JSONObject().put("ok", true).put("revision", (long) expected + 1).toString();
            } catch (Exception error) { return "{\"ok\":false,\"code\":\"STATE_COMMIT_FAILED\"}"; }
        }
        @JavascriptInterface public synchronized boolean inspectProtection() {
            try {
                byte[] header = new byte[16];
                try (var input = new FileInputStream(file)) { if (input.read(header) != 16) return false; }
                if (Arrays.equals(header, "SQLite format 3\u0000".getBytes(StandardCharsets.UTF_8))) return false;
                KeyStore vault = KeyStore.getInstance("AndroidKeyStore"); vault.load(null);
                SecretKey key = (SecretKey) vault.getKey(ALIAS, null);
                return key != null && key.getEncoded() == null;
            } catch (Exception error) { return false; }
        }
        @JavascriptInterface public synchronized boolean rejectsWrongKey() {
            try (SQLiteDatabase wrong = SQLiteDatabase.openDatabase(file.getPath(), "synthetic-wrong-key", null, SQLiteDatabase.OPEN_READONLY, null);
                 Cursor cursor = wrong.rawQuery("SELECT count(*) FROM snapshots", null)) { cursor.moveToFirst(); return false; }
            catch (Exception expected) { return true; }
        }
        @JavascriptInterface public void complete(String result) { outcome = result != null && result.length() <= 512 ? result : "FAIL invalid outcome"; }
        private void checkScope(String scope) { if (scope == null || scope.isEmpty() || scope.length() > 512) throw new IllegalArgumentException("Invalid scope"); }
    }
    @Override public void onDestroy() {
        if (web != null) { web.removeJavascriptInterface("RatchetNativeState"); web.destroy(); }
        if (database != null) { synchronized (stateBridge != null ? stateBridge : this) { database.close(); } }
        super.onDestroy();
    }
}
