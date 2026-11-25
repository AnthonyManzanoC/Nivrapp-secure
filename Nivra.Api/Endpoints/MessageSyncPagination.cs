using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    internal static IQueryable<MessageEnvelope> MessageSyncPage(IQueryable<MessageEnvelope> messages,
        DateTimeOffset? since, string? sinceId, int take, bool composite)
    {
        if (since is not { } watermark)
        {
            var ordered = messages.OrderByDescending(message => message.ServerReceivedAt);
            return (composite
                ? ordered.ThenByDescending(message => EF.Functions.Collate(message.Id, "C"))
                : ordered.ThenByDescending(message => message.Id)).Take(take);
        }

        if (!composite)
        {
            return messages.Where(message => message.ServerReceivedAt > watermark)
                .OrderBy(message => message.ServerReceivedAt).ThenBy(message => message.Id).Take(take);
        }

        // Generated message IDs are ASCII. The C collation preserves their
        // ordinal order in both the comparison and sort, independent of locale.
        var page = messages.Where(message => message.ServerReceivedAt >= watermark);
        if (!string.IsNullOrWhiteSpace(sinceId))
        {
            page = page.Where(message => message.ServerReceivedAt > watermark
                || string.Compare(EF.Functions.Collate(message.Id, "C"), sinceId) > 0);
        }
        return page.OrderBy(message => message.ServerReceivedAt)
            .ThenBy(message => EF.Functions.Collate(message.Id, "C")).Take(take);
    }

    internal static IQueryable<MessageEnvelope> MessageHistoryPage(IQueryable<MessageEnvelope> messages,
        DateTimeOffset? before, string? beforeId, int take)
    {
        if (before is { } boundary)
        {
            messages = string.IsNullOrWhiteSpace(beforeId)
                ? messages.Where(message => message.ServerReceivedAt < boundary)
                : messages.Where(message => message.ServerReceivedAt <= boundary
                    && (message.ServerReceivedAt < boundary
                        || string.Compare(EF.Functions.Collate(message.Id, "C"), beforeId) < 0));
        }

        return messages.OrderByDescending(message => message.ServerReceivedAt)
            .ThenByDescending(message => EF.Functions.Collate(message.Id, "C")).Take(take);
    }
}
