using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;
using Nivra.Api.Security;
using Nivra.Api.Services;

public static class DeviceAuthorityChecks
{
    public static async Task Run(WebApplication app, Dictionary<string, string> existingTokens)
    {
        const string userId = "usr-authority-fixture";
        int checks = 0;
        void Check(bool value, string label) { if (!value) throw new InvalidOperationException(label); checks++; Console.WriteLine("PASS authority " + label); }
        using var root = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var point = root.ExportParameters(false).Q;
        string Coordinate(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var rootKey = Coordinate(point.X!) + ":" + Coordinate(point.Y!);
        string Sign(byte[] value) => Convert.ToBase64String(root.SignData(value, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        var tokens = new Dictionary<string, string>();
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var now = DateTimeOffset.UtcNow;
            db.Users.Add(new UserAccount { Id = userId, Alias = "authority-fixture", PasswordHash = new("fixture", 1, "fixture", "fixture"), CreatedAt = now, UpdatedAt = now });
            db.AccountIdentities.Add(new AccountIdentityRecord { UserId = userId, PublicJson = JsonSerializer.Serialize(new AccountRootPublic(1, rootKey, "authority-web", Convert.ToBase64String(new byte[64]), rootKey, "fixture"), AccountIdentityPolicy.Json), PasswordBackup = "opaque", RecoveryBackup = "opaque", CreatedAt = now });
            await db.SaveChangesAsync();
        }
        async Task Enroll(string id, bool certified = true)
        {
            await using var scope = app.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            using var deviceKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var q = deviceKey.ExportParameters(false).Q;
            var coordinates = Coordinate(q.X!) + ":" + Coordinate(q.Y!);
            var hybrid = Convert.ToBase64String(RandomNumberGenerator.GetBytes(64));
            var certificate = new AccountDeviceCertificate(1, rootKey, id, coordinates, hybrid, "");
            certificate = certificate with { Signature = Sign(AccountIdentityPolicy.DeviceStatement(userId, certificate)) };
            var device = new DeviceRecord { Id = id, UserId = userId, Name = "Synthetic " + id, IsTrusted = true, CreatedAt = DateTimeOffset.UtcNow,
                KeyBundle = new KeyBundle { IdentityKey = JsonSerializer.Serialize(new { kty = "EC", crv = "P-256", x = Coordinate(q.X!), y = Coordinate(q.Y!) }) },
                AccountCertificateJson = certified ? JsonSerializer.Serialize(certificate, AccountIdentityPolicy.Json) : null };
            db.Devices.Add(device); db.Set<RatchetPilotDevice>().Add(new RatchetPilotDevice { DeviceId = id, UserId = userId, IdentityKey = hybrid, AddressMode = 2, SignalDeviceNumber = 1, RegistrationId = 1, CreatedAt = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
            var user = await db.Users.SingleAsync(row => row.Id == userId);
            var pair = await scope.ServiceProvider.GetRequiredService<TokenService>().CreateSessionAsync(scope.ServiceProvider.GetRequiredService<INivraStore>(), user, device, null, null);
            tokens[id] = pair.AccessToken;
        }
        foreach (var id in new[] { "authority-web", "authority-apk-older", "authority-apk-newer", "authority-exe", "authority-uncertified" }) await Enroll(id, id != "authority-uncertified");
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        async Task<HttpResponseMessage> Request(string? token, HttpMethod method, string path, object? body = null)
        {
            using var request = new HttpRequestMessage(method, path);
            if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (body is not null) request.Content = JsonContent.Create(body);
            return await client.SendAsync(request);
        }
        DevicePlatformDeclaration Declaration(string id, string platform)
        {
            var value = new DevicePlatformDeclaration(1, rootKey, id, platform, "");
            return value with { Signature = Sign(DeviceAuthorityPolicy.Statement(userId, value)) };
        }
        async Task<DeviceAuthorityResponse> Declare(string id, string platform)
        {
            using var response = await Request(tokens[id], HttpMethod.Post, "/devices/authority/platform", Declaration(id, platform));
            Check(response.StatusCode == HttpStatusCode.OK, "root-certified " + platform + " declares its own platform");
            return (await response.Content.ReadFromJsonAsync<DeviceAuthorityResponse>())!;
        }
        async Task<DeviceAuthorityResponse> Read(string id)
        {
            using var response = await Request(tokens[id], HttpMethod.Get, "/devices/authority");
            Check(response.StatusCode == HttpStatusCode.OK, "active linked session reads its own hierarchy");
            Check(response.Headers.CacheControl?.NoStore == true, "device hierarchy is not cacheable");
            return (await response.Content.ReadFromJsonAsync<DeviceAuthorityResponse>())!;
        }
        using (var denied = await Request(null, HttpMethod.Get, "/devices/authority")) Check(denied.StatusCode == HttpStatusCode.Unauthorized, "anonymous hierarchy access denied");
        using (var denied = await Request(tokens["authority-uncertified"], HttpMethod.Post, "/devices/authority/platform", Declaration("authority-uncertified", "android"))) Check(denied.StatusCode == HttpStatusCode.BadRequest, "claiming Android cannot replace a missing root certificate");
        using (var denied = await Request(tokens["authority-web"], HttpMethod.Post, "/devices/authority/platform", Declaration("authority-apk-older", "android"))) Check(denied.StatusCode == HttpStatusCode.BadRequest, "a root signer cannot declare a different session's device");
        using (var denied = await Request(existingTokens["alice"], HttpMethod.Post, "/devices/authority/platform", Declaration("authority-web", "android"))) Check(denied.StatusCode == HttpStatusCode.BadRequest, "cross-account declarations rejected");
        using (var denied = await Request(tokens["authority-web"], HttpMethod.Post, "/devices/authority/platform", Declaration("authority-web", "android") with { Signature = Convert.ToBase64String(new byte[64]) })) Check(denied.StatusCode == HttpStatusCode.BadRequest, "forged root platform signature rejected");
        using (var denied = await Request(tokens["authority-web"], HttpMethod.Post, "/devices/authority/platform", Declaration("authority-web", "admin"))) Check(denied.StatusCode == HttpStatusCode.BadRequest, "unknown platform is not an authority role");
        Check((await Declare("authority-web", "web")).PrimaryDeviceId == "authority-web", "web leads before any verified APK exists");
        Check((await Declare("authority-apk-older", "android")).PrimaryDeviceId == "authority-apk-older", "APK-first priority supersedes an older browser declaration");
        await Declare("authority-apk-newer", "android");
        var simultaneous = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Read("authority-web")));
        Check(simultaneous.All(value => value.PrimaryDeviceId == "authority-apk-older" && value.Devices.Count == 5), "2 APK plus web and EXE sessions converge without session collisions");
        await Declare("authority-exe", "desktop");
        var repeat = await Declare("authority-apk-older", "android");
        Check(repeat.PrimaryDeviceId == "authority-apk-older", "repeated signed declaration preserves verified seniority");
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            (await db.Devices.SingleAsync(row => row.Id == "authority-apk-older")).RevokedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }
        Check((await Read("authority-web")).PrimaryDeviceId == "authority-apk-newer", "revoking the principal automatically elects the next verified APK");
        using (var denied = await Request(tokens["authority-apk-older"], HttpMethod.Get, "/devices/authority")) Check(denied.StatusCode == HttpStatusCode.Unauthorized, "revoked principal loses access immediately");
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            await db.Sessions.Where(row => row.DeviceId == "authority-apk-newer").ExecuteUpdateAsync(update => update.SetProperty(row => row.ExpiresAt, DateTimeOffset.UtcNow.AddMinutes(-1)));
        }
        var expired = await Read("authority-web");
        Check(expired.PrimaryDeviceId == "authority-web" && expired.Devices.All(row => row.DeviceId != "authority-apk-newer"), "an APK without a live authenticated session cannot strand the principal role");
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            await db.Devices.Where(row => row.UserId == userId).ExecuteUpdateAsync(update => update.SetProperty(row => row.RevokedAt, DateTimeOffset.UtcNow));
        }
        await Enroll("authority-reentered-web");
        Check((await Read("authority-reentered-web")).PrimaryDeviceId == "authority-reentered-web", "authenticated reentry is elected even before its platform declaration after all devices were revoked");
        Check((await Declare("authority-reentered-web", "web")).PrimaryDeviceId == "authority-reentered-web", "recovered same root certifies the new principal without an orphan account");
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var device = await db.Devices.SingleAsync(row => row.Id == "authority-uncertified");
            Check(device.AccountCertificateJson is null, "platform routing never grants account identity trust or private keys");
            Check(await db.AccountIdentities.CountAsync(row => row.UserId == userId) == 1, "revoking every device retains exactly one established account root");
        }
        Console.WriteLine($"PASS {checks} PostgreSQL device authority checks");
    }
}
