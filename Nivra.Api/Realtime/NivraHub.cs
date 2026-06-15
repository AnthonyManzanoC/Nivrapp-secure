using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;

namespace Nivra.Api.Realtime;

public sealed class NivraHub(
    TokenService tokenService,
    INivraStore store,
    NivraDbContext db,
    QrLoginService qrLogin,
    RealtimePresence presence,
    EncryptedFileStorage storage,
    PushNotificationService pushNotifications,
    ILogger<NivraHub> logger,
    TimeProvider timeProvider) : Hub
{
    private const string ForceWipeCode = "FORCE_WIPE";

    public override async Task OnConnectedAsync()
    {
        var http = Context.GetHttpContext();
        var token = http?.Request.Query["access_token"].FirstOrDefault();
        var authorization = http?.Request.Headers.Authorization.ToString();
        var qrId = http?.Request.Query["qr_login_id"].FirstOrDefault();
        var qrCode = http?.Request.Query["qr_code"].FirstOrDefault();
        var qrLink = http?.Request.Query["qr_link"].FirstOrDefault();

        if (string.IsNullOrWhiteSpace(token) && authorization?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true)
        {
            token = authorization["Bearer ".Length..].Trim();
        }

        if (string.IsNullOrWhiteSpace(token) &&
            !string.IsNullOrWhiteSpace(qrId) &&
            !string.IsNullOrWhiteSpace(qrCode) &&
            qrLogin.IsValid(qrId, qrCode))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GroupsFor.QrLogin(qrId));
            qrLogin.AttachConnection(qrId, qrCode, Context.ConnectionId);
            await base.OnConnectedAsync();
            return;
        }

        if (string.IsNullOrWhiteSpace(token) &&
            string.Equals(qrLink, "1", StringComparison.Ordinal))
        {
            Context.Items["qr_link"] = true;
            await Clients.Caller.SendAsync("qr.connection-ready", new { connectionId = Context.ConnectionId }, Context.ConnectionAborted);
            await base.OnConnectedAsync();
            return;
        }

        var currentUser = string.IsNullOrWhiteSpace(token)
            ? null
            : await tokenService.ValidateAccessTokenAsync(token, store, Context.ConnectionAborted);
        if (currentUser is null)
        {
            Context.Abort();
            return;
        }

        Context.Items["current_user"] = currentUser;
        var now = timeProvider.GetUtcNow();
        var device = await store.GetDeviceAsync(currentUser.DeviceId, Context.ConnectionAborted);
        if (device is null || device.RevokedAt is not null)
        {
            await Clients.Caller.SendAsync(ForceWipeCode, new
            {
                code = ForceWipeCode,
                deviceId = currentUser.DeviceId,
                revokedAt = device?.RevokedAt
            }, Context.ConnectionAborted);
            Context.Abort();
            return;
        }

        if (device is not null)
        {
            device.LastSeenAt = now;
            await store.SaveChangesAsync(Context.ConnectionAborted);
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, GroupsFor.User(currentUser.UserId));
        await Groups.AddToGroupAsync(Context.ConnectionId, GroupsFor.Device(currentUser.DeviceId));
        presence.Connect(currentUser.UserId, Context.ConnectionId);
        await BroadcastPresenceAsync(currentUser.UserId, true, now, Context.ConnectionAborted);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (TryGetCurrentUser(out var currentUser))
        {
            presence.Disconnect(currentUser.UserId, Context.ConnectionId);
            var now = timeProvider.GetUtcNow();
            var device = await store.GetDeviceAsync(currentUser.DeviceId, CancellationToken.None);
            if (device is not null && device.RevokedAt is null)
            {
                device.LastSeenAt = now;
                await store.SaveChangesAsync(CancellationToken.None);
            }
            await BroadcastPresenceAsync(currentUser.UserId, presence.IsConnected(currentUser.UserId), now, CancellationToken.None);

            if (Context.Items.TryGetValue("vault_rooms", out var value) &&
                value is HashSet<string> roomIds)
            {
                try
                {
                    foreach (var roomId in roomIds)
                    {
                        var room = await db.VaultRooms.FirstOrDefaultAsync(candidate => candidate.Id == roomId && candidate.ClosedAt == null, CancellationToken.None);
                        var member = await db.VaultRoomMembers.FirstOrDefaultAsync(candidate => candidate.VaultRoomId == roomId && candidate.UserId == currentUser.UserId, CancellationToken.None);
                        if (room is null || member is null)
                        {
                            continue;
                        }

                        member.LastSeenAt = now;
                        if (room.RetentionMode == VaultRetentionMode.BurnOnExit)
                        {
                            member.Status = VaultMemberStatus.Left;
                            member.LeftAt = now;
                            room.ClosedAt = now;
                            room.UpdatedAt = now;
                            await BurnVaultRoomFilesAsync(roomId, CancellationToken.None);
                            await Clients.Group(GroupsFor.VaultRoom(roomId)).SendAsync("vault.closed", new
                            {
                                roomId,
                                userId = currentUser.UserId,
                                closedAt = now
                            }, CancellationToken.None);
                        }
                    }

                    await db.SaveChangesAsync(CancellationToken.None);
                }
                catch (Exception cleanupException) when (cleanupException is DbUpdateException or InvalidOperationException)
                {
                    logger.LogWarning(cleanupException, "Vault disconnect cleanup could not complete for user {UserId}.", currentUser.UserId);
                }
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    private async Task BroadcastPresenceAsync(string userId, bool online, DateTimeOffset at, CancellationToken cancellationToken)
    {
        try
        {
            var audience = new HashSet<string>(StringComparer.Ordinal) { userId };
            var conversations = await db.Conversations
                .AsNoTracking()
                .Where(conversation => conversation.Participants.Any(participant => participant.UserId == userId && participant.RemovedAt == null))
                .OrderByDescending(conversation => conversation.LastMessageAt ?? conversation.UpdatedAt)
                .Take(300)
                .ToListAsync(cancellationToken);

            foreach (var participant in conversations.SelectMany(conversation => conversation.Participants))
            {
                if (participant.RemovedAt is null && !string.IsNullOrWhiteSpace(participant.UserId))
                {
                    audience.Add(participant.UserId);
                }
            }

            var contacts = await db.Contacts
                .AsNoTracking()
                .Where(contact => contact.OwnerUserId == userId || contact.ContactUserId == userId)
                .Select(contact => new { contact.OwnerUserId, contact.ContactUserId })
                .Take(1000)
                .ToListAsync(cancellationToken);

            foreach (var contact in contacts)
            {
                audience.Add(contact.OwnerUserId == userId ? contact.ContactUserId : contact.OwnerUserId);
            }

            var response = new PresenceResponse(userId, online, at);
            foreach (var targetUserId in audience)
            {
                await Clients.Group(GroupsFor.User(targetUserId)).SendAsync("presence.changed", response, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception broadcastException)
        {
            logger.LogWarning(broadcastException, "Presence broadcast could not complete for user {UserId}.", userId);
        }
    }

    public string GetConnectionId() => Context.ConnectionId;

    public async Task<List<PresenceResponse>> Presence(List<string> userIds)
    {
        if (!TryGetCurrentUser(out _))
        {
            return [];
        }

        var ids = (userIds ?? [])
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Take(80)
            .ToList();
        if (ids.Count == 0)
        {
            return [];
        }

        var lastSeen = await db.Devices
            .AsNoTracking()
            .Where(device => ids.Contains(device.UserId) && device.RevokedAt == null)
            .GroupBy(device => device.UserId)
            .Select(group => new { UserId = group.Key, LastSeenAt = group.Max(device => device.LastSeenAt) })
            .ToDictionaryAsync(item => item.UserId, item => item.LastSeenAt, Context.ConnectionAborted);

        return ids.Select(id =>
            new PresenceResponse(id, presence.IsConnected(id), lastSeen.TryGetValue(id, out var seen) ? seen : null))
            .ToList();
    }

    public async Task SyncReadReceipts(string conversationId, List<string> messageIds, List<string>? openedMessageIds = null)
    {
        if (!TryGetCurrentUser(out var currentUser) ||
            string.IsNullOrWhiteSpace(conversationId) ||
            !await store.IsActiveParticipantAsync(conversationId, currentUser.UserId, Context.ConnectionAborted))
        {
            return;
        }

        var ids = (messageIds ?? [])
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Take(500)
            .ToList();
        if (ids.Count == 0)
        {
            return;
        }
        var openedIds = (openedMessageIds ?? [])
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Where(ids.Contains)
            .Take(500)
            .ToList();
        var now = timeProvider.GetUtcNow();

        if (openedIds.Count > 0)
        {
            var openedMessages = await db.Messages
                .Include(message => message.Receipts)
                .Where(message =>
                    message.ConversationId == conversationId &&
                    openedIds.Contains(message.Id) &&
                    message.DeleteAfterRead)
                .ToListAsync(Context.ConnectionAborted);
            var persistedOpenedIds = new List<string>();

            foreach (var message in openedMessages)
            {
                var ownReceipts = message.Receipts
                    .Where(receipt => receipt.UserId == currentUser.UserId)
                    .ToList();
                if (ownReceipts.Count == 0)
                {
                    continue;
                }

                foreach (var receipt in ownReceipts)
                {
                    receipt.DeliveredAt ??= now;
                    receipt.ReadAt ??= now;
                    receipt.DeletedAt ??= now;
                }
                persistedOpenedIds.Add(message.Id);
            }

            if (persistedOpenedIds.Count > 0)
            {
                await db.SaveChangesAsync(Context.ConnectionAborted);
                openedIds = persistedOpenedIds;
                ids = ids
                    .Concat(openedIds)
                    .Distinct(StringComparer.Ordinal)
                    .Take(500)
                    .ToList();

                foreach (var message in openedMessages.Where(message => openedIds.Contains(message.Id)))
                {
                    await Clients.Group(GroupsFor.User(message.SenderUserId)).SendAsync("message.receipt", new
                    {
                        messageId = message.Id,
                        userId = currentUser.UserId,
                        deviceId = currentUser.DeviceId,
                        kind = ReceiptKind.Read,
                        opened = true,
                        at = now
                    }, Context.ConnectionAborted);
                }
            }
        }

        await Clients.Group(GroupsFor.User(currentUser.UserId)).SendAsync("sync_read_receipts", new
        {
            conversationId,
            messageIds = ids,
            openedMessageIds = openedIds,
            userId = currentUser.UserId,
            sourceDeviceId = currentUser.DeviceId,
            at = now
        }, Context.ConnectionAborted);
    }

    public async Task CallAnsweredElsewhere(string callId)
    {
        if (!TryGetCurrentUser(out var currentUser) || string.IsNullOrWhiteSpace(callId))
        {
            return;
        }

        var call = await store.GetCallAsync(callId, Context.ConnectionAborted);
        if (call is null || !call.ParticipantUserIds.Contains(currentUser.UserId))
        {
            return;
        }

        await Clients.Group(GroupsFor.User(currentUser.UserId)).SendAsync("call_answered_elsewhere", new
        {
            callId,
            answeredByUserId = currentUser.UserId,
            answeredByDeviceId = currentUser.DeviceId,
            at = timeProvider.GetUtcNow()
        }, Context.ConnectionAborted);
    }

    public async Task<CallResponse> CallUser(StartCallRequest request)
    {
        if (!TryGetCurrentUser(out var currentUser))
        {
            throw new HubException("No autenticado.");
        }

        var participants = (request.ParticipantUserIds ?? [])
            .Append(currentUser.UserId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .ToHashSet(StringComparer.Ordinal);

        ConversationRecord? conversation = null;
        if (request.ConversationId is not null)
        {
            conversation = await store.GetConversationAsync(request.ConversationId, Context.ConnectionAborted);
            if (conversation is null || !conversation.Participants.Any(participant => participant.UserId == currentUser.UserId && participant.RemovedAt is null))
            {
                throw new HubException("Chat no encontrado.");
            }

            participants = conversation.Participants
                .Where(participant => participant.RemovedAt is null)
                .Select(participant => participant.UserId)
                .ToHashSet(StringComparer.Ordinal);
        }

        if (participants.Count < 2 || !await store.UsersExistAsync(participants, Context.ConnectionAborted))
        {
            throw new HubException("La llamada necesita al menos dos usuarios validos.");
        }

        var call = new CallSession
        {
            Id = NivraIds.NewId("cal"),
            ConversationId = request.ConversationId,
            InitiatorUserId = currentUser.UserId,
            Type = request.Type,
            Status = CallStatus.Ringing,
            ParticipantUserIds = participants,
            StartedAt = timeProvider.GetUtcNow()
        };

        await store.AddCallAsync(call, Context.ConnectionAborted);
        var response = ToCallResponse(call, currentUser.DeviceId);
        await NotifyUsersAsync(participants, "call.started", response);
        await SendIncomingCallPushesAsync(call, currentUser.UserId, participants);
        return response;
    }

    public async Task Typing(string conversationId, string encryptedState)
    {
        if (!TryGetCurrentUser(out var currentUser) || !await store.IsActiveParticipantAsync(conversationId, currentUser.UserId, Context.ConnectionAborted))
        {
            return;
        }

        await Clients.Group(GroupsFor.Conversation(conversationId)).SendAsync("conversation.typing", new
        {
            conversationId,
            senderUserId = currentUser.UserId,
            senderDeviceId = currentUser.DeviceId,
            encryptedState
        });
    }

    public async Task JoinConversation(string conversationId)
    {
        if (TryGetCurrentUser(out var currentUser) && await store.IsActiveParticipantAsync(conversationId, currentUser.UserId, Context.ConnectionAborted))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GroupsFor.Conversation(conversationId));
        }
    }

    public async Task JoinVaultRoom(string roomId)
    {
        if (!TryGetCurrentUser(out var currentUser))
        {
            return;
        }

        var now = timeProvider.GetUtcNow();
        var canEnter = await db.VaultRooms.AnyAsync(room =>
            room.Id == roomId &&
            room.ClosedAt == null &&
            (room.ExpiresAt == null || room.ExpiresAt > now) &&
            db.VaultRoomMembers.Any(member =>
                member.VaultRoomId == room.Id &&
                member.UserId == currentUser.UserId &&
                member.Status == VaultMemberStatus.Active),
            Context.ConnectionAborted);
        if (!canEnter)
        {
            return;
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, GroupsFor.VaultRoom(roomId));
        TrackVaultRoom(roomId);

        var memberRecord = await db.VaultRoomMembers.FirstOrDefaultAsync(member => member.VaultRoomId == roomId && member.UserId == currentUser.UserId, Context.ConnectionAborted);
        if (memberRecord is not null)
        {
            memberRecord.LastSeenAt = now;
            await db.SaveChangesAsync(Context.ConnectionAborted);
        }
    }

    public async Task SendVaultRoomMessage(string roomId, VaultRealtimeMessageRequest request)
    {
        if (!TryGetCurrentUser(out var currentUser) ||
            request.Recipients is null ||
            request.Recipients.Count == 0 ||
            !await IsActiveVaultMemberAsync(roomId, currentUser.UserId))
        {
            return;
        }

        var now = timeProvider.GetUtcNow();
        var response = new VaultRealtimeMessageResponse(
            NivraIds.NewId("vmsg"),
            roomId,
            string.IsNullOrWhiteSpace(request.ClientMessageId) ? $"hub-{Guid.NewGuid():N}" : request.ClientMessageId,
            currentUser.UserId,
            currentUser.DeviceId,
            request.Kind,
            request.Recipients,
            request.FileObjectId,
            now);

        await Clients.Group(GroupsFor.VaultRoom(roomId)).SendAsync("vault.message", response, Context.ConnectionAborted);
    }

    private Task<bool> IsActiveVaultMemberAsync(string roomId, string userId)
    {
        var now = timeProvider.GetUtcNow();
        return db.VaultRooms.AnyAsync(room =>
            room.Id == roomId &&
            room.ClosedAt == null &&
            (room.ExpiresAt == null || room.ExpiresAt > now) &&
            db.VaultRoomMembers.Any(member =>
                member.VaultRoomId == room.Id &&
                member.UserId == userId &&
                member.Status == VaultMemberStatus.Active),
            Context.ConnectionAborted);
    }

    private void TrackVaultRoom(string roomId)
    {
        if (!Context.Items.TryGetValue("vault_rooms", out var value) || value is not HashSet<string> rooms)
        {
            rooms = new HashSet<string>(StringComparer.Ordinal);
            Context.Items["vault_rooms"] = rooms;
        }

        rooms.Add(roomId);
    }

    private async Task BurnVaultRoomFilesAsync(string roomId, CancellationToken cancellationToken)
    {
        var files = await db.Files
            .Where(file => file.VaultRoomId == roomId && file.State != FileState.Deleted)
            .ToListAsync(cancellationToken);
        foreach (var file in files)
        {
            file.State = FileState.Deleted;
            await storage.DeleteIfExistsAsync(file, cancellationToken);
        }
    }

    private async Task NotifyUsersAsync(IEnumerable<string> userIds, string method, object payload)
    {
        foreach (var userId in userIds.Distinct(StringComparer.Ordinal))
        {
            await Clients.Group(GroupsFor.User(userId)).SendAsync(method, payload, Context.ConnectionAborted);
        }
    }

    private async Task SendIncomingCallPushesAsync(CallSession call, string callerUserId, IEnumerable<string> participantUserIds)
    {
        var callerName = await GetCallerNameAsync(callerUserId, Context.ConnectionAborted);
        var callees = participantUserIds
            .Where(userId => userId != callerUserId)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        foreach (var userId in callees)
        {
            await pushNotifications.SendIncomingCallAsync(userId, call.ConversationId, call.Id, callerUserId, callerName, call.Type, Context.ConnectionAborted);
        }
    }

    private async Task<string> GetCallerNameAsync(string callerUserId, CancellationToken cancellationToken)
    {
        var caller = await db.Users
            .AsNoTracking()
            .Where(user => user.Id == callerUserId)
            .Select(user => new { user.Alias, user.DisplayName })
            .FirstOrDefaultAsync(cancellationToken);

        return string.IsNullOrWhiteSpace(caller?.DisplayName)
            ? caller?.Alias ?? "un contacto"
            : caller.DisplayName;
    }

    private static CallResponse ToCallResponse(CallSession call, string? initiatorDeviceId = null)
    {
        return new CallResponse(call.Id, call.ConversationId, call.InitiatorUserId, call.Type, call.Status, call.ParticipantUserIds.ToList(), call.StartedAt, call.EndedAt, initiatorDeviceId);
    }

    private bool TryGetCurrentUser(out CurrentUser currentUser)
    {
        if (Context.Items.TryGetValue("current_user", out var value) && value is CurrentUser user)
        {
            currentUser = user;
            return true;
        }

        currentUser = default!;
        return false;
    }
}

public static class GroupsFor
{
    public static string User(string userId) => $"user:{userId}";
    public static string Device(string deviceId) => $"device:{deviceId}";
    public static string Conversation(string conversationId) => $"conversation:{conversationId}";
    public static string VaultRoom(string roomId) => $"vault-room:{roomId}";
    public static string QrLogin(string qrId) => $"qr-login:{qrId}";
}

public sealed class RealtimePresence
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> connectionsByUser = new(StringComparer.Ordinal);

    public void Connect(string userId, string connectionId)
    {
        var connections = connectionsByUser.GetOrAdd(userId, _ => new ConcurrentDictionary<string, byte>(StringComparer.Ordinal));
        connections[connectionId] = 1;
    }

    public void Disconnect(string userId, string connectionId)
    {
        if (!connectionsByUser.TryGetValue(userId, out var connections))
        {
            return;
        }

        connections.TryRemove(connectionId, out _);
        if (connections.IsEmpty)
        {
            connectionsByUser.TryRemove(userId, out _);
        }
    }

    public bool IsConnected(string userId)
    {
        return connectionsByUser.TryGetValue(userId, out var connections) && !connections.IsEmpty;
    }
}

public sealed record VaultRealtimeMessageRequest(
    string? ClientMessageId,
    MessageKind Kind,
    List<RecipientCipherRequest> Recipients,
    string? FileObjectId);

public sealed record PresenceResponse(string UserId, bool Online, DateTimeOffset? LastSeenAt);

public sealed record VaultRealtimeMessageResponse(
    string Id,
    string VaultRoomId,
    string ClientMessageId,
    string SenderUserId,
    string SenderDeviceId,
    MessageKind Kind,
    List<RecipientCipherRequest> Recipients,
    string? FileObjectId,
    DateTimeOffset SentAt);
