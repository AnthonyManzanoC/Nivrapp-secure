using Microsoft.EntityFrameworkCore;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public sealed class SessionCleanupService(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ILogger<SessionCleanupService> logger) : BackgroundService
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromDays(1);
    private static readonly TimeSpan StaleDeviceWindow = TimeSpan.FromDays(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await SweepAsync(stoppingToken);

        using var timer = new PeriodicTimer(SweepInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await SweepAsync(stoppingToken);
        }
    }

    private async Task SweepAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var now = timeProvider.GetUtcNow();
            var staleBefore = now.Subtract(StaleDeviceWindow);

            var expiredSessions = await db.Sessions
                .Where(session => session.RevokedAt == null && session.ExpiresAt <= now)
                .ToListAsync(cancellationToken);
            foreach (var session in expiredSessions)
            {
                session.RevokedAt = now;
            }

            var staleDevices = await db.Devices
                .Where(device => device.RevokedAt == null)
                .Where(device => (device.LastSeenAt ?? device.CreatedAt) <= staleBefore)
                .Where(device => !db.Sessions.Any(session =>
                    session.DeviceId == device.Id &&
                    session.RevokedAt == null &&
                    session.ExpiresAt > now))
                .ToListAsync(cancellationToken);
            foreach (var device in staleDevices)
            {
                device.RevokedAt = now;
            }

            if (expiredSessions.Count > 0 || staleDevices.Count > 0)
            {
                await db.SaveChangesAsync(cancellationToken);
                logger.LogInformation("Session cleanup revoked {SessionCount} expired sessions and {DeviceCount} stale devices.", expiredSessions.Count, staleDevices.Count);
            }

            await new PgSqlNivraStore(db).PurgeExpiredAsync(now, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Session cleanup failed.");
        }
    }
}
