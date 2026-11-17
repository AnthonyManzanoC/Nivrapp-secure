using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;
public static partial class EndpointExtensions
{
    public static void MapDeviceAuthorityEndpoints(this WebApplication app)
    {
        var routes = app.MapGroup("/devices/authority").RequireRateLimiting("auth");
        routes.MapGet("/", async Task<IResult>(HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) => {
            var user = http.GetCurrentUser(); if (user is null) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(await DeviceAuthorityPolicy.ReadAsync(db, user.UserId, clock.GetUtcNow(), ct));
        });
        routes.MapPost("/platform", async Task<IResult>(DevicePlatformDeclaration request, HttpContext http, NivraDbContext db,
            TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) => {
            var user = http.GetCurrentUser(); if (user is null) return Results.Unauthorized();
            if (request.V != 1 || request.DeviceId != user.DeviceId || request.RootKey?.Length != 87 || request.Signature?.Length != 88
                || !DeviceAuthorityPolicy.ValidPlatform(request.Platform)) return Results.BadRequest();
            return await CallCoordination.RunAsync(db, async () => {
                await using var tx = await CallCoordination.LockAsync(db, "account-identity:" + user.UserId, ct);
                var root = AccountIdentityPolicy.Read(await db.AccountIdentities.SingleOrDefaultAsync(row => row.UserId == user.UserId, ct));
                var device = await db.Devices.SingleOrDefaultAsync(row => row.Id == user.DeviceId && row.UserId == user.UserId && row.RevokedAt == null && row.IsTrusted, ct);
                var certificate = device is null ? null : AccountIdentityPolicy.Certificate(device);
                var hybrid = await db.Set<Nivra.Api.Domain.RatchetPilotDevice>().AsNoTracking().SingleOrDefaultAsync(row => row.DeviceId == user.DeviceId && row.UserId == user.UserId && row.AddressMode == 2, ct);
                if (root is null || device is null || certificate is null || root.RootKey != request.RootKey || certificate.RootKey != root.RootKey
                    || certificate.DeviceId != device.Id || certificate.LegacyKey != DeviceContinuityPolicy.Coordinates(device.KeyBundle.IdentityKey)
                    || hybrid is null || certificate.HybridKey != hybrid.IdentityKey
                    || !AccountIdentityPolicy.Verify(root.RootKey, AccountIdentityPolicy.DeviceStatement(user.UserId, certificate), certificate.Signature)
                    || !AccountIdentityPolicy.Verify(root.RootKey, DeviceAuthorityPolicy.Statement(user.UserId, request), request.Signature)) return Results.BadRequest();
                var changed = device.Platform != request.Platform || device.PlatformVerifiedAt is null;
                if (changed) { device.Platform = request.Platform; device.PlatformVerifiedAt = clock.GetUtcNow(); await db.SaveChangesAsync(ct); }
                await tx.CommitAsync(ct);
                if (changed) await hub.Clients.Group(GroupsFor.User(user.UserId)).SendAsync("device.listChanged", new { deviceId = device.Id, authorityChanged = true }, ct);
                http.Response.Headers.CacheControl = "no-store";
                return Results.Ok(await DeviceAuthorityPolicy.ReadAsync(db, user.UserId, clock.GetUtcNow(), ct));
            });
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(4096));
    }
}
