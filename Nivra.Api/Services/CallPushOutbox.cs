using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public enum CallPushDelivery { Sent, Retry, Discard }

public static class CallPushOutbox
{
    public static readonly TimeSpan InvitationLifetime = TimeSpan.FromSeconds(75);
    public static readonly TimeSpan LeaseLifetime = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan SendBudget = TimeSpan.FromSeconds(10);

    /// <summary>Call creation and these rows are saved by the caller's existing database transaction.</summary>
    public static void Enqueue(NivraDbContext db, CallSession call)
    {
        foreach (var userId in call.ParticipantUserIds.Where(userId => userId != call.InitiatorUserId).Distinct(StringComparer.Ordinal))
        {
            if (db.CallPushOutbox.Local.Any(item => item.CallId == call.Id && item.RecipientUserId == userId)) continue;
            db.CallPushOutbox.Add(new CallPushOutboxItem
            {
                CallId = call.Id, RecipientUserId = userId, CreatedAt = call.StartedAt,
                ExpiresAt = call.StartedAt + InvitationLifetime, NextAttemptAt = call.StartedAt
            });
        }
    }

    public static Expression<Func<CallPushOutboxItem, bool>> Ready(DateTimeOffset now) => item =>
        item.CompletedAt == null && item.ExpiresAt > now && item.NextAttemptAt <= now &&
        (item.LeaseUntil == null || item.LeaseUntil <= now);

    public static bool ShouldSend(CallSession? call, CallPushOutboxItem item, DateTimeOffset now) =>
        call is not null && call.Id == item.CallId && (call.Status is CallStatus.Ringing or CallStatus.Active) && call.EndedAt is null &&
        item.CompletedAt == null && item.ExpiresAt > now && call.StartedAt + InvitationLifetime > now &&
        item.RecipientUserId != call.InitiatorUserId && call.ParticipantUserIds.Contains(item.RecipientUserId) &&
        !call.ParticipantSessions.ContainsKey(item.RecipientUserId);

    public static bool ShouldExpire(CallSession call, DateTimeOffset now, bool isGroup = false) => !isGroup && call.Status == CallStatus.Ringing &&
        call.EndedAt is null && call.StartedAt + InvitationLifetime <= now &&
        !call.ParticipantSessions.Keys.Any(userId => userId != call.InitiatorUserId);

    public static TimeSpan RetryDelay(int attempts) => TimeSpan.FromSeconds(Math.Min(15, Math.Pow(2, Math.Clamp(attempts, 1, 4))));

    public static IQueryable<CallPushOutboxItem> PendingRecipient(NivraDbContext db, string callId, string userId) =>
        db.CallPushOutbox.Where(item => item.CallId == callId && item.RecipientUserId == userId && item.CompletedAt == null);

    // Persist acknowledgement in the answer transaction. Leaving a group again
    // must not make that account's original invitation eligible for a retry.
    public static Task<int> AcknowledgeAsync(NivraDbContext db, string callId, string userId, DateTimeOffset now, CancellationToken ct) =>
        PendingRecipient(db, callId, userId).ExecuteUpdateAsync(update => update.SetProperty(item => item.CompletedAt, now), ct);

    public static async Task<CallPushDelivery> DispatchAsync(CallSession? call, CallPushOutboxItem item, DateTimeOffset now,
        Func<DateTimeOffset, CancellationToken, Task<bool>> send, CancellationToken cancellationToken, TimeSpan? sendBudget = null)
    {
        if (!ShouldSend(call, item, now)) return CallPushDelivery.Discard;
        var expires = item.ExpiresAt < call!.StartedAt + InvitationLifetime ? item.ExpiresAt : call.StartedAt + InvitationLifetime;
        var budget = expires - now;
        if (budget > (sendBudget ?? SendBudget)) budget = sendBudget ?? SendBudget;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(budget);
        try { return await send(expires, deadline.Token) ? CallPushDelivery.Sent : CallPushDelivery.Retry; }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return CallPushDelivery.Retry; }
        catch when (!cancellationToken.IsCancellationRequested) { return CallPushDelivery.Retry; }
    }

    public static Task<int> TryLeaseAsync(NivraDbContext db, string callId, string userId, string leaseId, DateTimeOffset now, CancellationToken ct) =>
        db.CallPushOutbox.Where(Ready(now)).Where(item => item.CallId == callId && item.RecipientUserId == userId)
            .ExecuteUpdateAsync(update => update.SetProperty(item => item.LeaseId, leaseId)
                .SetProperty(item => item.LeaseUntil, now + LeaseLifetime)
                .SetProperty(item => item.Attempts, item => item.Attempts + 1), ct);
}
