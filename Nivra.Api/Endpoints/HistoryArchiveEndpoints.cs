using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;
using Nivra.Api.Contracts;

namespace Nivra.Api.Endpoints;

[System.Text.Json.Serialization.JsonUnmappedMemberHandling(System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)]
public sealed record HistoryArchiveUpload(int Sequence, string Header, string Ciphertext, bool Final);
[System.Text.Json.Serialization.JsonUnmappedMemberHandling(System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)]
public sealed record HistoryArchiveAcknowledgement(int Sequence);

public static partial class EndpointExtensions
{
    public static void MapHistoryArchiveEndpoints(this WebApplication app)
    {
        if (!RatchetClientEndpoints.Enabled(app.Configuration)) return;
        var group = app.MapGroup("/devices/history-transfer/{id}/archive/{sourceDeviceId}");
        group.AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            if (context.HttpContext.GetCurrentUser() is null) return Results.Unauthorized();
            try { return await next(context); }
            catch (RatchetPreKeyException error) { return RatchetPreKeyEndpoints.Failure(context.HttpContext, error); }
            catch (System.Text.Json.JsonException) { return Results.BadRequest(new { code = "invalid_history_archive" }); }
        });
        group.MapGet("/", async Task<IResult> (string id, string sourceDeviceId, HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
            var approved = await ApprovedArchive(db, current, id, sourceDeviceId, clock.GetUtcNow(), ct);
            if (approved is null) return Results.NotFound();
            var stream = await db.Set<HistoryArchiveStream>().AsNoTracking().SingleOrDefaultAsync(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId, ct);
            var pages = await db.Set<HistoryArchivePage>().AsNoTracking().Where(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId).OrderBy(row => row.Sequence).Take(8).ToListAsync(ct);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { leaseExpiresAt = ArchiveLease(approved.Value.Request, stream), nextSequence = stream?.NextSequence ?? 0, acknowledgedSequence = stream?.AcknowledgedSequence ?? -1, finished = stream?.Finished ?? false,
                pages = current.DeviceId == sourceDeviceId ? [] : pages.Select(row => new { row.Sequence, row.Header, row.Ciphertext, row.Final }).ToArray() });
        });
        group.MapPost("/", async Task<IResult> (string id, string sourceDeviceId, HttpContext http, NivraDbContext db, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var body = await RatchetPreKeyEndpoints.ReadBody<HistoryArchiveUpload>(http.Request, 600000, ct);
            return await CallCoordination.RunAsync<IResult>(db, async () =>
            {
                var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
                if (current.DeviceId != sourceDeviceId) return Results.NotFound();
                if (body.Sequence is < 0 or > 1000000 || body.Ciphertext?.Length > 262144 || body.Header?.Length is not (> 0 and <= 262144)) return Results.BadRequest();
                await using var tx = await CallCoordination.LockAsync(db, $"history-archive:{id}:{sourceDeviceId}", ct);
                var approved = await ApprovedArchive(db, current, id, sourceDeviceId, clock.GetUtcNow(), ct); if (approved is null) return Results.NotFound();
                if (!await RatchetMessagePolicy.ValidAsync(db, current.UserId, current.DeviceId, $"history_{id}", ArchiveMessageId(id, sourceDeviceId, body.Sequence),
                    [new RecipientCipherRequest(current.UserId, approved.Value.Request.TargetDeviceId, body.Ciphertext!, body.Header, null)], ct)) return Results.BadRequest();
                using (var header = System.Text.Json.JsonDocument.Parse(body.Header))
                    if (header.RootElement.GetProperty("v").GetInt32() != 4) return Results.BadRequest();
                var stream = await db.Set<HistoryArchiveStream>().SingleOrDefaultAsync(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId, ct);
                if (stream is null) { stream = new() { TransferId = id, SourceDeviceId = sourceDeviceId, LastActivityAt = clock.GetUtcNow() }; db.Add(stream); }
                if (body.Sequence <= stream.AcknowledgedSequence) { await tx.CommitAsync(ct); return Results.NoContent(); }
                if (body.Sequence < stream.NextSequence)
                {
                    var previous = await db.Set<HistoryArchivePage>().SingleAsync(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId && row.Sequence == body.Sequence, ct);
                    await tx.CommitAsync(ct);
                    return previous.Header == body.Header && previous.Ciphertext == body.Ciphertext && previous.Final == body.Final ? Results.NoContent() : Results.Conflict();
                }
                if (body.Sequence != stream.NextSequence || stream.Finished) return Results.Conflict();
                if (stream.NextSequence - stream.AcknowledgedSequence > 8) { http.Response.Headers.RetryAfter = "2"; return Results.StatusCode(429); }
                db.Add(new HistoryArchivePage { TransferId = id, SourceDeviceId = sourceDeviceId, Sequence = body.Sequence, Header = body.Header, Ciphertext = body.Ciphertext!, Final = body.Final });
                stream.NextSequence++; stream.Finished = body.Final;
                await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
                await hub.Clients.Group(GroupsFor.Device(approved.Value.Request.TargetDeviceId)).SendAsync("history.available", new { id }, ct);
                return Results.NoContent();
            });
        });
        group.MapPost("/ack", async Task<IResult> (string id, string sourceDeviceId, HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var body = await RatchetPreKeyEndpoints.ReadBody<HistoryArchiveAcknowledgement>(http.Request, 4096, ct);
            return await CallCoordination.RunAsync<IResult>(db, async () =>
            {
                var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
                await using var tx = await CallCoordination.LockAsync(db, $"history-archive:{id}:{sourceDeviceId}", ct);
                var approved = await ApprovedArchive(db, current, id, sourceDeviceId, clock.GetUtcNow(), ct);
                if (approved is null || current.DeviceId != approved.Value.Request.TargetDeviceId) return Results.NotFound();
                var stream = await db.Set<HistoryArchiveStream>().SingleOrDefaultAsync(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId, ct);
                if (stream is null || body.Sequence < 0 || body.Sequence >= stream.NextSequence) return Results.BadRequest();
                stream.AcknowledgedSequence = Math.Max(body.Sequence, stream.AcknowledgedSequence);
                stream.LastActivityAt = clock.GetUtcNow();
                await db.Set<HistoryArchivePage>().Where(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId && row.Sequence <= stream.AcknowledgedSequence).ExecuteDeleteAsync(ct);
                await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); return Results.Ok(new { leaseExpiresAt = ArchiveLease(approved.Value.Request, stream) });
            });
        });
    }
    internal static string ArchiveMessageId(string id, string sourceDeviceId, int sequence) => $"archive_{id}_{sourceDeviceId}_{sequence}";
    private static DateTimeOffset ArchiveLease(HistoryKeyTransfer request, HistoryArchiveStream? stream)
    {
        var activityExpiry = stream?.LastActivityAt.AddMinutes(15) ?? request.ExpiresAt;
        var limit = request.CreatedAt.AddHours(24);
        return activityExpiry < limit ? activityExpiry : limit;
    }
    private static async Task<(HistoryKeyTransfer Request, DeviceRecord Source)?> ApprovedArchive(NivraDbContext db, CurrentUser current, string id, string sourceDeviceId, DateTimeOffset now, CancellationToken ct)
    {
        var request = await db.HistoryKeyTransfers.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id && row.UserId == current.UserId, ct);
        if (request is null || current.DeviceId != sourceDeviceId && current.DeviceId != request.TargetDeviceId) return null;
        var source = await db.Devices.AsNoTracking().SingleOrDefaultAsync(row => row.Id == sourceDeviceId, ct);
        var target = await db.Devices.AsNoTracking().SingleOrDefaultAsync(row => row.Id == request.TargetDeviceId, ct);
        if (source?.Id == request.TargetDeviceId || !HistoryTransferDeviceAllowed(source, current.UserId) || !HistoryTransferDeviceAllowed(target, current.UserId) || target!.KeyBundle.IdentityKey != request.TargetIdentityKey || !await db.Users.AnyAsync(user => user.Id == current.UserId && user.DisabledAt == null, ct)) return null;
        var stream = await db.Set<HistoryArchiveStream>().AsNoTracking().SingleOrDefaultAsync(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId, ct);
        if (ArchiveLease(request, stream) <= now) return null;
        if (!await db.HistoryKeyTransferResponses.AnyAsync(row => row.TransferId == id && row.SourceDeviceId == sourceDeviceId && row.SourceIdentityKey == source!.KeyBundle.IdentityKey, ct)) return null;
        return (request, source!);
    }
}
