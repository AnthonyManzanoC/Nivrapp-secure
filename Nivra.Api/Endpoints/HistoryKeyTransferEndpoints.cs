using System.Text.Json;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;

namespace Nivra.Api.Endpoints;

public sealed record SealedHistoryKeyResponse(string Header, string Ciphertext);

public static partial class EndpointExtensions
{
    private static void MapHistoryKeyTransferEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/devices/history-transfer");
        group.MapPost("/", async Task<IResult> (HttpContext http, NivraDbContext db, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
            var target = await db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == current.DeviceId, ct);
            if (!HistoryTransferDeviceAllowed(target, current.UserId)) return Results.Unauthorized();
            var now = clock.GetUtcNow();
            await db.HistoryKeyTransfers.Where(x => x.UserId == current.UserId && x.ExpiresAt <= now).ExecuteDeleteAsync(ct);
            var request = await db.HistoryKeyTransfers.FirstOrDefaultAsync(x => x.UserId == current.UserId && x.TargetDeviceId == current.DeviceId && x.TargetIdentityKey == target!.KeyBundle.IdentityKey && x.ExpiresAt > now, ct);
            if (request is null)
            {
                if (await db.HistoryKeyTransfers.CountAsync(x => x.UserId == current.UserId && x.ExpiresAt > now, ct) >= 32) return Results.StatusCode(429);
                request = new HistoryKeyTransfer { UserId = current.UserId, TargetDeviceId = current.DeviceId, TargetIdentityKey = target!.KeyBundle.IdentityKey!, CreatedAt = now, ExpiresAt = now.AddMinutes(15) };
                db.HistoryKeyTransfers.Add(request); await db.SaveChangesAsync(ct);
            }
            http.Response.Headers.CacheControl = "no-store";
            await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("history.requested", new { request.Id }, ct);
            return Results.Ok(new { request.Id, request.UserId, request.TargetDeviceId, request.ExpiresAt });
        }).RequireRateLimiting("auth");

        group.MapGet("/pending", async Task<IResult> (HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
            var source = await db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == current.DeviceId, ct);
            if (!HistoryTransferDeviceAllowed(source, current.UserId)) return Results.Unauthorized();
            var now = clock.GetUtcNow();
            var pending = await db.HistoryKeyTransfers.AsNoTracking().Where(x => x.UserId == current.UserId && x.TargetDeviceId != current.DeviceId && x.ExpiresAt > now).OrderBy(x => x.CreatedAt).Take(32).ToListAsync(ct);
            var targetIds = pending.Select(x => x.TargetDeviceId).ToList();
            var targets = await db.Devices.AsNoTracking().Where(x => targetIds.Contains(x.Id) && x.UserId == current.UserId && x.IsTrusted && x.RevokedAt == null).ToDictionaryAsync(x => x.Id, ct);
            var pendingIds = pending.Select(x => x.Id).ToList();
            var answered = await db.HistoryKeyTransferResponses.AsNoTracking().Where(x => x.SourceDeviceId == current.DeviceId && pendingIds.Contains(x.TransferId)).Select(x => x.TransferId).ToListAsync(ct);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(pending.Where(x => !answered.Contains(x.Id) && targets.TryGetValue(x.TargetDeviceId, out var target) && HistoryTransferAllowed(x, source, target, now)).Select(x => new { x.Id, x.UserId, x.TargetDeviceId, x.TargetIdentityKey, targetDeviceName = targets[x.TargetDeviceId].Name, x.ExpiresAt }));
        });

        group.MapPost("/{id}/response", async Task<IResult> (string id, SealedHistoryKeyResponse body, HttpContext http, NivraDbContext db, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
            var request = await db.HistoryKeyTransfers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == current.UserId, ct);
            if (request is null) return Results.NotFound();
            var source = await db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == current.DeviceId, ct);
            var target = await db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == request.TargetDeviceId, ct);
            if (!HistoryTransferAllowed(request, source, target, clock.GetUtcNow())) return Results.NotFound();
            if (!ValidHistoryTransferEnvelope(body, source!.KeyBundle.IdentityKey!)) return Results.BadRequest(new { code = "invalid_history_envelope" });
            var responseId = $"{id}:{current.DeviceId}";
            if (!await db.HistoryKeyTransferResponses.AnyAsync(x => x.Id == responseId, ct))
            {
                db.HistoryKeyTransferResponses.Add(new HistoryKeyTransferResponse { Id = responseId, TransferId = id, SourceDeviceId = current.DeviceId, SourceIdentityKey = source.KeyBundle.IdentityKey!, Header = body.Header, Ciphertext = body.Ciphertext });
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException error) when (error.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation }) { /* Idempotent response from two browser tabs. */ }
            }
            await hub.Clients.Group(GroupsFor.Device(request.TargetDeviceId)).SendAsync("history.available", new { request.Id }, ct);
            return Results.NoContent();
        }).RequireRateLimiting("auth");

        group.MapGet("/{id}", async Task<IResult> (string id, HttpContext http, NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser(); if (current is null) return Results.Unauthorized();
            var request = await db.HistoryKeyTransfers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == current.UserId && x.TargetDeviceId == current.DeviceId, ct);
            var target = await db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == current.DeviceId, ct);
            if (request is null || request.ExpiresAt <= clock.GetUtcNow() || !HistoryTransferDeviceAllowed(target, current.UserId) || target!.KeyBundle.IdentityKey != request.TargetIdentityKey) return Results.NotFound();
            var replies = await db.HistoryKeyTransferResponses.AsNoTracking().Where(x => x.TransferId == id).ToListAsync(ct);
            var sourceIds = replies.Select(x => x.SourceDeviceId).ToList();
            var sources = await db.Devices.AsNoTracking().Where(x => sourceIds.Contains(x.Id) && x.UserId == current.UserId && x.IsTrusted && x.RevokedAt == null).ToDictionaryAsync(x => x.Id, ct);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { request.Id, request.UserId, request.TargetDeviceId, request.TargetIdentityKey, request.ExpiresAt, responses = replies.Where(x => sources.TryGetValue(x.SourceDeviceId, out var source) && source.KeyBundle.IdentityKey == x.SourceIdentityKey).Select(x => new { x.SourceDeviceId, x.SourceIdentityKey, x.Header, x.Ciphertext }) });
        });
    }

    internal static bool HistoryTransferDeviceAllowed(DeviceRecord? device, string userId) => device is { IsTrusted: true, RevokedAt: null } && device.UserId == userId && ValidHistoryPublicKey(device.KeyBundle.IdentityKey);
    internal static bool HistoryTransferAllowed(HistoryKeyTransfer request, DeviceRecord? source, DeviceRecord? target, DateTimeOffset now) => request.ExpiresAt > now && source?.Id != request.TargetDeviceId && HistoryTransferDeviceAllowed(source, request.UserId) && HistoryTransferDeviceAllowed(target, request.UserId) && target!.Id == request.TargetDeviceId && target.KeyBundle.IdentityKey == request.TargetIdentityKey;
    private static bool ValidHistoryPublicKey(string? json)
    {
        try
        {
            using var key = JsonDocument.Parse(json ?? ""); var root = key.RootElement;
            var x = root.GetProperty("x").GetString() ?? ""; var y = root.GetProperty("y").GetString() ?? "";
            if (root.GetProperty("kty").GetString() != "EC" || root.GetProperty("crv").GetString() != "P-256" || root.TryGetProperty("d", out _) || !Regex.IsMatch(x, "^[A-Za-z0-9_-]{43}$") || !Regex.IsMatch(y, "^[A-Za-z0-9_-]{43}$")) return false;
            byte[] Decode(string part) => Convert.FromBase64String(part.Replace('-', '+').Replace('_', '/') + "=");
            using var point = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = Decode(x), Y = Decode(y) } });
            return true;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or CryptographicException or ArgumentException or PlatformNotSupportedException) { return false; }
    }
    internal static bool ValidHistoryTransferEnvelope(SealedHistoryKeyResponse body, string sourceKey)
    {
        if (body.Header?.Length is not (> 0 and <= 4096) || body.Ciphertext?.Length is not (> 0 and <= 512 * 1024)) return false;
        try
        {
            using var header = JsonDocument.Parse(body.Header);
            if (header.RootElement.GetProperty("v").GetInt32() != 1 || header.RootElement.GetProperty("alg").GetString() != "ECDH-P256-A256GCM") return false;
            using var source = JsonDocument.Parse(sourceKey);
            var sender = header.RootElement.GetProperty("senderPublicKey");
            if (!ValidHistoryPublicKey(sender.GetRawText())) return false;
            foreach (var field in new[] { "kty", "crv", "x", "y" }) if (sender.GetProperty(field).GetString() != source.RootElement.GetProperty(field).GetString()) return false;
            return Convert.FromBase64String(header.RootElement.GetProperty("iv").GetString()!).Length == 12 && Convert.FromBase64String(body.Ciphertext).Length >= 16;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentNullException) { return false; }
    }
}
