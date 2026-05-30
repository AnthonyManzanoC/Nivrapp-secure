using Nivra.Api.Infrastructure;

namespace Nivra.Api.Security;

public static class AuthExtensions
{
    private const string CurrentUserItem = "__nivra_current_user";

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

                var currentUser = await tokenService.ValidateAccessTokenAsync(token, store, context.RequestAborted);
                if (currentUser is not null)
                {
                    context.Items[CurrentUserItem] = currentUser;
                    var device = await store.GetDeviceAsync(currentUser.DeviceId, context.RequestAborted);
                    if (device is not null)
                    {
                        device.LastSeenAt = TimeProvider.System.GetUtcNow();
                        await store.SaveChangesAsync(context.RequestAborted);
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
}
