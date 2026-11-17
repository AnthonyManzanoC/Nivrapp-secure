namespace Nivra.Api.Domain;

/// <summary>Opaque root-encrypted history, independent of device lifetime. Never contains plaintext or ratchet state.</summary>
public sealed class AccountHistorySyncItem
{
    public long Id { get; set; }
    public required string UserId { get; init; }
    public required string MessageId { get; init; }
    public required string RootKey { get; init; }
    public required string EnvelopeJson { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
}
