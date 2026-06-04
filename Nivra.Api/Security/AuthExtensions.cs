using System.Collections.Concurrent;
using System.Data.Common;
using System.Net.Sockets;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Security;

public static class AuthExtensions
{
    private const string CurrentUserItem = "__nivra_current_user";
    private const string ForceWipeCode = "FORCE_WIPE";
    private const string DeviceIdHeader = "X-Nivra-Device-Id";
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
                    try
                    {
                        var device = await store.GetDeviceAsync(currentUser.DeviceId, context.RequestAborted);
                        if (device?.RevokedAt is not null)
                        {
                            await WriteForceWipeAsync(context, currentUser.DeviceId, device.RevokedAt);
                            return;
                        }

                        if (device is not null && ShouldTouchDevice(currentUser.DeviceId, now))
                        {
                            device.LastSeenAt = now;
                            await store.SaveChangesAsync(context.RequestAborted);
                        }
                    }
                    catch (Exception exception) when (IsTransientAuthStoreFailure(exception))
                    {
                        logger.LogWarning(exception, "Could not validate device state for {DeviceId}.", currentUser.DeviceId);
                    }
                }
                else if (await TryWriteForceWipeForRevokedDeviceAsync(context, store, logger))
                {
                    return;
                }
            }
            else if (!string.IsNullOrWhiteSpace(context.Request.Headers[DeviceIdHeader].FirstOrDefault()) &&
                await TryWriteForceWipeForRevokedDeviceAsync(
                    context,
                    context.RequestServices.GetRequiredService<INivraStore>(),
                    context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Nivra.Api.Security.AuthExtensions")))
            {
                return;
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

    private static async Task<bool> TryWriteForceWipeForRevokedDeviceAsync(HttpContext context, INivraStore store, ILogger logger)
    {
        var deviceId = context.Request.Headers[DeviceIdHeader].FirstOrDefault()?.Trim();
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            return false;
        }

        try
        {
            var device = await store.GetDeviceAsync(deviceId, context.RequestAborted);
            if (device?.RevokedAt is null)
            {
                return false;
            }

            await WriteForceWipeAsync(context, device.Id, device.RevokedAt);
            return true;
        }
        catch (Exception exception) when (IsTransientAuthStoreFailure(exception))
        {
            logger.LogWarning(exception, "Could not check revoked device state for {DeviceId}.", deviceId);
            return false;
        }
    }

    private static Task WriteForceWipeAsync(HttpContext context, string deviceId, DateTimeOffset? revokedAt)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.ContentType = "application/json";
        context.Response.Headers.TryAdd("X-Nivra-Action", ForceWipeCode);
        return context.Response.WriteAsJsonAsync(new
        {
            code = ForceWipeCode,
            message = "This device was revoked and must wipe local Nivra data.",
            deviceId,
            revokedAt
        });
    }
}
