using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Reflection;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;
using Nivra.Api.Endpoints;
using Nivra.Api.Realtime;
using Nivra.Api.Contracts;
using Microsoft.AspNetCore.SignalR;

var checks = 0;
void Check(bool condition, string label)
{
    if (!condition) throw new InvalidOperationException(label);
    Console.WriteLine("PASS " + label); checks++;
}
// Synthetic accounts and an in-memory database; never load production settings.
var database = "security-fixture-" + Guid.NewGuid();
var signingKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
builder.Configuration.Sources.Clear();
builder.Configuration.AddInMemoryCollection();
builder.Logging.ClearProviders();
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddDbContext<NivraDbContext>(options => options.UseInMemoryDatabase(database));
builder.Services.AddScoped<INivraStore, PgSqlNivraStore>();
builder.Services.Configure<NivraSecurityOptions>(options => options.TokenSigningKey = signingKey);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<TokenService>();
builder.Services.AddHttpClient();
builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
builder.Services.Configure<NivraPushOptions>(options => { });
builder.Services.AddSingleton<PushNotificationService>();
await using var app = builder.Build();
app.UseNivraSecurityHeaders();
app.UseExceptionHandler(handler => handler.Run(context =>
{
    context.Response.StatusCode = 500;
    return context.Response.WriteAsJsonAsync(new { code = "test_failure" });
}));
app.UseNivraAuth();
app.MapGet("/private", (HttpContext context) => context.GetCurrentUser() is { } user
    ? Results.Ok(new { user.UserId }) : Results.Unauthorized());
app.MapGet("/failure", (HttpContext _) => { throw new InvalidOperationException("synthetic error"); });
typeof(EndpointExtensions).GetMethod("MapNotificationEndpoints", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, [app]);
await app.StartAsync();
using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };

async Task Mutate(Func<NivraDbContext, Task> action)
{
    await using var scope = app.Services.CreateAsyncScope();
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    await action(db); await db.SaveChangesAsync();
}
async Task<TokenPair> Session(string suffix)
{
    await using var scope = app.Services.CreateAsyncScope();
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    var user = new UserAccount { Id = "user-" + suffix, Alias = "alias-" + suffix, PasswordHash = new() };
    var device = new DeviceRecord { Id = "device-" + suffix, UserId = user.Id, Name = "Fixture", IsTrusted = true };
    db.Users.Add(user); db.Devices.Add(device); await db.SaveChangesAsync();
    return await scope.ServiceProvider.GetRequiredService<TokenService>().CreateSessionAsync(
        scope.ServiceProvider.GetRequiredService<INivraStore>(), user, device, null, null);
}
async Task<HttpResponseMessage> Request(string? token, string path = "/private")
{
    using var request = new HttpRequestMessage(HttpMethod.Get, path);
    if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    return await client.SendAsync(request);
}
async Task<bool> Rejected(string token)
{
    using var response = await Request(token);
    return response.StatusCode == HttpStatusCode.Unauthorized;
}
var session = await Session("logout");
using (var valid = await Request(session.AccessToken))
{
    Check(valid.IsSuccessStatusCode, "valid token authenticates over HTTP");
    Check(valid.Headers.CacheControl?.NoStore == true, "private responses prohibit HTTP storage");
    Check(valid.Headers.GetValues("X-Content-Type-Options").Single() == "nosniff", "MIME sniffing disabled");
    Check(valid.Headers.GetValues("Content-Security-Policy").Single().Contains("frame-ancestors 'none'"), "API cannot be framed");
    Check(valid.Headers.GetValues("Referrer-Policy").Single() == "no-referrer", "referrer metadata suppressed");
}
await Mutate(async db => (await db.Sessions.SingleAsync(s => s.UserId == "user-logout")).RevokedAt = DateTimeOffset.UtcNow);
Check(await Rejected(session.AccessToken), "logout revocation applies to the very next request, including previously validated tokens");

foreach (var kind in new[] { "expired", "disabled", "device", "foreign-device", "deleted" })
{
    var pair = await Session(kind);
    using (var initial = await Request(pair.AccessToken)) Check(initial.IsSuccessStatusCode, kind + " starts authorized");
    await Mutate(async db =>
    {
        if (kind == "expired") (await db.Sessions.SingleAsync(s => s.UserId == "user-" + kind)).ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        else if (kind == "disabled") (await db.Users.FindAsync("user-" + kind))!.DisabledAt = DateTimeOffset.UtcNow;
        else if (kind == "deleted") db.Devices.Remove((await db.Devices.FindAsync("device-" + kind))!);
        else if (kind == "foreign-device") db.Entry((await db.Devices.FindAsync("device-" + kind))!).Property(device => device.UserId).CurrentValue = "user-logout";
        else (await db.Devices.FindAsync("device-" + kind))!.RevokedAt = DateTimeOffset.UtcNow;
    });
    Check(await Rejected(pair.AccessToken), kind + " is rejected immediately after shared state changes");
    await using var scope = app.Services.CreateAsyncScope();
    Check(await scope.ServiceProvider.GetRequiredService<TokenService>().RefreshSessionAsync(
        scope.ServiceProvider.GetRequiredService<INivraStore>(), pair.RefreshToken) is null, kind + " cannot refresh access");
}

var active = await Session("tamper");
await using (var temporaryScope = app.Services.CreateAsyncScope())
{
    var db = temporaryScope.ServiceProvider.GetRequiredService<NivraDbContext>();
    var savedSession = await db.Sessions.SingleAsync(row => row.UserId == "user-tamper");
    db.VaultRooms.Add(new VaultRoom { Id = "incognito-waiting", OwnerUserId = "user-tamper", Name = "Synthetic temporary chat", RetentionMode = VaultRetentionMode.BurnOnExit, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow });
    db.VaultRoomMembers.Add(new VaultRoomMember { Id = "incognito-owner", VaultRoomId = "incognito-waiting", UserId = "user-tamper", Status = VaultMemberStatus.Active, CreatedAt = DateTimeOffset.UtcNow });
    await db.SaveChangesAsync();
    var hub = new NivraHub(null!, temporaryScope.ServiceProvider.GetRequiredService<INivraStore>(), db, null!, new RealtimePresence(), null!, null!, null!, NullLogger<NivraHub>.Instance, TimeProvider.System)
    { Context = new TemporaryChatContext(new CurrentUser("user-tamper", "device-tamper", savedSession.Id)) };
    var rejected = false;
    try { await hub.SendVaultRoomRatchetMessage("incognito-waiting", new VaultRealtimeMessageRequest("pending-text", MessageKind.Text, [new RecipientCipherRequest("user-tamper", "device-tamper", "opaque", null, null)], null)); }
    catch (HubException error) { rejected = error.Message.Contains("Espera"); }
    Check(rejected, "temporary messages cannot be silently sent before the contact joins");
}
async Task<bool> HasPushRegistration(string token)
{
    using var response = await Request(token, "/push-tokens/status");
    Check(response.IsSuccessStatusCode, "notification status is accessible to an active session");
    var content = await response.Content.ReadAsStringAsync();
    Check(!content.Contains("private-push-token") && !content.Contains("tokenHash") && !content.Contains("deviceId"), "notification diagnosis never discloses push destinations or device identifiers");
    using var json = JsonDocument.Parse(content);
    return json.RootElement.GetProperty("hasRegistration").GetBoolean();
}
await Mutate(db =>
{
    db.PushTokens.Add(new PushTokenRecord { Id = "other-device-registration", UserId = "user-tamper", DeviceId = "other-device", Provider = "fcm", TokenHash = "private-push-token", CreatedAt = DateTimeOffset.UtcNow });
    return Task.CompletedTask;
});
Check(!await HasPushRegistration(active.AccessToken), "another device's registration does not mark this device ready");
await Mutate(db =>
{
    db.PushTokens.Add(new PushTokenRecord { Id = "current-registration", UserId = "user-tamper", DeviceId = "device-tamper", Provider = "fcm", TokenHash = "private-push-token-current", CreatedAt = DateTimeOffset.UtcNow });
    return Task.CompletedTask;
});
Check(await HasPushRegistration(active.AccessToken), "this account and device's active registration is recognized");
var otherAccount = await Session("push-other");
Check(!await HasPushRegistration(otherAccount.AccessToken), "notification readiness remains isolated between accounts");
await Mutate(async db => (await db.PushTokens.FindAsync("current-registration"))!.RevokedAt = DateTimeOffset.UtcNow);
Check(!await HasPushRegistration(active.AccessToken), "revoked notification registration is no longer ready");
using (var anonymousPush = await Request(null, "/push-tokens/status")) Check(anonymousPush.StatusCode == HttpStatusCode.Unauthorized, "anonymous notification diagnosis is denied");
var parts = active.AccessToken.Split('.');
foreach (var token in new[] { "invalid", "a.b", "...", "%%%.%%%", parts[0] + ".AAAA", "A" + active.AccessToken[1..], new string('a', 4097) })
    Check(await Rejected(token), "malformed or tampered token rejected (length " + token.Length + ")");

// Signed malformed payloads must fail closed instead of causing a server error.
string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
foreach (var expiry in new[] { long.MaxValue, long.MinValue, DateTimeOffset.UtcNow.AddSeconds(-1).ToUnixTimeSeconds() })
{
    var payload = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Convert.FromBase64String(parts[0].Replace('-', '+').Replace('_', '/').PadRight((parts[0].Length + 3) / 4 * 4, '=')))!;
    payload["ExpiresUnixSeconds"] = JsonSerializer.SerializeToElement(expiry);
    var encoded = Encode(JsonSerializer.SerializeToUtf8Bytes(payload));
    var signature = Encode(HMACSHA256.HashData(SHA256.HashData(Encoding.UTF8.GetBytes(signingKey)), Encoding.UTF8.GetBytes(encoded)));
    Check(await Rejected(encoded + "." + signature), "out-of-range or expired signed timestamp rejected");
}
await using (var scope = app.Services.CreateAsyncScope())
{
    var store = scope.ServiceProvider.GetRequiredService<INivraStore>();
    var alien = new TokenService(Options.Create(new NivraSecurityOptions { TokenSigningKey = new string('z', 64) }), TimeProvider.System, NullLogger<TokenService>.Instance);
    Check(await alien.ValidateAccessTokenAsync(active.AccessToken, store) is null, "a different signing key cannot authenticate tokens");
}
using (var error = await Request(null, "/failure"))
{
    Check(error.StatusCode == HttpStatusCode.InternalServerError, "synthetic error exercised through HTTP");
    Check(error.Headers.CacheControl?.NoStore == true && error.Headers.Contains("X-Frame-Options"), "error responses keep security and cache headers");
    Check(!(await error.Content.ReadAsStringAsync()).Contains("InvalidOperationException"), "exception details are not returned");
}
using (var anonymous = await Request(null)) Check(anonymous.StatusCode == HttpStatusCode.Unauthorized, "anonymous private request is denied");
await app.StopAsync();
Console.WriteLine($"PASS {checks} security checks; isolated local HTTP server and synthetic data only.");

sealed class TemporaryChatContext(CurrentUser user) : HubCallerContext
{
    public override string ConnectionId => "isolated-temporary-chat";
    public override string? UserIdentifier => user.UserId;
    public override System.Security.Claims.ClaimsPrincipal? User => null;
    public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?> { ["current_user"] = user };
    public override Microsoft.AspNetCore.Http.Features.IFeatureCollection Features { get; } = new Microsoft.AspNetCore.Http.Features.FeatureCollection();
    public override CancellationToken ConnectionAborted => CancellationToken.None;
    public override void Abort() { }
}
