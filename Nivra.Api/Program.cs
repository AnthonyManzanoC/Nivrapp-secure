using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Realtime;
using Nivra.Api.Security;
using Nivra.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddDebug();

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddProblemDetails();
builder.Services.Configure<NivraSecurityOptions>(builder.Configuration.GetSection("Security"));
builder.Services.Configure<NivraStorageOptions>(builder.Configuration.GetSection("Storage"));
builder.Services.Configure<NivraPushOptions>(builder.Configuration.GetSection("Push"));
builder.Services.Configure<LiveKitOptions>(builder.Configuration.GetSection("LiveKit"));
builder.Services.AddDataProtection();
builder.Services.AddHttpClient();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddDbContext<NivraDbContext>(options =>
{
    var rawConnectionString = builder.Configuration.GetConnectionString("Supabase")
        ?? throw new InvalidOperationException("ConnectionStrings:Supabase is required.");
    options.UseNpgsql(
        PostgresConnection.ToNpgsqlConnectionString(rawConnectionString),
        npgsql =>
        {
            npgsql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery);
            npgsql.EnableRetryOnFailure(3, TimeSpan.FromSeconds(2), null);
        });
});
builder.Services.AddScoped<INivraStore, PgSqlNivraStore>();
builder.Services.AddSingleton<PasswordHasher>();
builder.Services.AddSingleton<TokenService>();
builder.Services.AddSingleton<EncryptedFileStorage>();
builder.Services.AddSingleton<PhoneOtpService>();
builder.Services.AddSingleton<QrLoginService>();
builder.Services.AddSingleton<RealtimePresence>();
builder.Services.AddSingleton<PushNotificationService>();
builder.Services.AddSingleton<LiveKitTokenService>();
builder.Services.AddHostedService<SessionCleanupService>();
builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 512 * 1024;
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(45);
    options.KeepAliveInterval = TimeSpan.FromSeconds(15);
}).AddJsonProtocol(options =>
{
    options.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddCors(options =>
{
    options.AddPolicy("NivraClients", policy =>
    {
        var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
            ?? [
                "http://localhost:5055",
                "https://localhost:5055",
                "http://localhost:4200",
                "http://localhost:5173",
                "http://localhost:8100",
                "capacitor://localhost",
                "ionic://localhost"
            ];

        policy
            .WithOrigins(allowedOrigins)
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials()
            .WithExposedHeaders("WWW-Authenticate")
            .SetPreflightMaxAge(TimeSpan.FromHours(1));
    });
});

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var current = context.GetCurrentUser();
        var key = current is not null
            ? $"user:{current.UserId}"
            : $"ip:{context.Connection.RemoteIpAddress?.ToString() ?? "unknown"}";
        var permitLimit = current is not null ? 1200 : 240;
        return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = permitLimit,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true
        });
    });

    options.AddFixedWindowLimiter("auth", limiter =>
    {
        limiter.PermitLimit = 20;
        limiter.Window = TimeSpan.FromMinutes(1);
        limiter.QueueLimit = 0;
        limiter.AutoReplenishment = true;
    });

    options.AddFixedWindowLimiter("uploads", limiter =>
    {
        limiter.PermitLimit = 30;
        limiter.Window = TimeSpan.FromMinutes(1);
        limiter.QueueLimit = 0;
        limiter.AutoReplenishment = true;
    });
});

var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
    await dbContext.Database.MigrateAsync();
}

app.UseExceptionHandler(exceptionApp =>
{
    exceptionApp.Run(async context =>
    {
        var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        var isBadRequest = exception is BadHttpRequestException;
        context.Response.StatusCode = isBadRequest
            ? StatusCodes.Status400BadRequest
            : StatusCodes.Status500InternalServerError;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new
        {
            code = isBadRequest ? "invalid_request" : "server_error",
            message = isBadRequest ? "Nivra could not read that request." : "Nivra could not complete the request.",
            traceId = context.TraceIdentifier
        });
    });
});

app.Use(async (context, next) =>
{
    context.Response.Headers.TryAdd("X-Content-Type-Options", "nosniff");
    context.Response.Headers.TryAdd("X-Frame-Options", "DENY");
    context.Response.Headers.TryAdd("Referrer-Policy", "no-referrer");
    context.Response.Headers.TryAdd("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
    context.Response.Headers.TryAdd("Cross-Origin-Opener-Policy", "same-origin");
    context.Response.Headers.TryAdd("Cross-Origin-Resource-Policy", "same-origin");
    await next();
});

app.UseCors("NivraClients");
app.UseNivraAuth();
app.UseRateLimiter();

app.MapNivraApi();
app.MapHub<NivraHub>("/hubs/realtime");

app.Run();
