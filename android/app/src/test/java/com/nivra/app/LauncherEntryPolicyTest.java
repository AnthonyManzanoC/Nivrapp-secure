package com.nivra.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class LauncherEntryPolicyTest {
    @Test public void opensStableActivityBeforeRemovingTransientEntrySynchronously() {
        List<String> events = new ArrayList<>();
        LauncherEntryPolicy.enter(new LauncherEntryPolicy.Host() {
            public void openMain() { events.add("open-main"); }
            public void finishEntry() { events.add("finish-entry"); }
        });
        assertEquals(Arrays.asList("open-main", "finish-entry"), events);
    }
    @Test public void launchFailureStillFinishesNoDisplayEntryWithoutRetryingOrRemovingTheMainTask() {
        List<String> events = new ArrayList<>();
        RuntimeException rejected = new IllegalStateException("fixture launch refusal");
        try {
            LauncherEntryPolicy.enter(new LauncherEntryPolicy.Host() {
                public void openMain() { events.add("open-main"); throw rejected; }
                public void finishEntry() { events.add("finish-entry"); }
            });
            fail("The caller decides how to report a refused launch");
        } catch (RuntimeException error) { assertSame(rejected, error); }
        assertEquals(Arrays.asList("open-main", "finish-entry"), events);
    }
}
