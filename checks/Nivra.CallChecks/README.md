# Call and QR regression checks

Run from the repository root:

```powershell
dotnet run --project checks/Nivra.CallChecks/Nivra.CallChecks.csproj --no-launch-profile
```

These checks exercise the API's call ownership transitions, same-device tab exclusion, explicit transfer, late timeout protection, departure behavior, stale signal filtering, EF ownership serialization and migration SQL. They also cover QR expiry, concurrent authorization and the authorization lease. They do not start the API or open a database connection; the EF context uses an offline localhost endpoint and mirrors the production retry configuration.

Before rollout, apply the additive `20260913180837_CallSessionOwnership` migration in a test database and validate simultaneous group starts through HTTP and SignalR, simultaneous answers, explicit transfers, device notifications and direct/group WebRTC on real devices. Group creation and ownership updates use PostgreSQL transaction advisory locks, so an in-memory test provider cannot validate their cross-process behavior. Call transitions execute in an EF execution-strategy scope with retries disabled for that operation, avoiding automatic replay after uncertain commits or emitted events.

The implementation deliberately has no background timer that expires an owner: mobile background suspension must not silently transfer a live call. Recovery from a lost tab or device uses the explicit `/calls/{id}/resume` action; ordinary `/claim` remains first-winner only.
