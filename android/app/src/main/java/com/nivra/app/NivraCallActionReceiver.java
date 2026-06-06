package com.nivra.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

public class NivraCallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) {
            return;
        }
        int notificationId = intent.getIntExtra("notificationId", 0);
        if (notificationId != 0) {
            NotificationManagerCompat.from(context).cancel(notificationId);
        }

        String action = intent.getAction();
        if (NivraNativePlugin.ACTION_CALL_ANSWER.equals(action)) {
            launchCallAction(context, intent, NivraNativePlugin.ACTION_CALL_ANSWER);
            return;
        }
        if (NivraNativePlugin.ACTION_CALL_REJECT.equals(action)) {
            boolean delivered = NivraNativePlugin.hasActivePlugin()
                && NivraNativePlugin.handleCallIntent(cloneForAction(intent, NivraNativePlugin.ACTION_CALL_REJECT));
            if (!delivered) {
                launchCallAction(context, intent, NivraNativePlugin.ACTION_CALL_REJECT);
            }
        }
    }

    private void launchCallAction(Context context, Intent source, String action) {
        Intent launch = cloneForAction(source, action);
        launch.setClass(context, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(launch);
    }

    private Intent cloneForAction(Intent source, String action) {
        Intent target = new Intent(source);
        target.setAction(action);
        return target;
    }
}
