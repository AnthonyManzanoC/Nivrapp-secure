using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Storage;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;

var count = 0;
void Check(bool valid, string name) { if (!valid) throw new InvalidOperationException(name); count++; Console.WriteLine("PASS " + name); }
object? Call(string method, params object?[] args) => typeof(EndpointExtensions).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, args);
var webJson = new JsonSerializerOptions(JsonSerializerDefaults.Web);
string Json(object value) => JsonSerializer.Serialize(value, webJson);
using var key = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
using var another = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
string Public(ECDiffieHellman value)
{
    var point = value.ExportParameters(false).Q;
    string B64(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    return Json(new { kty = "EC", crv = "P-256", x = B64(point.X!), y = B64(point.Y!), ext = true, key_ops = Array.Empty<string>() });
}
var published = Public(key);
string Header(string? publicKey = null, string? iv = null) => Json(new { v = 1, alg = "ECDH-P256-A256GCM", senderPublicKey = JsonSerializer.Deserialize<JsonElement>(publicKey ?? published), iv = iv ?? Convert.ToBase64String(new byte[12]) });
var cipher = Convert.ToBase64String(RandomNumberGenerator.GetBytes(48));
object Recipient(string user = "alice", string device = "phone-a", string? header = null, string? ciphertext = null) => new { userId = user, deviceId = device, header = header ?? Header(), ciphertext = ciphertext ?? cipher };
string Envelope(params object[] recipients) => Json(new { v = 1, purpose = "nivra-broadcast-list", recipients });
object? Parse(string? envelope) => Call("ParseBroadcastEnvelope", envelope, "alice", published);

Check(Parse(Envelope(Recipient())) is not null, "accepts opaque ECDH recipient envelope for owner device without examining encrypted names or recipients");
Check(Parse(Envelope(Recipient(), Recipient(device: "web-a"))) is not null, "supports a separate ciphertext for each linked owner device");
Check(Parse(Envelope()) is null, "requires at least one readable destination installation");
Check(Parse(Envelope(Recipient(user: "bob"))) is null, "cannot store a plaintext destination envelope for another user");
Check(Parse(Envelope(Recipient(), Recipient())) is null, "rejects duplicate owner device destinations");
Check(Parse(Envelope(Recipient(header: Header(Public(another))))) is null, "sender public identity must match the authenticated source device");
Check(Parse(Envelope(Recipient(ciphertext: "not base64"))) is null && Parse(Envelope(Recipient(ciphertext: "AA=="))) is null, "rejects malformed or truncated ciphertext");
Check(Parse(Envelope(Recipient(header: Header(iv: Convert.ToBase64String(new byte[11]))))) is null, "requires the AES-GCM nonce length");
Check(Parse(Envelope(Recipient(ciphertext: new string('A', 65_540)))) is not null, "accepts ciphertext larger than sixty-four KiB within the one MiB aggregate bound");
Check(Parse(Envelope(Recipient(ciphertext: new string('A', 1_048_580)))) is null, "rejects ciphertext that exceeds the aggregate envelope bound");
var largeRecipientIds = Enumerable.Range(0, 256).Select(index => "usr_" + index.ToString("x32")).ToArray();
var largeDispatch = new
{
    v = 1, type = "nivra-broadcast-list", id = "bcl_" + Guid.NewGuid(), ownerUserId = "alice", name = "Equipo",
    recipientUserIds = largeRecipientIds,
    lastDispatch = new { operationId = Guid.NewGuid(), text = new string('\u754c', 10_000), results = largeRecipientIds.Select(userId => new { userId, status = "pending" }) }
};
var largePlaintext = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(largeDispatch, new JsonSerializerOptions(webJson) { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
var largeCiphertext = new byte[largePlaintext.Length + 16];
using (var aes = new AesGcm(RandomNumberGenerator.GetBytes(32), 16))
    aes.Encrypt(new byte[12], largePlaintext, largeCiphertext.AsSpan(0, largePlaintext.Length), largeCiphertext.AsSpan(largePlaintext.Length));
var largeEncoded = Convert.ToBase64String(largeCiphertext);
Check(largeEncoded.Length > 65_536 && Parse(Envelope(Recipient(ciphertext: largeEncoded))) is not null,
    "supports an AES-GCM encrypted ten-thousand-character Unicode dispatch to 256 recipients");
Check(Parse(new string('a', 1_048_577)) is null, "bounds total stored UTF8 envelope to one MiB before parsing");
Check(Parse(Json(new { v = 1, purpose = "nivra-broadcast-list", name = "must never store this plaintext list name", recipients = new[] { Recipient() } })) is null,
    "rejects plaintext list metadata outside encrypted ciphertext");
Check(Parse(Json(new { v = 1, purpose = "other-purpose", recipients = new[] { Recipient() } })) is null, "ciphertext envelope is bound to broadcast-list purpose");
Check(Parse(Envelope(Recipient(header: new string('a', 8193)))) is null, "bounds each envelope header");
var privateIdentity = published.TrimEnd('}') + ",\"d\":\"private\"}";
Check(Call("ParseBroadcastEnvelope", Envelope(Recipient()), "alice", privateIdentity) is null, "rejects a source bundle containing private key material");

DeviceRecord Device(string id = "phone-a", string user = "alice", bool trusted = true, bool revoked = false, string? identity = null) => new()
{ Id = id, UserId = user, Name = id, IsTrusted = trusted, RevokedAt = revoked ? DateTimeOffset.UtcNow : null, KeyBundle = new KeyBundle { IdentityKey = identity ?? published } };
var recipients = Parse(Envelope(Recipient()))!;
bool Devices(params DeviceRecord[] devices) => (bool)Call("ValidBroadcastDevices", recipients, devices.ToList(), "alice")!;
Check(Devices(Device()), "stored envelopes target a trusted active device with a published own identity");
Check(!Devices(Device(user: "bob")) && !Devices(Device(trusted: false)) && !Devices(Device(revoked: true)) && !Devices(), "foreign, untrusted, revoked and missing destinations fail closed");
Check(!Devices(Device(identity: "{}")), "a destination without a valid public identity cannot claim an encrypted copy");
foreach (var icon in new[] { "original", "emerald", "ivory" }) Check((bool)Call("ValidAppearanceIcon", icon)!, "accepts explicit " + icon + " icon choice");
Check(!(bool)Call("ValidAppearanceIcon", "Original")! && !(bool)Call("ValidAppearanceIcon", "../../other")!, "appearance cannot select an arbitrary launcher component");
Check((bool)Call("ValidMetadataRevision", 0L)! && !(bool)Call("ValidMetadataRevision", -1L)! && !(bool)Call("ValidMetadataRevision", long.MaxValue)!, "CAS revisions start at zero and remain safe JavaScript integers");
var listId = "bcl_" + Guid.NewGuid();
Check((bool)Call("ValidBroadcastListId", listId)! && !(bool)Call("ValidBroadcastListId", "../foreign")! && !(bool)Call("ValidBroadcastListId", "bcl_" + Guid.Empty)!, "accepts only canonical owner-generated list identifiers");
var now = DateTimeOffset.UtcNow;
var tombstone = (BroadcastListResponse)Call("ToBroadcastListResponse", new BroadcastListRecord { UserId = "alice", Id = listId, DeletedAt = now, Revision = 3, EncryptedPayload = "legacy payload", RecipientCount = 12 })!;
Check(tombstone.EncryptedPayload is null && tombstone.RecipientCount == 0 && tombstone.Revision == 3 && tombstone.DeletedAt == now, "tombstone DTO retains revision while excluding even a leftover deleted payload");

var options = new DbContextOptionsBuilder<NivraDbContext>().UseInMemoryDatabase("metadata-checks-" + Guid.NewGuid()).Options;
await using var db = new NivraDbContext(options);
db.Users.AddRange(new UserAccount { Id = "alice", Alias = "alice", PasswordHash = new PasswordHash() }, new UserAccount { Id = "bob", Alias = "bob", PasswordHash = new PasswordHash() });
db.Devices.AddRange(Device(), Device("phone-b", "bob"), Device("revoked", revoked: true));
await db.SaveChangesAsync();
async Task<bool> Allowed(string user, string device) => await (Task<DeviceRecord?>)Call("MetadataDeviceAsync", db, user, device, CancellationToken.None)! is not null;
Check(await Allowed("alice", "phone-a") && !await Allowed("bob", "phone-a") && !await Allowed("alice", "revoked"), "metadata endpoints require the caller's own active trusted installation");
db.Set<AccountAppearance>().Add(new AccountAppearance { UserId = "alice", Icon = "ivory", Revision = 1, UpdatedAt = now });
db.Set<BroadcastListRecord>().AddRange(new BroadcastListRecord { UserId = "alice", Id = listId, EncryptedPayload = Envelope(Recipient()), Revision = 1, CreatedAt = now, UpdatedAt = now },
    new BroadcastListRecord { UserId = "bob", Id = listId, EncryptedPayload = "other-account", Revision = 1, CreatedAt = now, UpdatedAt = now });
await db.SaveChangesAsync();
Check(await db.Set<BroadcastListRecord>().CountAsync(row => row.UserId == "alice") == 1 && await db.Set<BroadcastListRecord>().CountAsync() == 2,
    "list identity is scoped by account even when two accounts use the same client ID");
await using (var first = new NivraDbContext(options))
await using (var second = new NivraDbContext(options))
{
    var a = await first.Set<AccountAppearance>().SingleAsync(row => row.UserId == "alice");
    var b = await second.Set<AccountAppearance>().SingleAsync(row => row.UserId == "alice");
    a.Revision++; a.Icon = "emerald"; await first.SaveChangesAsync();
    b.Revision++; b.Icon = "original";
    var conflicted = false;
    try { await second.SaveChangesAsync(); } catch (DbUpdateConcurrencyException) { conflicted = true; }
    Check(conflicted, "a stale second device cannot overwrite an appearance revision even outside the account lock");
    first.ChangeTracker.Clear();
    second.ChangeTracker.Clear();
    var x = await first.Set<BroadcastListRecord>().SingleAsync(row => row.UserId == "alice");
    var y = await second.Set<BroadcastListRecord>().SingleAsync(row => row.UserId == "alice");
    x.Revision++; x.DeletedAt = now; x.EncryptedPayload = null; await first.SaveChangesAsync();
    y.Revision++; y.EncryptedPayload = "late overwrite";
    conflicted = false;
    try { await second.SaveChangesAsync(); } catch (DbUpdateConcurrencyException) { conflicted = true; }
    Check(conflicted, "a stale edited list cannot resurrect a concurrently deleted ciphertext record");
}

await using var sqlDb = new NivraDbContext(new DbContextOptionsBuilder<NivraDbContext>()
    .UseNpgsql("Host=127.0.0.1;Port=1;Database=offline;Username=offline;Password=offline", provider => provider.EnableRetryOnFailure(3)).Options);
var appearanceModel = sqlDb.Model.FindEntityType(typeof(AccountAppearance))!;
var listModel = sqlDb.Model.FindEntityType(typeof(BroadcastListRecord))!;
Check(appearanceModel.FindProperty("Revision")!.IsConcurrencyToken && listModel.FindProperty("Revision")!.IsConcurrencyToken, "both account metadata tables enforce database compare-and-swap revisions");
Check(listModel.FindPrimaryKey()!.Properties.Select(property => property.Name).SequenceEqual(new[] { "UserId", "Id" }), "broadcast key includes its owner account");
Check(listModel.GetProperties().All(property => property.Name is not "Name" and not "Recipients" and not "RecipientUserIds" and not "Message"), "broadcast schema contains no plaintext list names, destination identities or messages");
Check(appearanceModel.GetForeignKeys().Single().DeleteBehavior == DeleteBehavior.Cascade && listModel.GetForeignKeys().Single().DeleteBehavior == DeleteBehavior.Cascade,
    "deleting an account also removes appearance and encrypted list metadata");
Check(sqlDb.GetService<IMigrationsAssembly>().Migrations.Keys.Any(name => name.EndsWith("_AccountAppearanceBroadcastLists")) && !sqlDb.Database.HasPendingModelChanges(), "additive migration is discoverable and its model snapshot matches runtime");
var authorizationSql = ((IQueryable<DeviceRecord>)Call("MetadataDeviceQuery", sqlDb, "fixture-owner", "fixture-device")!).ToQueryString();
Check(authorizationSql.Contains("EXISTS", StringComparison.OrdinalIgnoreCase) && authorizationSql.Contains("\"IsTrusted\"") && authorizationSql.Contains("\"RevokedAt\"") && authorizationSql.Contains("\"DisabledAt\""),
    "production Npgsql translates account appearance and broadcast trusted-device authorization with owner-status checks");
Check(sqlDb.Set<AccountAppearance>().Where(row => row.UserId == "fixture-owner").ToQueryString().Contains("public.account_appearances") &&
    sqlDb.Set<BroadcastListRecord>().Where(row => row.UserId == "fixture-owner").OrderBy(row => row.DeletedAt != null).ThenByDescending(row => row.UpdatedAt).Take(200).ToQueryString().Contains("public.broadcast_lists"),
    "production Npgsql translates appearance GET and bounded encrypted broadcast-list snapshot queries");

// Reproduce EF's actual provider guard without opening a socket or writing a
// row. InMemory never exercises this production failure. The marker represents
// the already-created transaction that EF sees before executing its command.
var connection = sqlDb.GetService<IRelationalConnection>();
var transactionProperty = typeof(RelationalConnection).GetProperty(nameof(RelationalConnection.CurrentTransaction))!;
using var marker = new FixtureTransaction();
transactionProperty.SetValue(connection, marker);
Check(sqlDb.Database.CreateExecutionStrategy().RetriesOnFailure && ReferenceEquals(sqlDb.Database.CurrentTransaction, marker),
    "metadata regression uses the production Npgsql retry policy with a user-initiated transaction");
var rejected = false;
try { await sqlDb.Database.CreateExecutionStrategy().ExecuteAsync(() => Task.FromResult(42)); }
catch (InvalidOperationException error) when (error.Message.Contains("user-initiated transactions", StringComparison.OrdinalIgnoreCase)) { rejected = true; }
Check(rejected, "reproduces the released appearance PUT failure before any database command is executed");
var result = await CallCoordination.RunAsync(sqlDb, () => sqlDb.Database.CreateExecutionStrategy().ExecuteAsync(() => Task.FromResult(42)));
Check(result == 42, "the mutation execution scope permits the same real provider guard while retaining the transaction");
var executions = 0;
try { await CallCoordination.RunAsync<int>(sqlDb, () => { executions++; throw new TimeoutException("fixture uncertain commit"); }); }
catch (TimeoutException) { }
Check(executions == 1 && ExecutionStrategy.Current is null, "uncertain commits never replay writes or realtime notifications and release the execution scope");
transactionProperty.SetValue(connection, null);
Console.WriteLine($"{count} account metadata checks passed (isolated fixtures; no live accounts).");

sealed class FixtureTransaction : IDbContextTransaction
{
    public Guid TransactionId { get; } = Guid.NewGuid();
    public void Commit() { }
    public Task CommitAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    public void Rollback() { }
    public Task RollbackAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    public void Dispose() { }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
