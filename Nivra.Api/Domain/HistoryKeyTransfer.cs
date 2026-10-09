namespace Nivra.Api.Domain;

// Only device public keys and opaque authenticated ciphertext reach the server.
public sealed class HistoryKeyTransfer
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = "";
    public string TargetDeviceId { get; set; } = "";
    public string TargetIdentityKey { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
}

public sealed class HistoryKeyTransferResponse
{
    public string Id { get; set; } = "";
    public string TransferId { get; set; } = "";
    public string SourceDeviceId { get; set; } = "";
    public string SourceIdentityKey { get; set; } = "";
    public string Header { get; set; } = "";
    public string Ciphertext { get; set; } = "";
}
