namespace Nivra.Api.Domain;

// Private account preference. It is never projected into the other account's
// conversation, contact or public profile DTOs.
public sealed class ContactBlockRecord
{
    public required string OwnerUserId { get; init; }
    public required string ContactUserId { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
}
