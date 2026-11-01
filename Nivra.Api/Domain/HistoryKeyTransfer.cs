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

// Bounded, acknowledged ciphertext stream. No ratchet private state is transferred.
public sealed class HistoryArchiveStream
{
    public required string TransferId { get; init; }
    public required string SourceDeviceId { get; init; }
    public int NextSequence { get; set; }
    public int AcknowledgedSequence { get; set; } = -1;
    public bool Finished { get; set; }
    public DateTimeOffset LastActivityAt { get; set; }
}
public sealed class HistoryArchivePage
{
    public required string TransferId { get; init; }
    public required string SourceDeviceId { get; init; }
    public int Sequence { get; init; }
    public required string Header { get; init; }
    public required string Ciphertext { get; init; }
    public bool Final { get; init; }
}
