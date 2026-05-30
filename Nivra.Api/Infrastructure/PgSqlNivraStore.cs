using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;

namespace Nivra.Api.Infrastructure;

public sealed class PgSqlNivraStore(NivraDbContext db) : INivraStore
{
    public async Task<bool> TryAddUserAsync(UserAccount user, CancellationToken cancellationToken = default)
    {
        user.Alias = NormalizeAlias(user.Alias);
        db.Users.Add(user);

        try
        {
            await db.SaveChangesAsync(cancellationToken);
            return true;
        }
        catch (DbUpdateException)
        {
            db.ChangeTracker.Clear();
            return false;
        }
    }

    public Task<UserAccount?> FindUserByAliasAsync(string alias, CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeAlias(alias);
        return db.Users.FirstOrDefaultAsync(user => user.Alias == normalized, cancellationToken);
    }

    public Task<UserAccount?> GetUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.Users.FirstOrDefaultAsync(user => user.Id == userId, cancellationToken);
    }

    public Task<bool> UserExistsAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.Users.AnyAsync(user => user.Id == userId && user.DisabledAt == null, cancellationToken);
    }

    public async Task<bool> UsersExistAsync(IEnumerable<string> userIds, CancellationToken cancellationToken = default)
    {
        var distinct = userIds.Distinct(StringComparer.Ordinal).ToList();
        var count = await db.Users.CountAsync(user => distinct.Contains(user.Id) && user.DisabledAt == null, cancellationToken);
        return count == distinct.Count;
    }

    public Task<List<UserAccount>> GetUsersAsync(IEnumerable<string> userIds, CancellationToken cancellationToken = default)
    {
        var ids = userIds.Distinct(StringComparer.Ordinal).ToList();
        return db.Users.Where(user => ids.Contains(user.Id)).ToListAsync(cancellationToken);
    }

    public async Task AddDeviceAsync(DeviceRecord device, CancellationToken cancellationToken = default)
    {
        db.Devices.Add(device);
        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<DeviceRecord?> GetDeviceAsync(string deviceId, CancellationToken cancellationToken = default)
    {
        return db.Devices.FirstOrDefaultAsync(device => device.Id == deviceId, cancellationToken);
    }

    public Task<List<DeviceRecord>> ActiveDevicesForUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.Devices
            .Where(device => device.UserId == userId && device.RevokedAt == null)
            .OrderBy(device => device.CreatedAt)
            .ToListAsync(cancellationToken);
    }

    public async Task RevokeDeviceAsync(string userId, string deviceId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        var device = await db.Devices.FirstOrDefaultAsync(candidate => candidate.Id == deviceId && candidate.UserId == userId, cancellationToken);
        if (device is null)
        {
            return;
        }

        device.RevokedAt = revokedAt;
        await RevokeSessionsForDeviceAsync(deviceId, revokedAt, cancellationToken);
    }

    public async Task RevokeDevicesForUserAsync(string userId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        var devices = await db.Devices.Where(device => device.UserId == userId).ToListAsync(cancellationToken);
        foreach (var device in devices)
        {
            device.RevokedAt = revokedAt;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task AddSessionAsync(SessionRecord session, CancellationToken cancellationToken = default)
    {
        db.Sessions.Add(session);
        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<SessionRecord?> GetSessionAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        return db.Sessions.FirstOrDefaultAsync(session => session.Id == sessionId, cancellationToken);
    }

    public Task<SessionRecord?> FindSessionByRefreshHashAsync(string refreshTokenHash, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        return db.Sessions.FirstOrDefaultAsync(session =>
            session.RefreshTokenHash == refreshTokenHash &&
            session.RevokedAt == null &&
            session.ExpiresAt > now,
            cancellationToken);
    }

    public async Task RevokeSessionAsync(string sessionId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        var session = await db.Sessions.FirstOrDefaultAsync(candidate => candidate.Id == sessionId, cancellationToken);
        if (session is not null)
        {
            session.RevokedAt = revokedAt;
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task RevokeSessionsForDeviceAsync(string deviceId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        var sessions = await db.Sessions.Where(session => session.DeviceId == deviceId && session.RevokedAt == null).ToListAsync(cancellationToken);
        foreach (var session in sessions)
        {
            session.RevokedAt = revokedAt;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task RevokeSessionsForUserAsync(string userId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        var sessions = await db.Sessions.Where(session => session.UserId == userId && session.RevokedAt == null).ToListAsync(cancellationToken);
        foreach (var session in sessions)
        {
            session.RevokedAt = revokedAt;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<List<ContactRecord>> ContactsForUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.Contacts
            .Where(contact => contact.OwnerUserId == userId)
            .OrderByDescending(contact => contact.CreatedAt)
            .ToListAsync(cancellationToken);
    }

    public async Task AddOrUpdateContactAsync(ContactRecord contact, CancellationToken cancellationToken = default)
    {
        var existing = await db.Contacts.FirstOrDefaultAsync(candidate => candidate.Id == contact.Id, cancellationToken);
        if (existing is null)
        {
            db.Contacts.Add(contact);
        }
        else
        {
            existing.NicknameCiphertext = contact.NicknameCiphertext;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task DeleteContactAsync(string ownerUserId, string contactUserId, CancellationToken cancellationToken = default)
    {
        var id = $"{ownerUserId}:{contactUserId}";
        var contact = await db.Contacts.FirstOrDefaultAsync(candidate => candidate.Id == id, cancellationToken);
        if (contact is not null)
        {
            db.Contacts.Remove(contact);
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task DeleteContactsTouchingUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        var contacts = await db.Contacts
            .Where(contact => contact.OwnerUserId == userId || contact.ContactUserId == userId)
            .ToListAsync(cancellationToken);
        db.Contacts.RemoveRange(contacts);
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task AddConversationAsync(ConversationRecord conversation, CancellationToken cancellationToken = default)
    {
        db.Conversations.Add(conversation);
        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<ConversationRecord?> GetConversationAsync(string conversationId, CancellationToken cancellationToken = default)
    {
        return db.Conversations.FirstOrDefaultAsync(conversation => conversation.Id == conversationId, cancellationToken);
    }

    public Task<bool> IsActiveParticipantAsync(string conversationId, string userId, CancellationToken cancellationToken = default)
    {
        return db.Conversations.AnyAsync(conversation =>
            conversation.Id == conversationId &&
            conversation.Participants.Any(participant => participant.UserId == userId && participant.RemovedAt == null),
            cancellationToken);
    }

    public Task<List<ConversationRecord>> ConversationsForUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.Conversations
            .Where(conversation => conversation.Participants.Any(participant => participant.UserId == userId && participant.RemovedAt == null))
            .OrderByDescending(conversation => conversation.LastMessageAt ?? conversation.UpdatedAt)
            .ToListAsync(cancellationToken);
    }

    public async Task AddMessageAsync(MessageEnvelope message, CancellationToken cancellationToken = default)
    {
        db.Messages.Add(message);
        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<MessageEnvelope?> GetMessageAsync(string messageId, CancellationToken cancellationToken = default)
    {
        return db.Messages.FirstOrDefaultAsync(message => message.Id == messageId, cancellationToken);
    }

    public async Task<List<MessageEnvelope>> PendingMessagesForDeviceAsync(string userId, string deviceId, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        await PurgeExpiredAsync(now, cancellationToken);

        return await db.Messages
            .Where(message => message.Recipients.Any(recipient => recipient.UserId == userId && recipient.DeviceId == deviceId))
            .Where(message => message.Receipts.Any(receipt =>
                receipt.UserId == userId &&
                receipt.DeviceId == deviceId &&
                receipt.DeliveredAt == null &&
                receipt.DeletedAt == null))
            .OrderBy(message => message.ServerReceivedAt)
            .ToListAsync(cancellationToken);
    }

    public async Task<int> MarkMessagesDeliveredAsync(
        string userId,
        string deviceId,
        IEnumerable<string> messageIds,
        DateTimeOffset deliveredAt,
        CancellationToken cancellationToken = default)
    {
        var ids = messageIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Take(500)
            .ToList();
        if (ids.Count == 0)
        {
            return 0;
        }

        var messages = await db.Messages
            .Where(message => ids.Contains(message.Id))
            .Where(message => message.Receipts.Any(receipt => receipt.UserId == userId && receipt.DeviceId == deviceId))
            .ToListAsync(cancellationToken);

        var changed = 0;
        foreach (var message in messages)
        {
            var receipt = message.Receipts.FirstOrDefault(candidate =>
                candidate.UserId == userId &&
                candidate.DeviceId == deviceId);
            if (receipt is null || receipt.DeletedAt is not null || receipt.DeliveredAt is not null)
            {
                continue;
            }

            receipt.DeliveredAt = deliveredAt;
            changed++;
        }

        if (changed > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        return changed;
    }

    public async Task AddFileAsync(FileObject file, CancellationToken cancellationToken = default)
    {
        db.Files.Add(file);
        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<FileObject?> GetFileAsync(string fileId, CancellationToken cancellationToken = default)
    {
        return db.Files.FirstOrDefaultAsync(file => file.Id == fileId, cancellationToken);
    }

    public Task<List<FileObject>> FilesOwnedByUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.Files.Where(file => file.OwnerUserId == userId).ToListAsync(cancellationToken);
    }

    public Task<List<VaultItem>> VaultItemsForUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.VaultItems
            .Where(item => item.UserId == userId && item.DeletedAt == null)
            .OrderByDescending(item => item.UpdatedAt)
            .ToListAsync(cancellationToken);
    }

    public async Task AddVaultItemAsync(VaultItem item, CancellationToken cancellationToken = default)
    {
        db.VaultItems.Add(item);
        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<VaultItem?> GetVaultItemAsync(string itemId, CancellationToken cancellationToken = default)
    {
        return db.VaultItems.FirstOrDefaultAsync(item => item.Id == itemId, cancellationToken);
    }

    public async Task AddCallAsync(CallSession call, CancellationToken cancellationToken = default)
    {
        db.Calls.Add(call);
        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<CallSession?> GetCallAsync(string callId, CancellationToken cancellationToken = default)
    {
        return db.Calls.FirstOrDefaultAsync(call => call.Id == callId, cancellationToken);
    }

    public async Task AddPushTokenAsync(PushTokenRecord pushToken, CancellationToken cancellationToken = default)
    {
        var existing = await db.PushTokens.FirstOrDefaultAsync(candidate => candidate.TokenHash == pushToken.TokenHash, cancellationToken);
        if (existing is null)
        {
            db.PushTokens.Add(pushToken);
        }
        else
        {
            existing.UserId = pushToken.UserId;
            existing.DeviceId = pushToken.DeviceId;
            existing.Provider = pushToken.Provider;
            existing.TokenCiphertext = pushToken.TokenCiphertext;
            existing.RevokedAt = null;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<PushTokenRecord?> GetPushTokenAsync(string pushTokenId, CancellationToken cancellationToken = default)
    {
        return db.PushTokens.FirstOrDefaultAsync(push => push.Id == pushTokenId, cancellationToken);
    }

    public Task<List<PushTokenRecord>> ActivePushTokensForUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        return db.PushTokens
            .Where(push => push.UserId == userId && push.RevokedAt == null)
            .OrderByDescending(push => push.CreatedAt)
            .ToListAsync(cancellationToken);
    }

    public Task<List<AdCampaign>> ActiveAdCampaignsAsync(string? locale, string? region, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        var normalizedLocale = NormalizeOptional(locale)?.Split('-', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
        var normalizedRegion = NormalizeOptional(region);

        return db.AdCampaigns
            .Where(ad => ad.IsActive && ad.StartsAt <= now && ad.EndsAt >= now)
            .Where(ad => ad.Locale == null || normalizedLocale == null || ad.Locale == normalizedLocale)
            .Where(ad => ad.Region == null || normalizedRegion == null || ad.Region == normalizedRegion)
            .ToListAsync(cancellationToken);
    }

    public Task<bool> AdCampaignExistsAsync(string campaignId, CancellationToken cancellationToken = default)
    {
        return db.AdCampaigns.AnyAsync(ad => ad.Id == campaignId, cancellationToken);
    }

    public async Task<AdImpressionAggregate> IncrementAdImpressionAsync(string campaignId, string placement, DateOnly day, CancellationToken cancellationToken = default)
    {
        var normalizedPlacement = placement.Trim();
        var id = $"{campaignId}:{normalizedPlacement}:{day:yyyyMMdd}";
        var aggregate = await db.AdImpressions.FirstOrDefaultAsync(candidate => candidate.Id == id, cancellationToken);

        if (aggregate is null)
        {
            aggregate = new AdImpressionAggregate
            {
                Id = id,
                CampaignId = campaignId,
                Placement = normalizedPlacement,
                Day = day,
                Count = 0
            };
            db.AdImpressions.Add(aggregate);
        }

        aggregate.Count++;
        await db.SaveChangesAsync(cancellationToken);
        return aggregate;
    }

    public PlanEntitlements EntitlementsFor(UserAccount user)
    {
        return user.PlanCode switch
        {
            "premium" => new PlanEntitlements
            {
                PlanCode = "premium",
                VaultStorageBytes = 10L * 1024 * 1024 * 1024,
                MaxLinkedDevices = 8,
                MaxGroupParticipants = 256,
                AdsEnabled = false,
                EncryptedBackupsEnabled = true,
                ProfessionalSpacesEnabled = false
            },
            "professional" => new PlanEntitlements
            {
                PlanCode = "professional",
                VaultStorageBytes = 50L * 1024 * 1024 * 1024,
                MaxLinkedDevices = 12,
                MaxGroupParticipants = 512,
                AdsEnabled = false,
                EncryptedBackupsEnabled = true,
                ProfessionalSpacesEnabled = true
            },
            _ => new PlanEntitlements
            {
                PlanCode = "free",
                VaultStorageBytes = 250L * 1024 * 1024,
                MaxLinkedDevices = 2,
                MaxGroupParticipants = 32,
                AdsEnabled = true,
                EncryptedBackupsEnabled = false,
                ProfessionalSpacesEnabled = false
            }
        };
    }

    public bool UserCanAccessFile(string userId, FileObject file)
    {
        return file.OwnerUserId == userId || file.AllowedUserIds.Contains(userId);
    }

    public async Task PurgeExpiredAsync(DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        var expiredMessages = await db.Messages
            .Where(message => message.ExpiresAt != null && message.ExpiresAt <= now)
            .ToListAsync(cancellationToken);
        db.Messages.RemoveRange(expiredMessages);

        var expiredFiles = await db.Files
            .Where(file => file.ExpiresAt != null && file.ExpiresAt <= now && file.State != FileState.Deleted)
            .ToListAsync(cancellationToken);
        foreach (var file in expiredFiles)
        {
            file.State = FileState.Deleted;
        }

        var expiredStories = await db.Stories
            .Where(story => story.ExpiresAt <= now && story.DeletedAt == null)
            .ToListAsync(cancellationToken);
        foreach (var story in expiredStories)
        {
            story.DeletedAt = now;
        }

        var expiredRooms = await db.VaultRooms
            .Where(room => room.ExpiresAt != null && room.ExpiresAt <= now && room.ClosedAt == null)
            .ToListAsync(cancellationToken);
        foreach (var room in expiredRooms)
        {
            room.ClosedAt = now;
            room.UpdatedAt = now;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task AddAuditAsync(string? userId, string action, string? ipAddress, string? details, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        db.SecurityAuditEvents.Add(new SecurityAuditEvent
        {
            Id = NivraIds.NewId("aud"),
            UserId = userId,
            Action = action,
            IpAddress = ipAddress,
            Details = details,
            CreatedAt = now
        });

        await db.SaveChangesAsync(cancellationToken);
    }

    public Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
    {
        return db.SaveChangesAsync(cancellationToken);
    }

    public static string NormalizeAlias(string alias) => alias.Trim().ToLowerInvariant();

    private static string? NormalizeOptional(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed;
    }
}
