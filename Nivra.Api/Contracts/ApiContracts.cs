using Nivra.Api.Domain;
using Nivra.Api.Security;

namespace Nivra.Api.Contracts;

public sealed record ApiError(string Code, string Message);

public sealed record RegisterRequest(
    string Alias,
    string Password,
    string DeviceName,
    KeyBundleRequest KeyBundle,
    string? DisplayName,
    string? Email,
    string? Phone);

public sealed record LoginRequest(
    string Alias,
    string Password,
    string DeviceName,
    KeyBundleRequest? KeyBundle);

public sealed record RefreshTokenRequest(string RefreshToken);

public sealed record AuthResponse(
    UserResponse User,
    DeviceResponse Device,
    TokenPair Tokens);

public sealed record UserResponse(
    string Id,
    string Alias,
    string? DisplayName,
    string? Email,
    string? Phone,
    string? Bio,
    string? ProfilePhotoDataUrl,
    bool IsDiscoverable,
    string PlanCode,
    PrivacySettings PrivacySettings,
    DateTimeOffset CreatedAt);

public sealed record PatchProfileRequest(
    string? DisplayName,
    string? Email,
    string? Phone,
    string? Bio,
    string? ProfilePhotoDataUrl,
    bool? IsDiscoverable);

public sealed record PhoneOtpStartRequest(string Phone);

public sealed record PhoneOtpStartResponse(DateTimeOffset ExpiresAt, string DeliveryHint);

public sealed record PhoneOtpVerifyRequest(
    string Phone,
    string Code,
    string DeviceName,
    KeyBundleRequest KeyBundle);

public sealed record FirebasePhoneVerifyRequest(
    string FirebaseToken,
    string DeviceName,
    KeyBundleRequest KeyBundle);

public sealed record PhoneOtpVerifyResponse(
    bool RequiresAlias,
    AuthResponse? Auth,
    string? PhoneSetupToken,
    DateTimeOffset? PhoneSetupExpiresAt,
    string? Phone);

public sealed record CompletePhoneAliasRequest(
    string PhoneSetupToken,
    string Alias,
    string? DisplayName,
    string DeviceName,
    KeyBundleRequest KeyBundle);

public sealed record QrLoginStartRequest(string DeviceName, KeyBundleRequest? KeyBundle, string? PublicKey);

public sealed record QrLoginStartResponse(string QrId, string Code, string SyncToken, string DeepLink, DateTimeOffset ExpiresAt);

public sealed record QrLoginAuthorizeRequest(string QrId, string Code, string? EncryptedPayload);

public sealed record QrLoginAuthorizedResponse(AuthResponse Auth, string EncryptedPayload);

public sealed record QrLoginStatusResponse(string Status, AuthResponse? Auth, string? EncryptedPayload);

public sealed record QrLinkAuthorizeRequest(string TargetConnectionId, string EncryptedPayload);

public sealed record KeyBundleRequest(
    string? IdentityKey,
    string? SignedPreKey,
    string? PreKeySignature,
    List<string>? OneTimePreKeys);

public sealed record DeviceResponse(
    string Id,
    string UserId,
    string Name,
    bool IsTrusted,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastSeenAt,
    DateTimeOffset? RevokedAt);

public sealed record LinkDeviceRequest(string DeviceName, KeyBundleRequest KeyBundle);

public sealed record PublicDeviceKeyResponse(
    string DeviceId,
    string DeviceName,
    KeyBundle KeyBundle,
    DateTimeOffset LastRotatedAt);

public sealed record PublicKeyDirectoryResponse(string UserId, string Alias, List<PublicDeviceKeyResponse> Devices);

public sealed record PublicKeyBatchRequest(List<string>? UserIds, List<string>? Aliases);

public sealed record CreateContactRequest(string Alias, string? NicknameCiphertext);

public sealed record ContactResponse(
    string UserId,
    string Alias,
    string? DisplayName,
    string? ProfilePhotoDataUrl,
    string? NicknameCiphertext,
    bool IsFavorite,
    DateTimeOffset CreatedAt);

public sealed record PatchContactRequest(bool? IsFavorite, string? NicknameCiphertext);

public sealed record UserSummaryResponse(
    string Id,
    string Alias,
    string? DisplayName,
    string? Bio,
    string? ProfilePhotoDataUrl,
    bool IsDiscoverable,
    bool IsContact,
    bool IsMutualContact,
    bool IsFavorite,
    string FriendshipState);

public sealed record DirectorySearchResponse(string Query, List<UserSummaryResponse> People);

public sealed record CreateFriendRequestRequest(string? Alias, string? UserId, string? Message);

public sealed record FriendRequestResponse(
    string Id,
    UserSummaryResponse From,
    UserSummaryResponse To,
    FriendRequestStatus Status,
    string? Message,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? RespondedAt);

public sealed record CreateConversationRequest(
    ConversationType Type,
    List<string> ParticipantUserIds,
    string? TitleCiphertext,
    PrivacySettings? PrivacySettings);

public sealed record PatchConversationRequest(string? TitleCiphertext, PrivacySettings? PrivacySettings);

public sealed record ConversationResponse(
    string Id,
    ConversationType Type,
    string? TitleCiphertext,
    PrivacySettings PrivacySettings,
    List<ParticipantResponse> Participants,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? LastMessageAt);

public sealed record ParticipantResponse(
    string UserId,
    ParticipantRole Role,
    bool CanInvite,
    bool CanChangePrivacy,
    DateTimeOffset JoinedAt,
    DateTimeOffset? RemovedAt);

public sealed record SendMessageRequest(
    string ClientMessageId,
    MessageKind Kind,
    List<RecipientCipherRequest> Recipients,
    string? EncryptedPolicy,
    DateTimeOffset? ExpiresAt,
    bool DeleteAfterRead);

public sealed record RecipientCipherRequest(
    string UserId,
    string DeviceId,
    string Ciphertext,
    string? Header,
    string? FileObjectId);

public sealed record MessageResponse(
    string Id,
    string ConversationId,
    string ClientMessageId,
    string SenderUserId,
    string SenderDeviceId,
    MessageKind Kind,
    List<RecipientCiphertext> Recipients,
    string? EncryptedPolicy,
    DateTimeOffset ServerReceivedAt,
    DateTimeOffset? ExpiresAt,
    bool DeleteAfterRead,
    List<DeliveryReceipt> Receipts);

public sealed record ReceiptRequest(ReceiptKind Kind);

public sealed record MessageSyncResponse(List<MessageResponse> Messages, DateTimeOffset SyncedAt);

public sealed record MessageSyncAckRequest(List<string> MessageIds);

public sealed record MessageSyncAckResponse(int Acknowledged, DateTimeOffset AcknowledgedAt);

public sealed record MessageDeletionResponse(
    string MessageId,
    string ConversationId,
    string Scope,
    DateTimeOffset DeletedAt);

public sealed record CreateFileRequest(
    long EncryptedSize,
    string? MimeTypeCiphertext,
    string? ClientSha256,
    List<string>? AllowedUserIds,
    DateTimeOffset? ExpiresAt,
    string? VaultRoomId);

public sealed record FileResponse(
    string Id,
    string OwnerUserId,
    long EncryptedSize,
    string? MimeTypeCiphertext,
    string? ClientSha256,
    FileState State,
    List<string> AllowedUserIds,
    DateTimeOffset CreatedAt,
    DateTimeOffset? UploadedAt,
    DateTimeOffset? ExpiresAt,
    string UploadUrl,
    string DownloadUrl);

public sealed record CreateVaultItemRequest(
    VaultItemKind Kind,
    string EncryptedMetadata,
    string? ParentId,
    string? FileObjectId);

public sealed record PatchVaultItemRequest(string? EncryptedMetadata, string? ParentId);

public sealed record VaultItemResponse(
    string Id,
    string? ParentId,
    string? FileObjectId,
    VaultItemKind Kind,
    string EncryptedMetadata,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record CreateStoryRequest(
    StoryVisibility Visibility,
    string EncryptedPayload,
    string? Caption,
    string? MediaFileObjectId,
    List<string>? AllowedUserIds,
    bool ViewOnce,
    int? DurationSeconds);

public sealed record StoryResponse(
    string Id,
    UserSummaryResponse Owner,
    StoryVisibility Visibility,
    string EncryptedPayload,
    string? Caption,
    string? MediaFileObjectId,
    List<string> AllowedUserIds,
    bool ViewOnce,
    bool ViewedByMe,
    int ViewCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt);

public sealed record CreateVaultRoomRequest(
    string Name,
    string? Pin,
    VaultAccessMode AccessMode,
    VaultRetentionMode RetentionMode,
    string? EncryptedWelcome,
    List<string>? InvitedUserIds,
    int? TtlSeconds);

public sealed record VaultRoomResponse(
    string Id,
    UserSummaryResponse Owner,
    string Name,
    VaultAccessMode AccessMode,
    VaultRetentionMode RetentionMode,
    string? EncryptedWelcome,
    List<VaultRoomMemberResponse> Members,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? ClosedAt);

public sealed record VaultRoomMemberResponse(
    string UserId,
    string Alias,
    string? DisplayName,
    string? ProfilePhotoDataUrl,
    ParticipantRole Role,
    VaultMemberStatus Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? JoinedAt,
    DateTimeOffset? LastSeenAt,
    DateTimeOffset? LeftAt);

public sealed record InviteVaultRoomRequest(List<string> UserIds);

public sealed record JoinVaultRoomRequest(string? Pin);

public sealed record StartCallRequest(CallType Type, string? ConversationId, List<string>? ParticipantUserIds);

public sealed record CallSignalRequest(string TargetUserId, string SignalType, string PayloadCiphertext);

public sealed record CallResponse(
    string Id,
    string? ConversationId,
    string InitiatorUserId,
    CallType Type,
    CallStatus Status,
    List<string> ParticipantUserIds,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt);

public sealed record PatchPrivacyRequest(
    bool? HideNotificationContent,
    bool? AllowForwarding,
    bool? AllowScreenshots,
    bool? ReadReceipts,
    int? DefaultMessageTtlSeconds,
    string? PrivacyPreset);

public sealed record RegisterPushTokenRequest(string Provider, string Token);

public sealed record PushTokenResponse(string Id, string Provider, DateTimeOffset CreatedAt, DateTimeOffset? RevokedAt, bool ServerReady);

public sealed record EntitlementsResponse(
    string PlanCode,
    long VaultStorageBytes,
    int MaxLinkedDevices,
    int MaxGroupParticipants,
    bool AdsEnabled,
    bool EncryptedBackupsEnabled,
    bool ProfessionalSpacesEnabled);

public sealed record AdCatalogResponse(string PrivacyModel, List<AdCreativeResponse> Ads);

public sealed record AdCreativeResponse(
    string Id,
    string Title,
    string Body,
    string Placement,
    string ClickUrl);

public sealed record RecordAdImpressionRequest(string CampaignId, string Placement);

public sealed record AdImpressionResponse(string CampaignId, string Placement, DateOnly Day, long Count);

public sealed record DeleteAccountRequest(string Confirmation);

public sealed record DeleteConversationRequest(bool RequestRemoteDelete, string? ReasonCiphertext);

public sealed record ChatScopeRequest(string? Scope);

public sealed record SyncBootstrapResponse(
    UserResponse User,
    List<DeviceResponse> Devices,
    List<ContactResponse> Contacts,
    List<ConversationResponse> Conversations,
    List<MessageResponse> Messages,
    List<MessageDeletionResponse> DeletedMessages,
    List<VaultItemResponse> VaultItems,
    List<FriendRequestResponse> FriendRequests,
    List<StoryResponse> Stories,
    List<VaultRoomResponse> VaultRooms,
    PrivacySettings PrivacySettings);
