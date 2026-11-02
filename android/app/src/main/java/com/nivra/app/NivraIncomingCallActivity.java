package com.nivra.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationManagerCompat;

public class NivraIncomingCallActivity extends Activity {
    private String callId = "";
    private String recipientUserId = "";
    private String recipientDeviceId = "";
    private TextView callerView;
    private TextView subtitleView;
    private TextView avatarView;
    private TextView kindView;
    private Button answerView;
    private LinearLayout rootView;
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
        window.setStatusBarColor(Color.rgb(3, 7, 8));
        window.setNavigationBarColor(Color.rgb(3, 7, 8));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
    }

    private void buildLayout() {
        rootView = new LinearLayout(this);
        rootView.setOrientation(LinearLayout.VERTICAL);
        rootView.setGravity(Gravity.CENTER_HORIZONTAL);
        rootView.setFitsSystemWindows(true);
        rootView.setPadding(dp(24), dp(24), dp(24), dp(28));
        rootView.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
            new int[] { Color.rgb(5, 24, 26), Color.rgb(10, 53, 47), Color.rgb(4, 14, 21) }));
        TextView appView = text("N I V R A", 15, Color.rgb(145, 233, 210), Typeface.BOLD);
        appView.setGravity(Gravity.CENTER);
        rootView.addView(appView, matchWrap());
        TextView privacy = text("Conexión privada", 12, Color.rgb(169, 194, 188), Typeface.NORMAL);
        privacy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams privacyParams=matchWrap(); privacyParams.topMargin=dp(8);
        rootView.addView(privacy, privacyParams);
        rootView.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1));
        kindView = text("LLAMADA ENTRANTE", 12, Color.rgb(145, 233, 210), Typeface.BOLD);
        kindView.setGravity(Gravity.CENTER);
        rootView.addView(kindView, matchWrap());
        avatarView = text("N", 50, Color.rgb(204, 255, 238), Typeface.BOLD);
        avatarView.setGravity(Gravity.CENTER);
        avatarView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        GradientDrawable avatar = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
            new int[] {Color.rgb(28, 93, 80), Color.rgb(13, 49, 53)});
        avatar.setShape(GradientDrawable.OVAL); avatar.setStroke(dp(2), Color.rgb(40, 188, 151));
        avatarView.setBackground(avatar);
        LinearLayout.LayoutParams avatarParams=new LinearLayout.LayoutParams(dp(136),dp(136));
        avatarParams.setMargins(0,dp(28),0,dp(24));rootView.addView(avatarView,avatarParams);
        callerView=text("Nivra",30,Color.WHITE,Typeface.BOLD);callerView.setGravity(Gravity.CENTER);
        callerView.setMaxLines(2);callerView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        rootView.addView(callerView,matchWrap());
        subtitleView=text("Llamada de voz",16,Color.rgb(186,210,205),Typeface.NORMAL);
        subtitleView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subtitleParams=matchWrap();subtitleParams.topMargin=dp(12);
        rootView.addView(subtitleView,subtitleParams);
        rootView.addView(new View(this),new LinearLayout.LayoutParams(1,0,1));
        // Keep the actions visible on compact and large screens without fixed-width buttons.
        LinearLayout actions=new LinearLayout(this);actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        Button reject=actionButton("Rechazar",Color.rgb(198,43,66));
        reject.setOnClickListener(view->sendCallAction(NivraNativePlugin.ACTION_CALL_REJECT));
        answerView=actionButton("Contestar",Color.rgb(0,151,112));
        answerView.setOnClickListener(view->sendCallAction(NivraNativePlugin.ACTION_CALL_ANSWER));
        LinearLayout.LayoutParams buttonParams=new LinearLayout.LayoutParams(0,dp(64),1);
        buttonParams.setMargins(dp(5),dp(16),dp(5),0);
        actions.addView(reject,buttonParams);actions.addView(answerView,new LinearLayout.LayoutParams(buttonParams));
        rootView.addView(actions,matchWrap());
        Button open=actionButton("Ver llamada",Color.TRANSPARENT);open.setTextSize(14);
        open.setOnClickListener(view->openCall());
        rootView.addView(open,new LinearLayout.LayoutParams(-1,dp(52)));
        setContentView(rootView);
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
        rootView.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
            video ? new int[] {Color.rgb(14,22,43),Color.rgb(23,57,66),Color.rgb(6,18,30)}
                  : new int[] {Color.rgb(5,24,26),Color.rgb(10,53,47),Color.rgb(4,14,21)}));
        if (callerView != null) {
            callerView.setText(callerName);
        }
        if (subtitleView != null) {
            subtitleView.setText(video ? "Te están llamando por video" : "Te están llamando por voz");
        }
        String action = intent.getAction();
        if (NivraNativePlugin.ACTION_CALL_ANSWER.equals(action) || NivraNativePlugin.ACTION_CALL_REJECT.equals(action)) {
            routeCallAction(action);
        }
    }

    private void openCall() {
        routeCallAction(NivraNativePlugin.ACTION_CALL_OPEN);
    }

    private void sendCallAction(String action) {
        routeCallAction(action);
    }

    private void routeCallAction(String action) {
        if (routed) {
            return;
        }
        routed = true;
        int notificationId = getIntent() == null ? 0 : getIntent().getIntExtra("notificationId", 0);
        if (notificationId != 0) {
            NotificationManagerCompat.from(this).cancel(NivraPushScopePolicy.notificationTag(recipientUserId, recipientDeviceId), notificationId);
        }
        java.util.Map<String, String> scope = new java.util.HashMap<>();
        scope.put("recipientUserId", recipientUserId); scope.put("recipientDeviceId", recipientDeviceId);
        if (!NivraNativePushRegistration.accepts(this, scope)) { finish(); return; }
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(action);
        copyExtras(getIntent(), launch);
        if (!NivraNativePushRegistration.signCallIntent(this, launch)) { finish(); return; }
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

    private Button actionButton(String label, int color) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(28));
        button.setBackground(background);
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
