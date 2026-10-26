using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    private static string? VisibleContactPhone(UserAccount? owner, string viewerId, bool mutual) =>
        owner is not null && (owner.Id == viewerId || mutual) ? owner.Phone : null;

    private static long RelationshipLockKey(string first, string second)
    {
        var pair = new[] { first, second }.Order(StringComparer.Ordinal).ToArray();
        return BinaryPrimitives.ReadInt64BigEndian(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(pair))));
    }

    private static async Task<IDbContextTransaction> LockRelationshipAsync(NivraDbContext db, string first, string second, CancellationToken token)
    {
        var transaction = await db.Database.BeginTransactionAsync(token);
        try
        {
            // A transaction-scoped PostgreSQL lock serializes both directions,
            // including contact edits, across API instances without deleting
            // historical requests or requiring a new schema/index.
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock({RelationshipLockKey(first, second)})", token);
            return transaction;
        }
        catch { await transaction.DisposeAsync(); throw; }
    }

    private static IQueryable<FriendRequestRecord> PendingFriendRequestsForViewer(IQueryable<FriendRequestRecord> requests, string viewerId)
    {
        var pending = requests.Where(request => request.Status == FriendRequestStatus.Pending && (request.FromUserId == viewerId || request.ToUserId == viewerId)
            && !requests.Any(closed => (closed.Status == FriendRequestStatus.Accepted || closed.Status == FriendRequestStatus.Rejected)
                && closed.UpdatedAt >= request.CreatedAt
                && ((closed.FromUserId == request.FromUserId && closed.ToUserId == request.ToUserId)
                    || (closed.FromUserId == request.ToUserId && closed.ToUserId == request.FromUserId))));
        return pending.Where(request => !pending.Any(older =>
            (older.FromUserId == viewerId ? older.ToUserId : older.FromUserId) == (request.FromUserId == viewerId ? request.ToUserId : request.FromUserId) &&
            (older.CreatedAt < request.CreatedAt || older.CreatedAt == request.CreatedAt && string.Compare(older.Id, request.Id) < 0)))
            .OrderByDescending(request => request.UpdatedAt).ThenBy(request => request.Id);
    }

    private static bool CanRespondToFriendRequest(FriendRequestRecord request, string actor, FriendRequestStatus next) =>
        next == FriendRequestStatus.Cancelled ? request.FromUserId == actor :
        (next is FriendRequestStatus.Accepted or FriendRequestStatus.Rejected) && request.ToUserId == actor;

    private static bool CanTransitionFriendRequest(FriendRequestRecord request, FriendRequestStatus next) =>
        request.Status == FriendRequestStatus.Pending || request.Status == next;

    private static IQueryable<UserAccount> DirectoryCandidates(IQueryable<UserAccount> users, string viewerId, string query)
    {
        var alias = NivraNumbers.NormalizeAlias(query);
        var number = NivraNumbers.Normalize(query);
        return users.Where(user => user.DisabledAt == null && user.Id != viewerId)
            .Where(user => user.IsDiscoverable || user.Alias == alias || user.Id == query || (number != null && user.NivraNumber == number))
            .Where(user => number == null || user.NivraNumber == number || user.Alias == alias || user.Id == query);
    }

    private sealed record ProfileVisibilityUpdate(string UserId, string? ProfilePhotoDataUrl, string? Phone);

    private static ProfileVisibilityUpdate ProfileVisibilityFor(UserAccount owner, string viewerId, bool ownerSavedViewer, bool viewerSavedOwner) =>
        new(owner.Id, VisibleProfilePhoto(owner, viewerId, ownerSavedViewer), VisibleContactPhone(owner, viewerId, ownerSavedViewer && viewerSavedOwner));

    private static async Task CloseDuplicateFriendRequestsAsync(NivraDbContext db, FriendRequestRecord chosen, DateTimeOffset now, CancellationToken token)
    {
        var duplicates = await db.FriendRequests.Where(request => request.Id != chosen.Id && request.Status == FriendRequestStatus.Pending &&
            ((request.FromUserId == chosen.FromUserId && request.ToUserId == chosen.ToUserId) ||
             (request.FromUserId == chosen.ToUserId && request.ToUserId == chosen.FromUserId))).ToListAsync(token);
        foreach (var duplicate in duplicates)
        {
            duplicate.Status = FriendRequestStatus.Cancelled;
            duplicate.UpdatedAt = now;
            duplicate.RespondedAt = now;
        }
    }

    private static async Task<IResult> RespondToFriendRequestAsync(string id, FriendRequestStatus next, HttpContext http,
        NivraDbContext db, TimeProvider clock, IHubContext<NivraHub> hub, CancellationToken token)
    {
        var current = http.GetCurrentUser();
        if (current is null) return Results.Unauthorized();
        var snapshot = await db.FriendRequests.AsNoTracking().FirstOrDefaultAsync(request => request.Id == id, token);
        if (snapshot is null || !CanRespondToFriendRequest(snapshot, current.UserId, next)) return Results.NotFound();
        await using var transaction = await LockRelationshipAsync(db, snapshot.FromUserId, snapshot.ToUserId, token);
        var request = await db.FriendRequests.FirstOrDefaultAsync(candidate => candidate.Id == id, token);
        if (request is null || !CanRespondToFriendRequest(request, current.UserId, next)) return Results.NotFound();
        if (!CanTransitionFriendRequest(request, next))
            return Results.Conflict(new { code = "friend_request_closed" });
        if (request.Status == FriendRequestStatus.Pending)
        {
            var now = clock.GetUtcNow();
            request.Status = next; request.UpdatedAt = now; request.RespondedAt = now;
            if (next == FriendRequestStatus.Accepted)
            {
                await UpsertContactAsync(db, request.FromUserId, request.ToUserId, now, token);
                await UpsertContactAsync(db, request.ToUserId, request.FromUserId, now, token);
            }
            await CloseDuplicateFriendRequestsAsync(db, request, now, token);
            await db.SaveChangesAsync(token);
        }
        await transaction.CommitAsync(token);
        await NotifyFriendRequestChangedAsync(db, hub, request, "friend.updated", token);
        if (next == FriendRequestStatus.Accepted)
            await NotifyRelationshipChangedAsync(db, hub, request.FromUserId, request.ToUserId, token);
        http.Response.Headers.CacheControl = "no-store";
        return Results.Ok(await ToFriendRequestResponseAsync(request, current.UserId, db, token));
    }

    private static async Task NotifyFriendRequestChangedAsync(NivraDbContext db, IHubContext<NivraHub> hub,
        FriendRequestRecord request, string method, CancellationToken token)
    {
        foreach (var viewer in new[] { request.FromUserId, request.ToUserId }.Distinct(StringComparer.Ordinal))
        {
            // A DTO projected for the actor includes their self-only photo.
            // Project independently for each receiving account, on every device.
            var response = await ToFriendRequestResponseAsync(request, viewer, db, token);
            await hub.Clients.Group(GroupsFor.User(viewer)).SendAsync(method, response, token);
        }
    }

    private static async Task NotifyRelationshipChangedAsync(NivraDbContext db, IHubContext<NivraHub> hub,
        string first, string second, CancellationToken token)
    {
        await NotifyUsers(hub, [first, second], "contacts.updated", new { });
        await NotifyProfileUpdatedAsync(db, hub, first, token, [second]);
        await NotifyProfileUpdatedAsync(db, hub, second, token, [first]);
    }
}
