namespace Nivra.Api.Security;

public static class SecurityResponseHeaders
{
    public static IApplicationBuilder UseNivraSecurityHeaders(this IApplicationBuilder app) =>
        app.Use(async (context, next) =>
        {
            // Register before the exception handler so error responses receive
            // the same protections as successful API responses.
            context.Response.OnStarting(() =>
            {
                var headers = context.Response.Headers;
                headers["X-Content-Type-Options"] = "nosniff";
                headers["X-Frame-Options"] = "DENY";
                headers["Referrer-Policy"] = "no-referrer";
                headers["Permissions-Policy"] = "camera=(self), microphone=(self), display-capture=(self), clipboard-write=(self), geolocation=()";
                headers["Cross-Origin-Opener-Policy"] = "same-origin";
                headers["Cross-Origin-Resource-Policy"] = "same-origin";
                headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
                // The API serves session material, private metadata and encrypted
                // attachments. Offline persistence belongs to the scoped client store.
                headers.CacheControl = "no-store";
                return Task.CompletedTask;
            });
            await next();
        });
}
