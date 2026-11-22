using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public sealed class MessagePushOutboxWorker(IServiceScopeFactory scopes, TimeProvider clock,
    ILogger<MessagePushOutboxWorker> logger) : BackgroundService
{
    private DateTimeOffset nextPrune;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            try { await RunOnceAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { logger.LogWarning(error, "Message notification outbox will retry after a dependency failure."); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task RunOnceAsync(CancellationToken ct)
    {
        List<MessagePushOutboxItem> jobs;
        await using (var scope = scopes.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var now = clock.GetUtcNow();
            jobs = await db.MessagePushOutbox.AsNoTracking().Where(MessagePushOutbox.Ready(now))
                .OrderBy(row => row.NextAttemptAt).Take(16).ToListAsync(ct);
            if (now >= nextPrune)
            {
                nextPrune = now.AddMinutes(1);
                await db.MessagePushOutbox.Where(row => row.ExpiresAt < now.AddDays(-1)).Take(250).ExecuteDeleteAsync(ct);
            }
        }
        await Parallel.ForEachAsync(jobs, new ParallelOptions { MaxDegreeOfParallelism = 2, CancellationToken = ct },
            async (job, token) =>
            {
                try { await DispatchAsync(job, token); }
                catch (Exception error) when (!token.IsCancellationRequested)
                {
                    // Keep the lease for a bounded retry and continue with other
                    // recipients if this job lost its connection during delivery.
                    logger.LogWarning(error, "Message notification job {MessageId} could not finish and will be retried.", job.MessageId);
                }
            });
    }

    private async Task DispatchAsync(MessagePushOutboxItem job, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
        var lease = Guid.NewGuid().ToString("N");
        if (await MessagePushOutbox.TryLeaseAsync(db, job.MessageId, job.RecipientUserId, lease, clock.GetUtcNow(), ct) != 1) return;
        var leased = await db.MessagePushOutbox.AsNoTracking().SingleOrDefaultAsync(row => row.MessageId == job.MessageId &&
            row.RecipientUserId == job.RecipientUserId && row.LeaseId == lease, ct);
        if (leased is null) return;
        job = leased;
        var message = await db.Messages.AsNoTracking().FirstOrDefaultAsync(row => row.Id == job.MessageId, ct);
        var currentMember = message is not null && await db.Conversations.AnyAsync(conversation => conversation.Id == message.ConversationId &&
            conversation.Participants.Any(participant => participant.UserId == job.RecipientUserId && participant.RemovedAt == null), ct);
        var pushes = scope.ServiceProvider.GetRequiredService<PushNotificationService>();
        var completed = MessagePushOutbox.CompletedDestinations(job);
        using var progressLock = new SemaphoreSlim(1, 1);
        async Task CompleteDestination(string tokenId)
        {
            // A provider acknowledgement may arrive just as its send budget
            // expires. Persist it using the worker lifetime, not that deadline.
            await progressLock.WaitAsync(ct);
            try
            {
                if (completed.Contains(tokenId)) return;
                var progress = JsonSerializer.Serialize(completed.Append(tokenId));
                var changed = await db.MessagePushOutbox.Where(row => row.MessageId == job.MessageId &&
                        row.RecipientUserId == job.RecipientUserId && row.LeaseId == lease)
                    .ExecuteUpdateAsync(update => update.SetProperty(row => row.CompletedPushTokenIdsJson, progress), ct);
                if (changed != 1) throw new InvalidOperationException("The message push lease is no longer owned.");
                completed.Add(tokenId);
            }
            finally { progressLock.Release(); }
        }
        var result = currentMember
            ? await MessagePushOutbox.DispatchAsync(message, job, clock.GetUtcNow(), token =>
                pushes.DispatchMessageAsync(job.RecipientUserId, message!.ConversationId, message.Id, message.SenderUserId, token,
                    completed, CompleteDestination, (job.Attempts - 1) * 4, job.ExpiresAt), ct)
            : MessagePushDelivery.Discard;
        var now = clock.GetUtcNow();
        var owned = db.MessagePushOutbox.Where(row => row.MessageId == job.MessageId && row.RecipientUserId == job.RecipientUserId && row.LeaseId == lease);
        if (result != MessagePushDelivery.Retry || now >= job.ExpiresAt)
            await owned.ExecuteUpdateAsync(update => update.SetProperty(row => row.CompletedAt, now)
                .SetProperty(row => row.LeaseUntil, (DateTimeOffset?)null).SetProperty(row => row.LeaseId, (string?)null), ct);
        else
            await owned.ExecuteUpdateAsync(update => update.SetProperty(row => row.NextAttemptAt, now + MessagePushOutbox.RetryDelay(job.Attempts))
                .SetProperty(row => row.LeaseUntil, (DateTimeOffset?)null).SetProperty(row => row.LeaseId, (string?)null), ct);
    }
}
