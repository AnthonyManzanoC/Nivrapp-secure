namespace Nivra.Api.Domain;

public sealed class AccountRecoveryChallenge
{
    public required string TokenHash { get; init; }
    public required string UserId { get; init; }
    public required string Purpose { get; init; }
    public required string Email { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public DateTimeOffset? ConsumedAt { get; set; }
}
