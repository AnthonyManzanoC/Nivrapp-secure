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
    private TextView callerView;
    private TextView subtitleView;
    private BroadcastReceiver dismissReceiver;
    private boolean routed;

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
        setIntent(intent);
        bindIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        registerDismissReceiver();
    }

    @Override
    protected void onStop() {
        unregisterDismissReceiver();
        super.onStop();
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
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(26), dp(34), dp(26), dp(34));
        GradientDrawable background = new GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { Color.rgb(3, 7, 8), Color.rgb(6, 36, 35), Color.rgb(4, 12, 14) }
        );
        root.setBackground(background);
        root.setOnClickListener(view -> openCall());

        TextView appView = text("Nivra", 18, Color.rgb(114, 240, 202), Typeface.BOLD);
        appView.setGravity(Gravity.CENTER);
        root.addView(appView, matchWrap());

        callerView = text("Nivra", 30, Color.WHITE, Typeface.BOLD);
        callerView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams callerParams = matchWrap();
        callerParams.setMargins(0, dp(26), 0, dp(8));
        root.addView(callerView, callerParams);

        subtitleView = text("Llamada entrante", 17, Color.rgb(207, 218, 220), Typeface.NORMAL);
        subtitleView.setGravity(Gravity.CENTER);
        root.addView(subtitleView, matchWrap());

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams actionsParams = matchWrap();
        actionsParams.setMargins(0, dp(42), 0, 0);

        Button reject = actionButton("Rechazar", Color.rgb(220, 38, 38));
        reject.setOnClickListener(view -> sendCallAction(NivraNativePlugin.ACTION_CALL_REJECT));
        Button answer = actionButton("Contestar", Color.rgb(31, 211, 164));
        answer.setOnClickListener(view -> sendCallAction(NivraNativePlugin.ACTION_CALL_ANSWER));
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(dp(136), dp(56));
        buttonParams.setMargins(dp(6), 0, dp(6), 0);
        actions.addView(reject, buttonParams);
        actions.addView(answer, new LinearLayout.LayoutParams(buttonParams));
        root.addView(actions, actionsParams);

        setContentView(root);
    }

    private void bindIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        callId = stringExtra(intent, "callId", callId);
        String callerName = stringExtra(intent, "callerName", "Nivra");
        String callType = stringExtra(intent, "callType", "Voice");
        if (callerView != null) {
            callerView.setText(callerName);
        }
        if (subtitleView != null) {
            subtitleView.setText("Video".equalsIgnoreCase(callType) ? "Videollamada entrante" : "Llamada entrante");
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
            NotificationManagerCompat.from(this).cancel(notificationId);
        }
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(action);
        copyExtras(getIntent(), launch);
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
                if (callId.isEmpty() || callId.equals(dismissedCallId)) {
                    finish();
                }
            }
        };
        IntentFilter filter = new IntentFilter(NivraNativePlugin.ACTION_CALL_DISMISS);
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
