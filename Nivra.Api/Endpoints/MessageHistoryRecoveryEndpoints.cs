using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;

namespace Nivra.Api.Endpoints;

public sealed record MessageHistoryRecoveryRequest(List<string>? MessageIds);
public sealed record MessageHistoryRecoveryResponse(List<MessageResponse> Messages, List<MessageDeletionResponse> DeletedMessages);

public static partial class EndpointExtensions
{
    private static void MapMessageHistoryRecoveryEndpoints(this WebApplication app)
    {
        app.MapPost("/messages/history-recovery", async Task<IResult> (MessageHistoryRecoveryRequest request, HttpContext http,
            NivraDbContext db, TimeProvider clock, CancellationToken ct) =>
        {
            var current = http.GetCurrentUser();
            if (current is null) return Results.Unauthorized();
            if (!TryNormalizeMessageHistoryRecoveryIds(request.MessageIds, out var ids))
                return Results.BadRequest(new { code = "invalid_history_message_ids" });
            http.Response.Headers.CacheControl = "no-store";
            if (ids.Count == 0) return Results.Ok(new MessageHistoryRecoveryResponse([], []));

            // Unknown IDs, envelopes addressed to another account, and removed
            // conversation membership all produce the same empty result.
            // Neither absence nor lack of permission is proof of deletion.
            var rows = await MessageHistoryRecoveryQuery(db.Messages.AsNoTracking(), db.Conversations.AsNoTracking(), current.UserId, ids)
                .OrderBy(message => message.ServerReceivedAt).ThenBy(message => message.Id)
                .ToListAsync(ct);
            return Results.Ok(BuildMessageHistoryRecoveryResponse(rows, current.UserId, current.DeviceId, clock.GetUtcNow()));
        });
    }

    internal static bool TryNormalizeMessageHistoryRecoveryIds(List<string>? requested, out List<string> ids)
    {
        ids = [];
        if (requested is null || requested.Count > 100 || requested.Any(id => string.IsNullOrWhiteSpace(id) || id.Trim().Length > 64)) return false;
        ids = requested.Select(id => id.Trim()).Distinct(StringComparer.Ordinal).ToList();
        return true;
    }

    internal static IQueryable<MessageEnvelope> MessageHistoryRecoveryQuery(IQueryable<MessageEnvelope> messages,
        IQueryable<ConversationRecord> conversations, string userId, List<string> ids)
    {
        var activeConversations = conversations
            .Where(conversation => conversation.Participants.Any(participant => participant.UserId == userId && participant.RemovedAt == null))
            .Select(conversation => conversation.Id);
        return messages
            .Where(message => ids.Contains(message.Id))
            .Where(message => message.Recipients.Any(recipient => recipient.UserId == userId))
            .Where(message => activeConversations.Contains(message.ConversationId));
    }

    internal static MessageHistoryRecoveryResponse BuildMessageHistoryRecoveryResponse(IEnumerable<MessageEnvelope> rows,
        string userId, string deviceId, DateTimeOffset now)
    {
        var messages = new List<MessageResponse>();
        var deleted = new List<MessageDeletionResponse>();
        foreach (var message in rows)
        {
            // Defense in depth before serializing encrypted envelopes. The
            // database query also requires active conversation participation.
            if (!message.Recipients.Any(recipient => recipient.UserId == userId)) continue;
            var expiredAt = message.ExpiresAt is { } expiresAt && expiresAt <= now ? message.ExpiresAt : null;
            var deletedAt = message.Receipts.Where(receipt => receipt.UserId == userId && receipt.DeletedAt != null)
                .Select(receipt => receipt.DeletedAt).OrderByDescending(at => at).FirstOrDefault();
            if (expiredAt is not null || deletedAt is not null)
            {
                var at = deletedAt is not null && (expiredAt is null || deletedAt > expiredAt) ? deletedAt.Value : expiredAt!.Value;
                deleted.Add(new MessageDeletionResponse(message.Id, message.ConversationId, "me", at));
                continue;
            }
            messages.Add(ToMessageResponseForUser(message, userId, deviceId));
        }
        return new MessageHistoryRecoveryResponse(messages, deleted);
    }
}
