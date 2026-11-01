package com.nivra.ratchetlab;

import android.content.Intent;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class RatchetStateInstrumentedTest {
    @Test public void requestedPhaseUsesRealWebViewSQLCipherAndKeystore() {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        var context = instrumentation.getTargetContext();
        String phase = InstrumentationRegistry.getArguments().getString("phase", "1");
        Intent intent = new Intent(context, RatchetLabActivity.class).putExtra("phase", phase).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        var activity = (RatchetLabActivity) instrumentation.startActivitySync(intent);
        try {
            long deadline = SystemClock.elapsedRealtime() + 90000;
            while (RatchetLabActivity.outcome == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(200);
            assertNotNull("Android WebView timed out", RatchetLabActivity.outcome);
            assertTrue(RatchetLabActivity.outcome, RatchetLabActivity.outcome.startsWith("PASS Android phase " + phase));
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
}
