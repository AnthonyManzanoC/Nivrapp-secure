using System.Text.Json;
using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;
using Nivra.Api.Contracts;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;

var checks = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new InvalidOperationException(description);
    Console.WriteLine($"PASS {description}");
    checks++;
}
CallSession NewCall() => new()
{
    Id = "cal-test", InitiatorUserId = "alice", InitiatorDeviceId = "phone-a", InitiatorSessionId = "tab-a",
    Type = CallType.Voice, Status = CallStatus.Ringing, ParticipantUserIds = ["alice", "bob", "carol"],
    StartedAt = DateTimeOffset.UtcNow
};

var call = NewCall();
Check(CallCoordination.TryClaim(call, "alice", "phone-a", "tab-a"), "caller owns initiating tab");
Check(CallCoordination.TryClaim(call, "bob", "phone-b", "tab-b"), "first answering device claims participant");
Check(CallCoordination.TryClaim(call, "bob", "phone-b", "tab-b"), "same owner retry is idempotent");
Check(!CallCoordination.TryClaim(call, "bob", "phone-c", "tab-c"), "second device cannot answer the same participant");
Check(!CallCoordination.TryClaim(call, "alice", "phone-a", "tab-a2"), "second tab on the caller's device cannot steal outgoing call");
Check(!CallCoordination.TryClaim(call, "alice", "phone-a", null), "omitting session id cannot bypass existing tab owner");
foreach (var signal in new[] { "accepted", "declined", "busy", "left", "ice", "offer", "answer" })
{
    Check(!CallCoordination.TryAuthorizeSignal(call, "bob", "phone-c", "tab-c", signal), $"losing device cannot send {signal}");
}
Check(!CallCoordination.TryLeave(call, "bob", "phone-c", "tab-c", false, DateTimeOffset.UtcNow), "losing device timeout cannot end a live direct call");
Check(call.EndedAt is null && call.ParticipantSessions.Count == 2, "rejected timeout preserves active owners");
Check(CallCoordination.TryAuthorizeSignal(call, "carol", "phone-c", "tab-c", "declined") && !call.ParticipantSessions.ContainsKey("carol"), "declining a group invite does not occupy the room");
Check(CallCoordination.TryLeave(call, "alice", "phone-a", "tab-a", true, DateTimeOffset.UtcNow), "owner leaves group");
Check(call.EndedAt is null && CallCoordination.IsOwner(call, "bob", "phone-b", "tab-b"), "group continues after initiator leaves");
Check(!CallCoordination.TryAuthorizeSignal(call, "alice", "phone-a", "tab-a", "ice"), "late ICE cannot resurrect a departed owner");
Check(CallCoordination.TryClaim(call, "alice", "phone-a2", "tab-a2"), "departed participant can explicitly rejoin from another device");
Check(CallCoordination.TryLeave(call, "alice", "phone-a2", "tab-a2", true, DateTimeOffset.UtcNow), "rejoined device can leave");
Check(CallCoordination.TryLeave(call, "bob", "phone-b", "tab-b", true, DateTimeOffset.UtcNow), "last participant can close room");
Check(call.Status == CallStatus.Ended && call.EndedAt is not null && call.ParticipantSessions.Count == 0, "last departure closes group and clears owners");
Check(!CallCoordination.TryClaim(call, "alice", "phone-a", "tab-a"), "ended room cannot be claimed again");
Check(!CallCoordination.TryClaim(NewCall(), "outsider", "phone-x", "tab-x"), "nonparticipant cannot claim call");
Check(!CallCoordination.IsValidSessionId(new string('a', 129)) && !CallCoordination.IsValidSessionId("tab with spaces"), "invalid session ids are rejected");

var transfer = NewCall();
CallCoordination.TryClaim(transfer, "alice", "phone-a", "tab-a");
CallCoordination.TryClaim(transfer, "bob", "phone-b", "tab-b");
Check(!CallCoordination.TryClaim(transfer, "bob", "phone-c", "tab-c"), "normal claim cannot silently transfer ownership");
Check(CallCoordination.TryResume(transfer, "bob", "phone-c", "tab-c"), "explicit resume recovers call after reload or device loss");
Check(CallCoordination.IsOwner(transfer, "alice", "phone-a", "tab-a") && CallCoordination.IsOwner(transfer, "bob", "phone-c", "tab-c"), "resume replaces only requesting participant's owner");
Check(!CallCoordination.TryLeave(transfer, "bob", "phone-b", "tab-b", false, DateTimeOffset.UtcNow), "old device cannot end transferred call");
Check(!CallCoordination.TryResume(transfer, "outsider", "phone-x", "tab-x"), "outsider cannot resume another participant's call");
CallSignalRecord Signal(string kind, string device, string session) => new()
{
    Id = "signal-test", CallId = transfer.Id, FromUserId = "bob", FromDeviceId = device, FromClientSessionId = session,
    TargetUserId = "alice", SignalType = kind, PayloadCiphertext = "test-ciphertext"
};
Check(!CallCoordination.IsCurrentSignalSource(transfer, Signal("offer", "phone-b", "tab-b")), "persisted old-device SDP is filtered after transfer");
Check(!CallCoordination.IsCurrentSignalSource(transfer, Signal("left", "phone-b", "tab-b")), "persisted old-device departure cannot close resumed peer");
Check(CallCoordination.IsCurrentSignalSource(transfer, Signal("offer", "phone-c", "tab-c")), "current owner SDP remains deliverable");
transfer.ParticipantSessions.Remove("bob");
Check(CallCoordination.IsCurrentSignalSource(transfer, Signal("left", "phone-c", "tab-c")) && !CallCoordination.IsCurrentSignalSource(transfer, Signal("ice", "phone-c", "tab-c")), "departure control survives while abandoned ICE is dropped");
transfer.Status = CallStatus.Ended;
Check(!CallCoordination.TryResume(transfer, "bob", "phone-c", "tab-c"), "explicit resume cannot revive ended call");
var timeoutCall = NewCall();
CallCoordination.TryClaim(timeoutCall, "alice", "phone-a", "tab-a");
Check(!CallCoordination.ShouldIgnoreTimeout(timeoutCall, "alice"), "unanswered caller can expire ringing call");
CallCoordination.TryClaim(timeoutCall, "bob", "phone-b", "tab-b");
Check(CallCoordination.ShouldIgnoreTimeout(timeoutCall, "alice"), "answer claim wins against late caller timeout even before active status event");
timeoutCall.ParticipantSessions.Remove("bob");
timeoutCall.Status = CallStatus.Active;
Check(CallCoordination.ShouldIgnoreTimeout(timeoutCall, "alice"), "late unanswered timer cannot close an active call");

// Exercise the actual EF converters, snapshots and migration SQL without opening any database connection.
using var db = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>()
    .UseNpgsql("Host=127.0.0.1;Port=1;Database=offline_checks;Username=offline;Password=offline", options => options.EnableRetryOnFailure(3)).Options);
Check(db.Database.CreateExecutionStrategy().RetriesOnFailure, "offline context mirrors production provider retries");
await CallCoordination.RunAsync(db, () =>
{
    Check(ExecutionStrategy.Current is not null && !ExecutionStrategy.Current.RetriesOnFailure, "call transactions run in an EF strategy scope without replaying side effects");
    return Task.FromResult(true);
});
var mapped = db.Model.FindEntityType(typeof(CallSession))!.FindProperty(nameof(CallSession.ParticipantSessions))!;
var converter = mapped.GetValueConverter()!;
var original = new Dictionary<string, CallParticipantSession> { ["alice"] = new("phone-a", "tab-a") };
var serialized = (string)converter.ConvertToProvider(original)!;
var restored = (Dictionary<string, CallParticipantSession>)converter.ConvertFromProvider(serialized)!;
Check(restored["alice"] == original["alice"], "persisted ownership survives JSON roundtrip");
var snapshot = mapped.GetValueComparer()!.Snapshot(original);
original["bob"] = new("phone-b", "tab-b");
Check(!mapped.GetValueComparer()!.Equals(snapshot, original), "EF detects in-place ownership changes");
var migrationSql = db.GetService<IMigrator>().GenerateScript("20260726050348_ProfilePhotoVisibility", "20260913180837_CallSessionOwnership");
Check(migrationSql.Contains("\"ParticipantSessions\" jsonb NOT NULL DEFAULT '{}'"), "migration initializes existing calls with valid empty JSON");
Check(!migrationSql.Contains("DROP TABLE", StringComparison.OrdinalIgnoreCase) && !migrationSql.Contains("DELETE FROM", StringComparison.OrdinalIgnoreCase), "ownership migration preserves existing records");
using var parsed = JsonDocument.Parse(serialized);
Check(parsed.RootElement.GetProperty("alice").GetProperty("clientSessionId").GetString() == "tab-a", "ownership uses client-compatible JSON property names");
var clock = new ManualClock();
var qr = new QrLoginService(clock);
var challenge = qr.Start("Regression device", null, null, null);
clock.Advance(TimeSpan.FromSeconds(60));
Check(!qr.IsValid(challenge.Id, challenge.Code), "QR expires at one minute");
challenge = qr.Start("Regression device", null, null, null);
var authorization = new QrLoginAuthorizedResponse(null!, "test-ciphertext");
var attempts = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(() => qr.TryAuthorize(challenge.Id, challenge.Code, authorization))));
Check(attempts.Count(accepted => accepted) == 1, "simultaneous QR authorization has exactly one winner");
clock.Advance(TimeSpan.FromSeconds(30));
Check(qr.Get(challenge.Id, challenge.Code) is null, "authorized QR credentials are purged after delivery window");
challenge = qr.Start("Regression device", null, null, null);
var lease = await qr.AcquireAuthorizationAsync(challenge.Id, challenge.Code, CancellationToken.None);
var waitingLease = qr.AcquireAuthorizationAsync(challenge.Id, challenge.Code, CancellationToken.None);
Check(lease is not null && !waitingLease.IsCompleted, "second QR scan waits before issuing credentials");
qr.TryAuthorize(challenge.Id, challenge.Code, authorization);
lease!.Dispose();
Check(await waitingLease is null, "second QR scan cannot issue another session after winner completes");
Check(NivraNumbers.Normalize("849-123-456") == "849123456", "formatted Nivra ID resolves to canonical number");
Check(NivraNumbers.Normalize("@849123456") is null, "explicit alias keeps its namespace");
Check(NivraNumbers.Normalize("084912345") is null && NivraNumbers.Normalize("84912345x") is null, "invalid ID formats are rejected");
Check(Enumerable.Range(0, 1000).Select(_ => NivraNumbers.Generate()).All(value => NivraNumbers.Normalize(value) == value), "generated private identifiers satisfy database format");
Check(db.Model.FindEntityType(typeof(UserAccount))!.GetIndexes().Any(index => index.IsUnique && index.Properties.Any(property => property.Name == nameof(UserAccount.NivraNumber))), "database enforces private number uniqueness");
Check(Nivra.Api.Endpoints.RecoveryEndpoints.NormalizeEmail("test@example.com") == "test@example.com", "recovery accepts a valid email address");
Check(Nivra.Api.Endpoints.RecoveryEndpoints.NormalizeEmail("Fake <test@example.com>") is null, "recovery rejects display-name email injection");
Check(Nivra.Api.Endpoints.RecoveryEndpoints.ValidToken(new string('a', 43)) && !Nivra.Api.Endpoints.RecoveryEndpoints.ValidToken("short"), "recovery token requires full 256-bit representation");
Check(Nivra.Api.Endpoints.RecoveryEndpoints.HashToken(new string('a', 43)).Length == 64, "only SHA-256 recovery token digest is stored");
var recoveryHtml = BrevoEmailService.Html("<script>", "private", "https://example.com/?a=1&b=2", "Continue", "Notice");
Check(!recoveryHtml.Contains("<script>") && recoveryHtml.Contains("&lt;script&gt;"), "transactional template escapes interpolated content");
var acceptedDelivery = new RecordingBrevoHandler(HttpStatusCode.Created);
using (var acceptedClient = new HttpClient(acceptedDelivery))
{
    var mail = new BrevoEmailService(new FixedHttpClientFactory(acceptedClient), Options.Create(new BrevoEmailOptions
    {
        ApiKey = "test-api-key", SenderEmail = "sender@example.test", PublicAppUrl = "https://app.example.test"
    }));
    await mail.SendChallengeAsync("recipient@example.test", "reset-password", new string('a', 43), CancellationToken.None);
}
Check(acceptedDelivery.Calls == 1 && acceptedDelivery.Uri?.ToString() == "https://api.brevo.com/v3/smtp/email", "recovery delivery synchronously posts once to Brevo");
Check(acceptedDelivery.ApiKey == "test-api-key" && acceptedDelivery.Body?.Contains("recipient@example.test") == true && acceptedDelivery.Body.Contains("recover#token="), "recovery delivery sends the intended recipient and reset link");
var rejectedDelivery = new RecordingBrevoHandler(HttpStatusCode.ServiceUnavailable);
var rejected = false;
using (var rejectedClient = new HttpClient(rejectedDelivery))
{
    var mail = new BrevoEmailService(new FixedHttpClientFactory(rejectedClient), Options.Create(new BrevoEmailOptions
    {
        ApiKey = "test-api-key", SenderEmail = "sender@example.test", PublicAppUrl = "https://app.example.test"
    }));
    try { await mail.SendChallengeAsync("recipient@example.test", "reset-password", new string('b', 43), CancellationToken.None); }
    catch (HttpRequestException) { rejected = true; }
}
Check(rejected, "recovery delivery failure is observed by the request instead of a volatile queue");
Check(ClientCompatibility.RequiresCallProtocol("/calls/start", "POST") && !ClientCompatibility.RequiresCallProtocol("/calls/test/end", "POST"), "legacy clients cannot start calls but can hang up during rollout");
Console.WriteLine($"{checks} regression checks passed. Physical devices require separate validation.");

sealed class ManualClock : TimeProvider
{
    private DateTimeOffset current = DateTimeOffset.Parse("2026-09-13T00:00:00Z");
    public override DateTimeOffset GetUtcNow() => current;
    public void Advance(TimeSpan elapsed) => current = current.Add(elapsed);
}

sealed class FixedHttpClientFactory(HttpClient client) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => client;
}

sealed class RecordingBrevoHandler(HttpStatusCode statusCode) : HttpMessageHandler
{
    public int Calls { get; private set; }
    public Uri? Uri { get; private set; }
    public string? ApiKey { get; private set; }
    public string? Body { get; private set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Calls++;
        Uri = request.RequestUri;
        ApiKey = request.Headers.TryGetValues("api-key", out var values) ? values.SingleOrDefault() : null;
        Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        return new HttpResponseMessage(statusCode);
    }
}
