package com.nivra.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Android component overrides persist per installation, across accounts and APK updates. */
final class LauncherAppearanceManager {
    private static final String PREFS = "nivra_launcher_appearance_v1";
    private LauncherAppearanceManager() { }
    static synchronized String reconcile(Context context) {
        AndroidComponents components = new AndroidComponents(context);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = prefs.getString("icon", "original");
        String icon = LauncherAppearancePolicy.migrationChoice(components, saved);
        LauncherAppearancePolicy.select(components, icon);
        if (!icon.equals(saved)) prefs.edit().putString("icon", icon).apply();
        return icon;
    }
    static synchronized String select(Context context, String icon) {
        // Validate before reading preferences or touching PackageManager.
        if (!LauncherAppearancePolicy.validIcon(icon)) throw new IllegalArgumentException("Unsupported launcher icon.");
        LauncherAppearancePolicy.select(new AndroidComponents(context), icon);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!icon.equals(prefs.getString("icon", "original"))) prefs.edit().putString("icon", icon).apply();
        return icon;
    }
    private static final class AndroidComponents implements LauncherAppearancePolicy.Components {
        private final PackageManager manager;
        private final String packageName;
        AndroidComponents(Context context) { manager = context.getPackageManager(); packageName = context.getPackageName(); }
        private ComponentName component(String icon) { return new ComponentName(packageName, LauncherAppearancePolicy.aliasName(icon)); }
        public boolean enabled(String icon) {
            int state = manager.getComponentEnabledSetting(component(icon));
            return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && "original".equals(icon));
        }
        public boolean atomic() { return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU; }
        public void setEnabled(String icon, boolean enabled) {
            manager.setComponentEnabledSetting(component(icon), enabled ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                : PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
        }
        public void setAtomically(Map<String, Boolean> states) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) throw new IllegalStateException("Atomic component update unavailable.");
            List<PackageManager.ComponentEnabledSetting> settings = new ArrayList<>();
            for (String icon : LauncherAppearancePolicy.ICONS) settings.add(new PackageManager.ComponentEnabledSetting(component(icon),
                states.get(icon) ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP));
            manager.setComponentEnabledSettings(settings);
        }
    }
}
