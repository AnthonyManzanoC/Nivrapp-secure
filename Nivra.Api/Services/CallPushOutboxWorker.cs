using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;

namespace Nivra.Api.Services;

public sealed class CallPushOutboxWorker(IServiceScopeFactory scopes, TimeProvider clock,
    ILogger<CallPushOutboxWorker> logger) : BackgroundService
{
    private DateTimeOffset nextPrune;
    private DateTimeOffset nextExpiry;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            try { await RunOnceAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { logger.LogWarning(error, "Call notification outbox will retry after a dependency failure."); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task RunOnceAsync(CancellationToken ct)
    {
        if (clock.GetUtcNow() >= nextExpiry)
        {
            await ExpireRingingAsync(ct);
            nextExpiry = clock.GetUtcNow().AddSeconds(5);
        }
        List<CallPushOutboxItem> jobs;
        await using (var scope = scopes.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var now = clock.GetUtcNow();
            jobs = await db.CallPushOutbox.AsNoTracking().Where(CallPushOutbox.Ready(now))
                .OrderBy(item => item.NextAttemptAt).Take(8).ToListAsync(ct);
            if (now >= nextPrune)
            {
                nextPrune = now.AddMinutes(1);
                await db.CallPushOutbox.Where(item => item.ExpiresAt < now.AddDays(-1)).Take(250).ExecuteDeleteAsync(ct);
            }
        }
        await Parallel.ForEachAsync(jobs, new ParallelOptions { MaxDegreeOfParallelism = 2, CancellationToken = ct },
            async (job, token) => await DispatchAsync(job, token));
    }

    private async Task DispatchAsync(CallPushOutboxItem job, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
        var now = clock.GetUtcNow();
        var lease = Guid.NewGuid().ToString("N");
        if (await CallPushOutbox.TryLeaseAsync(db, job.CallId, job.RecipientUserId, lease, now, ct) != 1) return;
        var call = await db.Calls.AsNoTracking().FirstOrDefaultAsync(item => item.Id == job.CallId, ct);
        var caller = call is null ? null : await db.Users.AsNoTracking().FirstOrDefaultAsync(user => user.Id == call.InitiatorUserId, ct);
        var pushes = scope.ServiceProvider.GetRequiredService<PushNotificationService>();
        var result = await CallPushOutbox.DispatchAsync(call, job, clock.GetUtcNow(), (expires, token) =>
            pushes.DispatchIncomingCallAsync(job.RecipientUserId, call!.ConversationId, call.Id, call.InitiatorUserId,
                caller?.DisplayName ?? caller?.Alias ?? "Nivra", call.Type, expires, token), ct);
        now = clock.GetUtcNow();
        var owned = db.CallPushOutbox.Where(item => item.CallId == job.CallId && item.RecipientUserId == job.RecipientUserId && item.LeaseId == lease);
        if (result != CallPushDelivery.Retry || now >= job.ExpiresAt)
            await owned.ExecuteUpdateAsync(update => update.SetProperty(item => item.CompletedAt, now)
                .SetProperty(item => item.LeaseUntil, (DateTimeOffset?)null).SetProperty(item => item.LeaseId, (string?)null), ct);
        else
            await owned.ExecuteUpdateAsync(update => update.SetProperty(item => item.NextAttemptAt, now + CallPushOutbox.RetryDelay(job.Attempts + 1))
                .SetProperty(item => item.LeaseUntil, (DateTimeOffset?)null).SetProperty(item => item.LeaseId, (string?)null), ct);
    }

    private async Task ExpireRingingAsync(CancellationToken ct)
    {
        List<string> expired;
        await using (var scope = scopes.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var before = clock.GetUtcNow() - CallPushOutbox.InvitationLifetime;
            expired = await db.Calls.AsNoTracking().Where(call => call.Status == CallStatus.Ringing && call.EndedAt == null && call.StartedAt <= before &&
                    !db.Conversations.Any(conversation => conversation.Id == call.ConversationId && conversation.Type == ConversationType.Group))
                .OrderBy(call => call.StartedAt).Take(10).Select(call => call.Id).ToListAsync(ct);
        }
        foreach (var id in expired)
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var ended = await CallCoordination.RunAsync<CallSession?>(db, async () =>
            {
                await using var transaction = await CallCoordination.LockAsync(db, $"call:{id}", ct);
                var call = await db.Calls.FirstOrDefaultAsync(item => item.Id == id, ct);
                var now = clock.GetUtcNow();
                if (call is null) return null;
                var isGroup = await db.Conversations.AnyAsync(conversation => conversation.Id == call.ConversationId && conversation.Type == ConversationType.Group, ct);
                if (!CallPushOutbox.ShouldExpire(call, now, isGroup)) return null;
                call.Status = CallStatus.Ended; call.EndedAt = now; call.ParticipantSessions.Clear();
                await db.SaveChangesAsync(ct);
                await db.CallPushOutbox.Where(item => item.CallId == id && item.CompletedAt == null)
                    .ExecuteUpdateAsync(update => update.SetProperty(item => item.CompletedAt, now), ct);
                await transaction.CommitAsync(ct);
                return call;
            });
            if (ended is null) continue;
            var hub = scope.ServiceProvider.GetRequiredService<IHubContext<NivraHub>>();
            var response = new CallResponse(ended.Id, ended.ConversationId, ended.InitiatorUserId, ended.Type, ended.Status,
                ended.ParticipantUserIds.ToList(), ended.StartedAt, ended.EndedAt, ended.InitiatorDeviceId, ended.InitiatorSessionId,
                new(ended.ParticipantSessions, StringComparer.Ordinal), ended.MediaEncryption);
            await hub.Clients.Groups(ended.ParticipantUserIds.Select(GroupsFor.User).ToList()).SendAsync("call.ended", response, ct);
        }
    }
}
