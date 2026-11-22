using Microsoft.AspNetCore.SignalR;
using Nivra.Api.Realtime;

namespace Nivra.Api.Services;

/// <summary>Delivers optional notifications after a call mutation has committed.</summary>
public sealed class CallNotificationDispatch(ILogger logger)
{
    public async Task SendAsync(string callId, string notification, Func<CancellationToken, Task> send, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            await send(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            // The call or signal is already stored. A transport failure must not
            // make the initiating client repeat a mutation that already succeeded.
            logger.LogWarning(exception, "Notification {Notification} failed for committed call {CallId}.", notification, callId);
        }
    }

    public async Task SendToUsersAsync(IHubClients<IClientProxy> clients, IEnumerable<string> users, string callId, string notification,
        object payload, CancellationToken cancellationToken)
    {
        foreach (var userId in users.Distinct(StringComparer.Ordinal))
        {
            await SendAsync(callId, notification, token =>
                clients.Group(GroupsFor.User(userId)).SendAsync(notification, payload, token), cancellationToken);
        }
    }
}
