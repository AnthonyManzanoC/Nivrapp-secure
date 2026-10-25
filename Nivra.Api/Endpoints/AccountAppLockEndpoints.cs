using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;

namespace Nivra.Api.Endpoints;

public sealed record AppLockPinEnvelope(int V, string Alg, int Iterations, string Salt, string Iv, string Ciphertext);
public sealed record AccountAppLockResponse(string UserId, long Revision, bool Enabled, AppLockPinEnvelope? PinEnvelope, DateTimeOffset? UpdatedAt);
public sealed record UpdateAccountAppLock(long Revision, bool Enabled, AppLockPinEnvelope? PinEnvelope);

public static partial class EndpointExtensions
{
    private static readonly JsonSerializerOptions AppLockJson = new(JsonSerializerDefaults.Web);

    private static void MapAccountAppLockEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/account/app-lock");
        group.MapGet("", async Task<IResult> (HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null || !await AppLockDeviceAllowed(db, current.UserId, current.DeviceId, ct)) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            var settings = await db.Set<AccountAppLock>().AsNoTracking().SingleOrDefaultAsync(x => x.UserId == current.UserId, ct);
            return Results.Ok(ToAppLockResponse(current.UserId, settings));
        });

        group.MapPut("", async Task<IResult> (UpdateAccountAppLock body, HttpContext http, NivraDbContext db, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null || !await AppLockDeviceAllowed(db, current.UserId, current.DeviceId, ct)) return Results.Unauthorized();
            if (body.Revision < 0 || body.Revision >= 9_007_199_254_740_990L || body.Enabled && !ValidAppLockEnvelope(body.PinEnvelope))
                return Results.BadRequest(new { code = "invalid_app_lock" });
            var settings = await db.Set<AccountAppLock>().SingleOrDefaultAsync(x => x.UserId == current.UserId, ct);
            if ((settings?.Revision ?? 0) != body.Revision) return Results.Conflict(new { code = "app_lock_changed" });
            if (settings is null)
            {
                settings = new AccountAppLock { UserId = current.UserId };
                db.Add(settings);
            }
            settings.Revision = body.Revision + 1;
            settings.Enabled = body.Enabled;
            settings.PinEnvelopeJson = body.Enabled ? JsonSerializer.Serialize(body.PinEnvelope, AppLockJson) : null;
            settings.UpdatedAt = clock.GetUtcNow();
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException) { return Results.Conflict(new { code = "app_lock_changed" }); }
            catch (DbUpdateException error) when (error.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation })
            { return Results.Conflict(new { code = "app_lock_changed" }); }
            http.Response.Headers.CacheControl = "no-store";
            // The event contains no verifier. Each trusted client re-reads its
            // own account policy, including after a missed event/reconnection.
            await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("account.app-lock.updated", new { revision = settings.Revision }, ct);
            return Results.Ok(ToAppLockResponse(current.UserId, settings));
        }).RequireRateLimiting("auth");
    }

    private static Task<bool> AppLockDeviceAllowed(NivraDbContext db, string userId, string deviceId, CancellationToken ct) =>
        db.Devices.AsNoTracking().AnyAsync(x => x.Id == deviceId && x.UserId == userId && x.IsTrusted && x.RevokedAt == null, ct);

    private static AccountAppLockResponse ToAppLockResponse(string userId, AccountAppLock? settings) => new(userId,
        settings?.Revision ?? 0, settings?.Enabled ?? false,
        settings?.Enabled == true ? JsonSerializer.Deserialize<AppLockPinEnvelope>(settings.PinEnvelopeJson!, AppLockJson) : null,
        settings?.UpdatedAt);

    private static bool ValidAppLockEnvelope(AppLockPinEnvelope? envelope)
    {
        if (envelope is not { V: 1, Alg: "PBKDF2-SHA256+A256GCM", Iterations: >= 240_000 and <= 1_000_000 }) return false;
        try
        {
            return envelope.Salt.Length <= 32 && Convert.FromBase64String(envelope.Salt).Length == 16
                && envelope.Iv.Length <= 24 && Convert.FromBase64String(envelope.Iv).Length == 12
                && envelope.Ciphertext.Length is >= 64 and <= 2048 && Convert.FromBase64String(envelope.Ciphertext).Length is >= 48 and <= 1536;
        }
        catch (Exception error) when (error is FormatException or ArgumentNullException or NullReferenceException) { return false; }
    }
}
