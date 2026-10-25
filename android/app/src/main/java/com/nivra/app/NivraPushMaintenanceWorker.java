package com.nivra.app;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;

/** Reconciles the FCM routing token using the existing authenticated device. */
public final class NivraPushMaintenanceWorker extends Worker {
    public NivraPushMaintenanceWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        JSONObject snapshot = NivraNativePushRegistration.read(context);
        if (snapshot == null || isStopped()) return Result.success();
        try {
            String token = Tasks.await(FirebaseMessaging.getInstance().getToken(), 20, TimeUnit.SECONDS);
            synchronized (NivraNativePushRegistration.class) {
                JSONObject current = NivraNativePushRegistration.read(context);
                // Never revive an account that logged out or changed while
                // Google Play services was returning the routing token.
                if (isStopped() || current == null || !current.optString("epoch").equals(snapshot.optString("epoch"))) {
                    return Result.success();
                }
                NivraNativePushRegistration.tokenChanged(context, token);
            }
            return Result.success();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Result.retry();
        } catch (Exception unavailable) {
            return getRunAttemptCount() < 3 && !isStopped() ? Result.retry() : Result.success();
        }
    }
}
