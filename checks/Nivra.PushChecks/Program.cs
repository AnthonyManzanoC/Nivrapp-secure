using System.Reflection;
using System.Security.Cryptography;
using Nivra.Api.Domain;
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
