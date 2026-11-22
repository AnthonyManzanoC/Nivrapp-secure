package com.nivra.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

public class NivraIncomingCallActivity extends Activity {
    private String callId = "";
    private String recipientUserId = "";
    private String recipientDeviceId = "";
    private TextView callerView;
    private TextView avatarView;
    private TextView kindView;
    private Button answerView;
    private ScrollView rootView;
    private BroadcastReceiver dismissReceiver;
    private boolean routed;
    private final android.os.Handler expiryHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        configureWindow();
        buildLayout();
        bindIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (!callId.equals(stringExtra(intent, "callId", ""))
            || !recipientUserId.equals(stringExtra(intent, "recipientUserId", ""))
            || !recipientDeviceId.equals(stringExtra(intent, "recipientDeviceId", ""))) routed = false;
        setIntent(intent);
        bindIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        registerDismissReceiver();
        if (!isFinishing() && !routed) bindIntent(getIntent());
    }

    @Override
    protected void onStop() {
        unregisterDismissReceiver();
        super.onStop();
    }

    @Override protected void onDestroy() {
        expiryHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void configureWindow() {
        Window window = getWindow();
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        );
        WindowCompat.setDecorFitsSystemWindows(window, false);
        var bars = WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
    }

    private void buildLayout() {
        boolean compact = getResources().getConfiguration().screenHeightDp < 580
            || getResources().getConfiguration().fontScale > 1.25f;
        rootView = new ScrollView(this);
        rootView.setFillViewport(true);
        rootView.setBackground(callBackground(false));

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        int gutter = dp(compact ? 16 : 24);
        int top = dp(compact ? 10 : 16);
        int bottom = dp(compact ? 12 : 20);
        content.setPadding(gutter, top, gutter, bottom);
        ViewCompat.setOnApplyWindowInsetsListener(rootView, (view, insets) -> {
            var safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            content.setPadding(gutter + safe.left, top + safe.top, gutter + safe.right, bottom + safe.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        TextView appView = text("Nivra", 17, Color.rgb(172, 228, 209), Typeface.BOLD);
        appView.setGravity(Gravity.CENTER);
        content.addView(appView, matchWrap());
        content.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1));

        kindView = text("LLAMADA ENTRANTE", 12, Color.rgb(145, 233, 210), Typeface.BOLD);
        kindView.setGravity(Gravity.CENTER);
        kindView.setLetterSpacing(.12f);
        LinearLayout.LayoutParams kindParams = matchWrap();
        kindParams.topMargin = dp(12);
        content.addView(kindView, kindParams);

        int avatarSize = dp(compact ? 76 : 126);
        avatarView = text("N", compact ? 32 : 50, Color.rgb(218, 251, 242), Typeface.BOLD);
        avatarView.setGravity(Gravity.CENTER);
        avatarView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        GradientDrawable avatar = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
            new int[] {Color.rgb(36, 94, 83), Color.rgb(17, 56, 61)});
        avatar.setShape(GradientDrawable.OVAL);
        avatar.setStroke(dp(2), Color.rgb(88, 186, 161));
        avatarView.setBackground(avatar);
        LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(avatarSize, avatarSize);
        avatarParams.setMargins(0, dp(compact ? 12 : 24), 0, dp(compact ? 10 : 18));
        content.addView(avatarView, avatarParams);
        callerView = text("Nivra", compact ? 24 : 32, Color.WHITE, Typeface.BOLD);
        callerView.setGravity(Gravity.CENTER);
        callerView.setMaxLines(2);
        callerView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        ViewCompat.setAccessibilityHeading(callerView, true);
        content.addView(callerView, matchWrap());
        content.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 2));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        actions.setBaselineAligned(false);
        actions.setPadding(0, dp(16), 0, dp(6));
        Button reject = actionButton("Rechazar", Color.rgb(153, 42, 58), Color.WHITE, 16, 58);
        reject.setOnClickListener(view -> routeCallAction(NivraNativePlugin.ACTION_CALL_REJECT));
        answerView = actionButton("Contestar", Color.rgb(119, 225, 184), Color.rgb(5, 41, 31), 16, 58);
        answerView.setOnClickListener(view -> routeCallAction(NivraNativePlugin.ACTION_CALL_ANSWER));
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        buttonParams.setMargins(dp(4), 0, dp(4), 0);
        actions.addView(reject, buttonParams);
        actions.addView(answerView, new LinearLayout.LayoutParams(buttonParams));
        content.addView(actions, matchWrap());
        Button reply = actionButton("Responder con mensaje", Color.TRANSPARENT, Color.rgb(206, 243, 229), 14, 48);
        reply.setOnClickListener(view -> {
            getIntent().putExtra("callQuickReplies", "1");
            routeCallAction(NivraNativePlugin.ACTION_CALL_OPEN);
        });
        content.addView(reply, matchWrap());
        Button open = actionButton("Ver llamada", Color.TRANSPARENT, Color.rgb(188, 211, 207), 14, 48);
        open.setOnClickListener(view -> routeCallAction(NivraNativePlugin.ACTION_CALL_OPEN));
        content.addView(open, matchWrap());
        rootView.addView(content, new ScrollView.LayoutParams(-1, -2));
        setContentView(rootView);
        ViewCompat.requestApplyInsets(rootView);
    }

    private void bindIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        callId = stringExtra(intent, "callId", callId);
        recipientUserId = stringExtra(intent, "recipientUserId", "");
        recipientDeviceId = stringExtra(intent, "recipientDeviceId", "");
        java.util.Map<String, String> scope = new java.util.HashMap<>();
        scope.put("recipientUserId", recipientUserId); scope.put("recipientDeviceId", recipientDeviceId);
        if (!NivraNativePushRegistration.accepts(this, scope)) { finish(); return; }
        if (!NivraNativePushRegistration.acceptsCallIntent(this, intent)) { finish(); return; }
        if (NivraCallPushPolicy.wasEnded(this, recipientUserId, recipientDeviceId, callId, System.currentTimeMillis())) { finish(); return; }
        if (!NivraNativePushRegistration.isActive(this, scope)) {
            String command = intent.getAction();
            if (NivraNativePlugin.ACTION_CALL_ANSWER.equals(command) || NivraNativePlugin.ACTION_CALL_REJECT.equals(command)) routeCallAction(command);
            else finish(); // A full-screen reception must never switch accounts.
            return;
        }
        expiryHandler.removeCallbacksAndMessages(null);
        long remaining = 75_000;
        try { remaining = Long.parseLong(stringExtra(intent, "expiresAt", String.valueOf(System.currentTimeMillis() + remaining))) - System.currentTimeMillis(); }
        catch (NumberFormatException ignored) { remaining = 0; }
        if (remaining <= 0) { finish(); return; }
        expiryHandler.postDelayed(() -> {
            NivraNativePlugin.clearIncomingCallNotification(this, callId, recipientUserId, recipientDeviceId);
            finish();
        }, Math.min(remaining, 75_000));
        String callerName = stringExtra(intent, "callerName", "Nivra");
        scope.put("conversationId", stringExtra(intent, "conversationId", ""));
        if (NivraNativePushRegistration.hideNotificationContent(this, scope)) callerName = "Nivra";
        String callType = stringExtra(intent, "callType", "Voice");
        boolean video = "Video".equalsIgnoreCase(callType);
        avatarView.setText(initials(callerName));
        kindView.setText(video ? "VIDEOLLAMADA ENTRANTE" : "LLAMADA ENTRANTE");
        answerView.setText(video ? "Aceptar video" : "Contestar");
        answerView.setContentDescription(video ? "Contestar videollamada" : "Contestar llamada de voz");
        rootView.setBackground(callBackground(video));
        callerView.setText(callerName);
        String action = intent.getAction();
        if (NivraNativePlugin.ACTION_CALL_ANSWER.equals(action) || NivraNativePlugin.ACTION_CALL_REJECT.equals(action)) {
            routeCallAction(action);
        }
    }

    private void routeCallAction(String action) {
        if (routed) {
            return;
        }
        routed = true;
        Intent source = getIntent();
        java.util.Map<String, String> scope = new java.util.HashMap<>();
        scope.put("recipientUserId", recipientUserId); scope.put("recipientDeviceId", recipientDeviceId);
        if (source == null || !NivraNativePushRegistration.accepts(this, scope)
            || !NivraNativePushRegistration.acceptsCallIntent(this, source)
            || NivraCallPushPolicy.wasEnded(this, recipientUserId, recipientDeviceId, callId, System.currentTimeMillis())) {
            finish();
            return;
        }
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(action);
        copyExtras(source, launch);
        if (!NivraNativePushRegistration.signCallIntent(this, launch)) { finish(); return; }
        int notificationId = source.getIntExtra("notificationId", 0);
        if (notificationId != 0) {
            NotificationManagerCompat.from(this).cancel(NivraPushScopePolicy.notificationTag(recipientUserId, recipientDeviceId), notificationId);
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(launch);
        finish();
    }

    private void registerDismissReceiver() {
        if (dismissReceiver != null) {
            return;
        }
        dismissReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String dismissedCallId = intent == null ? "" : intent.getStringExtra("callId");
                boolean sameScope = intent != null && NivraPushScopePolicy.matches(recipientUserId, recipientDeviceId,
                    intent.getStringExtra("recipientUserId"), intent.getStringExtra("recipientDeviceId"));
                if (intent != null && NivraNativePushRegistration.ACTION_PRIVACY_CHANGED.equals(intent.getAction())) {
                    if (sameScope) {
                        if (!routed) bindIntent(getIntent());
                    }
                    return;
                }
                if ((intent != null && intent.getBooleanExtra("all", false)) || (sameScope && (intent.getBooleanExtra("scopeAll", false) || callId.isEmpty() || callId.equals(dismissedCallId)))) {
                    finish();
                }
            }
        };
        IntentFilter filter = new IntentFilter(NivraNativePlugin.ACTION_CALL_DISMISS);
        filter.addAction(NivraNativePushRegistration.ACTION_PRIVACY_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(dismissReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(dismissReceiver, filter);
        }
    }

    private void unregisterDismissReceiver() {
        if (dismissReceiver == null) {
            return;
        }
        try {
            unregisterReceiver(dismissReceiver);
        } catch (Exception ignored) {
            // The receiver may already be gone if Android tears down the activity during a cold start.
        }
        dismissReceiver = null;
    }

    private static void copyExtras(Intent source, Intent target) {
        if (source != null && source.getExtras() != null) {
            target.putExtras(source.getExtras());
        }
    }

    private static String initials(String name) {
        StringBuilder result=new StringBuilder();
        for(String word:name.trim().split("\\s+")) {
            if (!word.isEmpty()) result.appendCodePoint(Character.toUpperCase(word.codePointAt(0)));
            if(result.codePointCount(0,result.length())>=2)break;
        }
        return result.length()>0?result.toString():"N";
    }

    private TextView text(String value, int sp, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setTypeface(Typeface.DEFAULT, style);
        view.setIncludeFontPadding(false);
        return view;
    }

    private GradientDrawable callBackground(boolean video) {
        return new GradientDrawable(GradientDrawable.Orientation.TL_BR,
            video ? new int[] {Color.rgb(12, 21, 38), Color.rgb(28, 57, 64), Color.rgb(6, 17, 27)}
                  : new int[] {Color.rgb(5, 24, 26), Color.rgb(12, 53, 45), Color.rgb(4, 17, 23)});
    }

    private Button actionButton(String label, int color, int textColor, int textSize, int minHeight) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(textColor);
        button.setTextSize(textSize);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(dp(minHeight));
        button.setMinimumHeight(dp(minHeight));
        button.setPadding(dp(10), dp(8), dp(10), dp(8));
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(22));
        GradientDrawable rippleMask = new GradientDrawable();
        rippleMask.setColor(Color.WHITE);
        rippleMask.setCornerRadius(dp(22));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x28FFFFFF), background, rippleMask));
        return button;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String stringExtra(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}
