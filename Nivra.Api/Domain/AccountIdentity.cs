namespace Nivra.Api.Domain;

public sealed class AccountIdentityRecord
{
    public required string UserId { get; init; }
    public required string PublicJson { get; init; }
    public required string PasswordBackup { get; set; }
    public required string RecoveryBackup { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public int Revision { get; set; } = 1;
}
public sealed record AccountRootPublic(int V, string RootKey, string SourceDeviceId, string SourceHybrid, string SourceLegacy, string Endorsement);
public sealed record AccountDeviceCertificate(int V, string RootKey, string DeviceId, string LegacyKey, string HybridKey, string Signature);
public sealed record AccountIdentityBackup(AccountRootPublic Identity, string PasswordBackup, string RecoveryBackup, int Revision);
public sealed record SaveAccountIdentity(AccountRootPublic Identity, string PasswordBackup, string RecoveryBackup, string Signature, int Revision);
