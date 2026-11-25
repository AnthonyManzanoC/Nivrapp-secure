using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

internal static class GroupHistorySharing
{
    internal const string Prefix = "group-history:";
    internal const string RouteSuffix = "/messages/group-history/ratchet";

    internal static string MessageKey(string conversationId, ConversationParticipant member)
    {
        var admitted = member.JoinedAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
        var address = Encoding.UTF8.GetBytes($"{conversationId}\u001f{member.UserId}\u001f{admitted}");
        return Prefix + Convert.ToHexStringLower(SHA256.HashData(address));
    }

    internal static bool ValidRequest(SendMessageRequest request) => request.GroupHistory is
        { RecipientUserId.Length: > 0 and <= 64, SourceMessageIds.Count: > 0 and <= 10 } share
        && share.SourceMessageIds.All(id => !string.IsNullOrWhiteSpace(id) && id.Length <= 64)
        && share.SourceMessageIds.Distinct(StringComparer.Ordinal).Count() == share.SourceMessageIds.Count
        && request.Kind == MessageKind.Text && request.ExpiresAt is null && !request.DeleteAfterRead
        && (request.SharedPayloadCiphertext?.Length ?? 0) <= 48_000
        && request.Recipients.All(recipient => recipient is { FileObjectId: null, Ciphertext.Length: <= 48_000 });

    internal static bool RecentAdmission(ConversationRecord group, ConversationParticipant member, DateTimeOffset now) =>
        member.RemovedAt is null && member.JoinedAt > group.CreatedAt
        && member.JoinedAt <= now && member.JoinedAt >= now.AddMinutes(-15);

    internal static async Task<bool> SourcesEligibleAsync(NivraDbContext db, string conversationId, string adminUserId,
        ConversationParticipant member, IReadOnlyCollection<string> sourceIds, CancellationToken cancellationToken)
    {
        var cutoff = member.JoinedAt.AddDays(-7);
        var count = await db.Messages.CountAsync(message => sourceIds.Contains(message.Id)
            && message.ConversationId == conversationId && message.SenderUserId == adminUserId
            && message.ServerReceivedAt >= cutoff && message.ServerReceivedAt < member.JoinedAt
            && message.Kind == MessageKind.Text && !message.ClientMessageId.StartsWith(Prefix)
            && message.ExpiresAt == null && !message.DeleteAfterRead
            && !message.Recipients.Any(recipient => recipient.FileObjectId != null || recipient.UserId == member.UserId)
            && !message.Receipts.Any(receipt => receipt.UserId == adminUserId && receipt.DeletedAt != null), cancellationToken);
        return count == sourceIds.Count;
    }
}
