namespace Nivra.Api.Domain;

// The announcement conversation is the canonical membership/role directory.
// All existing device encryption, group permissions and history rules apply.
public sealed class CommunityRecord
{
    public required string Id { get; init; }
    public string Description { get; set; } = "";
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class CommunityGroupRecord
{
    public required string CommunityId { get; init; }
    public required string ConversationId { get; init; }
    public DateTimeOffset LinkedAt { get; init; }
}
