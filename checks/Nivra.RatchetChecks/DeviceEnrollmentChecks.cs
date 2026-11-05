using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Endpoints;
using Nivra.Api.Infrastructure;

public static class DeviceEnrollmentChecks
{
    public static async Task Run(WebApplication app)
    {
        const string owner = "usr-lab-carol", hardware = "isolated-reinstall";
        var method = typeof(EndpointExtensions).GetMethod("UpsertDeviceAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        var count = 0;
        void Check(bool condition, string label)
        {
            if (!condition) throw new InvalidOperationException(label);
            Console.WriteLine("PASS enrollment " + label);
            count++;
        }
        KeyBundleRequest Keys()
        {
            using var ec = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
            var point = ec.ExportParameters(false).Q;
            string Coordinate(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var jwk = JsonSerializer.Serialize(new {kty="EC", crv="P-256", x=Coordinate(point.X!), y=Coordinate(point.Y!)});
            return new(jwk, jwk, "fixture", []);
        }
        async Task<DeviceRecord> Enroll(KeyBundleRequest keys)
        {
            await using var scope = app.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            return await (Task<DeviceRecord>)method.Invoke(null, [db, owner, "Reinstalled client", hardware, keys, DateTimeOffset.UtcNow, true, CancellationToken.None])!;
        }
        var originalKeys = Keys();
        var first = await Enroll(originalKeys);
        Check((await Enroll(originalKeys)).Id == first.Id, "same installation and identity retain their device address");
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var device = await db.Devices.SingleAsync(row => row.Id == first.Id);
            device.RevokedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }
        var restored = await Enroll(originalKeys);
        Check(restored.Id != first.Id, "revoked installation receives a fresh address after authenticated reentry");
        var replacementKeys = Keys();
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            db.Sessions.Add(new SessionRecord {Id="session-enrollment", UserId=owner, DeviceId=restored.Id,
                RefreshTokenHash="isolated-fixture", CreatedAt=DateTimeOffset.UtcNow, ExpiresAt=DateTimeOffset.UtcNow.AddHours(1)});
            await db.SaveChangesAsync();
        }
        var replacement = await Enroll(replacementKeys);
        Check(replacement.Id != restored.Id, "lost local keys create a new ratchet address");
        var parallel = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => Enroll(replacementKeys)));
        Check(parallel.All(device => device.Id == replacement.Id), "parallel logins converge on one current installation");
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
            var old = await db.Devices.SingleAsync(row => row.Id == restored.Id);
            Check(old.RevokedAt != null && old.HardwareId == null && old.KeyBundle.IdentityKey == originalKeys.IdentityKey,
                "retired identity and its history references are preserved");
            Check((await db.Sessions.SingleAsync(row => row.Id == "session-enrollment")).RevokedAt != null,
                "old sessions cannot revive after a new identity is enrolled");
            Check(await db.Devices.CountAsync(row => row.UserId == owner && row.HardwareId == hardware && row.RevokedAt == null) == 1,
                "database retains one active hardware binding");
        }
        Console.WriteLine($"PASS {count} PostgreSQL device reenrollment checks");
    }
}
