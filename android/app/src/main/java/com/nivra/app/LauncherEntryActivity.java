package com.nivra.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

/** Launcher aliases are replaceable; the WebView's task identity must not be. */
public final class LauncherEntryActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            LauncherEntryPolicy.enter(new LauncherEntryPolicy.Host() {
                public void openMain() {
                    // Build a fresh explicit intent. Launcher callers cannot inject
                    // account routing, data, URI grants, extras or activity flags.
                    Intent main = new Intent(LauncherEntryActivity.this, MainActivity.class);
                    main.setAction(Intent.ACTION_MAIN);
                    main.addCategory(Intent.CATEGORY_LAUNCHER);
                    main.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    startActivity(main);
                }
                public void finishEntry() { finish(); }
            });
        } catch (RuntimeException ignored) {
            // No caller data or account identifiers belong in launcher logs.
            Log.w("NivraLauncher", "Unable to open the stable app activity.");
        }
    }
}
