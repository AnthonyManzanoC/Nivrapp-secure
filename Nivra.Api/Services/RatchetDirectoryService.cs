using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

/// <summary>Public capabilities plus per-recipient bindings protected by the existing E2EE identity.</summary>
public sealed class RatchetDirectoryService(NivraDbContext db, TimeProvider clock)
{
    private static RatchetPreKeyException Reject(string code, int status = 403) => new(code, status);
    public async Task<int> AvailableAsync(string userId, string deviceId, CancellationToken ct)
    {
        await OwnDevice(userId, deviceId, ct);
        return await db.Set<RatchetPilotPreKey>().CountAsync(row => row.DeviceId == deviceId && row.ClaimRequestId == null, ct);
    }
    public async Task<List<RatchetDirectoryEntry>> DirectoryAsync(string userId, string deviceId, List<string>? deviceIds, CancellationToken ct, int addressMode = 1)
    {
        await OwnDevice(userId, deviceId, ct);
        var ids = Ids(deviceIds);
        var active = await db.Devices.AsNoTracking().Where(row => ids.Contains(row.Id) && row.IsTrusted && row.RevokedAt == null &&
            db.Users.Any(user => user.Id == row.UserId && user.DisabledAt == null)).Select(row => row.Id).ToListAsync(ct);
        var registrations = await db.Set<RatchetPilotDevice>().AsNoTracking().Where(row => active.Contains(row.DeviceId) && row.AddressMode == addressMode).ToListAsync(ct);
        var bindings = await db.Set<RatchetDeviceBinding>().AsNoTracking().Where(row => active.Contains(row.SourceDeviceId) && row.TargetDeviceId == deviceId).ToDictionaryAsync(row => row.SourceDeviceId, ct);
        return registrations.Select(row => new RatchetDirectoryEntry(row.UserId, row.DeviceId, row.SignalDeviceNumber, row.RegistrationId, row.IdentityKey,
            bindings.GetValueOrDefault(row.DeviceId)?.Header, bindings.GetValueOrDefault(row.DeviceId)?.Ciphertext)).ToList();
    }

    public async Task PublishBindingsAsync(string userId, string deviceId, List<RatchetBindingUpload>? uploads, CancellationToken ct)
    {
        if (uploads is null || uploads.Count is < 1 or > 64 || uploads.Select(row => row.TargetDeviceId).Distinct().Count() != uploads.Count) throw Reject("invalid_ratchet_bindings", 400);
        try
        {
            await CallCoordination.RunAsync(db, async () =>
            {
                await using var tx = await CallCoordination.LockAsync(db, $"ratchet-bindings:{deviceId}", ct);
                var source = await OwnDevice(userId, deviceId, ct);
                if (!await db.Set<RatchetPilotDevice>().AnyAsync(row => row.DeviceId == deviceId && row.UserId == userId && row.AddressMode > 0, ct)) throw Reject("ratchet_registration_required", 409);
                var sourceIdentity = Coordinates(source.KeyBundle.IdentityKey);
                if (sourceIdentity is null) throw Reject("legacy_identity_unavailable", 409);
                var count = await db.Set<RatchetDeviceBinding>().CountAsync(row => row.SourceDeviceId == deviceId, ct);
                foreach (var upload in uploads)
                {
                    if (string.IsNullOrEmpty(upload.Header) || upload.Header.Length > 4096 || string.IsNullOrEmpty(upload.Ciphertext) || upload.Ciphertext.Length > 16384 || upload.Ciphertext.Length < 24)
                        throw Reject("invalid_ratchet_binding", 400);
                    try
                    {
                        using var header = JsonDocument.Parse(upload.Header);
                        var root = header.RootElement;
                        if (root.GetProperty("v").GetInt32() != 1 || root.GetProperty("alg").GetString() != "ECDH-P256-A256GCM" ||
                            Coordinates(root.GetProperty("senderPublicKey").GetRawText()) != sourceIdentity || Convert.FromBase64String(root.GetProperty("iv").GetString()!).Length != 12 ||
                            Convert.FromBase64String(upload.Ciphertext).Length < 16) throw Reject("invalid_ratchet_binding", 400);
                    }
                    catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or ArgumentException) { throw Reject("invalid_ratchet_binding", 400); }
                    var target = await RelatedDevice(source, upload.TargetDeviceId, ct);
                    if (Coordinates(target.KeyBundle.IdentityKey) is not { } targetIdentity || targetIdentity != upload.TargetIdentity) throw Reject("binding_target_identity_changed", 409);
                    var stored = await db.Set<RatchetDeviceBinding>().SingleOrDefaultAsync(row => row.SourceDeviceId == deviceId && row.TargetDeviceId == target.Id, ct);
                    if (stored is null)
                    {
                        if (++count > 4096) throw Reject("ratchet_binding_limit", 429);
                        stored = new RatchetDeviceBinding { SourceDeviceId = deviceId, TargetDeviceId = target.Id, TargetIdentity = targetIdentity, Header = upload.Header, Ciphertext = upload.Ciphertext };
                        db.Add(stored);
                    }
                    stored.TargetIdentity = targetIdentity; stored.Header = upload.Header; stored.Ciphertext = upload.Ciphertext; stored.UpdatedAt = clock.GetUtcNow();
                    await db.Set<RatchetBindingRequest>().Where(row => row.SourceDeviceId == target.Id && row.TargetDeviceId == deviceId).ExecuteDeleteAsync(ct);
                }
                await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); return true;
            });
        }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task RequestBindingsAsync(string userId, string deviceId, List<string>? targetDeviceIds, CancellationToken ct)
    {
        var ids = Ids(targetDeviceIds);
        try
        {
            await CallCoordination.RunAsync(db, async () =>
            {
                await using var tx = await CallCoordination.LockAsync(db, $"ratchet-binding-requests:{deviceId}", ct);
                var source = await OwnDevice(userId, deviceId, ct);
                await db.Set<RatchetBindingRequest>().Where(row => row.SourceDeviceId == deviceId && row.RequestedAt < clock.GetUtcNow().AddDays(-7)).ExecuteDeleteAsync(ct);
                var count = await db.Set<RatchetBindingRequest>().CountAsync(row => row.SourceDeviceId == deviceId, ct);
                foreach (var id in ids.Where(id => id != deviceId))
                {
                    var target = await RelatedDevice(source, id, ct);
                    if (!await db.Set<RatchetPilotDevice>().AnyAsync(row => row.DeviceId == target.Id && row.AddressMode > 0, ct)) continue;
                    var request = await db.Set<RatchetBindingRequest>().SingleOrDefaultAsync(row => row.SourceDeviceId == deviceId && row.TargetDeviceId == id, ct);
                    if (request is null)
                    {
                        if (++count > 512) throw Reject("ratchet_binding_request_limit", 429);
                        request = new RatchetBindingRequest { SourceDeviceId = deviceId, TargetDeviceId = id }; db.Add(request);
                    }
                    request.RequestedAt = clock.GetUtcNow();
                }
                await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); return true;
            });
        }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<object[]> PendingBindingsAsync(string userId, string deviceId, CancellationToken ct)
    {
        await OwnDevice(userId, deviceId, ct);
        var since = clock.GetUtcNow().AddDays(-7);
        var requests = await db.Set<RatchetBindingRequest>().AsNoTracking().Where(row => row.TargetDeviceId == deviceId && row.RequestedAt >= since)
            .OrderBy(row => row.RequestedAt).Take(128).Select(row => row.SourceDeviceId).ToListAsync(ct);
        var devices = await db.Devices.AsNoTracking().Where(row => requests.Contains(row.Id) && row.IsTrusted && row.RevokedAt == null && db.Users.Any(user => user.Id == row.UserId && user.DisabledAt == null)).ToListAsync(ct);
        return devices.Select(row => (object)new { userId = row.UserId, deviceId = row.Id, identityKey = row.KeyBundle.IdentityKey }).ToArray();
    }

    private async Task<DeviceRecord> OwnDevice(string userId, string deviceId, CancellationToken ct) =>
        await db.Devices.AsNoTracking().SingleOrDefaultAsync(row => row.Id == deviceId && row.UserId == userId && row.IsTrusted && row.RevokedAt == null && db.Users.Any(user => user.Id == userId && user.DisabledAt == null), ct)
        ?? throw Reject("ratchet_device_unauthorized");

    private async Task<DeviceRecord> RelatedDevice(DeviceRecord source, string targetId, CancellationToken ct)
    {
        if (!ValidId(targetId)) throw Reject("invalid_ratchet_target", 400);
        var target = await db.Devices.AsNoTracking().SingleOrDefaultAsync(row => row.Id == targetId && row.IsTrusted && row.RevokedAt == null && db.Users.Any(user => user.Id == row.UserId && user.DisabledAt == null), ct)
            ?? throw Reject("ratchet_device_unavailable", 404);
        if (source.UserId == target.UserId) return target;
        if (await db.Conversations.AnyAsync(chat => chat.Type == ConversationType.Group && chat.Participants.Any(peer => peer.UserId == source.UserId && peer.RemovedAt == null) && chat.Participants.Any(peer => peer.UserId == target.UserId && peer.RemovedAt == null), ct)) return target;
        if (await ContactBlockPolicy.BetweenAsync(db, source.UserId, target.UserId, ct)) throw Reject("ratchet_binding_forbidden");
        if (await db.Conversations.AnyAsync(chat => chat.Participants.Any(peer => peer.UserId == source.UserId && peer.RemovedAt == null) && chat.Participants.Any(peer => peer.UserId == target.UserId && peer.RemovedAt == null), ct)
            || await db.Contacts.AnyAsync(contact => contact.OwnerUserId == source.UserId && contact.ContactUserId == target.UserId, ct)) return target;
        throw Reject("ratchet_binding_forbidden");
    }
    private static string[] Ids(List<string>? ids)
    {
        if (ids is null || ids.Count is < 1 or > 128 || ids.Any(id => !ValidId(id))) throw Reject("invalid_ratchet_devices", 400);
        return ids.Distinct(StringComparer.Ordinal).ToArray();
    }
    private static bool ValidId(string? value) => value is { Length: > 0 and <= 64 } && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
    public static string? Coordinates(string? encoded)
    {
        try
        {
            using var document = JsonDocument.Parse(encoded ?? "null"); var key = document.RootElement;
            if (key.ValueKind != JsonValueKind.Object || key.TryGetProperty("d", out _) || key.GetProperty("kty").GetString() != "EC" || key.GetProperty("crv").GetString() != "P-256") return null;
            var x = key.GetProperty("x").GetString(); var y = key.GetProperty("y").GetString();
            return x is { Length: 43 } && y is { Length: 43 } && (x + y).All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') ? x + ":" + y : null;
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or ArgumentException) { return null; }
    }
}
