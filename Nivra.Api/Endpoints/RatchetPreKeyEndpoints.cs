using System.Text.Json;
using Nivra.Api.Contracts;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public static class RatchetPreKeyEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { MaxDepth = 16 };

    public static void MapRatchetPreKeyPilotEndpoints(this WebApplication app)
    {
        // Opt-in repository trial only. This must not announce production v3
        // support, change /keys, or enable ratchet message delivery.
        if (!app.Configuration.GetValue<bool>("Ratchet:PreKeyPilotEnabled")) return;
        var group = app.MapGroup("/experimental/ratchet");
        group.MapPost("/prekeys", async Task<IResult> (HttpContext http, RatchetPreKeyStore store, CancellationToken ct) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            if (http.GetCurrentUser() is not { } current) return Results.Unauthorized();
            try
            {
                var request = await ReadBody<RatchetPublishRequest>(http.Request, 262144, ct);
                var added = await store.PublishAsync(current.UserId, current.DeviceId, request.Bundles, ct);
                return Results.Ok(new { added, pilot = true, productionMessagingEnabled = false });
            }
            catch (RatchetPreKeyException error) { return Failure(http, error); }
            catch (JsonException) { return Results.BadRequest(new { code = "invalid_prekey_request" }); }
        });
        group.MapPost("/devices/{deviceId}/prekey", async Task<IResult> (string deviceId, HttpContext http, RatchetPreKeyStore store, CancellationToken ct) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            if (http.GetCurrentUser() is not { } current) return Results.Unauthorized();
            try
            {
                var request = await ReadBody<RatchetReserveRequest>(http.Request, 4096, ct);
                var reservation = await store.ReserveAsync(current.UserId, current.DeviceId, deviceId, request.ConversationId, request.RequestId, ct);
                return reservation is null ? Results.Conflict(new { code = "prekeys_exhausted" }) : Results.Ok(reservation);
            }
            catch (RatchetPreKeyException error) { return Failure(http, error); }
            catch (JsonException) { return Results.BadRequest(new { code = "invalid_prekey_request" }); }
        });
    }

    private static IResult Failure(HttpContext http, RatchetPreKeyException error)
    {
        if (error.Status == 429) http.Response.Headers.RetryAfter = "60";
        return Results.Json(new { code = error.Code }, statusCode: error.Status);
    }

    private static async Task<T> ReadBody<T>(HttpRequest request, int limit, CancellationToken ct)
    {
        if (request.ContentLength.HasValue && request.ContentLength.Value > limit) throw new RatchetPreKeyException("prekey_request_too_large", 413);
        using var body = new MemoryStream();
        var buffer = new byte[4096];
        while (true)
        {
            var read = await request.Body.ReadAsync(buffer, ct);
            if (read == 0) break;
            if (body.Length + read > limit) throw new RatchetPreKeyException("prekey_request_too_large", 413);
            body.Write(buffer, 0, read);
        }
        body.Position = 0;
        return await JsonSerializer.DeserializeAsync<T>(body, Json, ct) ?? throw new JsonException("Missing request");
    }
}
