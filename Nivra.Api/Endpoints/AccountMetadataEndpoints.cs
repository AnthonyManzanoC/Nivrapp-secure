using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public sealed record AccountAppearanceResponse(string Icon, long Revision);
public sealed record UpdateAccountAppearance(string? Icon, long ExpectedRevision);
public sealed record BroadcastListResponse(string Id, string? EncryptedPayload, int RecipientCount, long Revision,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? DeletedAt);
public sealed record UpdateBroadcastList(string? EncryptedPayload, int RecipientCount, long ExpectedRevision);

public static partial class EndpointExtensions
{
    private const long MaxMetadataRevision = 9_007_199_254_740_990L;

    private static void MapAccountMetadataEndpoints(this WebApplication app)
    {
        app.MapGet("/account/appearance", async Task<IResult> (HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null || await MetadataDeviceAsync(db, current.UserId, current.DeviceId, ct) is null) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            var row = await db.Set<AccountAppearance>().AsNoTracking().SingleOrDefaultAsync(x => x.UserId == current.UserId, ct);
            return Results.Ok(new AccountAppearanceResponse(row?.Icon ?? "original", row?.Revision ?? 0));
        });

        app.MapPut("/account/appearance", async Task<IResult> (UpdateAccountAppearance body, HttpContext http, NivraDbContext db,
            TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null || await MetadataDeviceAsync(db, current.UserId, current.DeviceId, ct) is null) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            if (!ValidMetadataRevision(body.ExpectedRevision) || !ValidAppearanceIcon(body.Icon)) return Results.BadRequest(new { code = "invalid_appearance" });
            return await CallCoordination.RunAsync(db, async Task<IResult> () =>
            {
                await using var transaction = await LockRelationshipAsync(db, "account-appearance", current.UserId, ct);
                var row = await db.Set<AccountAppearance>().SingleOrDefaultAsync(x => x.UserId == current.UserId, ct);
                if ((row?.Revision ?? 0) != body.ExpectedRevision) return Results.Conflict(new { code = "appearance_changed", revision = row?.Revision ?? 0 });
                if (row is null) { row = new AccountAppearance { UserId = current.UserId }; db.Add(row); }
                row.Icon = body.Icon!; row.Revision = body.ExpectedRevision + 1; row.UpdatedAt = clock.GetUtcNow();
                await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct);
                var response = new AccountAppearanceResponse(row.Icon, row.Revision);
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("account.appearanceChanged", response, ct);
                return Results.Ok(response);
            });
        }).RequireRateLimiting("auth");

        app.MapGet("/broadcast-lists", async Task<IResult> (HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null || await MetadataDeviceAsync(db, current.UserId, current.DeviceId, ct) is null) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            var rows = await db.Set<BroadcastListRecord>().AsNoTracking().Where(x => x.UserId == current.UserId)
                .OrderBy(x => x.DeletedAt != null).ThenByDescending(x => x.UpdatedAt).ThenBy(x => x.Id).Take(200).ToListAsync(ct);
            return Results.Ok(new { lists = rows.Select(ToBroadcastListResponse).ToList() });
        });

        app.MapPut("/broadcast-lists/{id}", async Task<IResult> (string id, UpdateBroadcastList body, HttpContext http, NivraDbContext db,
            TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null || await MetadataDeviceAsync(db, current.UserId, current.DeviceId, ct) is not { } source) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            if (!ValidBroadcastListId(id) || !ValidMetadataRevision(body.ExpectedRevision) || body.RecipientCount is < 0 or > 256)
                return Results.BadRequest(new { code = "invalid_broadcast_list" });
            var recipients = ParseBroadcastEnvelope(body.EncryptedPayload, current.UserId, source.KeyBundle.IdentityKey);
            if (recipients is null) return Results.BadRequest(new { code = "invalid_broadcast_envelope" });
            return await CallCoordination.RunAsync(db, async Task<IResult> () =>
            {
                await using var transaction = await LockRelationshipAsync(db, "account-broadcast-lists", current.UserId, ct);
                var deviceIds = recipients.Select(x => x.DeviceId).ToList();
                var devices = await db.Devices.AsNoTracking().Where(device => device.UserId == current.UserId && deviceIds.Contains(device.Id)
                    && device.IsTrusted && device.RevokedAt == null).ToListAsync(ct);
                if (!ValidBroadcastDevices(recipients, devices, current.UserId)) return Results.BadRequest(new { code = "invalid_broadcast_destinations" });
                var row = await db.Set<BroadcastListRecord>().SingleOrDefaultAsync(x => x.UserId == current.UserId && x.Id == id, ct);
                if (row?.DeletedAt is not null || (row?.Revision ?? 0) != body.ExpectedRevision)
                    return Results.Conflict(new { code = row?.DeletedAt is not null ? "broadcast_list_deleted" : "broadcast_list_changed", revision = row?.Revision ?? 0, deletedAt = row?.DeletedAt });
                if (row is null)
                {
                    if (await db.Set<BroadcastListRecord>().CountAsync(x => x.UserId == current.UserId && x.DeletedAt == null, ct) >= 100)
                        return Results.Conflict(new { code = "broadcast_list_limit", limit = 100 });
                    row = new BroadcastListRecord { UserId = current.UserId, Id = id, CreatedAt = clock.GetUtcNow() }; db.Add(row);
                }
                row.EncryptedPayload = body.EncryptedPayload; row.RecipientCount = body.RecipientCount;
                row.Revision = body.ExpectedRevision + 1; row.UpdatedAt = clock.GetUtcNow();
                await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct);
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("broadcast.updated", new { row.Id, row.Revision }, ct);
                return Results.Ok(ToBroadcastListResponse(row));
            });
        }).RequireRateLimiting("auth").WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(2_200_000));

        app.MapDelete("/broadcast-lists/{id}", async Task<IResult> (string id, long expectedRevision, HttpContext http, NivraDbContext db,
            TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null || await MetadataDeviceAsync(db, current.UserId, current.DeviceId, ct) is null) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            if (!ValidBroadcastListId(id) || !ValidMetadataRevision(expectedRevision)) return Results.BadRequest(new { code = "invalid_broadcast_list" });
            return await CallCoordination.RunAsync(db, async Task<IResult> () =>
            {
                await using var transaction = await LockRelationshipAsync(db, "account-broadcast-lists", current.UserId, ct);
                var row = await db.Set<BroadcastListRecord>().SingleOrDefaultAsync(x => x.UserId == current.UserId && x.Id == id, ct);
                if (row is null) return Results.NotFound();
                if (row.Revision != expectedRevision) return Results.Conflict(new { code = "broadcast_list_changed", revision = row.Revision, deletedAt = row.DeletedAt });
                if (row.DeletedAt is null)
                {
                    row.DeletedAt = clock.GetUtcNow(); row.UpdatedAt = row.DeletedAt.Value;
                    row.Revision++; row.EncryptedPayload = null; row.RecipientCount = 0;
                    await db.SaveChangesAsync(ct);
                }
                await transaction.CommitAsync(ct);
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("broadcast.updated", new { row.Id, row.Revision }, ct);
                return Results.Ok(ToBroadcastListResponse(row));
            });
        }).RequireRateLimiting("auth");
    }

    private static IQueryable<DeviceRecord> MetadataDeviceQuery(NivraDbContext db, string user, string device) =>
        db.Devices.AsNoTracking().Where(x => x.Id == device && x.UserId == user && x.IsTrusted && x.RevokedAt == null &&
            db.Users.Any(owner => owner.Id == user && owner.DisabledAt == null));

    private static Task<DeviceRecord?> MetadataDeviceAsync(NivraDbContext db, string user, string device, CancellationToken ct) =>
        MetadataDeviceQuery(db, user, device).FirstOrDefaultAsync(ct);

    private static bool ValidMetadataRevision(long revision) => revision >= 0 && revision < MaxMetadataRevision;
    private static bool ValidAppearanceIcon(string? icon) => icon is "original" or "emerald" or "ivory";
    private static bool ValidBroadcastListId(string id) => id.StartsWith("bcl_", StringComparison.Ordinal) && Guid.TryParseExact(id[4..], "D", out var value) && value != Guid.Empty;
    private static BroadcastListResponse ToBroadcastListResponse(BroadcastListRecord row) => new(row.Id, row.DeletedAt is null ? row.EncryptedPayload : null,
        row.DeletedAt is null ? row.RecipientCount : 0, row.Revision, row.CreatedAt, row.UpdatedAt, row.DeletedAt);
}
