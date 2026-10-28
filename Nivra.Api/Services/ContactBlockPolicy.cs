using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public static class ContactBlockPolicy
{
    public static string LockKey(string first, string second) => "contact-block:" + JsonSerializer.Serialize(new[] { first, second }.Order(StringComparer.Ordinal));

    public static Task LockWithinTransactionAsync(NivraDbContext db, string first, string second, CancellationToken ct) =>
        db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({LockKey(first, second)}, 0))", ct);

    public static IQueryable<ContactBlockRecord> ForOwner(NivraDbContext db, string owner) =>
        db.Set<ContactBlockRecord>().Where(row => row.OwnerUserId == owner);

    public static Task<bool> BetweenAsync(NivraDbContext db, string first, string second, CancellationToken ct) =>
        db.Set<ContactBlockRecord>().AnyAsync(row =>
            row.OwnerUserId == first && row.ContactUserId == second ||
            row.OwnerUserId == second && row.ContactUserId == first, ct);

    public static Task<bool> BlocksConversationAsync(NivraDbContext db, ConversationRecord conversation, string actor, CancellationToken ct)
    {
        if (conversation.Type != ConversationType.Direct) return Task.FromResult(false);
        var others = conversation.Participants.Where(person => person.RemovedAt is null && person.UserId != actor).Select(person => person.UserId).ToArray();
        return db.Set<ContactBlockRecord>().AnyAsync(row =>
            row.OwnerUserId == actor && others.Contains(row.ContactUserId) ||
            row.ContactUserId == actor && others.Contains(row.OwnerUserId), ct);
    }

    public static async Task<bool> BlocksCallAsync(NivraDbContext db, CallSession call, CancellationToken ct)
    {
        if (call.ParticipantUserIds.Count != 2) return false;
        if (call.ConversationId is not null && await db.Conversations.AnyAsync(row => row.Id == call.ConversationId && row.Type == ConversationType.Group, ct)) return false;
        var pair = call.ParticipantUserIds.ToArray();
        return await BetweenAsync(db, pair[0], pair[1], ct);
    }

    // Recheck queued notices at delivery, not only when the message/call was
    // created. A newly blocked contact must not ring from an older outbox row.
    public static async Task<bool> SuppressPushAsync(NivraDbContext db, string recipient, IReadOnlyDictionary<string, string> data, CancellationToken ct)
    {
        data.TryGetValue("type", out var type);
        if (type is not ("message" or "incoming_call" or "missed_call" or "conversation" or "friend_request")) return false;
        var sender = data.GetValueOrDefault("senderUserId") ?? data.GetValueOrDefault("callerUserId");
        if (string.IsNullOrWhiteSpace(sender) || sender == recipient) return false;
        var conversationId = data.GetValueOrDefault("conversationId");
        if (!string.IsNullOrEmpty(conversationId) && await db.Conversations.AnyAsync(row => row.Id == conversationId && row.Type == ConversationType.Group, ct)) return false;
        return await BetweenAsync(db, recipient, sender, ct);
    }
}
