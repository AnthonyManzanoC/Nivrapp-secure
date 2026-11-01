namespace Nivra.Api.Domain;

// Separate pilot tables. These records never replace the current key bundle.
public sealed class RatchetPilotDevice
{
    public required string DeviceId { get; init; }
    public required string UserId { get; init; }
    public required string IdentityKey { get; init; }
    public int SignalDeviceNumber { get; init; }
    public int RegistrationId { get; init; }
    // 0: account-name laboratory addresses; 1: unique Nivra device-name addresses.
    public int AddressMode { get; init; }
    public long HighWatermark { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
}

public sealed class RatchetDeviceBinding
{
    public required string SourceDeviceId { get; init; }
    public required string TargetDeviceId { get; init; }
    public required string TargetIdentity { get; set; }
    public required string Header { get; set; }
    public required string Ciphertext { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class RatchetBindingRequest
{
    public required string SourceDeviceId { get; init; }
    public required string TargetDeviceId { get; init; }
    public DateTimeOffset RequestedAt { get; set; }
}

public sealed class RatchetPilotPreKey
{
    public required string DeviceId { get; init; }
    public long PreKeyId { get; init; }
    public required string BundleJson { get; init; }
    public required string BundleHash { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public Guid? ClaimRequestId { get; set; }
    public string? ClaimantDeviceId { get; set; }
    public string? ConversationId { get; set; }
    public DateTimeOffset? ClaimedAt { get; set; }
}
