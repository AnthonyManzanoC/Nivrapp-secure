using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Nivra.Api.Contracts;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;
namespace Nivra.Api.Endpoints;

public static class RatchetHybridEndpoints
{
    public static void MapRatchetHybridEndpoints(this WebApplication app)
    {
        var enabled = RatchetClientEndpoints.Enabled(app.Configuration);
        app.MapGet("/ratchet/olm/config", (HttpContext http) => http.GetCurrentUser() is null ? Results.Unauthorized() : Results.Ok(new { enabled, protocol = 5, suite = "NIVRA-PQXDH-MLKEM768-A256GCM-1" }));
        if (!enabled) return;
        var group = app.MapGroup("/ratchet/olm");
        group.AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            if (context.HttpContext.GetCurrentUser() is null) return Results.Unauthorized();
            try { return await next(context); }
            catch (RatchetPreKeyException error) { return RatchetPreKeyEndpoints.Failure(context.HttpContext, error); }
            catch (JsonException) { return Results.BadRequest(new { code = "invalid_ratchet_request" }); }
        });
        group.MapGet("/prekeys/status", async (HttpContext http, RatchetDirectoryService store, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; return Results.Ok(new { available = await store.AvailableAsync(user.UserId, user.DeviceId, ct) });
        });
        group.MapPost("/prekeys", async (HttpContext http, RatchetPreKeyStore store, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; var request = await RatchetPreKeyEndpoints.ReadBody<RatchetOlmPublishRequest>(http.Request, 131072, ct);
            return Results.Ok(new { added = await store.PublishOlmAsync(user.UserId, user.DeviceId, request.Bundles, ct) });
        });
        group.MapPost("/prekeys/consumed", async (HttpContext http, RatchetPreKeyStore store, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; var request = await RatchetPreKeyEndpoints.ReadBody<RatchetConsumedPreKeys>(http.Request, 8192, ct);
            await store.ConsumeOlmAsync(user.UserId, user.DeviceId, request.PreKeyIds, ct); return Results.NoContent();
        });
        group.MapPost("/directory", async (HttpContext http, RatchetDirectoryService store, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; var request = await RatchetPreKeyEndpoints.ReadBody<RatchetDeviceIdsRequest>(http.Request, 16384, ct);
            return Results.Ok(await store.DirectoryAsync(user.UserId, user.DeviceId, request.DeviceIds, ct, addressMode: 2));
        });
        group.MapPost("/bindings", async (HttpContext http, RatchetDirectoryService store, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; var request = await RatchetPreKeyEndpoints.ReadBody<RatchetBindingUploadRequest>(http.Request, 1048576, ct);
            await store.PublishBindingsAsync(user.UserId, user.DeviceId, request.Bindings, ct); return Results.NoContent();
        });
        group.MapPost("/bindings/request", async (HttpContext http, RatchetDirectoryService store, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; var request = await RatchetPreKeyEndpoints.ReadBody<RatchetDeviceIdsRequest>(http.Request, 16384, ct);
            await store.RequestBindingsAsync(user.UserId, user.DeviceId, request.DeviceIds, ct);
            foreach (var target in request.DeviceIds.Distinct()) await hub.Clients.Group(GroupsFor.Device(target)).SendAsync("ratchet.binding.requested", new { sourceDeviceId = user.DeviceId }, ct);
            return Results.NoContent();
        });
        group.MapGet("/bindings/pending", async (HttpContext http, RatchetDirectoryService store, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; return Results.Ok(await store.PendingBindingsAsync(user.UserId, user.DeviceId, ct));
        });
        group.MapPost("/devices/{deviceId}/prekey", async (string deviceId, HttpContext http, RatchetPreKeyStore store, CancellationToken ct) =>
        {
            var user = http.GetCurrentUser()!; var request = await RatchetPreKeyEndpoints.ReadBody<RatchetReserveRequest>(http.Request, 4096, ct);
            var result = await store.ReserveOlmAsync(user.UserId, user.DeviceId, deviceId, request.ConversationId, request.RequestId, ct);
            if (result is null) { http.Response.Headers.RetryAfter = "30"; return Results.Json(new { code = "ratchet_prekeys_unavailable" }, statusCode: 503); }
            return Results.Ok(result);
        });
    }
}
