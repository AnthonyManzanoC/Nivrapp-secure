namespace Nivra.Api.Domain;

/// <summary>Durable routing metadata; no message plaintext, media or keys are retained.</summary>
public sealed class MessagePushOutboxItem
{
    public required string MessageId { get; init; }
    public required string RecipientUserId { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public int Attempts { get; set; }
    public string? LeaseId { get; set; }
    public DateTimeOffset? LeaseUntil { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    // IDs of opaque push-token records only. Successful destinations survive
    // a worker restart so a slow later device cannot be starved by earlier ones.
    public string CompletedPushTokenIdsJson { get; set; } = "[]";
}
