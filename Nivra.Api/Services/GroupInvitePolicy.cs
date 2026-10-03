using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public static class GroupInvitePolicy
{
    public static bool CanAdminister(ConversationRecord? conversation, string userId) =>
        conversation?.Type == ConversationType.Group && conversation.Participants.Any(p =>
            p.UserId == userId && p.RemovedAt == null && p.Role is ParticipantRole.Owner or ParticipantRole.Admin);

    public static bool CanRedeem(GroupInviteLink invite, ConversationRecord? conversation, string userId, DateTimeOffset now)
    {
        if (invite.RevokedAt != null || invite.ExpiresAt <= now || conversation?.Id != invite.ConversationId || !CanAdminister(conversation, invite.CreatorUserId)) return false;
        var member = conversation.Participants.FirstOrDefault(p => p.UserId == userId);
        if (member != null) return member.RemovedAt == null;
        return invite.Uses < invite.MaxUses;
    }
}
