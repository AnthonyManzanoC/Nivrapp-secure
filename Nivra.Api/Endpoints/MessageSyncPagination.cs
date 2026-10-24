using Nivra.Api.Domain;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    internal static List<MessageEnvelope> MessageSyncBoundaryPage(IEnumerable<MessageEnvelope> boundary,
        string? sinceId, int take)
    {
        // The timestamp predicate is applied in SQL. Compare the remaining
        // IDs in one explicit order so equal timestamps can span many pages.
        return boundary
            .Where(message => string.IsNullOrWhiteSpace(sinceId) || string.CompareOrdinal(message.Id, sinceId) > 0)
            .OrderBy(message => message.Id, StringComparer.Ordinal)
            .Take(Math.Max(0, take))
            .ToList();
    }
}
