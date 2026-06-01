using Nivra.Api.Domain;

namespace Nivra.Api.Infrastructure;

public interface INivraStore
{
    Task<bool> TryAddUserAsync(UserAccount user, CancellationToken cancellationToken = default);
    Task<UserAccount?> FindUserByAliasAsync(string alias, CancellationToken cancellationToken = default);
    Task<UserAccount?> GetUserAsync(string userId, CancellationToken cancellationToken = default);
    Task<bool> UserExistsAsync(string userId, CancellationToken cancellationToken = default);
    Task<bool> UsersExistAsync(IEnumerable<string> userIds, CancellationToken cancellationToken = default);
    Task<List<UserAccount>> GetUsersAsync(IEnumerable<string> userIds, CancellationToken cancellationToken = default);

    Task AddDeviceAsync(DeviceRecord device, CancellationToken cancellationToken = default);
    Task<DeviceRecord?> GetDeviceAsync(string deviceId, CancellationToken cancellationToken = default);
    Task<List<DeviceRecord>> ActiveDevicesForUserAsync(string userId, CancellationToken cancellationToken = default);
    Task RevokeDeviceAsync(string userId, string deviceId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default);
    Task RevokeDevicesForUserAsync(string userId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default);

    Task AddSessionAsync(SessionRecord session, CancellationToken cancellationToken = default);
    Task<SessionRecord?> GetSessionAsync(string sessionId, CancellationToken cancellationToken = default);
    Task<SessionRecord?> FindSessionByRefreshHashAsync(string refreshTokenHash, DateTimeOffset now, CancellationToken cancellationToken = default);
    Task RevokeSessionAsync(string sessionId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default);
    Task RevokeSessionsForDeviceAsync(string deviceId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default);
    Task RevokeSessionsForUserAsync(string userId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default);

    Task<List<ContactRecord>> ContactsForUserAsync(string userId, CancellationToken cancellationToken = default);
    Task AddOrUpdateContactAsync(ContactRecord contact, CancellationToken cancellationToken = default);
    Task DeleteContactAsync(string ownerUserId, string contactUserId, CancellationToken cancellationToken = default);
    Task DeleteContactsTouchingUserAsync(string userId, CancellationToken cancellationToken = default);

    Task AddConversationAsync(ConversationRecord conversation, CancellationToken cancellationToken = default);
    Task<ConversationRecord?> GetConversationAsync(string conversationId, CancellationToken cancellationToken = default);
    Task<bool> IsActiveParticipantAsync(string conversationId, string userId, CancellationToken cancellationToken = default);
    Task<List<ConversationRecord>> ConversationsForUserAsync(string userId, CancellationToken cancellationToken = default);

    Task AddMessageAsync(MessageEnvelope message, CancellationToken cancellationToken = default);
    Task<MessageEnvelope?> GetMessageAsync(string messageId, CancellationToken cancellationToken = default);
    Task<List<MessageEnvelope>> PendingMessagesForDeviceAsync(string userId, string deviceId, DateTimeOffset now, CancellationToken cancellationToken = default);
    Task<List<MessageEnvelope>> MessagesForDeviceSinceAsync(string userId, string deviceId, DateTimeOffset since, DateTimeOffset now, int take, CancellationToken cancellationToken = default);
    Task<int> MarkMessagesDeliveredAsync(string userId, string deviceId, IEnumerable<string> messageIds, DateTimeOffset deliveredAt, CancellationToken cancellationToken = default);

    Task AddFileAsync(FileObject file, CancellationToken cancellationToken = default);
    Task<FileObject?> GetFileAsync(string fileId, CancellationToken cancellationToken = default);
    Task<List<FileObject>> FilesOwnedByUserAsync(string userId, CancellationToken cancellationToken = default);

    Task<List<VaultItem>> VaultItemsForUserAsync(string userId, CancellationToken cancellationToken = default);
    Task AddVaultItemAsync(VaultItem item, CancellationToken cancellationToken = default);
    Task<VaultItem?> GetVaultItemAsync(string itemId, CancellationToken cancellationToken = default);

    Task AddCallAsync(CallSession call, CancellationToken cancellationToken = default);
    Task<CallSession?> GetCallAsync(string callId, CancellationToken cancellationToken = default);

    Task AddPushTokenAsync(PushTokenRecord pushToken, CancellationToken cancellationToken = default);
    Task<PushTokenRecord?> GetPushTokenAsync(string pushTokenId, CancellationToken cancellationToken = default);
    Task<List<PushTokenRecord>> ActivePushTokensForUserAsync(string userId, CancellationToken cancellationToken = default);

    Task<List<AdCampaign>> ActiveAdCampaignsAsync(string? locale, string? region, DateTimeOffset now, CancellationToken cancellationToken = default);
    Task<bool> AdCampaignExistsAsync(string campaignId, CancellationToken cancellationToken = default);
    Task<AdImpressionAggregate> IncrementAdImpressionAsync(string campaignId, string placement, DateOnly day, CancellationToken cancellationToken = default);

    PlanEntitlements EntitlementsFor(UserAccount user);
    bool UserCanAccessFile(string userId, FileObject file);

    Task PurgeExpiredAsync(DateTimeOffset now, CancellationToken cancellationToken = default);
    Task AddAuditAsync(string? userId, string action, string? ipAddress, string? details, DateTimeOffset now, CancellationToken cancellationToken = default);
    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
