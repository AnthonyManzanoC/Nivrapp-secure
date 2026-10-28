using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Contracts;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Endpoints;

public static class ContactBlockEndpoints
{
    public sealed record ChangeBlockRequest(bool Blocked);
    public sealed record BlockResponse(string UserId, bool Blocked);

    public static void MapContactBlockEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/contacts");
        group.MapGet("/blocks", async Task<IResult> (HttpContext http, NivraDbContext db, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null) return Results.Unauthorized();
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(await ContactBlockPolicy.ForOwner(db, current.UserId).AsNoTracking()
                .OrderBy(row => row.ContactUserId).Select(row => row.ContactUserId).ToListAsync(ct));
        });
        group.MapPut("/{userId}/block", async Task<IResult> (string userId, ChangeBlockRequest request, HttpContext http,
            NivraDbContext db, IHubContext<NivraHub> hub, TimeProvider clock, PushNotificationService pushes, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null) return Results.Unauthorized();
            if (userId == current.UserId || !await db.Users.AnyAsync(row => row.Id == userId, ct)) return Results.NotFound();
            return await CallCoordination.RunAsync(db, async Task<IResult> () =>
            {
                // Serialize edits from two devices of this owner. The counterpart
                // is not notified, and cannot read or change the owner's rows.
                await using (var transaction = db.Database.IsRelational()
                    ? await CallCoordination.LockAsync(db, ContactBlockPolicy.LockKey(current.UserId, userId), ct) : null)
                {
                    var row = await ContactBlockPolicy.ForOwner(db, current.UserId).SingleOrDefaultAsync(row => row.ContactUserId == userId, ct);
                    if (request.Blocked && row is null) db.Set<ContactBlockRecord>().Add(new() { OwnerUserId = current.UserId, ContactUserId = userId, CreatedAt = clock.GetUtcNow() });
                    if (!request.Blocked && row is not null) db.Set<ContactBlockRecord>().Remove(row);
                    await db.SaveChangesAsync(ct);
                    if (transaction is not null) await transaction.CommitAsync(ct);
                }
                // Release the pair lock before taking call locks: answering uses
                // call -> pair too. New starts must now fail their pair check.
                // Once committed, finish closing the existing media even if the
                // client navigates away and cancels its HTTP request.
                if (request.Blocked) await EndDirectCallsAsync(db, current.UserId, userId, hub, pushes, clock);
                await hub.Clients.Group(GroupsFor.User(current.UserId)).SendAsync("contacts.blocksChanged", new { }, ct);
                http.Response.Headers.CacheControl = "no-store";
                return Results.Ok(new BlockResponse(userId, request.Blocked));
            });
        });
    }

    private static async Task EndDirectCallsAsync(NivraDbContext db, string owner, string target,
        IHubContext<NivraHub> hub, PushNotificationService pushes, TimeProvider clock)
    {
        var candidates = await db.Calls.AsNoTracking()
            .Where(call => call.EndedAt == null && (call.Status == CallStatus.Ringing || call.Status == CallStatus.Active) &&
                (call.InitiatorUserId == owner || call.InitiatorUserId == target))
            .ToListAsync(CancellationToken.None);
        foreach (var candidate in candidates.Where(call => call.ParticipantUserIds.Count == 2 && call.ParticipantUserIds.Contains(owner) && call.ParticipantUserIds.Contains(target)))
        {
            CallResponse? ended = null;
            await using (var transaction = db.Database.IsRelational()
                ? await CallCoordination.LockAsync(db, $"call:{candidate.Id}", CancellationToken.None) : null)
            {
                if (db.Database.IsRelational()) await ContactBlockPolicy.LockWithinTransactionAsync(db, owner, target, CancellationToken.None);
                // A concurrent unblock, departure or shared group must not let
                // this operation terminate someone else's ongoing call.
                if (!await ContactBlockPolicy.ForOwner(db, owner).AnyAsync(row => row.ContactUserId == target)) continue;
                var call = await db.Calls.FirstOrDefaultAsync(row => row.Id == candidate.Id);
                if (call is null || call.EndedAt is not null || call.ParticipantUserIds.Count != 2 ||
                    !call.ParticipantUserIds.Contains(owner) || !call.ParticipantUserIds.Contains(target)) continue;
                if (call.ConversationId is not null && await db.Conversations.AnyAsync(row => row.Id == call.ConversationId && row.Type == ConversationType.Group)) continue;
                var now = clock.GetUtcNow();
                call.Status = CallStatus.Ended; call.EndedAt = now; call.ParticipantSessions.Clear();
                var notices = await db.CallPushOutbox.Where(row => row.CallId == call.Id && row.CompletedAt == null).ToListAsync();
                foreach (var notice in notices) { notice.CompletedAt = now; notice.LeaseId = null; notice.LeaseUntil = null; }
                await db.SaveChangesAsync();
                if (transaction is not null) await transaction.CommitAsync();
                ended = new CallResponse(call.Id, call.ConversationId, call.InitiatorUserId, call.Type, call.Status,
                    call.ParticipantUserIds.ToList(), call.StartedAt, call.EndedAt, call.InitiatorDeviceId, call.InitiatorSessionId,
                    new(call.ParticipantSessions, StringComparer.Ordinal), call.MediaEncryption);
            }
            foreach (var recipient in ended!.ParticipantUserIds)
            {
                await hub.Clients.Group(GroupsFor.User(recipient)).SendAsync("call.ended", ended, CancellationToken.None);
                // This also clears a background Android ringing notification.
                // Delivery failures cannot roll back the persisted closure.
                using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await pushes.SendCallEndedAsync(recipient, ended.ConversationId, ended.Id, owner, ended.Type, budget.Token); }
                catch (Exception) { /* Real-time and durable call state reconcile on the next wake. */ }
            }
        }
    }
}
