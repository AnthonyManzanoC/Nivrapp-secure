using System.Collections.Concurrent;
using System.Data.Common;
using System.Net.Sockets;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Security;

public static class AuthExtensions
{
    private const string CurrentUserItem = "__nivra_current_user";
    private static readonly ConcurrentDictionary<string, DateTimeOffset> LastSeenWrites = new(StringComparer.Ordinal);
    private static readonly TimeSpan LastSeenWriteInterval = TimeSpan.FromSeconds(45);

    public static IApplicationBuilder UseNivraAuth(this IApplicationBuilder app)
    {
        return app.Use(async (context, next) =>
        {
            var authorization = context.Request.Headers.Authorization.ToString();
            if (authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            {
                var token = authorization["Bearer ".Length..].Trim();
                var tokenService = context.RequestServices.GetRequiredService<TokenService>();
                var store = context.RequestServices.GetRequiredService<INivraStore>();
                var logger = context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Nivra.Api.Security.AuthExtensions");

                CurrentUser? currentUser;
                try
                {
                    currentUser = await tokenService.ValidateAccessTokenAsync(token, store, context.RequestAborted);
                }
                catch (Exception exception) when (IsTransientAuthStoreFailure(exception))
                {
                    logger.LogWarning(exception, "Authentication store is unavailable.");
                    context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                    context.Response.ContentType = "application/json";
                    await context.Response.WriteAsJsonAsync(new
                    {
                        code = "store_unavailable",
                        message = "Nivra is reconnecting to its data store. Try again in a moment.",
                        traceId = context.TraceIdentifier
                    });
                    return;
                }

                if (currentUser is not null)
                {
                    context.Items[CurrentUserItem] = currentUser;
                    var now = TimeProvider.System.GetUtcNow();
                    if (ShouldTouchDevice(currentUser.DeviceId, now))
                    {
                        try
                        {
                            var device = await store.GetDeviceAsync(currentUser.DeviceId, context.RequestAborted);
                            if (device is not null)
                            {
                                device.LastSeenAt = now;
                                await store.SaveChangesAsync(context.RequestAborted);
                            }
                        }
                        catch (Exception exception) when (IsTransientAuthStoreFailure(exception))
                        {
                            logger.LogWarning(exception, "Could not update device last-seen for {DeviceId}.", currentUser.DeviceId);
                        }
                    }
                }
            }

            await next();
        });
    }

    public static CurrentUser? GetCurrentUser(this HttpContext context)
    {
        return context.Items.TryGetValue(CurrentUserItem, out var value) && value is CurrentUser currentUser
            ? currentUser
            : null;
    }

    private static bool ShouldTouchDevice(string deviceId, DateTimeOffset now)
    {
        if (LastSeenWrites.TryGetValue(deviceId, out var lastWrite) &&
            now - lastWrite < LastSeenWriteInterval)
        {
            return false;
        }

        LastSeenWrites[deviceId] = now;
        return true;
    }

    private static bool IsTransientAuthStoreFailure(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is DbException or SocketException or TimeoutException)
            {
                return true;
            }
        }

        return false;
    }
}
