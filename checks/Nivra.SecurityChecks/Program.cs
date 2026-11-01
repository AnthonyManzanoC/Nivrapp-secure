using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;

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
