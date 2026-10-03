namespace Nivra.Api.Domain;

public sealed class GroupInviteLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ConversationId { get; set; } = "";
    public string CreatorUserId { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public int MaxUses { get; set; } = 25;
    public int Uses { get; set; }
}
