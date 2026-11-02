using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;

// Exercise the actual auth route mapper. Never open a database, resolve token
// services, register Firebase or create an account during a disabled-route probe.
int checks = 0, resolutions = 0;
void Check(bool value, string label) { if (!value) throw new InvalidOperationException(label); checks++; Console.WriteLine("PASS " + label); }
foreach (var environment in new[] { "Production", "Staging", "Testing", "Development" })
{
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
    builder.Configuration.Sources.Clear(); builder.Configuration.AddInMemoryCollection(new Dictionary<string,string?>());
    builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
    builder.Services.AddRateLimiter(options => options.AddFixedWindowLimiter("auth", limiter => { limiter.PermitLimit = 50; limiter.Window = TimeSpan.FromMinutes(1); }));
    foreach (var type in new[] { typeof(INivraStore), typeof(NivraDbContext), typeof(PasswordHasher), typeof(TokenService), typeof(PhoneOtpService), typeof(PushNotificationService), typeof(QrLoginService) })
        builder.Services.AddScoped(type, _ => { resolutions++; throw new InvalidOperationException("A disabled legacy endpoint resolved " + type.Name); });
    builder.Services.AddSingleton(TimeProvider.System);
    builder.Services.AddSignalR();
    await using var app = builder.Build(); app.UseRateLimiter();
    var mapper = typeof(EndpointExtensions).GetMethod("MapAuthEndpoints", BindingFlags.NonPublic | BindingFlags.Static)!;
    mapper.Invoke(null, [app]); await app.StartAsync();
    var routes = ((IEndpointRouteBuilder)app).DataSources.SelectMany(source => source.Endpoints).OfType<RouteEndpoint>().Select(endpoint => endpoint.RoutePattern.RawText).ToHashSet();
    Check(routes.Contains("/auth/phone/verify-firebase"), environment + " keeps verified Firebase phone login");
    if (environment == "Development")
    {
        Check(routes.Contains("/auth/phone/start") && routes.Contains("/auth/phone/verify"), "local development retains its explicit OTP fixture");
    }
    else
    {
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        foreach (var path in new[] { "/auth/phone/start", "/auth/phone/verify" })
        {
            using var response = await client.PostAsJsonAsync(path, new { phone = "+16505550199", code = "000000", deviceName = "synthetic" });
            Check(response.StatusCode == HttpStatusCode.NotFound, environment + " rejects " + path + " before authentication services");
            Check(!(await response.Content.ReadAsStringAsync()).Contains("Codigo dev", StringComparison.OrdinalIgnoreCase), "disabled route never reveals an OTP hint");
        }
    }
    await app.StopAsync();
}
Check(resolutions == 0, "production boundary probes never resolve account, database, token or push services");
Console.WriteLine($"Completed {checks} authentication boundary checks without external services.");
