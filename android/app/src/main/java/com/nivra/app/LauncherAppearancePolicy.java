package com.nivra.app;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Fixed component allowlist and transition policy, independent of Android for unit tests. */
final class LauncherAppearancePolicy {
    static final List<String> ICONS = Collections.unmodifiableList(Arrays.asList("original", "emerald", "ivory"));
    interface Components {
        boolean enabled(String icon);
        boolean atomic();
        void setEnabled(String icon, boolean enabled);
        void setAtomically(Map<String, Boolean> states);
    }
    private LauncherAppearancePolicy() { }
    static boolean validIcon(String icon) { return ICONS.contains(icon); }
    static String aliasName(String icon) {
        if (!validIcon(icon)) throw new IllegalArgumentException("Unsupported launcher icon.");
        switch (icon) {
            case "emerald": return "com.nivra.app.LauncherEmerald";
            case "ivory": return "com.nivra.app.LauncherIvory";
            default: return "com.nivra.app.LauncherOriginal";
        }
    }
    static boolean trustedDocument(String value) {
        try {
            URI uri = new URI(value);
            return "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost())
                && uri.getRawUserInfo() == null && uri.getPort() == -1;
        } catch (Exception ignored) { return false; }
    }
    static String activeIcon(Components components) {
        String active = null;
        for (String icon : ICONS) if (components.enabled(icon)) {
            if (active != null) return null;
            active = icon;
        }
        return active;
    }
    static String migrationChoice(Components components, String saved) {
        String active = activeIcon(components);
        return active != null ? active : validIcon(saved) ? saved : "original";
    }
    static void select(Components components, String icon) {
        if (!validIcon(icon)) throw new IllegalArgumentException("Unsupported launcher icon.");
        Map<String, Boolean> before = new LinkedHashMap<>();
        Map<String, Boolean> desired = new LinkedHashMap<>();
        for (String candidate : ICONS) {
            before.put(candidate, components.enabled(candidate));
            desired.put(candidate, candidate.equals(icon));
        }
        if (before.equals(desired)) return;
        try { apply(components, desired); }
        catch (RuntimeException error) {
            // Legacy Android has no multi-component transaction: re-enable the prior
            // entry before removing the new one. Never leave the app with no launcher.
            if (!before.containsValue(true)) before.put("original", true);
            try { apply(components, before); }
            catch (RuntimeException rollback) {
                error.addSuppressed(rollback);
                try { components.setEnabled("original", true); }
                catch (RuntimeException recovery) { error.addSuppressed(recovery); }
            }
            throw error;
        }
    }
    private static void apply(Components components, Map<String, Boolean> states) {
        if (components.atomic()) { components.setAtomically(states); return; }
        // Enable first. The real activity is deliberately outside this allowlist.
        for (String icon : ICONS) if (states.get(icon)) components.setEnabled(icon, true);
        for (String icon : ICONS) if (!states.get(icon)) components.setEnabled(icon, false);
    }
}
