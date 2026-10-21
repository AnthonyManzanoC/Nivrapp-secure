package com.nivra.app;

import android.app.Activity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Bundled launcher choices only; no file paths, arbitrary components, uploads or permissions. */
@CapacitorPlugin(name = "LauncherAppearance")
public class LauncherAppearancePlugin extends Plugin {
    @PluginMethod public void getState(PluginCall call) { execute(call, null); }
    @PluginMethod public void setIcon(PluginCall call) {
        String icon = call.getString("icon");
        if (!LauncherAppearancePolicy.validIcon(icon)) {
            call.reject("Unsupported launcher icon.", "ICON_INVALID");
            return;
        }
        execute(call, icon);
    }
    private void execute(PluginCall call, String icon) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("Launcher appearance unavailable.", "ICON_UNAVAILABLE"); return; }
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed()
                || getBridge() == null || getBridge().getWebView() == null
                || !LauncherAppearancePolicy.trustedDocument(getBridge().getWebView().getUrl())) {
                call.reject("Launcher appearance requires the installed app.", "ICON_UNAVAILABLE"); return;
            }
            try {
                String selected = icon == null ? LauncherAppearanceManager.reconcile(getContext()) : LauncherAppearanceManager.select(getContext(), icon);
                JSObject state = new JSObject();
                state.put("supported", true); state.put("icon", selected); state.put("scope", "installation");
                call.resolve(state);
            } catch (Exception ignored) { call.reject("The launcher could not apply this icon.", "ICON_APPLY_FAILED"); }
        });
    }
}
