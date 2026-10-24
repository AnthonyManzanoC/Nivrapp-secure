using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Nivra.Api.Endpoints;

public sealed record DeviceIdentityRecoveryRequest(string DeviceName, KeyBundleRequest KeyBundle, string? HardwareId, string RecoveryToken);

public static partial class EndpointExtensions
{
    private static void MapDeviceIdentityRecoveryEndpoints(this WebApplication app)
    {
        app.MapPost("/auth/repair-device", async Task<IResult> (DeviceIdentityRecoveryRequest request, HttpContext http, NivraDbContext db, TokenService tokens, TimeProvider clock, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null) return Results.Unauthorized();
            var user = await db.Users.FirstOrDefaultAsync(item => item.Id == current.UserId && item.DisabledAt == null, ct);
            var source = await db.Devices.AsNoTracking().FirstOrDefaultAsync(item => item.Id == current.DeviceId && item.UserId == current.UserId, ct);
            if (user is null || !DeviceIdentityRecoverySourceAllowed(source, current.UserId)) return Results.Unauthorized();
            var hardwareId = NormalizeHardwareId(request.HardwareId);
            if (hardwareId is null || string.IsNullOrWhiteSpace(request.DeviceName) || !ValidHistoryPublicKey(request.KeyBundle?.IdentityKey)
                || request.RecoveryToken is null || !Regex.IsMatch(request.RecoveryToken, "^[a-f0-9]{64}$")) return Results.BadRequest(new { code = "invalid_device_identity" });
            var target = await db.Devices.FirstOrDefaultAsync(item => item.UserId == current.UserId && item.HardwareId == hardwareId, ct);
            var binding = target is null ? null : DeviceIdentityRecoveryBinding(source!.Id, target.Id, request.RecoveryToken);
            var recorded = binding is not null && await db.SecurityAuditEvents.AsNoTracking().AnyAsync(item => item.UserId == current.UserId && item.Action == "auth.device_identity_recovery" && item.Details == binding, ct);
            if (hardwareId == source!.HardwareId || !DeviceIdentityRecoveryTargetAllowed(source, target, current.UserId, request.KeyBundle!, recorded)) return Results.Conflict(new { code = "device_identity_conflict" });
            var now = clock.GetUtcNow();
            if (target is null)
            {
                // This authenticated session already has device-link permission.
                // Repairing old copied credentials creates a distinct device and
                // never rotates, revives or overwrites the source or another target.
                target = NewDevice(current.UserId, request.DeviceName, hardwareId, request.KeyBundle!, now, trusted: true);
                db.Devices.Add(target);
                db.SecurityAuditEvents.Add(new SecurityAuditEvent { Id = NivraIds.NewId("aud"), UserId = current.UserId,
                    Action = "auth.device_identity_recovery", IpAddress = ClientIp(http), Details = DeviceIdentityRecoveryBinding(source.Id, target.Id, request.RecoveryToken), CreatedAt = now });
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException error) when (error.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation })
                { return Results.Conflict(new { code = "device_identity_conflict" }); }
            }
            var session = await tokens.CreateSessionAsync(new PgSqlNivraStore(db), user, target, ClientIp(http), http.Request.Headers.UserAgent.ToString(), ct);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new AuthResponse(ToUserResponse(user), ToDeviceResponse(target), session));
        }).RequireRateLimiting("auth");
    }

    internal static bool DeviceIdentityRecoverySourceAllowed(DeviceRecord? source, string userId) => source is { IsTrusted: true, RevokedAt: null } && source.UserId == userId;

    internal static bool DeviceIdentityRecoveryTargetAllowed(DeviceRecord source, DeviceRecord? target, string userId, KeyBundleRequest key, bool recordedRecovery)
        => DeviceIdentityRecoverySourceAllowed(source, userId) && ValidHistoryPublicKey(key.IdentityKey)
            && (target is null || (recordedRecovery && target.Id != source.Id && DeviceIdentityRecoverySourceAllowed(target, userId)
                && SameHistoryPublicKey(target.KeyBundle.IdentityKey, key.IdentityKey)));

    private static string DeviceIdentityRecoveryBinding(string sourceId, string targetId, string token)
        => $"SourceDevice={sourceId}; TargetDevice={targetId}; ProofHash={Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))}";

    private static bool SameHistoryPublicKey(string? left, string? right)
    {
        if (!ValidHistoryPublicKey(left) || !ValidHistoryPublicKey(right)) return false;
        using var a = System.Text.Json.JsonDocument.Parse(left!);
        using var b = System.Text.Json.JsonDocument.Parse(right!);
        return new[] { "kty", "crv", "x", "y" }.All(field => a.RootElement.GetProperty(field).GetString() == b.RootElement.GetProperty(field).GetString());
    }
}
