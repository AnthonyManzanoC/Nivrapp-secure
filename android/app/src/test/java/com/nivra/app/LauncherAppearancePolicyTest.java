package com.nivra.app;

import org.junit.Test;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class LauncherAppearancePolicyTest {
    private static final class Components implements LauncherAppearancePolicy.Components {
        final Map<String, Boolean> states = new LinkedHashMap<>();
        final List<String> operations = new ArrayList<>();
        boolean atomic;
        boolean failDisable;
        Components() { for (String icon : LauncherAppearancePolicy.ICONS) states.put(icon, icon.equals("original")); }
        public boolean enabled(String icon) { return Boolean.TRUE.equals(states.get(icon)); }
        public boolean atomic() { return atomic; }
        public void setEnabled(String icon, boolean enabled) {
            operations.add(icon + ":" + enabled);
            if (!enabled && failDisable) { failDisable = false; throw new IllegalStateException("OS refused change"); }
            states.put(icon, enabled);
            assertTrue("Never remove the last entry", states.containsValue(true));
        }
        public void setAtomically(Map<String, Boolean> next) { operations.add("atomic"); states.clear(); states.putAll(next); }
    }
    @Test public void acceptsOnlyBundledIdentifiersWithoutTrimmingOrCaseCoercion() {
        for (String icon : new String[] { "original", "emerald", "ivory" }) assertTrue(LauncherAppearancePolicy.validIcon(icon));
        for (String icon : new String[] { null, "", "Original", " original", "ivory ", "../../private", "/sdcard/icon.png", "https://evil.test/icon.png", "com.nivra.app.MainActivity" }) assertFalse(LauncherAppearancePolicy.validIcon(icon));
    }
    @Test public void aliasNamesAreStableAndNeverTargetTheRealActivity() {
        assertEquals("com.nivra.app.LauncherOriginal", LauncherAppearancePolicy.aliasName("original"));
        assertEquals("com.nivra.app.LauncherEmerald", LauncherAppearancePolicy.aliasName("emerald"));
        assertEquals("com.nivra.app.LauncherIvory", LauncherAppearancePolicy.aliasName("ivory"));
    }
    @Test public void rejectsUntrustedBridgeDocuments() {
        assertTrue(LauncherAppearancePolicy.trustedDocument("https://localhost/"));
        assertTrue(LauncherAppearancePolicy.trustedDocument("https://localhost/app/account?x=1"));
        for (String origin : new String[] { null, "", "file:///android_asset/index.html", "http://localhost/", "https://localhost:444/", "https://localhost.evil.test/", "https://user@localhost/", "https://nivrapp-secure.vercel.app/", "javascript:alert(1)" }) assertFalse(origin, LauncherAppearancePolicy.trustedDocument(origin));
    }
    @Test public void cleanInstallMigratesToOriginalWithOneEntry() {
        Components os = new Components();
        assertEquals("original", LauncherAppearancePolicy.migrationChoice(os, null));
        LauncherAppearancePolicy.select(os, "original");
        assertTrue(os.operations.isEmpty());
    }
    @Test public void realInstalledSelectionWinsOverStalePreferencesAcrossUpgrades() {
        Components os = new Components();
        os.states.put("original", false); os.states.put("emerald", true);
        assertEquals("emerald", LauncherAppearancePolicy.migrationChoice(os, "ivory"));
    }
    @Test public void repairsMissingAndDuplicateEntriesUsingOnlyAnAllowedPreference() {
        Components os = new Components();
        os.states.replaceAll((key, value) -> false);
        assertEquals("ivory", LauncherAppearancePolicy.migrationChoice(os, "ivory"));
        assertEquals("original", LauncherAppearancePolicy.migrationChoice(os, "../other"));
        os.states.put("original", true); os.states.put("emerald", true);
        assertNull(LauncherAppearancePolicy.activeIcon(os));
        LauncherAppearancePolicy.select(os, LauncherAppearancePolicy.migrationChoice(os, "emerald"));
        assertEquals("emerald", LauncherAppearancePolicy.activeIcon(os));
    }
    @Test public void enablesNewAliasBeforeDisablingTheOldOnLegacyAndroid() {
        Components os = new Components();
        LauncherAppearancePolicy.select(os, "emerald");
        assertEquals("emerald:true", os.operations.get(0));
        assertEquals("emerald", LauncherAppearancePolicy.activeIcon(os));
    }
    @Test public void usesOneAtomicTransactionOnAndroid13AndNewer() {
        Components os = new Components(); os.atomic = true;
        LauncherAppearancePolicy.select(os, "ivory");
        assertEquals(1, os.operations.size()); assertEquals("atomic", os.operations.get(0));
        assertEquals("ivory", LauncherAppearancePolicy.activeIcon(os));
    }
    @Test public void everySelectionIncludingOriginalRemainsReversible() {
        for (boolean atomic : new boolean[] { false, true }) {
            Components os = new Components(); os.atomic = atomic;
            for (String first : LauncherAppearancePolicy.ICONS) for (String second : LauncherAppearancePolicy.ICONS) {
                LauncherAppearancePolicy.select(os, first); LauncherAppearancePolicy.select(os, second);
                assertEquals(second, LauncherAppearancePolicy.activeIcon(os));
                assertEquals(1, os.states.values().stream().filter(Boolean.TRUE::equals).count());
            }
        }
    }
    @Test public void refusesInvalidInputWithoutAnyComponentMutation() {
        Components os = new Components();
        try { LauncherAppearancePolicy.select(os, "com.nivra.app.MainActivity"); fail(); }
        catch (IllegalArgumentException expected) { }
        assertTrue(os.operations.isEmpty()); assertEquals("original", LauncherAppearancePolicy.activeIcon(os));
    }
    @Test public void failedLegacyTransitionRollsBackWithoutLosingTheLauncher() {
        Components os = new Components(); os.failDisable = true;
        try { LauncherAppearancePolicy.select(os, "ivory"); fail(); }
        catch (IllegalStateException expected) { }
        assertEquals("original", LauncherAppearancePolicy.activeIcon(os));
    }
}
