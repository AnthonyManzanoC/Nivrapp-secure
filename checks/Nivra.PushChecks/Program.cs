using System.Reflection;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;

var checks = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new InvalidOperationException(description);
    Console.WriteLine($"PASS {description}"); checks++;
}
bool Rejects(Action action) { try { action(); return false; } catch (Exception e) when (e is CryptographicException or FormatException) { return true; } }

var firstHost = new PushTokenCipher("test-stable-secret-never-a-production-credential");
var nextHost = new PushTokenCipher("test-stable-secret-never-a-production-credential");
var encrypted = firstHost.Protect("fcm-routing-address");
Check(nextHost.Unprotect(encrypted) == "fcm-routing-address", "push destination decrypts after a new server instance");
Check(firstHost.Protect("fcm-routing-address") != encrypted, "each stored push destination uses a fresh nonce");
Check(!encrypted.Contains("fcm-routing-address", StringComparison.Ordinal), "stored push destination does not contain plaintext");
Check(Rejects(() => new PushTokenCipher("other-secret").Unprotect(encrypted)), "a different server key cannot decrypt push destination");
var mutated = Convert.FromBase64String(encrypted[PushTokenCipher.Prefix.Length..]); mutated[^1] ^= 1;
Check(Rejects(() => firstHost.Unprotect(PushTokenCipher.Prefix + Convert.ToBase64String(mutated))), "modified ciphertext is rejected");
Check(Rejects(() => firstHost.Unprotect(PushTokenCipher.Prefix + Convert.ToBase64String(new byte[28]))), "truncated push destination is rejected");

var now = DateTimeOffset.UtcNow;
var session = new SessionRecord { Id = "session", UserId = "alice", DeviceId = "phone", RefreshTokenHash = "hash", CreatedAt = now, ExpiresAt = now.AddDays(1) };
var device = new DeviceRecord { Id = "phone", UserId = "alice", Name = "Phone", IsTrusted = true };
var user = new UserAccount { Id = "alice", Alias = "alice", PasswordHash = new PasswordHash() };
bool Allowed(string uid = "alice", string did = "phone") => NativePushRegistrationPolicy.IsAllowed(session, user, device, uid, did, now);
Check(Allowed(), "active trusted session can renew its own FCM destination");
Check(!Allowed("bob") && !Allowed(did: "other-phone"), "native renewal cannot change account or device");
session.RevokedAt = now; Check(!Allowed(), "logged-out session cannot renew notifications"); session.RevokedAt = null;
session.ExpiresAt = now; Check(!Allowed(), "expired native session cannot renew notifications"); session.ExpiresAt = now.AddDays(1);
device.RevokedAt = now; Check(!Allowed(), "revoked device cannot renew notifications"); device.RevokedAt = null;
device.IsTrusted = false; Check(!Allowed(), "untrusted device cannot renew notifications"); device.IsTrusted = true;
user.DisabledAt = now; Check(!Allowed(), "disabled account cannot renew notifications"); user.DisabledAt = null;
Check(!NativePushRegistrationPolicy.IsAllowed(null, user, device, "alice", "phone", now), "missing session fails closed");
Check(session.ExpiresAt == now.AddDays(1) && session.RefreshTokenHash == "hash", "renewal authorization neither extends nor rotates the session");
var destination = new PushTokenRecord { Id = "push", UserId = "bob", DeviceId = "phone-b", Provider = "fcm", TokenHash = "token-hash" };
Check(!NativePushRegistrationPolicy.CanRenewDestination(destination, "alice", "phone-a"), "late native worker cannot reclaim a token reassigned to another account");
Check(!NativePushRegistrationPolicy.CanRenewDestination(destination, "bob", "phone-old"), "late native worker cannot reclaim another device destination");
Check(NativePushRegistrationPolicy.CanRenewDestination(destination, "bob", "phone-b"), "native worker can refresh its existing destination");
destination.RevokedAt = now;
Check(!NativePushRegistrationPolicy.CanRenewDestination(destination, "bob", "phone-b"), "native worker cannot reactivate an explicitly revoked destination");
Check(NativePushRegistrationPolicy.CanRenewDestination(null, "bob", "phone-b"), "native token refresh can create a newly issued FCM destination");

var destinationQuery = typeof(PushNotificationService).GetMethod("PushDestinations", BindingFlags.NonPublic | BindingFlags.Static)!;
IQueryable<PushTokenRecord> Destinations(IQueryable<PushTokenRecord> tokens, IQueryable<DeviceRecord> devices,
    string uid, Dictionary<string, string> data, string? target = null) =>
    (IQueryable<PushTokenRecord>)destinationQuery.Invoke(null, new object?[] { tokens, devices, uid, data, target })!;
DeviceRecord PushDevice(string id, string uid = "alice", bool revoked = false, bool trusted = true) =>
    new() { Id = id, UserId = uid, Name = id, IsTrusted = trusted, RevokedAt = revoked ? now : null };
PushTokenRecord PushDestination(string id, string did, string uid = "alice", string provider = "fcm", bool revoked = false) =>
    new() { Id = id, UserId = uid, DeviceId = did, Provider = provider, TokenHash = id, RevokedAt = revoked ? now.AddMinutes(-1) : null };
Dictionary<string, string> Wipe(string did) => new() { ["type"] = "force_wipe", ["code"] = "FORCE_WIPE", ["deviceId"] = did };
var pushDevices = new[] {
    PushDevice("active"), PushDevice("revoked", revoked: true), PushDevice("foreign", "bob", revoked: true),
    PushDevice("untrusted", revoked: true, trusted: false)
}.AsQueryable();
var pushDestinations = new[] {
    PushDestination("active-fcm", "active"), PushDestination("revoked-fcm", "revoked"),
    PushDestination("revoked-web", "revoked", provider: "webpush"), PushDestination("explicitly-revoked", "revoked", revoked: true),
    PushDestination("foreign-account", "revoked", "bob"), PushDestination("foreign-device", "foreign"),
    PushDestination("untrusted", "untrusted"), PushDestination("unsupported", "revoked", provider: "unsupported")
}.AsQueryable();
var wipeTargets = Destinations(pushDestinations, pushDevices, "alice", Wipe("revoked"), "revoked").Select(token => token.Id).Order().ToArray();
Check(wipeTargets.SequenceEqual(new[] { "revoked-fcm", "revoked-web" }), "scoped FORCE_WIPE reaches the revoked device through its active FCM and Web Push destinations only");
Check(Destinations(pushDestinations, pushDevices, "alice", Wipe("revoked"), "revoked").All(token => token.RevokedAt == null),
    "FORCE_WIPE never reuses an explicitly revoked token");
Check(!Destinations(pushDestinations, pushDevices, "alice", Wipe("foreign"), "foreign").Any(), "FORCE_WIPE cannot target another account's device");
Check(!Destinations(pushDestinations, pushDevices, "bob", Wipe("revoked"), "revoked").Any(), "token account alone cannot authorize a wipe of another account's device");
Check(!Destinations(pushDestinations, pushDevices, "alice", Wipe("untrusted"), "untrusted").Any(), "FORCE_WIPE does not bypass device trust");
Check(!Destinations(pushDestinations, pushDevices, "alice", Wipe("revoked")).Any(), "FORCE_WIPE without an explicit target fails closed");
Check(!Destinations(pushDestinations, pushDevices, "alice", Wipe("active"), "revoked").Any(), "FORCE_WIPE with a mismatched payload device fails closed");
var incompleteWipe = Wipe("revoked"); incompleteWipe.Remove("code");
Check(!Destinations(pushDestinations, pushDevices, "alice", incompleteWipe, "revoked").Any(), "incomplete FORCE_WIPE cannot bypass revocation");
foreach (var eventType in new[] { "message", "incoming_call", "end_call", "contact_joined" })
{
    var ordinaryTargets = Destinations(pushDestinations, pushDevices, "alice", new() { ["type"] = eventType }).Select(token => token.Id).ToArray();
    Check(ordinaryTargets.SequenceEqual(new[] { "active-fcm" }), $"{eventType} remains restricted to active trusted devices");
}
Check(!Destinations(pushDestinations, pushDevices, "alice", new() { ["type"] = "message", ["code"] = "FORCE_WIPE", ["deviceId"] = "revoked" }, "revoked").Any(),
    "adding wipe metadata to a normal event cannot deliver it to a revoked device");
Check(pushDevices.Single(candidate => candidate.Id == "revoked").RevokedAt == now &&
    pushDestinations.Single(token => token.Id == "explicitly-revoked").RevokedAt == now.AddMinutes(-1),
    "wipe destination selection preserves device and token revocation state");
using (var pushDb = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>()
    .UseNpgsql("Host=127.0.0.1;Database=offline_checks;Username=offline;Password=offline").Options))
{
    var uniqueIndexes = pushDb.Model.FindEntityType(typeof(PushTokenRecord))!.GetIndexes().Where(index => index.IsUnique).ToArray();
    Check(uniqueIndexes.Any(index => index.Properties.Select(property => property.Name).SequenceEqual(new[] { "UserId", "DeviceId", "TokenHash" })) &&
        !uniqueIndexes.Any(index => index.Properties.Select(property => property.Name).SequenceEqual(new[] { "TokenHash" })),
        "one physical push address supports independent unique account/device memberships");
    var migrationSql = pushDb.GetService<IMigrator>().GenerateScript("20261025071607_AccountAppearanceBroadcastLists", "20261025083000_ScopedPushMemberships");
    Check(migrationSql.Contains("DROP INDEX public.\"IX_push_tokens_TokenHash\"", StringComparison.Ordinal) &&
        migrationSql.Contains("\"UserId\", \"DeviceId\", \"TokenHash\"", StringComparison.Ordinal),
        "offline migration removes global token uniqueness and installs scoped uniqueness without deleting memberships");
    var wipeSql = Destinations(pushDb.PushTokens, pushDb.Devices, "alice", Wipe("revoked"), "revoked").ToQueryString();
    var normalSql = Destinations(pushDb.PushTokens, pushDb.Devices, "alice", new() { ["type"] = "message" }).ToQueryString();
    Check(wipeSql.Contains("EXISTS", StringComparison.Ordinal) && wipeSql.Contains("\"RevokedAt\" IS NULL", StringComparison.Ordinal) &&
        wipeSql.Contains("\"DeviceId\"", StringComparison.Ordinal) && normalSql.Contains("\"RevokedAt\" IS NULL", StringComparison.Ordinal),
        "production PostgreSQL translates both destination policies into SQL without a database connection");
}

var sharedDevices = new[] { PushDevice("alice-phone"), PushDevice("bob-phone", "bob") }.AsQueryable();
var sharedTokens = new[] { PushDestination("alice-membership", "alice-phone"), PushDestination("bob-membership", "bob-phone", "bob") };
foreach (var shared in sharedTokens) shared.TokenHash = "same-physical-fcm-token";
Check(Destinations(sharedTokens.AsQueryable(), sharedDevices, "alice", new() { ["type"] = "message" }).Single().Id == "alice-membership" &&
    Destinations(sharedTokens.AsQueryable(), sharedDevices, "bob", new() { ["type"] = "incoming_call" }).Single().Id == "bob-membership",
    "messages and calls independently reach both account memberships sharing one FCM token");
sharedTokens[0].RevokedAt = now;
Check(!Destinations(sharedTokens.AsQueryable(), sharedDevices, "alice", new() { ["type"] = "message" }).Any() &&
    Destinations(sharedTokens.AsQueryable(), sharedDevices, "bob", new() { ["type"] = "message" }).Single().Id == "bob-membership",
    "revoking one saved account membership preserves the other account's delivery");

var builder = typeof(PushNotificationService).GetMethod("CreateFcmMessage", BindingFlags.NonPublic | BindingFlags.Static)!;
Dictionary<string, object?> Message(string type) => (Dictionary<string, object?>)builder.Invoke(null, new object[] {
    "token", "private title", "private body", new Dictionary<string, string> { ["type"] = type, ["tag"] = "nivra-call-call1" }, true, true })!;
var incoming = Message("incoming_call");
var android = (Dictionary<string, object?>)incoming["android"]!;
Check((string)android["priority"]! == "HIGH" && (string)android["ttl"]! == "75s", "incoming FCM data is high priority with a bounded ring window");
Check((string)android["collapse_key"]! == "nivra-call-call1", "call updates collapse by call identity");
Check(!incoming.ContainsKey("notification"), "FCM never proxies a generic notification instead of native call UI");
var terminal = (Dictionary<string, object?>)Message("end_call")["android"]!;
Check((string)terminal["ttl"]! == "300s", "terminal push survives longer to cancel a stale native ring");
Console.WriteLine($"{checks} push checks passed.");
