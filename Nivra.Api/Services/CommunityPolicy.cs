using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public static class CommunityPolicy
{
    public const int MaxGroups = 50;
    public const int MaxMembers = 512;
    public static bool IsMember(ConversationRecord? conversation, string userId) =>
        conversation?.Type == ConversationType.Group && conversation.Participants.Any(p => p.UserId == userId && p.RemovedAt == null);
    public static bool IsAdmin(ConversationRecord? conversation, string userId) => GroupInvitePolicy.CanAdminister(conversation, userId);
    public static bool CanLink(ConversationRecord? parent, ConversationRecord? child, string userId) =>
        parent != null && child != null && parent.Id != child.Id && IsAdmin(parent, userId) && IsAdmin(child, userId);
    public static bool CanJoin(ConversationRecord? parent, ConversationRecord? child, string userId) =>
        IsMember(parent, userId) && child?.Type == ConversationType.Group &&
        !child.Participants.Any(p => p.UserId == userId && p.RemovedAt != null);
}
