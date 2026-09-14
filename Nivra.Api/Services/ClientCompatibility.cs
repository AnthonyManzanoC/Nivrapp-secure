namespace Nivra.Api.Services;

public static class ClientCompatibility
{
    public const int CallProtocol = 2;
    public const string Version = "1.1.0";
    public const string UpdateUrl = "https://nivrapp-secure.vercel.app";

    public static bool RequiresCallProtocol(PathString path, string method)
    {
        if (HttpMethods.IsOptions(method)) return false;
        var value = path.Value?.TrimEnd('/') ?? "";
        // Older clients can still hang up their existing call during rollout.
        if (value.StartsWith("/calls/", StringComparison.OrdinalIgnoreCase) && value.EndsWith("/end", StringComparison.OrdinalIgnoreCase)) return false;
        return value.StartsWith("/calls/", StringComparison.OrdinalIgnoreCase) &&
                !value.Equals("/calls/ice-config", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/api/calls/room-token/", StringComparison.OrdinalIgnoreCase);
    }

    public static object Description() => new
    {
        version = Version,
        minimumCallProtocol = CallProtocol,
        updateUrl = UpdateUrl,
        message = "Hay una nueva versión de Nivra disponible. Actualiza para seguir llamando."
    };

    public static IApplicationBuilder UseCallCompatibility(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        if (RequiresCallProtocol(context.Request.Path, context.Request.Method) &&
            (!int.TryParse(context.Request.Headers["X-Nivra-Call-Protocol"], out var protocol) || protocol < CallProtocol))
        {
            context.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
            await context.Response.WriteAsJsonAsync(new
            {
                code = "client_update_required",
                message = "Hay una nueva versión de Nivra disponible. Actualiza para seguir llamando.",
                minimumCallProtocol = CallProtocol,
                version = Version,
                updateUrl = UpdateUrl
            });
            return;
        }
        await next();
    });
}
