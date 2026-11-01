using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Npgsql;

namespace Nivra.Api.Services;

public sealed class RatchetPreKeyException(string code, int status) : Exception(code)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}

/// <summary>Experimental public prekey repository. No private keys or v3 capability announcements.</summary>
public sealed class RatchetPreKeyStore(NivraDbContext db, TimeProvider clock)
{
    public const string Suite = "NIVRA-LIBSIGNAL-BUNDLE-PILOT-1";
    public const string OlmSuite = "NIVRA-PQXDH-MLKEM768-BUNDLE-1";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static RatchetPreKeyException Reject(string code, int status = 409) => new(code, status);

    public static bool IsValidBundle(RatchetPublicBundle? bundle) => bundle is not null &&
        bundle.V == 1 && bundle.Suite == Suite && bundle.RegistrationId is > 0 and < 16380 &&
        bundle.DeviceId is > 0 and < 128 && bundle.PreKeyId > 0 && bundle.SignedPreKeyId > 0 && bundle.KyberPreKeyId > 0 &&
        Binary(bundle.IdentityKey, 33, 0x05) && Binary(bundle.PreKeyPublic, 33, 0x05) && Binary(bundle.SignedPreKeyPublic, 33, 0x05) &&
        Binary(bundle.SignedPreKeySignature, 64) && Binary(bundle.KyberPreKeyPublic, 1569, 0x08) && Binary(bundle.KyberPreKeySignature, 64);

    private static bool Binary(string? value, int size, byte? prefix = null)
    {
        if (value is null || value.Length != (size + 2) / 3 * 4) return false;
        var bytes = new byte[size];
        return Convert.TryFromBase64String(value, bytes, out var written) && written == size &&
            Convert.ToBase64String(bytes) == value && (prefix is null || bytes[0] == prefix) &&
            bytes.Skip(prefix.HasValue ? 1 : 0).Any(part => part != 0);
    }

    private sealed record Material(uint PreKeyId, string IdentityKey, int DeviceId, int RegistrationId, string Encoded);
    private sealed record Reserved(string DeviceId, Guid RequestId, string Encoded);
    public Task<int> PublishAsync(string userId, string deviceId, IReadOnlyList<RatchetPublicBundle>? bundles, CancellationToken ct, bool deviceAddresses = false)
    {
        if (bundles is null || bundles.Count is < 1 or > 64 || bundles.Any(bundle => !IsValidBundle(bundle)) ||
            bundles.Select(bundle => bundle.PreKeyId).Distinct().Count() != bundles.Count) throw Reject("invalid_prekey_batch", 400);
        return PublishMaterials(userId, deviceId, bundles.Select(bundle => new Material(bundle.PreKeyId, bundle.IdentityKey, bundle.DeviceId, bundle.RegistrationId, JsonSerializer.Serialize(bundle, Json))).ToList(), deviceAddresses ? 1 : 0, ct);
    }
    public Task<int> PublishOlmAsync(string userId, string deviceId, IReadOnlyList<RatchetOlmPublicBundle>? bundles, CancellationToken ct)
    {
        if (bundles is null || bundles.Count is < 1 or > 32 || bundles.Any(bundle => bundle is null || bundle.V != 1 || bundle.Suite != OlmSuite || bundle.DeviceId != 1 || bundle.RegistrationId is < 1 or >= 16380 || bundle.PreKeyId == 0 || !Binary(bundle.IdentityKey, 64) || !Binary(bundle.SignedPreKeyPublic, 32) || !Binary(bundle.PreKeyPublic, 32) || !Binary(bundle.MlKemPublic, 1184) || !Binary(bundle.Signature, 64)) ||
            bundles.Select(bundle => bundle.PreKeyId).Distinct().Count() != bundles.Count) throw Reject("invalid_prekey_batch", 400);
        return PublishMaterials(userId, deviceId, bundles.Select(bundle => new Material(bundle.PreKeyId, bundle.IdentityKey, bundle.DeviceId, bundle.RegistrationId, JsonSerializer.Serialize(bundle, Json))).ToList(), 2, ct);
    }
    private async Task<int> PublishMaterials(string userId, string deviceId, IReadOnlyList<Material> bundles, int addressMode, CancellationToken ct)
    {
        RequirePostgres(); var deviceAddresses = addressMode > 0;
        var first = bundles[0];
        if (bundles.Any(bundle => bundle.IdentityKey != first.IdentityKey || bundle.DeviceId != first.DeviceId || bundle.RegistrationId != first.RegistrationId))
            throw Reject("inconsistent_prekey_identity", 400);

        try
        {
            return await CallCoordination.RunAsync(db, async () =>
            {
                // Serialize registration/slot allocation per account across API instances.
                await using var transaction = await CallCoordination.LockAsync(db, $"ratchet-publish:{userId}", ct);
                await RequireDeviceAsync(userId, deviceId, ct);
                var registration = await db.Set<RatchetPilotDevice>().SingleOrDefaultAsync(row => row.DeviceId == deviceId, ct);
                if (registration is null)
                {
                    if (!deviceAddresses && await db.Set<RatchetPilotDevice>().AnyAsync(row => row.UserId == userId && row.AddressMode == 0 && row.SignalDeviceNumber == first.DeviceId, ct))
                        throw Reject("ratchet_device_number_taken");
                    registration = new RatchetPilotDevice { DeviceId = deviceId, UserId = userId, IdentityKey = first.IdentityKey,
                        SignalDeviceNumber = first.DeviceId, RegistrationId = first.RegistrationId, AddressMode = addressMode, CreatedAt = clock.GetUtcNow() };
                    db.Add(registration);
                }
                else if (registration.UserId != userId || registration.IdentityKey != first.IdentityKey ||
                    registration.SignalDeviceNumber != first.DeviceId || registration.RegistrationId != first.RegistrationId || registration.AddressMode != addressMode)
                    throw Reject("ratchet_identity_change_requires_verification");

                var ids = bundles.Select(bundle => (long)bundle.PreKeyId).ToArray();
                var existing = await db.Set<RatchetPilotPreKey>().Where(row => row.DeviceId == deviceId && ids.Contains(row.PreKeyId)).ToDictionaryAsync(row => row.PreKeyId, ct);
                var added = 0;
                foreach (var bundle in bundles)
                {
                    var encoded = bundle.Encoded;
                    var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(encoded)));
                    if (existing.TryGetValue(bundle.PreKeyId, out var previous))
                    {
                        if (previous.BundleHash != digest) throw Reject("prekey_id_reused");
                        continue; // A retry must never make a consumed prekey available again.
                    }
                    if (bundle.PreKeyId <= registration.HighWatermark) throw Reject("prekey_id_reused");
                    db.Add(new RatchetPilotPreKey { DeviceId = deviceId, PreKeyId = bundle.PreKeyId, BundleJson = encoded, BundleHash = digest, CreatedAt = clock.GetUtcNow() });
                    added++;
                }
                if (deviceAddresses)
                {
                    var retention = clock.GetUtcNow().AddDays(-30);
                    await db.Set<RatchetPilotPreKey>().Where(row => row.DeviceId == deviceId && row.ClaimedAt < retention).ExecuteDeleteAsync(ct);
                }
                var stored = await db.Set<RatchetPilotPreKey>().Where(row => row.DeviceId == deviceId).CountAsync(ct);
                var available = await db.Set<RatchetPilotPreKey>().Where(row => row.DeviceId == deviceId && row.ClaimRequestId == null).CountAsync(ct);
                if (stored + added > (deviceAddresses ? 8192 : 1024) || available + added > 256) throw Reject("prekey_storage_limit", 429);
                registration.HighWatermark = Math.Max(registration.HighWatermark, bundles.Max(bundle => (long)bundle.PreKeyId));
                await db.SaveChangesAsync(ct);
                await transaction.CommitAsync(ct);
                return added;
            });
        }
        catch (DbUpdateException error) when (error.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            throw Reject("prekey_publication_conflict");
        }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<RatchetPreKeyReservation?> ReserveAsync(string userId, string deviceId, string targetDeviceId, string conversationId, Guid requestId, CancellationToken ct, bool deviceAddresses = false)
    {
        var value = await ReserveMaterial(userId, deviceId, targetDeviceId, conversationId, requestId, deviceAddresses ? 1 : 0, ct);
        return value is null ? null : new(value.DeviceId, value.RequestId, JsonSerializer.Deserialize<RatchetPublicBundle>(value.Encoded, Json) ?? throw Reject("invalid_stored_prekey", 503));
    }
    public async Task<RatchetOlmPreKeyReservation?> ReserveOlmAsync(string userId, string deviceId, string targetDeviceId, string conversationId, Guid requestId, CancellationToken ct)
    {
        var value = await ReserveMaterial(userId, deviceId, targetDeviceId, conversationId, requestId, 2, ct);
        return value is null ? null : new(value.DeviceId, value.RequestId, JsonSerializer.Deserialize<RatchetOlmPublicBundle>(value.Encoded, Json) ?? throw Reject("invalid_stored_prekey", 503));
    }
    private async Task<Reserved?> ReserveMaterial(string userId, string deviceId, string targetDeviceId, string conversationId, Guid requestId, int addressMode, CancellationToken ct)
    {
        RequirePostgres(); var deviceAddresses = addressMode > 0;
        if (!ValidId(targetDeviceId) || !ValidId(conversationId) || requestId == Guid.Empty || targetDeviceId == deviceId) throw Reject("invalid_prekey_reservation", 400);
        try
        {
            return await CallCoordination.RunAsync(db, async () =>
            {
                // One shared per-initiator lock also makes quota accounting and
                // same-request retries atomic, without depending on process memory.
                await using var transaction = await CallCoordination.LockAsync(db, $"ratchet-reserve:{deviceId}", ct);
                await RequireDeviceAsync(userId, deviceId, ct);
                if (deviceAddresses && (!await db.Set<RatchetPilotDevice>().AnyAsync(row => row.DeviceId == deviceId && row.AddressMode == addressMode, ct)
                    || !await db.Set<RatchetPilotDevice>().AnyAsync(row => row.DeviceId == targetDeviceId && row.AddressMode == addressMode, ct))) throw Reject("ratchet_registration_required", 409);
                var target = await db.Devices.AsNoTracking().SingleOrDefaultAsync(row => row.Id == targetDeviceId && row.RevokedAt == null && row.IsTrusted, ct);
                if (target is null || !await db.Users.AnyAsync(user => user.Id == target.UserId && user.DisabledAt == null, ct)) throw Reject("ratchet_device_unavailable", 404);
                var allowed = await db.Conversations.AnyAsync(conversation => conversation.Id == conversationId &&
                    conversation.Participants.Any(peer => peer.UserId == userId && peer.RemovedAt == null) &&
                    conversation.Participants.Any(peer => peer.UserId == target.UserId && peer.RemovedAt == null), ct);
                var sharedVault = deviceAddresses && await RatchetDirectoryService.SharedVaultAsync(db, userId, target.UserId, clock.GetUtcNow(), ct, conversationId);
                allowed |= sharedVault;
                if (!allowed && deviceAddresses && target.UserId == userId && conversationId.StartsWith("history_", StringComparison.Ordinal))
                {
                    var transferId = conversationId[8..];
                    allowed = await db.HistoryKeyTransfers.AnyAsync(request => request.Id == transferId && request.UserId == userId && request.TargetDeviceId == targetDeviceId && request.ExpiresAt > clock.GetUtcNow() &&
                        db.HistoryKeyTransferResponses.Any(response => response.TransferId == request.Id && response.SourceDeviceId == deviceId), ct);
                }
                var sharedGroup = sharedVault || deviceAddresses && await db.Conversations.AnyAsync(chat => chat.Id == conversationId && chat.Type == ConversationType.Group, ct);
                if (!allowed || !sharedGroup && await db.Set<ContactBlockRecord>().AnyAsync(block =>
                    block.OwnerUserId == userId && block.ContactUserId == target.UserId || block.OwnerUserId == target.UserId && block.ContactUserId == userId, ct))
                    throw Reject("prekey_conversation_forbidden", 403);

                var previous = await db.Set<RatchetPilotPreKey>().AsNoTracking().SingleOrDefaultAsync(row => row.DeviceId == targetDeviceId && row.ClaimantDeviceId == deviceId && row.ClaimRequestId == requestId, ct);
                if (previous is not null)
                {
                    if (previous.ConversationId != conversationId) throw Reject("prekey_request_context_changed");
                    await transaction.CommitAsync(ct);
                    return Reservation(previous, requestId);
                }
                var since = clock.GetUtcNow().AddHours(-1);
                if (await db.Set<RatchetPilotPreKey>().CountAsync(row => row.ClaimantDeviceId == deviceId && row.ClaimedAt >= since, ct) >= (deviceAddresses ? 512 : 32))
                    throw Reject("prekey_claim_limit", 429);

                var candidates = await db.Set<RatchetPilotPreKey>().FromSqlInterpolated($"""
                    SELECT * FROM public.ratchet_pilot_prekeys
                    WHERE "DeviceId" = {targetDeviceId} AND "ClaimRequestId" IS NULL
                    ORDER BY "PreKeyId" LIMIT 1 FOR UPDATE SKIP LOCKED
                    """).ToListAsync(ct);
                var candidate = candidates.SingleOrDefault();
                if (candidate is null) { await transaction.CommitAsync(ct); return null; }
                candidate.ClaimRequestId = requestId; candidate.ClaimantDeviceId = deviceId; candidate.ConversationId = conversationId; candidate.ClaimedAt = clock.GetUtcNow();
                await db.SaveChangesAsync(ct);
                var result = Reservation(candidate, requestId);
                await transaction.CommitAsync(ct);
                return result;
            });
        }
        finally { db.ChangeTracker.Clear(); }
    }

    private async Task RequireDeviceAsync(string userId, string deviceId, CancellationToken ct)
    {
        if (!await db.Devices.AnyAsync(device => device.Id == deviceId && device.UserId == userId && device.RevokedAt == null && device.IsTrusted, ct) ||
            !await db.Users.AnyAsync(user => user.Id == userId && user.DisabledAt == null, ct)) throw Reject("ratchet_device_unauthorized", 403);
    }
    public async Task ConsumeOlmAsync(string userId, string deviceId, List<uint>? ids, CancellationToken ct)
    {
        RequirePostgres();
        if (ids is null || ids.Count is < 1 or > 256 || ids.Any(id => id == 0)) throw Reject("invalid_consumed_prekeys", 400);
        try
        {
            await CallCoordination.RunAsync(db, async () =>
            {
                await using var tx = await CallCoordination.LockAsync(db, $"ratchet-publish:{userId}", ct);
                await RequireDeviceAsync(userId, deviceId, ct);
                if (!await db.Set<RatchetPilotDevice>().AnyAsync(row => row.DeviceId == deviceId && row.UserId == userId && row.AddressMode == 2, ct)) throw Reject("ratchet_registration_required");
                var keys = ids.Select(id => (long)id).Distinct().ToArray();
                // HighWatermark remains immutable. A late publication retry
                // cannot reintroduce one of these consumed identifiers.
                await db.Set<RatchetPilotPreKey>().Where(row => row.DeviceId == deviceId && keys.Contains(row.PreKeyId) && row.ClaimRequestId != null).ExecuteDeleteAsync(ct);
                await tx.CommitAsync(ct); return true;
            });
        }
        finally { db.ChangeTracker.Clear(); }
    }
    private static Reserved Reservation(RatchetPilotPreKey row, Guid requestId) => new(row.DeviceId, requestId, row.BundleJson);
    private static bool ValidId(string value) => !string.IsNullOrEmpty(value) && value.Length <= 64 && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
    private void RequirePostgres() { if (!db.Database.IsNpgsql()) throw new NotSupportedException("Ratchet reservations require PostgreSQL transactions"); }
}
