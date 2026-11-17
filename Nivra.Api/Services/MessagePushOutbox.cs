using System.Linq.Expressions;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public enum MessagePushDelivery { Sent, Retry, Discard }

public static class MessagePushOutbox
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(1);
    public static readonly TimeSpan LeaseLifetime = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan SendBudget = TimeSpan.FromSeconds(10);

    /// <summary>Persisted atomically with the encrypted message, including on explicit caller transactions.</summary>
    public static void Enqueue(NivraDbContext db, MessageEnvelope message)
    {
        var expires = message.ServerReceivedAt + Lifetime;
        if (message.ExpiresAt is { } ttl && ttl < expires) expires = ttl;
        foreach (var userId in message.Recipients.Where(row => row.UserId != message.SenderUserId)
                     .Select(row => row.UserId).Distinct(StringComparer.Ordinal))
        {
            if (db.MessagePushOutbox.Local.Any(row => row.MessageId == message.Id && row.RecipientUserId == userId)) continue;
            db.MessagePushOutbox.Add(new MessagePushOutboxItem
            {
                MessageId = message.Id, RecipientUserId = userId, CreatedAt = message.ServerReceivedAt,
                ExpiresAt = expires, NextAttemptAt = message.ServerReceivedAt
            });
        }
    }

    public static Expression<Func<MessagePushOutboxItem, bool>> Ready(DateTimeOffset now) => row =>
        row.CompletedAt == null && row.ExpiresAt > now && row.NextAttemptAt <= now &&
        (row.LeaseUntil == null || row.LeaseUntil <= now);

    public static bool ShouldSend(MessageEnvelope? message, MessagePushOutboxItem row, DateTimeOffset now) =>
        message is not null && message.Id == row.MessageId && row.CompletedAt == null && row.ExpiresAt > now &&
        (message.ExpiresAt == null || message.ExpiresAt > now) && row.RecipientUserId != message.SenderUserId &&
        message.Recipients.Any(recipient => recipient.UserId == row.RecipientUserId) &&
        !message.Receipts.Any(receipt => receipt.UserId == row.RecipientUserId && (receipt.ReadAt != null || receipt.DeletedAt != null));

    public static TimeSpan RetryDelay(int attempts) => TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, Math.Clamp(attempts, 1, 9))));

    public static HashSet<string> CompletedDestinations(MessagePushOutboxItem row)
    {
        try { return (JsonSerializer.Deserialize<string[]>(row.CompletedPushTokenIdsJson) ?? [])
            .Where(id => !string.IsNullOrWhiteSpace(id) && id.Length <= 64).ToHashSet(StringComparer.Ordinal); }
        catch (JsonException) { return new(StringComparer.Ordinal); }
    }

    public static Task<int> TryLeaseAsync(NivraDbContext db, string messageId, string userId, string leaseId, DateTimeOffset now, CancellationToken ct) =>
        db.MessagePushOutbox.Where(Ready(now)).Where(row => row.MessageId == messageId && row.RecipientUserId == userId)
            .ExecuteUpdateAsync(update => update.SetProperty(row => row.LeaseId, leaseId)
                .SetProperty(row => row.LeaseUntil, now + LeaseLifetime).SetProperty(row => row.Attempts, row => row.Attempts + 1), ct);

    public static async Task<MessagePushDelivery> DispatchAsync(MessageEnvelope? message, MessagePushOutboxItem row, DateTimeOffset now,
        Func<CancellationToken, Task<bool>> send, CancellationToken ct, TimeSpan? sendBudget = null)
    {
        if (!ShouldSend(message, row, now)) return MessagePushDelivery.Discard;
        var budget = row.ExpiresAt - now;
        if (budget > (sendBudget ?? SendBudget)) budget = sendBudget ?? SendBudget;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(budget);
        try { return await send(deadline.Token) ? MessagePushDelivery.Sent : MessagePushDelivery.Retry; }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return MessagePushDelivery.Retry; }
        catch when (!ct.IsCancellationRequested) { return MessagePushDelivery.Retry; }
    }
}
