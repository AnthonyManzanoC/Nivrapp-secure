namespace Nivra.Api.Domain;

public sealed class AccountAppearance
{
    public string UserId { get; set; } = "";
    public string Icon { get; set; } = "original";
    public long Revision { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

// Names and destination user IDs exist only inside client ciphertext. Deleted
// records retain an opaque ID/revision tombstone so stale clients cannot revive it.
public sealed class BroadcastListRecord
{
    public string UserId { get; set; } = "";
    public string Id { get; set; } = "";
    public string? EncryptedPayload { get; set; }
    public int RecipientCount { get; set; }
    public long Revision { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}
