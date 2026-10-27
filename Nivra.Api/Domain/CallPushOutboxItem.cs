namespace Nivra.Api.Domain;

/// <summary>Durable routing metadata only; message and media keys never enter this queue.</summary>
public sealed class CallPushOutboxItem
{
    public required string CallId { get; init; }
    public required string RecipientUserId { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public int Attempts { get; set; }
    public string? LeaseId { get; set; }
    public DateTimeOffset? LeaseUntil { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}
