using Microsoft.AspNetCore.SignalR;
using Nivra.Api.Domain;
using Nivra.Api.Realtime;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    private static Task NotifyGroupMembersAsync(IHubContext<NivraHub> hub, ConversationRecord conversation,
        string method, object payload, CancellationToken ct) =>
        NotifyGroupUsersAsync(hub, conversation.Participants.Where(member => member.RemovedAt is null).Select(member => member.UserId),
            method, payload, ct);

    private static Task NotifyGroupUsersAsync(IHubContext<NivraHub> hub, IEnumerable<string> userIds,
        string method, object payload, CancellationToken ct)
    {
        var groups = userIds.Distinct(StringComparer.Ordinal).Select(GroupsFor.User).ToArray();
        return groups.Length == 0 ? Task.CompletedTask : hub.Clients.Groups(groups).SendAsync(method, payload, ct);
    }

    private static Task NotifyCommittedGroupAsync(HttpContext http, Func<CancellationToken, Task> notify) =>
        NotifyCommittedGroupAsync(http.RequestServices.GetRequiredService<ILoggerFactory>(), notify);

    private static async Task NotifyCommittedGroupAsync(ILoggerFactory logs, Func<CancellationToken, Task> notify)
    {
        // Membership has already committed. A disconnected caller or a transient
        // delivery failure cannot undo it. The next refresh reads persisted state.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try { await notify(timeout.Token); }
        catch (Exception ex)
        {
            logs.CreateLogger("Nivra.GroupNotifications").LogWarning(ex, "Delivery of a persisted group change failed.");
        }
    }
}
