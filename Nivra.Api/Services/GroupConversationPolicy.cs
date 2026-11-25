using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public static class GroupConversationPolicy
{
    public static bool IsAdmin(ConversationParticipant participant) =>
        participant.RemovedAt is null && participant.Role is ParticipantRole.Owner or ParticipantRole.Admin;

    public static void RemoveParticipant(ConversationRecord conversation, ConversationParticipant participant, DateTimeOffset now)
    {
        participant.RemovedAt = now;
        participant.Role = ParticipantRole.Member;
        participant.CanInvite = false;
        participant.CanChangePrivacy = false;
        conversation.UpdatedAt = now;

        if (conversation.Type != ConversationType.Group || conversation.Participants.Any(member => member.RemovedAt is null && member.Role == ParticipantRole.Owner)) return;
        var successor = conversation.Participants.Where(member => member.RemovedAt is null)
            .OrderByDescending(IsAdmin).ThenBy(member => member.JoinedAt).ThenBy(member => member.UserId, StringComparer.Ordinal).FirstOrDefault();
        if (successor is null) return;
        successor.Role = ParticipantRole.Owner;
        successor.CanInvite = true;
        successor.CanChangePrivacy = true;
    }

    public static Task LockRowAsync(NivraDbContext db, string conversationId, CancellationToken ct) =>
        db.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM public.conversations WHERE \"Id\" = {conversationId} FOR UPDATE", ct);

    public static async Task LockRowsAsync(NivraDbContext db, IEnumerable<string> conversationIds, CancellationToken ct)
    {
        foreach (var id in conversationIds.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
            await LockRowAsync(db, id, ct);
    }

    public static async Task<IDbContextTransaction?> BeginMutationAsync(NivraDbContext db, string conversationId, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql()) return null;
        var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            await LockRowAsync(db, conversationId, ct);
            return transaction;
        }
        catch
        {
            await transaction.DisposeAsync();
            throw;
        }
    }
}
