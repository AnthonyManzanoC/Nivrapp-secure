using StackExchange.Redis;
using Nivra.Api.Services;

namespace Nivra.Api.Realtime;

public sealed class DistributedPresenceHeartbeat(RealtimePresence presence, ILogger<DistributedPresenceHeartbeat> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { presence.RenewLocalConnections(); }
            catch (RedisException) { logger.LogWarning("Shared presence heartbeat is unavailable; failover readiness is disabled until Redis recovers."); }
        }
    }
}
