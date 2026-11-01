using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;
using Npgsql;

// Never load application settings or a production connection. These tests
// require an ephemeral CI database with this exact loopback name.
if (!args.Contains("--postgres-ci") || Environment.GetEnvironmentVariable("CI") != "true")
    throw new InvalidOperationException("Use --postgres-ci only in isolated CI with NIVRA_RATCHET_TEST_POSTGRES");
var connection = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable("NIVRA_RATCHET_TEST_POSTGRES") ?? "");
if (connection.Host is not ("127.0.0.1" or "localhost") || connection.Database != "nivra_ratchet_tests")
    throw new InvalidOperationException("A dedicated loopback test database is required");
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
builder.Configuration.Sources.Clear();
builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["Ratchet:PreKeyPilotEnabled"] = "true", ["Ratchet:Enabled"] = "true" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddDbContext<NivraDbContext>(options => options.UseNpgsql(connection.ConnectionString, provider => provider.EnableRetryOnFailure(3)));
builder.Services.AddScoped<INivraStore, PgSqlNivraStore>(); builder.Services.AddScoped<RatchetPreKeyStore>();
builder.Services.AddScoped<RatchetDirectoryService>(); builder.Services.AddSignalR();
builder.Services.AddSingleton(TimeProvider.System); builder.Services.AddSingleton<TokenService>();
builder.Services.Configure<NivraSecurityOptions>(options => options.TokenSigningKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
await using var app = builder.Build();
app.UseExceptionHandler(handler => handler.Run(context =>
{
    var error = context.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>()?.Error;
    Console.Error.WriteLine(error);
    context.Response.StatusCode = 500;
    return context.Response.WriteAsJsonAsync(new { code = "synthetic_test_failure" });
}));
app.UseNivraSecurityHeaders(); app.UseNivraAuth(); app.MapRatchetPreKeyPilotEndpoints(); app.MapRatchetClientEndpoints(); app.MapRatchetHybridEndpoints(); app.MapHistoryArchiveEndpoints();
var tokens = new Dictionary<string, string>();
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    await db.Database.OpenConnectionAsync();
    await using var probe = db.Database.GetDbConnection().CreateCommand();
    probe.CommandText = "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'";
    if (Convert.ToInt32(await probe.ExecuteScalarAsync()) != 0) throw new InvalidOperationException("Test database must be empty");
    await db.Database.CloseConnectionAsync();
    await db.Database.MigrateAsync();
    foreach (var name in new[] { "alice", "bob", "carol", "stranger" })
    {
        var user = new UserAccount { Id = "usr-lab-" + name, Alias = "lab-" + name, PasswordHash = new("fixture", 1, "fixture", "fixture"), CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow };
        db.Users.Add(user); await db.SaveChangesAsync();
        foreach (var suffix in name is "alice" or "bob" ? new[] { "", "-real", "-client", "-client-two", "-hybrid" } : new[] { "" })
        {
            var device = new DeviceRecord { Id = "dev-lab-" + name + suffix, UserId = user.Id, Name = "Synthetic fixture", IsTrusted = true, CreatedAt = DateTimeOffset.UtcNow };
            db.Devices.Add(device); await db.SaveChangesAsync();
            var pair = await scope.ServiceProvider.GetRequiredService<TokenService>().CreateSessionAsync(scope.ServiceProvider.GetRequiredService<INivraStore>(), user, device, null, null);
            tokens[name + suffix] = pair.AccessToken;
        }
    }
    foreach (var id in new[] { "chat-lab", "chat-lab-other" })
    {
        var chat = new ConversationRecord { Id = id, Type = ConversationType.Group, CreatedByUserId = "usr-lab-alice", CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow };
        foreach (var name in new[] { "alice", "bob", "carol" }) chat.Participants.Add(new ConversationParticipant { UserId = "usr-lab-" + name, JoinedAt = DateTimeOffset.UtcNow });
        db.Conversations.Add(chat);
    }
    await db.SaveChangesAsync();
}
await app.StartAsync();
using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(45) };
int checks = 0;
void Check(bool condition, string label) { if (!condition) throw new InvalidOperationException(label); Interlocked.Increment(ref checks); Console.WriteLine("PASS " + label); }
async Task Mutate(Func<NivraDbContext, Task> action)
{
    await using var scope = app.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    await action(db); await db.SaveChangesAsync();
}
async Task<HttpResponseMessage> Post(string? actor, string path, object body)
{
    using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body, options: json) };
    if (actor is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokens[actor]);
    return await client.SendAsync(request);
}
async Task<RatchetPreKeyReservation> Claim(string actor, Guid requestId, string chat = "chat-lab")
{
    using var response = await Post(actor, "/experimental/ratchet/devices/dev-lab-bob/prekey", new RatchetReserveRequest(chat, requestId));
    if (response.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException("Claim failed: " + (int)response.StatusCode + " " + await response.Content.ReadAsStringAsync());
    return (await response.Content.ReadFromJsonAsync<RatchetPreKeyReservation>(json))!;
}
async Task Status(string? actor, string path, object body, HttpStatusCode expected, string label)
{
    using var response = await Post(actor, path, body); Check(response.StatusCode == expected, label);
}
string Public(int size, byte? prefix = null)
{
    var bytes = RandomNumberGenerator.GetBytes(size); if (prefix.HasValue) bytes[0] = prefix.Value; return Convert.ToBase64String(bytes);
}
// Structural fixtures only. The separate native interop test uses real signed
// libsignal keys; the server is not the cryptographic trust authority.
var identity = Public(33, 5);
RatchetPublicBundle Bundle(uint id) => new(1, RatchetPreKeyStore.Suite, 11, 1, identity, id, Public(33, 5), id, Public(33, 5), Public(64), id, Public(1569, 8), Public(64));
var batch = Enumerable.Range(1, 64).Select(id => Bundle((uint)id)).ToList();
const string publish = "/experimental/ratchet/prekeys";
await Status(null, publish, new RatchetPublishRequest(batch), HttpStatusCode.Unauthorized, "anonymous publication denied");
await Status("bob", publish, new RatchetPublishRequest(batch), HttpStatusCode.OK, "public prekeys stored in PostgreSQL");
var requestId = Guid.NewGuid();
var repeated = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Claim("alice", requestId)));
Check(repeated.Select(row => row.Bundle.PreKeyId).Distinct().Count() == 1, "12 same-request races reserve exactly one key");
await Status("alice", "/experimental/ratchet/devices/dev-lab-bob/prekey", new RatchetReserveRequest("chat-lab-other", requestId), HttpStatusCode.Conflict, "request id cannot change conversation");
var distinct = await Task.WhenAll(Enumerable.Range(0, 24).Select(index => Claim(index % 2 == 0 ? "alice" : "carol", Guid.NewGuid())));
Check(distinct.Select(row => row.Bundle.PreKeyId).Append(repeated[0].Bundle.PreKeyId).Distinct().Count() == 25, "independent initiators never receive the same one-time key");
await Status("bob", publish, new RatchetPublishRequest(batch), HttpStatusCode.OK, "publication retry remains idempotent after claims");
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    Check(await db.Set<RatchetPilotPreKey>().CountAsync(row => row.ClaimRequestId != null) == 25, "republication cannot reset consumed keys");
}
await Status("bob", publish, new RatchetPublishRequest([batch[0] with { PreKeyPublic = Public(33, 5) }]), HttpStatusCode.Conflict, "prekey identifiers cannot be reused with new bytes");
await Status("bob", publish, new RatchetPublishRequest([Bundle(65) with { IdentityKey = Public(33, 5) }]), HttpStatusCode.Conflict, "identity replacement requires verification");
await Status("bob-real", publish, new RatchetPublishRequest([Bundle(1)]), HttpStatusCode.Conflict, "device slots cannot collide inside an account");
await Status("stranger", "/experimental/ratchet/devices/dev-lab-bob/prekey", new RatchetReserveRequest("chat-lab", Guid.NewGuid()), HttpStatusCode.Forbidden, "non-participants cannot consume prekeys");
await Status("bob", publish, new RatchetPublishRequest([batch[0] with { V = 2 }]), HttpStatusCode.BadRequest, "unknown bundle versions rejected");
await Status("bob", publish, new { bundles = new[] { new { privateKey = "must-not-be-stored" } } }, HttpStatusCode.BadRequest, "unknown/private fields rejected");
await Status("bob", publish, new { padding = new string('x', 262145) }, HttpStatusCode.RequestEntityTooLarge, "oversized request body rejected");
await Mutate(db => { db.Add(new ContactBlockRecord { OwnerUserId = "usr-lab-alice", ContactUserId = "usr-lab-bob", CreatedAt = DateTimeOffset.UtcNow }); return Task.CompletedTask; });
await Status("alice", "/experimental/ratchet/devices/dev-lab-bob/prekey", new RatchetReserveRequest("chat-lab", requestId), HttpStatusCode.Forbidden, "blocked contact cannot retrieve even an old reservation");
await Mutate(async db => db.Remove(await db.Set<ContactBlockRecord>().SingleAsync()));
await Mutate(async db => (await db.Devices.SingleAsync(row => row.Id == "dev-lab-bob")).RevokedAt = DateTimeOffset.UtcNow);
await Status("alice", "/experimental/ratchet/devices/dev-lab-bob/prekey", new RatchetReserveRequest("chat-lab", requestId), HttpStatusCode.NotFound, "revoked target cannot return cached reservation");
await Mutate(async db => (await db.Devices.SingleAsync(row => row.Id == "dev-lab-bob")).RevokedAt = null);
// Alice has 13 claims (one shared retry plus 12 distinct); quota is across all API processes.
for (var i = 13; i < 32; i++) await Claim("alice", Guid.NewGuid());
await Status("alice", "/experimental/ratchet/devices/dev-lab-bob/prekey", new RatchetReserveRequest("chat-lab", Guid.NewGuid()), HttpStatusCode.TooManyRequests, "database-backed claim quota enforced");
Check((await Claim("alice", requestId)).Bundle.PreKeyId == repeated[0].Bundle.PreKeyId, "exact retry succeeds without consuming quota");
// Production addresses use the actual device id, so multiple devices in one
// account can each use libsignal device number 1 without sharing private state.
await Status("alice-client", "/ratchet/prekeys", new RatchetPublishRequest([Bundle(1)]), HttpStatusCode.OK, "client device registers independent address");
await Status("alice-client-two", "/ratchet/prekeys", new RatchetPublishRequest([Bundle(1)]), HttpStatusCode.OK, "second same-account client can use number one");
await Status("bob-client", "/ratchet/prekeys", new RatchetPublishRequest([Bundle(1)]), HttpStatusCode.OK, "recipient client publishes prekey");
await Status("bob-client", "/ratchet/prekeys", new RatchetPublishRequest([Bundle(2) with { DeviceId = 2 }]), HttpStatusCode.BadRequest, "client rejects account-slot addressing");
await Status("alice-client", "/ratchet/devices/dev-lab-bob-client/prekey", new RatchetReserveRequest("chat-lab", Guid.NewGuid()), HttpStatusCode.OK, "client reserves real-device-address prekey");
await Status("alice-client", "/ratchet/devices/dev-lab-bob-client/prekey", new RatchetReserveRequest("chat-lab", Guid.NewGuid()), HttpStatusCode.ServiceUnavailable, "exhausted client prekeys queue without legacy fallback");
await Status("alice-client", "/ratchet/directory", new RatchetDeviceIdsRequest(["dev-lab-bob-client"]), HttpStatusCode.OK, "authenticated client capability directory");
await Status(null, "/ratchet/directory", new RatchetDeviceIdsRequest(["dev-lab-bob-client"]), HttpStatusCode.Unauthorized, "anonymous client directory denied");
await Status("alice-client", "/ratchet/directory", new { deviceIds = new[] { "dev-lab-bob-client" }, privateState = "reject" }, HttpStatusCode.BadRequest, "client directory rejects unknown fields");
using var legacyAlice = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
using var legacyBob = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
string Legacy(ECDiffieHellman key) { var point = key.ExportParameters(false).Q; string Part(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); return JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = Part(point.X!), y = Part(point.Y!) }); }
var aliceLegacy = Legacy(legacyAlice); var bobLegacy = Legacy(legacyBob);
await Mutate(async db => { (await db.Devices.SingleAsync(row => row.Id == "dev-lab-alice-client")).KeyBundle.IdentityKey = aliceLegacy; (await db.Devices.SingleAsync(row => row.Id == "dev-lab-bob-client")).KeyBundle.IdentityKey = bobLegacy; });
await Status("alice-client", "/ratchet/bindings/request", new RatchetDeviceIdsRequest(["dev-lab-bob-client"]), HttpStatusCode.NoContent, "client requests legacy-identity continuity proof");
var sealedHeader = JsonSerializer.Serialize(new { v = 1, alg = "ECDH-P256-A256GCM", senderPublicKey = JsonSerializer.Deserialize<JsonElement>(bobLegacy), iv = Public(12) });
var binding = new RatchetBindingUpload("dev-lab-alice-client", RatchetDirectoryService.Coordinates(aliceLegacy)!, sealedHeader, Public(96));
await Status("bob-client", "/ratchet/bindings", new RatchetBindingUploadRequest([binding]), HttpStatusCode.NoContent, "producer stores recipient-specific opaque continuity proof");
using (var forAlice = await Post("alice-client", "/ratchet/directory", new RatchetDeviceIdsRequest(["dev-lab-bob-client"])))
    Check((await forAlice.Content.ReadFromJsonAsync<List<RatchetDirectoryEntry>>(json))!.Single().BindingCiphertext == binding.Ciphertext, "binding is delivered only to intended requester");
using (var forOther = await Post("alice-client-two", "/ratchet/directory", new RatchetDeviceIdsRequest(["dev-lab-bob-client"])))
    Check((await forOther.Content.ReadFromJsonAsync<List<RatchetDirectoryEntry>>(json))!.Single().BindingCiphertext is null, "another same-account device cannot obtain target proof");
await Status("bob-client", "/ratchet/bindings", new RatchetBindingUploadRequest([binding with { TargetIdentity = "changed" }]), HttpStatusCode.Conflict, "binding cannot target replaced legacy identity");
await Status("bob-client", "/ratchet/bindings", new RatchetBindingUploadRequest([binding with { Header = sealedHeader.Replace(bobLegacy, aliceLegacy) }]), HttpStatusCode.BadRequest, "binding header must match producer identity");
Console.WriteLine($"PASS {checks} PostgreSQL and HTTP ratchet checks");
const string archiveId = "approved-archive-fixture";
await Mutate(db => {
    db.HistoryKeyTransfers.Add(new HistoryKeyTransfer { Id = archiveId, UserId = "usr-lab-alice", TargetDeviceId = "dev-lab-alice-client-two", TargetIdentityKey = aliceLegacy, CreatedAt = DateTimeOffset.UtcNow, ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15) });
    return Task.CompletedTask;
});
await Mutate(async db => (await db.Devices.SingleAsync(row => row.Id == "dev-lab-alice-client-two")).KeyBundle.IdentityKey = aliceLegacy);
var archivePath = $"/devices/history-transfer/{archiveId}/archive/dev-lab-alice-client/";
HistoryArchiveUpload Page(int sequence, bool final = false)
{
    var messageId = $"archive_{archiveId}_dev-lab-alice-client_{sequence}";
    var digest = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(messageId))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    var header = JsonSerializer.Serialize(new { v = 4, alg = RatchetMessagePolicy.Algorithm, senderDeviceId = "dev-lab-alice-client", recipientDeviceId = "dev-lab-alice-client-two", identityKey = identity, registrationId = 11, payloadIv = Public(12), payloadCiphertext = Public(96) });
    var ciphertext = JsonSerializer.Serialize(new { v = 3, suite = "NIVRA-LIBSIGNAL-A256GCM-PILOT-1", type = 3, keyMessage = Public(96), iv = Public(12), ciphertext = Public(96), context = new { conversationId = "history_" + archiveId, messageId = digest, sender = "dev-lab-alice-client.1", recipient = "dev-lab-alice-client-two.1" } });
    return new(sequence, header, ciphertext, final);
}
await Status("alice-client", archivePath, Page(0), HttpStatusCode.NotFound, "history cannot stream before explicit approval response");
await Mutate(db => { db.HistoryKeyTransferResponses.Add(new HistoryKeyTransferResponse { Id = archiveId + ":dev-lab-alice-client", TransferId = archiveId, SourceDeviceId = "dev-lab-alice-client", SourceIdentityKey = aliceLegacy, Header = "opaque", Ciphertext = "opaque" }); return Task.CompletedTask; });
var archiveFirst = Page(0);
await Status("alice-client", archivePath, archiveFirst, HttpStatusCode.NoContent, "approved ratchet archive page stored");
await Status("alice-client", archivePath, archiveFirst, HttpStatusCode.NoContent, "archive exact retry is idempotent");
await Status("alice-client", archivePath, Page(0), HttpStatusCode.Conflict, "archive sequence cannot replace ciphertext");
await Status("alice-client-two", archivePath, Page(1), HttpStatusCode.NotFound, "target cannot publish source history");
await Status("stranger", archivePath, Page(1), HttpStatusCode.NotFound, "unrelated account cannot stream archive");
for (var index = 1; index < 8; index++) await Status("alice-client", archivePath, Page(index), HttpStatusCode.NoContent, "bounded archive page " + index);
await Status("alice-client", archivePath, Page(8), HttpStatusCode.TooManyRequests, "archive backpressure bounds unacknowledged ciphertext");
await Status("alice-client", archivePath + "ack", new HistoryArchiveAcknowledgement(7), HttpStatusCode.NotFound, "source cannot forge target history acknowledgement");
await Status("alice-client-two", archivePath + "ack", new HistoryArchiveAcknowledgement(8), HttpStatusCode.BadRequest, "target cannot acknowledge unsent history");
await Status("alice-client-two", archivePath + "ack", new HistoryArchiveAcknowledgement(7), HttpStatusCode.OK, "target acknowledges durable imported history");
await Status("alice-client", archivePath, new { sequence = 8, header = "x", ciphertext = "x", final = false, privateState = "reject" }, HttpStatusCode.BadRequest, "archive rejects unknown private fields");
await Status("alice-client", archivePath, new { padding = new string('x', 600001) }, HttpStatusCode.RequestEntityTooLarge, "archive body rejected before unbounded deserialization");
await Mutate(async db => (await db.HistoryKeyTransfers.SingleAsync(row => row.Id == archiveId)).ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1));
await Status("alice-client", archivePath, Page(8, true), HttpStatusCode.NoContent, "acknowledged archive continues beyond original approval window with bounded lease");
await Status("alice-client", archivePath, Page(9), HttpStatusCode.Conflict, "completed archive cannot append pages");
await Mutate(async db => (await db.Devices.SingleAsync(row => row.Id == "dev-lab-alice-client-two")).RevokedAt = DateTimeOffset.UtcNow);
await Status("alice-client", archivePath, Page(8, true), HttpStatusCode.NotFound, "revocation blocks archive retries immediately");
Console.WriteLine($"PASS {checks} PostgreSQL and HTTP ratchet/archive checks");
var hybridIdentity = Public(64);
RatchetOlmPublicBundle Hybrid(uint id) => new(1, RatchetPreKeyStore.OlmSuite, 21, 1, hybridIdentity, id, Public(32), Public(32), Public(1184), Public(64));
const string hybridPublish = "/ratchet/olm/prekeys";
var hybridBatch = Enumerable.Range(1, 8).Select(index => Hybrid((uint)index)).ToList();
await Status(null, hybridPublish, new RatchetOlmPublishRequest(hybridBatch), HttpStatusCode.Unauthorized, "anonymous hybrid publication denied");
await Status("alice-hybrid", hybridPublish, new RatchetOlmPublishRequest([Hybrid(1)]), HttpStatusCode.OK, "hybrid initiator registers independent identity");
await Status("bob-hybrid", hybridPublish, new RatchetOlmPublishRequest(hybridBatch), HttpStatusCode.OK, "signed classical and ML-KEM prekeys stored");
await Status("bob-hybrid", hybridPublish, new RatchetOlmPublishRequest([Hybrid(9) with { MlKemPublic = Public(32) }]), HttpStatusCode.BadRequest, "truncated ML-KEM key rejected");
await Status("bob-hybrid", hybridPublish, new { bundles = hybridBatch, privateSeed = "reject" }, HttpStatusCode.BadRequest, "hybrid private fields rejected");
var hybridRequest = Guid.NewGuid();
var hybridClaims = await Task.WhenAll(Enumerable.Range(0, 12).Select(async _ => {
    using var response = await Post("alice-hybrid", "/ratchet/olm/devices/dev-lab-bob-hybrid/prekey", new RatchetReserveRequest("chat-lab", hybridRequest));
    Check(response.StatusCode == HttpStatusCode.OK, "hybrid concurrent claim authenticated");
    return (await response.Content.ReadFromJsonAsync<RatchetOlmPreKeyReservation>(json))!;
}));
Check(hybridClaims.Select(row => row.Bundle.PreKeyId).Distinct().Count() == 1, "hybrid reservation races consume one key");
var usedHybrid = hybridClaims[0].Bundle.PreKeyId;
await Status("alice-hybrid", "/ratchet/olm/prekeys/consumed", new RatchetConsumedPreKeys([usedHybrid]), HttpStatusCode.NoContent, "another device cannot delete recipient prekeys");
await using (var scope = app.Services.CreateAsyncScope()) { var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>(); Check(await db.Set<RatchetPilotPreKey>().AnyAsync(row => row.DeviceId == "dev-lab-bob-hybrid" && row.PreKeyId == usedHybrid), "other-owner acknowledgement retains key"); }
await Status("bob-hybrid", "/ratchet/olm/prekeys/consumed", new RatchetConsumedPreKeys([usedHybrid]), HttpStatusCode.NoContent, "recipient cleans consumed prekey atomically");
await using (var scope = app.Services.CreateAsyncScope()) { var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>(); Check(!await db.Set<RatchetPilotPreKey>().AnyAsync(row => row.DeviceId == "dev-lab-bob-hybrid" && row.PreKeyId == usedHybrid), "consumed public row is removed"); }
await Status("bob-hybrid", hybridPublish, new RatchetOlmPublishRequest(hybridBatch), HttpStatusCode.Conflict, "late publication cannot resurrect cleaned keys");
await Status("bob-hybrid", hybridPublish, new RatchetOlmPublishRequest([Hybrid(9)]), HttpStatusCode.OK, "monotonic hybrid prekey replenishment continues");
Console.WriteLine($"PASS {checks} PostgreSQL and HTTP hybrid ratchet checks");
if (args.Contains("--serve-for-interop"))
{
    // Synthetic bearer tokens are passed to the parent test harness only. That
    // harness suppresses this line, and no fixture is uploaded as an artifact.
    Console.WriteLine("RATCHET_FIXTURE " + JsonSerializer.Serialize(new { url = app.Urls.Single(), aliceToken = tokens["alice-real"], bobToken = tokens["bob-real"], aliceUser = "usr-lab-alice", bobUser = "usr-lab-bob", aliceDevice = "dev-lab-alice-real", bobDevice = "dev-lab-bob-real", conversationId = "chat-lab" }, json));
    await app.WaitForShutdownAsync();
}
