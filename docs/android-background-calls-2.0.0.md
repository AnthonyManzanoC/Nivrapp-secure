# Android calls and push delivery in 2.0.0

Incoming calls use a native Firebase service and Android call notifications. They do not require SignalR or a running WebView. The existing high-priority FCM data payload has a 75-second lifetime; the native handler immediately posts a visible call notification, keeps the ringtone active until dismissal/answer/expiry, and uses Android CallStyle where available. Terminal pushes leave a short tombstone so reordered incoming pushes cannot ring an ended call. The lock-screen activity expires with the same deadline.

Two missing pieces could make notifications appear to work only immediately after opening the app:

- Server readiness previously combined standard web push with FCM. Native readiness now uses `fcmReady`, so web push alone cannot report the APK ready.
- Stored tokens previously depended solely on a filesystem DataProtection keyring. An ephemeral server restart could lose that keyring. New destinations use versioned AES-GCM with a purpose-specific HMAC-derived key from the required stable server signing secret. Legacy records still decrypt when their keyring is available; unreadable legacy destinations remain pending re-registration instead of being irrevocably removed. Opening the updated app re-registers its destination in the durable format.

Firebase token refresh now persists a native registration job even when JavaScript is unavailable. The account/device refresh credential is encrypted with an Android Keystore key, never written as plaintext, sent only to the pinned HTTPS Nivra API, and cleared on logout or force-wipe. `POST /push-tokens/native-renew` can only register FCM for that exact active, trusted, unrevoked session. It cannot issue access tokens, rotate refresh credentials, extend the session or retrieve history. Rotated WebView credentials synchronize back to the native store. An expired/revoked native credential waits for authenticated app startup rather than restoring a session.

Authenticated token registration can move a token when the user logs into another account. Native renewal cannot move a token that already belongs to another user/device or reactivate a revoked destination. Both operations use the same PostgreSQL transaction lock for that token. This prevents an old in-flight worker from reclaiming the destination after an account switch. Every server push carries recipient user/device identifiers; native delivery requires both to match the current encrypted native registration.

Logout, force-wipe and an account/device switch also dismiss existing notifications and the old incoming-call screen and release the former account's foreground call service. Refreshing credentials for the same account/device preserves the live call. The updater receives an explicit native safety flag, so a call or lock that begins during installer verification invalidates that pending handoff as well as hiding the Angular prompt.

Diagnostics expose notification permission, call-channel enablement/sound, full-screen intent eligibility, native registration time/pending state and actual FCM readiness. The explicit onboarding permission action requests notifications. Optional settings buttons open app notifications, the calls channel or full-screen intent settings without changing the user's choices.

## Validation and real-device limits

`checks/Nivra.PushChecks` covers durable encryption/tamper rejection, native authorization, destination ownership and FCM payload policy. Android unit tests cover expired/malformed incoming pushes and pinned origins; Gradle compiles the actual native bridge/WorkManager/update helper. Frontend tests cover cold restoration, credential rotation, logout, FCM readiness and late responses after account switches.

Device delivery still requires Google Play services/FCM configuration, network access and notification permission. Android or the phone manufacturer can suppress an explicitly force-stopped/restricted app; an APK cannot override that choice. Full-screen presentation also follows Android's user-controlled eligibility. These conditions are distinct from WebView sleep. No physical phone Doze test was available during this implementation.

For device verification, log in and enable notices, place the app in the background, then test incoming calls after screen-off idle. With a test device connected, `adb shell dumpsys deviceidle force-idle` can exercise Doze and `adb shell dumpsys deviceidle unforce` restores normal operation. Verify incoming ringing, answer, decline, caller cancellation, an offline expired call, token refresh and account switching. Do not infer successful delivery from a live SignalR connection alone.

Official references: [Firebase Android priority and processing window](https://firebase.google.com/docs/cloud-messaging/android-message-priority), [Android Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby), [Android 14 full-screen intent eligibility](https://developer.android.com/about/versions/14/behavior-changes-14).
