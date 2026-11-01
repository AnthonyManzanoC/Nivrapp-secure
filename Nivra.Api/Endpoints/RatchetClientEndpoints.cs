using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Nivra.Api.Contracts;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public static class RatchetClientEndpoints
{
    public static bool Enabled(IConfiguration configuration) => configuration.GetValue<bool>("Ratchet:Enabled");
    public static void MapRatchetClientEndpoints(this WebApplication app)
    {
        // Sending is enabled only when the deployment explicitly enables the
        // complete client protocol. Reading retained local v3 state is separate.
        app.MapGet("/ratchet/config", (HttpContext http) => http.GetCurrentUser() is null ? Results.Unauthorized() : Results.Ok(new { enabled = Enabled(app.Configuration), protocol = 3 }));
        if (!Enabled(app.Configuration)) return;
        var group = app.MapGroup("/ratchet");
        group.MapGet("/prekeys/status", (HttpContext http, RatchetDirectoryService store, CancellationToken ct) => Execute(http, async user => Results.Ok(new { available = await store.AvailableAsync(user.UserId, user.DeviceId, ct) })));
        group.MapPost("/prekeys", (HttpContext http, RatchetPreKeyStore store, CancellationToken ct) => Execute(http, async user =>
        {
            var request = await RatchetPreKeyEndpoints.ReadBody<RatchetPublishRequest>(http.Request, 262144, ct);
            if (request.Bundles is null || request.Bundles.Any(bundle => bundle.DeviceId != 1)) throw new RatchetPreKeyException("invalid_device_address", 400);
            return Results.Ok(new { added = await store.PublishAsync(user.UserId, user.DeviceId, request.Bundles, ct, deviceAddresses: true) });
        }));
        group.MapPost("/directory", (HttpContext http, RatchetDirectoryService store, CancellationToken ct) => Execute(http, async user =>
        {
            var request = await RatchetPreKeyEndpoints.ReadBody<RatchetDeviceIdsRequest>(http.Request, 16384, ct);
            return Results.Ok(await store.DirectoryAsync(user.UserId, user.DeviceId, request.DeviceIds, ct));
        }));
        group.MapPost("/bindings", (HttpContext http, RatchetDirectoryService store, CancellationToken ct) => Execute(http, async user =>
        {
            var request = await RatchetPreKeyEndpoints.ReadBody<RatchetBindingUploadRequest>(http.Request, 1048576, ct);
            await store.PublishBindingsAsync(user.UserId, user.DeviceId, request.Bindings, ct); return Results.NoContent();
        }));
        group.MapPost("/bindings/request", (HttpContext http, RatchetDirectoryService store, IHubContext<NivraHub> hub, CancellationToken ct) => Execute(http, async user =>
        {
            var request = await RatchetPreKeyEndpoints.ReadBody<RatchetDeviceIdsRequest>(http.Request, 16384, ct);
            await store.RequestBindingsAsync(user.UserId, user.DeviceId, request.DeviceIds, ct);
            foreach (var target in request.DeviceIds.Distinct(StringComparer.Ordinal)) await hub.Clients.Group(GroupsFor.Device(target)).SendAsync("ratchet.binding.requested", new { sourceDeviceId = user.DeviceId }, ct);
            return Results.NoContent();
        }));
        group.MapGet("/bindings/pending", (HttpContext http, RatchetDirectoryService store, CancellationToken ct) => Execute(http, async user => Results.Ok(await store.PendingBindingsAsync(user.UserId, user.DeviceId, ct))));
        group.MapPost("/devices/{deviceId}/prekey", (string deviceId, HttpContext http, RatchetPreKeyStore store, CancellationToken ct) => Execute(http, async user =>
        {
            var request = await RatchetPreKeyEndpoints.ReadBody<RatchetReserveRequest>(http.Request, 4096, ct);
            var result = await store.ReserveAsync(user.UserId, user.DeviceId, deviceId, request.ConversationId, request.RequestId, ct, deviceAddresses: true);
            if (result is null) { http.Response.Headers.RetryAfter = "30"; return Results.Json(new { code = "ratchet_prekeys_unavailable" }, statusCode: 503); }
            return Results.Ok(result);
        }));
    }
    private static async Task<IResult> Execute(HttpContext http, Func<CurrentUser, Task<IResult>> action)
    {
        http.Response.Headers.CacheControl = "no-store";
        if (http.GetCurrentUser() is not { } current) return Results.Unauthorized();
        try { return await action(current); }
        catch (RatchetPreKeyException error) { return RatchetPreKeyEndpoints.Failure(http, error); }
        catch (JsonException) { return Results.BadRequest(new { code = "invalid_ratchet_request" }); }
    }
}
