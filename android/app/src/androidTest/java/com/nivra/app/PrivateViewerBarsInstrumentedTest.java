package com.nivra.app;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public class PrivateViewerBarsInstrumentedTest {
    @Test public void visibleSystemBarsKeepTheirContrastWhenTheViewerRotatesAndCloses() throws Exception {
        assumeTrue("Use the isolated experience lab", "com.nivra.app.experiencelab".equals(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName()));
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitForBridge(scenario);
            assertTrue("Welcome must finish setting the initial system bar surface", waitUntil(scenario, activity -> {
                View container = (View) activity.getBridge().getWebView().getParent();
                if (!(container.getBackground() instanceof ColorDrawable background)) return false;
                int color = background.getColor();
                return color == Color.parseColor("#f7f8f2") || color == Color.parseColor("#0d1815");
            }));
            evaluate(scenario, "void Capacitor.Plugins.StatusBar.hide()");
            applySurface(scenario, false, "#070b0d");
            assertSurface(scenario, false, "#070b0d");

            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            assertTrue("Device must rotate", waitUntil(scenario, activity ->
                activity.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE));
            assertSurface(scenario, false, "#070b0d");

            applySurface(scenario, true, "#ffffff");
            assertSurface(scenario, true, "#ffffff");
        }
    }

    private static void waitForBridge(ActivityScenario<MainActivity> scenario) throws Exception {
        for (int attempt = 0; attempt < 40; attempt++) {
            if ("true".equals(evaluate(scenario, """
                Boolean(document.readyState === 'complete'
                  && document.querySelector('app-root > ion-app')
                  && window.Capacitor?.Plugins?.NivraNative
                  && window.Capacitor?.Plugins?.SystemBars)
                """))) return;
            SystemClock.sleep(150);
        }
        throw new AssertionError("Capacitor bridge did not load");
    }

    private static void applySurface(ActivityScenario<MainActivity> scenario, boolean darkIcons, String color) throws Exception {
        String style = darkIcons ? "LIGHT" : "DARK";
        evaluate(scenario, """
            window.privateViewerBarFixture = false;
            (async () => {
              await Capacitor.Plugins.StatusBar.setOverlaysWebView({overlay: false});
              await Capacitor.Plugins.StatusBar.setStyle({style: '%s'});
              await Capacitor.Plugins.StatusBar.setBackgroundColor({color: '%s'});
              await Capacitor.Plugins.SystemBars.setStyle({style: '%s'});
              await Capacitor.Plugins.NivraNative.setNavigationBar({color: '%s', darkIcons: %b});
              if (%b) await Capacitor.Plugins.StatusBar.show();
              window.privateViewerBarFixture = true;
            })();
            """.formatted(style, color, style, color, darkIcons, !darkIcons));
        for (int attempt = 0; attempt < 40; attempt++) {
            if ("true".equals(evaluate(scenario, "window.privateViewerBarFixture"))) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("Capacitor did not finish updating the system bars");
    }

    private static void assertSurface(ActivityScenario<MainActivity> scenario, boolean darkIcons, String color) {
        AtomicReference<String> state = new AtomicReference<>();
        boolean applied = waitUntil(scenario, activity -> {
            View decor = activity.getWindow().getDecorView();
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
            var style = WindowCompat.getInsetsController(activity.getWindow(), decor);
            View container = (View) activity.getBridge().getWebView().getParent();
            boolean visible = insets != null && insets.isVisible(WindowInsetsCompat.Type.statusBars());
            boolean darkStatusIcons = style.isAppearanceLightStatusBars();
            boolean darkNavigationIcons = style.isAppearanceLightNavigationBars();
            String background = container.getBackground() instanceof ColorDrawable drawable
                ? Integer.toHexString(drawable.getColor()) : String.valueOf(container.getBackground());
            state.set("visible=" + visible + ", darkStatusIcons=" + darkStatusIcons
                + ", darkNavigationIcons=" + darkNavigationIcons + ", background=" + background);
            return visible && darkStatusIcons == darkIcons && darkNavigationIcons == darkIcons
                && background.equals(Integer.toHexString(Color.parseColor(color)));
        });
        assertTrue("Expected visible status bar with darkIcons=" + darkIcons + " on " + color + ", observed " + state.get(), applied);
    }

    private static boolean waitUntil(ActivityScenario<MainActivity> scenario, Predicate<MainActivity> predicate) {
        AtomicBoolean done = new AtomicBoolean();
        for (int attempt = 0; attempt < 45; attempt++) {
            scenario.onActivity(activity -> done.set(predicate.test(activity)));
            if (done.get()) return true;
            SystemClock.sleep(120);
        }
        return false;
    }

    private static String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch ready = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, value -> {
            result.set(value);
            ready.countDown();
        }));
        assertTrue("WebView should answer the local bridge test", ready.await(3, TimeUnit.SECONDS));
        return result.get();
    }
}
