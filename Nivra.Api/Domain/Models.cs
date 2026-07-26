namespace Nivra.Api.Domain;

public static class NivraIds
{
    public static string NewId(string prefix) => $"{prefix}_{Guid.NewGuid():N}";
}

public enum ConversationType
{
    Direct,
    Group
}

public enum MessageKind
{
    Text,
    Image,
    Video,
    Audio,
    Document,
    System
}

public enum ParticipantRole
{
    Owner,
    Admin,
    Member
}

public enum ReceiptKind
{
    Delivered,
    Read,
    Deleted
}

public enum FileState
{
    Reserved,
    Uploaded,
    Deleted
}

public enum VaultItemKind
{
    Folder,
    File,
    Note
}

public enum CallType
{
    Voice,
    Video
}

public enum CallStatus
{
    Ringing,
    Active,
    Ended,
    Missed,
    Failed
}

public enum FriendRequestStatus
{
    Pending,
    Accepted,
    Rejected,
    Cancelled
}

public enum StoryVisibility
{
    PublicWorld,
    Contacts,
    MutualContacts,
    CloseFriends,
    SelectedUsers
}

public enum VaultAccessMode
{
    PinOnly,
    InviteOnly,
    WaitingRoom
}

public enum VaultRetentionMode
{
    Persistent,
    BurnOnExit,
    ExpiresAfterTtl
}

public enum VaultMemberStatus
{
    Invited,
    Waiting,
    Active,
    Rejected,
    Left
}

public sealed class UserAccount
{
    public required string Id { get; init; }
    public required string Alias { get; set; }
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public string? PhoneHash { get; set; }
    public bool RequiresAlias { get; set; }
    public string? Bio { get; set; }
    public string? ProfilePhotoDataUrl { get; set; }
    public bool IsDiscoverable { get; set; } = true;
    public bool AllowStoryReposts { get; set; } = true;
    public string PlanCode { get; set; } = "free";
    public required PasswordHash PasswordHash { get; init; }
    public PrivacySettings PrivacySettings { get; set; } = PrivacySettings.Default();
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DisabledAt { get; set; }
}

public sealed class PlanEntitlements
{
    public required string PlanCode { get; init; }
    public long VaultStorageBytes { get; init; }
    public int MaxLinkedDevices { get; init; }
    public int MaxGroupParticipants { get; init; }
    public bool AdsEnabled { get; init; }
    public bool EncryptedBackupsEnabled { get; init; }
    public bool ProfessionalSpacesEnabled { get; init; }
}

public sealed class PasswordHash
{
    public PasswordHash()
    {
    }

    public PasswordHash(string algorithm, int iterations, string salt, string hash)
    {
        Algorithm = algorithm;
        Iterations = iterations;
        Salt = salt;
        Hash = hash;
    }

    public string Algorithm { get; set; } = string.Empty;
    public int Iterations { get; set; }
    public string Salt { get; set; } = string.Empty;
    public string Hash { get; set; } = string.Empty;
}

public sealed class KeyBundle
{
    public string? IdentityKey { get; set; }
    public string? SignedPreKey { get; set; }
    public string? PreKeySignature { get; set; }
    public List<string> OneTimePreKeys { get; set; } = [];
    public DateTimeOffset LastRotatedAt { get; set; }
}

public sealed class DeviceRecord
{
    public required string Id { get; init; }
    public required string UserId { get; init; }
    public required string Name { get; set; }
    public string? HardwareId { get; set; }
    public KeyBundle KeyBundle { get; set; } = new();
    public bool IsTrusted { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? LastSeenAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

public sealed class SessionRecord
{
    public required string Id { get; init; }
    public required string UserId { get; init; }
    public required string DeviceId { get; init; }
    public required string RefreshTokenHash { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? CreatedIp { get; init; }
    public string? UserAgent { get; init; }
}

public sealed class ContactRecord
{
    public required string Id { get; init; }
    public required string OwnerUserId { get; init; }
    public required string ContactUserId { get; init; }
    public string? NicknameCiphertext { get; set; }
    public bool IsFavorite { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
}

public sealed class UserContactHash
{
    public required string UserId { get; init; }
    public required string ContactPhoneHash { get; init; }
}

public sealed class FriendRequestRecord
{
    public required string Id { get; init; }
    public required string FromUserId { get; init; }
    public required string ToUserId { get; init; }
    public FriendRequestStatus Status { get; set; }
    public string? Message { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? RespondedAt { get; set; }
}

public sealed class PrivacySettings
{
    public bool HideNotificationContent { get; set; } = true;
    public bool AllowForwarding { get; set; } = false;
    public bool AllowScreenshots { get; set; } = false;
    public bool ReadReceipts { get; set; } = true;
    public int? DefaultMessageTtlSeconds { get; set; }
    public string PrivacyPreset { get; set; } = "private";
    public string ProfilePhotoVisibility { get; set; } = "contacts";

    public static PrivacySettings Default() => new();
}

public sealed class GroupSettings
{
    public string EditInfo { get; set; } = "admins";
    public string SendMessages { get; set; } = "all";
    public string AddMembers { get; set; } = "admins";

    public static GroupSettings Default() => new();
}

public sealed class ConversationRecord
{
    public required string Id { get; init; }
    public ConversationType Type { get; set; }
    public string? TitleCiphertext { get; set; }
    public string? GroupName { get; set; }
    public string? GroupAvatar { get; set; }
    public required string CreatedByUserId { get; init; }
    public PrivacySettings PrivacySettings { get; set; } = PrivacySettings.Default();
    public GroupSettings Settings { get; set; } = GroupSettings.Default();
    public List<ConversationParticipant> Participants { get; } = [];
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? LastMessageAt { get; set; }
}

public sealed class ConversationParticipant
{
    public required string UserId { get; init; }
    public ParticipantRole Role { get; set; }
    public bool CanInvite { get; set; }
    public bool CanChangePrivacy { get; set; }
    public DateTimeOffset JoinedAt { get; init; }
    public DateTimeOffset? RemovedAt { get; set; }
}

public sealed class MessageEnvelope
{
    public required string Id { get; init; }
    public required string ConversationId { get; init; }
    public required string ClientMessageId { get; init; }
    public required string SenderUserId { get; init; }
    public required string SenderDeviceId { get; init; }
    public MessageKind Kind { get; set; }
    public List<RecipientCiphertext> Recipients { get; set; } = [];
    public string? EncryptedPolicy { get; set; }
    public DateTimeOffset ServerReceivedAt { get; init; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public bool DeleteAfterRead { get; set; }
    public List<DeliveryReceipt> Receipts { get; set; } = [];
}

public sealed class RecipientCiphertext
{
    public required string UserId { get; init; }
    public required string DeviceId { get; init; }
    public required string Ciphertext { get; init; }
    public string? Header { get; init; }
    public string? FileObjectId { get; init; }
}

public sealed class DeliveryReceipt
{
    public required string UserId { get; init; }
    public required string DeviceId { get; init; }
    public DateTimeOffset? DeliveredAt { get; set; }
    public DateTimeOffset? ReadAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

public sealed class FileObject
{
    public required string Id { get; init; }
    public required string OwnerUserId { get; init; }
    public required string StorageKey { get; init; }
    public string? VaultRoomId { get; set; }
    public long EncryptedSize { get; set; }
    public string? MimeTypeCiphertext { get; set; }
    public string? ClientSha256 { get; set; }
    public FileState State { get; set; }
    public HashSet<string> AllowedUserIds { get; set; } = new(StringComparer.Ordinal);
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? UploadedAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
}

public sealed class VaultItem
{
    public required string Id { get; init; }
    public required string UserId { get; init; }
    public string? ParentId { get; set; }
    public string? FileObjectId { get; set; }
    public VaultItemKind Kind { get; set; }
    public required string EncryptedMetadata { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

public sealed class StoryRecord
{
    public required string Id { get; init; }
    public required string OwnerUserId { get; init; }
    public StoryVisibility Visibility { get; set; }
    public string TargetType { get; set; } = "contacts";
    public string? TargetId { get; set; }
    public required string EncryptedPayload { get; set; }
    public string? Caption { get; set; }
    public string? MediaFileObjectId { get; set; }
    public HashSet<string> AllowedUserIds { get; set; } = new(StringComparer.Ordinal);
    public HashSet<string> ViewedByUserIds { get; set; } = new(StringComparer.Ordinal);
    public List<StoryViewEvent> ViewEvents { get; set; } = [];
    public List<StoryReactionRecord> Reactions { get; set; } = [];
    public List<StoryCommentRecord> Comments { get; set; } = [];
    public string? OriginalStoryId { get; set; }
    public string? OriginalAuthorId { get; set; }
    public bool ViewOnce { get; set; }
    public bool AllowReposts { get; set; } = true;
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

public sealed class StoryViewEvent
{
    public required string UserId { get; set; }
    public DateTimeOffset ViewedAt { get; set; }
}

public sealed class StoryReactionRecord
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public required string Emoji { get; set; }
    public DateTimeOffset ReactedAt { get; set; }
}

public sealed class StoryCommentRecord
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public string? MessageId { get; set; }
    public DateTimeOffset CommentedAt { get; set; }
}

public sealed class VaultRoom
{
    public required string Id { get; init; }
    public required string OwnerUserId { get; init; }
    public required string Name { get; set; }
    public PasswordHash? PinHash { get; set; }
    public VaultAccessMode AccessMode { get; set; }
    public VaultRetentionMode RetentionMode { get; set; }
    public string? EncryptedWelcome { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }
}

public sealed class VaultRoomMember
{
    public required string Id { get; init; }
    public required string VaultRoomId { get; init; }
    public required string UserId { get; init; }
    public VaultMemberStatus Status { get; set; }
    public ParticipantRole Role { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? JoinedAt { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
    public DateTimeOffset? LeftAt { get; set; }
}

public sealed class VaultRoomInvite
{
    public required string Id { get; init; }
    public required string VaultRoomId { get; init; }
    public required string CreatedByUserId { get; init; }
    public required string CodeHash { get; set; }
    public bool RequireApproval { get; set; }
    public int MaxUses { get; set; }
    public int Uses { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

public sealed class CallSession
{
    public required string Id { get; init; }
    public string? ConversationId { get; set; }
    public required string InitiatorUserId { get; init; }
    public CallType Type { get; set; }
    public CallStatus Status { get; set; }
    public HashSet<string> ParticipantUserIds { get; set; } = new(StringComparer.Ordinal);
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? EndedAt { get; set; }
}

public sealed class CallSignalRecord
{
    public required string Id { get; init; }
    public required string CallId { get; init; }
    public required string FromUserId { get; init; }
    public string? FromDeviceId { get; init; }
    public required string TargetUserId { get; init; }
    public required string SignalType { get; init; }
    public required string PayloadCiphertext { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
}

public sealed class PushTokenRecord
{
    public required string Id { get; init; }
    public required string UserId { get; set; }
    public required string DeviceId { get; set; }
    public required string Provider { get; set; }
    public required string TokenHash { get; set; }
    public string? TokenCiphertext { get; set; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? RevokedAt { get; set; }
}

public sealed class AdCampaign
{
    public required string Id { get; init; }
    public required string Title { get; set; }
    public required string Body { get; set; }
    public required string Placement { get; set; }
    public string? Locale { get; set; }
    public string? Region { get; set; }
    public required string ClickUrl { get; set; }
    public DateTimeOffset StartsAt { get; init; }
    public DateTimeOffset EndsAt { get; init; }
    public bool IsActive { get; set; }
}

public sealed class AdImpressionAggregate
{
    public required string Id { get; init; }
    public required string CampaignId { get; init; }
    public required string Placement { get; init; }
    public required DateOnly Day { get; init; }
    public long Count { get; set; }
}

public sealed class SecurityAuditEvent
{
    public required string Id { get; init; }
    public string? UserId { get; init; }
    public required string Action { get; init; }
    public string? IpAddress { get; init; }
    public string? Details { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
}
