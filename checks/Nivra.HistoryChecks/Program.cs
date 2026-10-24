using System.Reflection;
using System.Text.Json;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Services;
using Nivra.Api.Contracts;

var count = 0;
void Check(bool condition, string label) { if (!condition) throw new Exception(label); Console.WriteLine($"PASS {label}"); count++; }
bool Allowed(HistoryKeyTransfer request, DeviceRecord? source, DeviceRecord? target, DateTimeOffset now) => (bool)typeof(EndpointExtensions).GetMethod("HistoryTransferAllowed", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, [request, source, target, now])!;
bool Envelope(SealedHistoryKeyResponse body, string sourceKey) => (bool)typeof(EndpointExtensions).GetMethod("ValidHistoryTransferEnvelope", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, [body, sourceKey])!;
string B64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
using var pair = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
var point = pair.ExportParameters(false);
var key = JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = B64Url(point.Q.X!), y = B64Url(point.Q.Y!) });
var now = DateTimeOffset.UtcNow;
DeviceRecord Device(string id, string user = "alice") => new() { Id = id, Name = "Test", UserId = user, IsTrusted = true, KeyBundle = new KeyBundle { IdentityKey = key } };
var source = Device("source"); var target = Device("target");
var request = new HistoryKeyTransfer { Id = "request", UserId = "alice", TargetDeviceId = "target", TargetIdentityKey = key, CreatedAt = now, ExpiresAt = now.AddMinutes(15) };
Check(Allowed(request, source, target, now), "authorized same-account active devices can transfer");
Check(!Allowed(request, Device("source", "mallory"), target, now), "cross-account source cannot transfer another user's keyring");
Check(!Allowed(request, source, Device("target", "mallory"), now), "cross-account target is rejected");
Check(!Allowed(request, source, Device("different"), now), "target device is bound to request");
Check(!Allowed(request, target, target, now), "target cannot submit a source response to itself");
Check(!Allowed(request, null, target, now) && !Allowed(request, source, null, now), "missing devices are rejected");
source.RevokedAt = now; Check(!Allowed(request, source, target, now), "revoked source is rejected even with a cached JWT"); source.RevokedAt = null;
target.RevokedAt = now; Check(!Allowed(request, source, target, now), "revoked target cannot receive old ciphertext"); target.RevokedAt = null;
source.IsTrusted = false; Check(!Allowed(request, source, target, now), "untrusted source is rejected"); source.IsTrusted = true;
target.IsTrusted = false; Check(!Allowed(request, source, target, now), "untrusted target is rejected"); target.IsTrusted = true;
Check(!Allowed(request, source, target, request.ExpiresAt), "expiry boundary rejects replay");
target.KeyBundle.IdentityKey = key + " "; Check(!Allowed(request, source, target, now), "target key rotation invalidates original request"); target.KeyBundle.IdentityKey = key;
var header = JsonSerializer.Serialize(new { v = 1, alg = "ECDH-P256-A256GCM", senderPublicKey = JsonSerializer.Deserialize<JsonElement>(key), iv = Convert.ToBase64String(new byte[12]) });
var valid = new SealedHistoryKeyResponse(header, Convert.ToBase64String(new byte[32]));
Check(Envelope(valid, key), "opaque authenticated ciphertext accepts bound source public key");
Check(!Envelope(valid with { Ciphertext = "plaintext" }, key), "plain text is not a transferable ciphertext");
Check(!Envelope(valid with { Ciphertext = Convert.ToBase64String(new byte[15]) }, key), "ciphertext without GCM tag is rejected");
Check(!Envelope(valid with { Header = "{}" }, key), "missing source metadata is rejected");
Check(!Envelope(valid with { Header = header.Replace("ECDH-P256-A256GCM", "none") }, key), "wrong algorithm is rejected");
Check(!Envelope(valid with { Header = header.Replace("\"v\":1", "\"v\":9") }, key), "unsupported envelope version is rejected");
Check(!Envelope(valid with { Ciphertext = new string('A', 512 * 1024 + 1) }, key), "oversized keyring ciphertext is rejected");
using var different = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
var other = different.ExportParameters(false);
var differentKey = JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = B64Url(other.Q.X!), y = B64Url(other.Q.Y!) });
Check(!Envelope(valid, differentKey), "claimed source cannot substitute another device public key");
source.KeyBundle.IdentityKey = JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = B64Url(point.Q.X!), y = B64Url(point.Q.Y!), d = "must-not-be-published" });
Check(!Allowed(request, source, target, now), "server key directory never accepts a private key as public metadata");
source.KeyBundle.IdentityKey = JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = new string('!', 43), y = B64Url(point.Q.Y!) });
Check(!Allowed(request, source, target, now), "invalid coordinate encodings cannot authorize a history recipient");
source.KeyBundle.IdentityKey = JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = B64Url(new byte[32]), y = B64Url(new byte[32]) });
Check(!Allowed(request, source, target, now), "coordinates outside the P-256 curve are rejected");
var sourceBundle = new KeyBundle { IdentityKey = key };
var localBundle = new KeyBundleRequest(differentKey, differentKey, "webcrypto-p256", []);
var localChallenge = new QrLoginChallenge("qr", "123456", "Destination", localBundle, null, "new-hardware", now, now.AddMinutes(1));
var selectQrBundle = typeof(EndpointExtensions).GetMethod("QrTargetKeyBundle", BindingFlags.NonPublic | BindingFlags.Static)!;
Check(ReferenceEquals(selectQrBundle.Invoke(null, [localChallenge, new DeviceRecord { Id = "source", Name = "Source", UserId = "alice", KeyBundle = sourceBundle }]), localBundle), "QR registers the locally generated destination identity without adopting the source key");
var legacyChallenge = new QrLoginChallenge("legacy", "123456", "Old destination", null, null, "old-hardware", now, now.AddMinutes(1));
Check(((KeyBundleRequest)selectQrBundle.Invoke(null, [legacyChallenge, new DeviceRecord { Id = "source", Name = "Source", UserId = "alice", KeyBundle = sourceBundle }])!).IdentityKey == key, "old QR destinations retain compatibility without changing the source identity");
var recoverySource = typeof(EndpointExtensions).GetMethod("DeviceIdentityRecoverySourceAllowed", BindingFlags.NonPublic | BindingFlags.Static)!;
var recoveryTarget = typeof(EndpointExtensions).GetMethod("DeviceIdentityRecoveryTargetAllowed", BindingFlags.NonPublic | BindingFlags.Static)!;
bool CanRecoverSource(DeviceRecord? device, string account = "alice") => (bool)recoverySource.Invoke(null, [device, account])!;
bool CanRecoverTarget(DeviceRecord device, DeviceRecord? destination, KeyBundleRequest bundle, bool recorded = false, string account = "alice") => (bool)recoveryTarget.Invoke(null, [device, destination, account, bundle, recorded])!;
source.KeyBundle.IdentityKey = key;
Check(CanRecoverSource(source), "active trusted credentials may recover a separate local device identity");
Check(!CanRecoverSource(null) && !CanRecoverSource(Device("source", "mallory")), "identity recovery rejects missing and foreign source credentials");
var revokedRecovery = Device("revoked"); revokedRecovery.RevokedAt = now;
Check(!CanRecoverSource(revokedRecovery), "revoked source cannot create a replacement session");
var untrustedRecovery = Device("untrusted"); untrustedRecovery.IsTrusted = false;
Check(!CanRecoverSource(untrustedRecovery), "untrusted source cannot create a replacement session");
Check(CanRecoverTarget(source, null, localBundle), "recovery can create a new destination without changing source keys");
Check(!CanRecoverTarget(source, source, new KeyBundleRequest(key, key, "webcrypto-p256", [])), "identity recovery never overwrites the source device");
Check(!CanRecoverTarget(source, target, localBundle), "an existing target with another identity cannot be overwritten");
Check(!CanRecoverTarget(source, target, new KeyBundleRequest(key, key, "webcrypto-p256", [])), "copying an existing phone public key and hardware cannot obtain its session");
Check(CanRecoverTarget(source, target, new KeyBundleRequest(key, key, "webcrypto-p256", []), true), "only a recorded repair with its secret proof can resume the exact destination identity");
Check(!CanRecoverTarget(source, revokedRecovery, new KeyBundleRequest(key, key, "webcrypto-p256", [])), "identity repair never revives a revoked target");
Check(!CanRecoverTarget(source, Device("target", "mallory"), new KeyBundleRequest(key, key, "webcrypto-p256", [])), "identity repair cannot reuse a foreign account target");
Check(!CanRecoverTarget(source, null, new KeyBundleRequest("invalid", null, null, [])), "identity repair requires a valid destination P-256 public identity");
var options = new DbContextOptionsBuilder<NivraDbContext>().UseNpgsql("Host=localhost;Database=unused;Username=unused;Password=unused").Options;
using var db = new NivraDbContext(options);
var migrations = db.GetService<IMigrationsAssembly>();
Check(migrations.Migrations.Keys.Any(x => x.EndsWith("HistoryKeyTransfers")), "history transfer migration is discoverable on API startup");
var transferModel = db.Model.FindEntityType(typeof(HistoryKeyTransfer))!;
Check(transferModel.GetProperties().All(x => !x.Name.Contains("Private", StringComparison.OrdinalIgnoreCase)), "database request schema contains no private key material");
Check(db.Model.FindEntityType(typeof(HistoryKeyTransferResponse))!.GetForeignKeys().Single().DeleteBehavior == DeleteBehavior.Cascade, "expired requests cascade their sealed responses");

var boundaryMethod = typeof(EndpointExtensions).GetMethod("MessageSyncBoundaryPage", BindingFlags.NonPublic | BindingFlags.Static)!;
List<MessageEnvelope> Boundary(IEnumerable<MessageEnvelope> rows, string? cursor, int take) =>
    (List<MessageEnvelope>)boundaryMethod.Invoke(null, [rows, cursor, take])!;
MessageEnvelope HistoryMessage(string id, string recipient = "alice", string conversationId = "conversation") => new()
{
    Id = id, ConversationId = conversationId, ClientMessageId = $"client-{id}",
    SenderUserId = "sender", SenderDeviceId = "sender-device", ServerReceivedAt = now,
    Recipients = [new RecipientCiphertext { UserId = recipient, DeviceId = "phone", Ciphertext = "opaque-phone-ciphertext" }]
};
var tiedRows = new[] { "msg_e", "msg_c", "msg_a", "msg_d", "msg_b" }.Select(id => HistoryMessage(id)).ToList();
Check(Boundary(tiedRows, null, 2).Select(message => message.Id).SequenceEqual(["msg_a", "msg_b"]), "sync cursor orders an equal-timestamp boundary before applying its limit");
Check(Boundary(tiedRows, "msg_b", 2).Select(message => message.Id).SequenceEqual(["msg_c", "msg_d"]), "sync cursor excludes the last returned id while retaining later equal-timestamp messages");
Check(Boundary(tiedRows, "msg_z", 2).Count == 0 && Boundary(tiedRows, null, 0).Count == 0, "sync cursor respects exhausted boundaries and an empty limit");
Check(Boundary([HistoryMessage("msg_A"), HistoryMessage("msg_a"), HistoryMessage("msg_B")], "msg_A", 3)
    .Select(message => message.Id).SequenceEqual(["msg_B", "msg_a"]), "sync boundary comparisons and sorting both use ordinal id ordering");
Check(Boundary(tiedRows.Where(message => message.Id != "msg_b"), "msg_b", 2).Select(message => message.Id)
    .SequenceEqual(["msg_c", "msg_d"]), "a deleted cursor envelope does not skip the remaining equal-timestamp messages");
var scanned = new List<string>();
string? scanCursor = null;
for (var pageNumber = 0; pageNumber < 4; pageNumber++)
{
    var candidates = Boundary(tiedRows, scanCursor, 3);
    var page = candidates.Take(2).ToList();
    scanned.AddRange(page.Select(message => message.Id));
    if (page.Count > 0) scanCursor = page[^1].Id;
    if (candidates.Count <= 2) break;
}
Check(scanned.SequenceEqual(["msg_a", "msg_b", "msg_c", "msg_d", "msg_e"]), "lookahead pagination consumes an entire timestamp tie without skipping or duplicating messages");

var normalizeHistoryIds = typeof(EndpointExtensions).GetMethod("TryNormalizeMessageHistoryRecoveryIds", BindingFlags.NonPublic | BindingFlags.Static)!;
bool NormalizeHistoryIds(List<string>? requested, out List<string> normalized)
{
    object?[] arguments = [requested, null];
    var validIds = (bool)normalizeHistoryIds.Invoke(null, arguments)!;
    normalized = (List<string>)arguments[1]!;
    return validIds;
}
Check(NormalizeHistoryIds([" msg_a ", "msg_a", "msg_b"], out var normalizedIds)
    && normalizedIds.SequenceEqual(["msg_a", "msg_b"]), "targeted history recovery trims and deduplicates requested ids");
Check(NormalizeHistoryIds([], out var emptyHistoryIds) && emptyHistoryIds.Count == 0, "an empty history recovery request is safe and returns no ids");
Check(!NormalizeHistoryIds(null, out _) && !NormalizeHistoryIds([" "], out _) && !NormalizeHistoryIds([null!], out _), "history recovery rejects absent or blank ids before querying messages");
Check(NormalizeHistoryIds(Enumerable.Range(0, 100).Select(index => $"msg_{index}").ToList(), out _)
    && !NormalizeHistoryIds(Enumerable.Range(0, 101).Select(index => $"msg_{index}").ToList(), out _), "history recovery bounds each request to one hundred message ids");
Check(NormalizeHistoryIds([new string('a', 64)], out _)
    && !NormalizeHistoryIds([new string('a', 65)], out _), "history recovery bounds ids to the database key length");

var recoveryQueryMethod = typeof(EndpointExtensions).GetMethod("MessageHistoryRecoveryQuery", BindingFlags.NonPublic | BindingFlags.Static)!;
IQueryable<MessageEnvelope> RecoveryQuery(IQueryable<MessageEnvelope> messages, IQueryable<ConversationRecord> conversations, List<string> ids) =>
    (IQueryable<MessageEnvelope>)recoveryQueryMethod.Invoke(null, [messages, conversations, "alice", ids])!;
ConversationRecord RecoveryConversation(string id, string participant, DateTimeOffset? removedAt = null)
{
    var conversation = new ConversationRecord { Id = id, CreatedByUserId = "owner" };
    conversation.Participants.Add(new ConversationParticipant { UserId = participant, RemovedAt = removedAt });
    return conversation;
}
var recoveryConversations = new[] {
    RecoveryConversation("active", "alice"), RecoveryConversation("removed", "alice", now), RecoveryConversation("foreign", "mallory")
}.AsQueryable();
var authorizationRows = new[] {
    HistoryMessage("msg_allowed", "alice", "active"), HistoryMessage("msg_foreign_recipient", "mallory", "active"),
    HistoryMessage("msg_removed_member", "alice", "removed"), HistoryMessage("msg_foreign_conversation", "alice", "foreign"),
    HistoryMessage("msg_not_requested", "alice", "active")
}.AsQueryable();
List<string> authorizationIds = ["msg_allowed", "msg_foreign_recipient", "msg_removed_member", "msg_foreign_conversation", "msg_unknown"];
Check(RecoveryQuery(authorizationRows, recoveryConversations, authorizationIds).Select(message => message.Id).SequenceEqual(["msg_allowed"]),
    "targeted recovery requires a requested id, its own envelope, and active conversation membership together");
Check(RecoveryQuery(authorizationRows, recoveryConversations, ["msg_unknown"]).Count() == 0,
    "unknown targeted ids reveal no rows even when the account has other readable conversations");
var recoverySql = RecoveryQuery(db.Messages.AsNoTracking(), db.Conversations.AsNoTracking(), authorizationIds).ToQueryString();
Check(recoverySql.Contains("conversation_participants", StringComparison.Ordinal)
    && recoverySql.Contains("message_recipients", StringComparison.Ordinal)
    && recoverySql.Contains("EXISTS", StringComparison.OrdinalIgnoreCase),
    "PostgreSQL translates both history authorization predicates into the database query");

var buildHistoryRecovery = typeof(EndpointExtensions).GetMethod("BuildMessageHistoryRecoveryResponse", BindingFlags.NonPublic | BindingFlags.Static)!;
MessageHistoryRecoveryResponse Recover(IEnumerable<MessageEnvelope> rows) =>
    (MessageHistoryRecoveryResponse)buildHistoryRecovery.Invoke(null, [rows, "alice", "browser", now])!;
var readable = HistoryMessage("msg_readable");
readable.Recipients.Add(new RecipientCiphertext { UserId = "alice", DeviceId = "browser", Ciphertext = "opaque-browser-ciphertext" });
readable.Recipients.Add(new RecipientCiphertext { UserId = "mallory", DeviceId = "other", Ciphertext = "must-not-be-returned" });
var ownRecovery = Recover([readable]);
Check(ownRecovery.Messages.Count == 1 && ownRecovery.Messages[0].Recipients.Count == 2
    && ownRecovery.Messages[0].Recipients.All(recipient => recipient.UserId == "alice")
    && ownRecovery.Messages[0].Recipients[0].DeviceId == "browser", "history recovery returns only the requesting account's envelopes and prefers its current device");
var foreign = HistoryMessage("msg_foreign", "mallory");
foreign.ExpiresAt = now.AddSeconds(-1);
var foreignRecovery = Recover([foreign]);
Check(foreignRecovery.Messages.Count == 0 && foreignRecovery.DeletedMessages.Count == 0,
    "foreign envelopes reveal neither ciphertext nor deletion tombstones");
var expired = HistoryMessage("msg_expired"); expired.ExpiresAt = now.AddSeconds(-1);
var boundaryExpiry = HistoryMessage("msg_expiry_boundary"); boundaryExpiry.ExpiresAt = now;
var futureExpiry = HistoryMessage("msg_future"); futureExpiry.ExpiresAt = now.AddTicks(1);
var expiryRecovery = Recover([expired, boundaryExpiry, futureExpiry]);
Check(expiryRecovery.Messages.Select(message => message.Id).SequenceEqual(["msg_future"])
    && expiryRecovery.DeletedMessages.Select(message => message.MessageId).SequenceEqual(["msg_expired", "msg_expiry_boundary"]),
    "history recovery never reopens expired envelopes, including the exact expiry boundary");
var ownDeleted = HistoryMessage("msg_own_deleted");
ownDeleted.Receipts.Add(new DeliveryReceipt { UserId = "alice", DeviceId = "phone", DeletedAt = now });
var otherDeleted = HistoryMessage("msg_other_deleted");
otherDeleted.Receipts.Add(new DeliveryReceipt { UserId = "mallory", DeviceId = "other", DeletedAt = now });
var deletionRecovery = Recover([ownDeleted, otherDeleted]);
Check(deletionRecovery.Messages.Select(message => message.Id).SequenceEqual(["msg_other_deleted"])
    && deletionRecovery.DeletedMessages.Count == 1 && deletionRecovery.DeletedMessages[0].MessageId == "msg_own_deleted"
    && deletionRecovery.DeletedMessages[0].Scope == "me", "a deletion on one own device applies account-wide while another account's receipt cannot delete this user's message");
var unopenedOnce = HistoryMessage("msg_unopened_once"); unopenedOnce.DeleteAfterRead = true;
unopenedOnce.Receipts.Add(new DeliveryReceipt { UserId = "alice", DeviceId = "phone", ReadAt = now });
Check(Recover([unopenedOnce]).Messages.Count == 1, "a read receipt alone does not consume an unopened one-time message");
unopenedOnce.Receipts[0].DeletedAt = now;
Check(Recover([unopenedOnce]).Messages.Count == 0 && Recover([unopenedOnce]).DeletedMessages.Count == 1,
    "a consumed one-time message is returned only as a deletion tombstone");
var absentRecovery = Recover([]);
Check(absentRecovery.Messages.Count == 0 && absentRecovery.DeletedMessages.Count == 0,
    "an absent message is not treated as proof of deletion");
Console.WriteLine($"Completed {count} history-security checks.");
