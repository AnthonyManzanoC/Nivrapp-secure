using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Nivra.Api.Contracts;
using Nivra.Api.Services;
using Nivra.Api.Security;

var passed = 0;
void Check(bool value, string name) { if (!value) throw new InvalidOperationException(name); Console.WriteLine($"PASS {name}"); passed++; }
var settings = new Dictionary<string, string?>
{
    ["MultiInstance:Enabled"] = "true", ["Security:TokenSigningKey"] = new string('x', 48),
    ["ConnectionStrings:Supabase"] = "Host=db.example.test;Database=postgres;Username=app;Password=fixture",
    ["ConnectionStrings:RealtimeRedis"] = "redis.example.test:6380,ssl=true,password=fixture",
    ["Storage:Provider"] = "S3", ["Storage:Endpoint"] = "https://storage.example.test", ["Storage:Bucket"] = "encrypted",
    ["Storage:AccessKeyId"] = "fixture", ["Storage:SecretAccessKey"] = "fixture", ["Push:Fcm:ProjectId"] = "project-fixture",
    ["LiveKit:Url"] = "wss://live.example.test", ["LiveKit:ApiKey"] = "fixture", ["LiveKit:ApiSecret"] = "fixture"
};
IConfiguration Config(Dictionary<string, string?> values) => new ConfigurationBuilder().AddInMemoryCollection(values).Build();
var config = Config(settings);
Check(TrustedProxyConfiguration.Read(config) is null, "unconfigured forwarded headers do not trust caller-supplied IPs");
var proxySettings = new Dictionary<string, string?> { ["ReverseProxy:Enabled"] = "true", ["ReverseProxy:KnownProxies:0"] = "192.0.2.2" };
var trustedProxy = TrustedProxyConfiguration.Read(Config(proxySettings))!;
Check(trustedProxy.KnownProxies.Count == 1 && trustedProxy.KnownProxies[0].ToString() == "192.0.2.2" && trustedProxy.KnownNetworks.Count == 0, "forwarded headers trust only explicitly configured proxies");
proxySettings = new() { ["ReverseProxy:Enabled"] = "true", ["ReverseProxy:KnownNetworks:0"] = "192.0.2.0/24" };
Check(TrustedProxyConfiguration.Read(Config(proxySettings))!.KnownNetworks.Count == 1, "explicit proxy networks retain bounded CIDR scope");
foreach (var network in new[] { "0.0.0.0/0", "::/0", "not-a-network", "192.0.2.0/99" })
{
    var rejected = false;
    try { TrustedProxyConfiguration.Read(Config(new() { ["ReverseProxy:Enabled"] = "true", ["ReverseProxy:KnownNetworks:0"] = network })); } catch (InvalidOperationException) { rejected = true; }
    Check(rejected, "malformed or all-network proxy trust is rejected");
}
var emptyProxyRejected = false;
try { TrustedProxyConfiguration.Read(Config(new() { ["ReverseProxy:Enabled"] = "true" })); } catch (InvalidOperationException) { emptyProxyRejected = true; }
Check(emptyProxyRejected, "enabled forwarded headers cannot start with an empty trust list");
var infrastructure = new InfrastructureReadiness(config);
Check(infrastructure.ClusterFingerprint?.Length == 64, "configured cluster has an opaque compatibility pin");
Check(SharedAuthRateLimiter.ScopeKey("user-fixture", "first-ip") == SharedAuthRateLimiter.ScopeKey("user-fixture", "second-ip"), "authenticated shared limits cannot reset by changing IP");
Check(SharedAuthRateLimiter.ScopeKey(null, "first-ip") != SharedAuthRateLimiter.ScopeKey(null, "second-ip"), "anonymous shared limits separate client IP scopes");
Check(!SharedAuthRateLimiter.ScopeKey("user-fixture", null).Contains("user-fixture") && SharedAuthRateLimiter.ScopeKey("user-fixture", null).Length == 64, "shared authentication keys do not store raw identities");
Check(!infrastructure.IsReady(null, null!), "unconnected shared infrastructure cannot advertise ready");
Check(!infrastructure.ClusterFingerprint!.Contains("fixture"), "cluster pin exposes no credential or hostname");
Check(new InfrastructureReadiness(Config(new(settings))).ClusterFingerprint == infrastructure.ClusterFingerprint, "identically configured hosts match");
foreach (var pair in new Dictionary<string, string?>
{
    ["ConnectionStrings:Supabase"] = "Host=other.example.test;Database=postgres;Username=app;Password=fixture",
    ["ConnectionStrings:RealtimeRedis"] = "other.example.test:6380,ssl=true,password=fixture",
    ["MultiInstance:Namespace"] = "other-app", ["Security:TokenSigningKey"] = new string('y', 48),
    ["Storage:Bucket"] = "other", ["LiveKit:ApiSecret"] = "other", ["Push:Fcm:ProjectId"] = "other"
})
{
    var altered = new Dictionary<string, string?>(settings) { [pair.Key] = pair.Value };
    Check(new InfrastructureReadiness(Config(altered)).ClusterFingerprint != infrastructure.ClusterFingerprint, $"mismatched {pair.Key} cannot join the cluster");
}
foreach (var pair in new Dictionary<string, string?> { ["Security:TokenSigningKey"] = "weak", ["Storage:Provider"] = "Local", ["ConnectionStrings:RealtimeRedis"] = "" })
{
    var altered = new Dictionary<string, string?>(settings) { [pair.Key] = pair.Value };
    var rejected = false;
    try { new InfrastructureReadiness(Config(altered)).ValidateStartup(false); } catch (InvalidOperationException) { rejected = true; }
    Check(rejected, $"unsafe multi-instance {pair.Key} fails at startup");
}
var cipher = new SharedStateCipher(settings["Security:TokenSigningKey"]!);
var encrypted = cipher.Protect("session-credentials");
Check(cipher.Unprotect(encrypted) == "session-credentials", "shared authorization round-trips encrypted");
Check(cipher.Protect("session-credentials") != encrypted && !encrypted.Contains("session-credentials"), "shared state uses a fresh nonce and hides credentials");
var bytes = Convert.FromBase64String(encrypted); bytes[^1] ^= 1;
var tamperRejected = false;
try { cipher.Unprotect(Convert.ToBase64String(bytes)); } catch (CryptographicException) { tamperRejected = true; }
Check(tamperRejected, "modified shared credentials are rejected");
var wrongKeyRejected = false;
try { new SharedStateCipher("wrong-cluster-secret").Unprotect(encrypted); } catch (CryptographicException) { wrongKeyRejected = true; }
Check(wrongKeyRejected, "another cluster cannot decrypt authorization");
var downloadNow = DateTimeOffset.UtcNow;
Check(EncryptedDownloadPolicy.Deadline(downloadNow, null) == downloadNow.AddSeconds(60), "download authorization expires after sixty seconds");
Check(EncryptedDownloadPolicy.Deadline(downloadNow, downloadNow.AddSeconds(8)) == downloadNow.AddSeconds(8), "download cannot outlive the encrypted file");
Check(EncryptedDownloadPolicy.IsValidUrl("https://store.example.test/bucket/object?X-Amz-Signature=fixture", "https://store.example.test/storage/v1/s3"), "signed download remains on its configured HTTPS storage host");
foreach (var url in new[] { "http://store.example.test/bucket/object", "https://attacker.example.test/object", "https://user@store.example.test/object", "https://store.example.test:8443/object", "https://store.example.test/object#fragment" })
    Check(!EncryptedDownloadPolicy.IsValidUrl(url, "https://store.example.test/storage/v1/s3"), "unsafe signed download origin rejected");
var source = new MemoryStream([1, 2, 3]);
var owner = new TestDisposable(source.Dispose);
var owned = new OwnedReadStream(source, owner);
Check(owned.ReadByte() == 1 && !owned.CanWrite, "fallback download reads the source without copying or allowing writes");
await owned.DisposeAsync(); owned.Dispose();
Check(owner.Count == 1 && !source.CanRead, "fallback download releases its S3 response exactly once");
var clock = new TestClock();
var shared = new TestState(clock);
var first = new QrLoginService(clock, shared);
var second = new QrLoginService(clock, shared);
var challenge = first.Start("New device", null, "identity-key", "hardware");
Check(second.GetPending(challenge.Id, challenge.Code)?.PublicKey == "identity-key", "QR opened on one instance is recognized by another");
second.AttachConnection(challenge.Id, challenge.Code, "connection-on-second-host");
Check(first.GetPending(challenge.Id, challenge.Code)?.ConnectionId == "connection-on-second-host", "QR connection routing is shared across hosts");
Check(second.GetPending(challenge.Id, "000000x") is null, "cross-host QR does not bypass the challenge code");
using (var lease = await first.AcquireAuthorizationAsync(challenge.Id, challenge.Code, CancellationToken.None))
{
    Check(lease is not null && await second.AcquireAuthorizationAsync(challenge.Id, challenge.Code, CancellationToken.None) is null, "simultaneous cross-host scans cannot issue duplicate sessions");
    Check(first.TryAuthorize(challenge.Id, challenge.Code, new QrLoginAuthorizedResponse(null!, "encrypted-payload")), "shared QR authorization wins once");
    Check(!second.TryAuthorize(challenge.Id, challenge.Code, new QrLoginAuthorizedResponse(null!, "replay")), "another host rejects an already authorized QR");
}
Check(second.Get(challenge.Id, challenge.Code)?.Authorization?.EncryptedPayload == "encrypted-payload", "authorized QR payload can be delivered from the replacement host");
clock.Advance(TimeSpan.FromSeconds(30));
Check(second.Get(challenge.Id, challenge.Code) is null, "shared QR credentials expire after delivery");
challenge = first.Start("Expired", null, null, null); clock.Advance(TimeSpan.FromSeconds(60));
Check(!second.IsValid(challenge.Id, challenge.Code), "shared pending QR expires exactly at one minute");
var otpFirst = new PhoneOtpService(clock, NullLogger<PhoneOtpService>.Instance, shared);
var otpSecond = new PhoneOtpService(clock, NullLogger<PhoneOtpService>.Instance, shared);
var otp = otpFirst.Start("+10000000000");
Check(otpSecond.TryVerify(otp.Phone, otp.Code) && !otpFirst.TryVerify(otp.Phone, otp.Code), "legacy OTP succeeds on another host exactly once");
var setup = otpFirst.CreateAliasSetup("user-fixture", otp.Phone);
Check(otpSecond.TryGetAliasSetup(setup.Token, out var found) && found.UserId == "user-fixture", "phone alias completion survives a host switch");
otpSecond.ConsumeAliasSetup(setup.Token);
Check(!otpFirst.TryGetAliasSetup(setup.Token, out _), "consumed alias setup cannot be reused on the original host");
Console.WriteLine($"{passed} infrastructure checks passed.");

sealed class TestClock : TimeProvider
{
    private DateTimeOffset now = DateTimeOffset.FromUnixTimeSeconds(1700000000);
    public override DateTimeOffset GetUtcNow() => now;
    public void Advance(TimeSpan span) => now += span;
}
sealed class TestDisposable(Action action) : IDisposable { public int Count { get; private set; } public void Dispose() { Count++; action(); } }
sealed class TestState(TestClock clock) : ISharedEphemeralState
{
    private readonly Dictionary<string, (string value, DateTimeOffset until)> entries = [];
    private readonly HashSet<string> leases = [];
    public string? Read(string key) { lock (entries) return entries.TryGetValue(key, out var value) && value.until > clock.GetUtcNow() ? value.value : null; }
    public void Write(string key, string value, TimeSpan lifetime) { lock (entries) entries[key] = (value, clock.GetUtcNow() + lifetime); }
    public bool CompareExchange(string key, string expected, string replacement, TimeSpan lifetime) { lock (entries) { if (Read(key) != expected) return false; Write(key, replacement, lifetime); return true; } }
    public bool TryTake(string key, string expected) { lock (entries) { if (Read(key) != expected) return false; return entries.Remove(key); } }
    public void Remove(string key) { lock (entries) entries.Remove(key); }
    public Task<IDisposable?> AcquireLeaseAsync(string key, TimeSpan lifetime, CancellationToken cancellationToken) { cancellationToken.ThrowIfCancellationRequested(); lock (leases) return Task.FromResult<IDisposable?>(leases.Add(key) ? new Lease(() => { lock (leases) leases.Remove(key); }) : null); }
    private sealed class Lease(Action release) : IDisposable { public void Dispose() => release(); }
}
