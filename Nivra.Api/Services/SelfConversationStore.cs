using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public static class SelfConversationStore
{
    public static Task<ConversationRecord> GetOrCreateAsync(NivraDbContext db, INivraStore store,
        string userId, DateTimeOffset now, CancellationToken ct) => CallCoordination.RunAsync(db, async () =>
    {
        await using var transaction = await CallCoordination.LockAsync(db, $"self-conversation:{userId}", ct);
        var conversations = await store.ConversationsForUserAsync(userId, ct);
        var existing = conversations.FirstOrDefault(conversation => conversation.Type == ConversationType.Direct
            && conversation.Participants.Count == 1
            && conversation.Participants[0].UserId == userId && conversation.Participants[0].RemovedAt is null);
        if (existing is not null)
        {
            await transaction.CommitAsync(ct);
            return existing;
        }
        var conversation = new ConversationRecord
        {
            Id = NivraIds.NewId("con"), Type = ConversationType.Direct, CreatedByUserId = userId,
            PrivacySettings = PrivacySettings.Default(), Settings = GroupSettings.Default(),
            CreatedAt = now, UpdatedAt = now,
        };
        conversation.Participants.Add(new ConversationParticipant
        {
            UserId = userId, Role = ParticipantRole.Owner, CanInvite = false,
            CanChangePrivacy = true, JoinedAt = now,
        });
        await store.AddConversationAsync(conversation, ct);
        await transaction.CommitAsync(ct);
        return conversation;
    });
}
