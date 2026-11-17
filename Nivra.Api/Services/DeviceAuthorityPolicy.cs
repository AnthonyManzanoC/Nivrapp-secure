using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public sealed record DevicePlatformDeclaration(int V, string RootKey, string DeviceId, string Platform, string Signature);
public sealed record DeviceAuthorityNode(string DeviceId, string Platform, string Role, DateTimeOffset? VerifiedAt);
public sealed record DeviceAuthorityResponse(string? PrimaryDeviceId, IReadOnlyList<DeviceAuthorityNode> Devices);

/// <summary>Deterministic source preference, independent of encryption authorization.</summary>
public static class DeviceAuthorityPolicy
{
    public static bool ValidPlatform(string? platform) => platform is "android" or "web" or "desktop";
    public static byte[] Statement(string userId, DevicePlatformDeclaration declaration) => JsonSerializer.SerializeToUtf8Bytes(
        new object[] { "nivra-device-platform-v1", userId, declaration.RootKey, declaration.DeviceId, declaration.Platform }, AccountIdentityPolicy.Json);

    public static DeviceAuthorityResponse Elect(IEnumerable<DeviceRecord> devices, IEnumerable<SessionRecord> sessions,
        DateTimeOffset now, string? establishedRoot)
    {
        var active = sessions.Where(session => session.RevokedAt is null && session.ExpiresAt > now)
            .Select(session => (session.UserId, session.DeviceId)).ToHashSet();
        var candidates = devices.Where(device => device.IsTrusted && device.RevokedAt is null && active.Contains((device.UserId, device.Id)))
            .OrderBy(device => device.CreatedAt).ThenBy(device => device.Id, StringComparer.Ordinal).ToList();
        bool Certified(DeviceRecord device)
        {
            var certificate = AccountIdentityPolicy.Certificate(device);
            return establishedRoot is not null && certificate is not null && certificate.DeviceId == device.Id && certificate.RootKey == establishedRoot
                && certificate.LegacyKey == DeviceContinuityPolicy.Coordinates(device.KeyBundle.IdentityKey)
                && AccountIdentityPolicy.Verify(establishedRoot, AccountIdentityPolicy.DeviceStatement(device.UserId, certificate), certificate.Signature);
        }
        var verified = candidates.Where(device => device.PlatformVerifiedAt is not null && ValidPlatform(device.Platform) && Certified(device)).ToList();
        var primary = verified.OrderBy(device => device.Platform == "android" ? 0 : 1)
            .ThenBy(device => device.PlatformVerifiedAt).ThenBy(device => device.CreatedAt).ThenBy(device => device.Id, StringComparer.Ordinal).FirstOrDefault()
            ?? candidates.FirstOrDefault();
        return new(primary?.Id, candidates.Select(device => new DeviceAuthorityNode(device.Id, device.Platform ?? "unknown",
            primary?.Id == device.Id ? "primary" : "mirror", device.PlatformVerifiedAt)).ToList());
    }

    public static async Task<DeviceAuthorityResponse> ReadAsync(NivraDbContext db, string userId, DateTimeOffset now, CancellationToken ct)
    {
        var devices = await db.Devices.AsNoTracking().Where(device => device.UserId == userId && device.RevokedAt == null && device.IsTrusted).ToListAsync(ct);
        var sessions = await db.Sessions.AsNoTracking().Where(session => session.UserId == userId && session.RevokedAt == null && session.ExpiresAt > now).ToListAsync(ct);
        var root = AccountIdentityPolicy.Read(await db.AccountIdentities.AsNoTracking().SingleOrDefaultAsync(row => row.UserId == userId, ct));
        return Elect(devices, sessions, now, root?.RootKey);
    }
}
