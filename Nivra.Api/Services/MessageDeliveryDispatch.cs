using Nivra.Api.Domain;

namespace Nivra.Api.Services;

/// <summary>Notifies recipients after persistence without letting one transport suppress the others.</summary>
public static class MessageDeliveryDispatch
{
    public static async Task NotifyAsync(
        MessageEnvelope message,
        Func<RecipientCiphertext, CancellationToken, Task> sendRealtime,
        Func<string, CancellationToken, Task> sendPush,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        // The message is already committed. A notification failure must not turn that successful
        // write into an HTTP failure, and other devices and push transports still need an attempt.
        foreach (var recipient in message.Recipients)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await sendRealtime(recipient, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Realtime notification failed for persisted message {MessageId} and device {DeviceId}; other notifications will continue.", message.Id, recipient.DeviceId);
            }
        }

        foreach (var userId in message.Recipients
            .Where(recipient => recipient.UserId != message.SenderUserId)
            .Select(recipient => recipient.UserId)
            .Distinct(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await sendPush(userId, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Push notification failed for persisted message {MessageId} and user {UserId}; other notifications will continue.", message.Id, userId);
            }
        }
    }
}
