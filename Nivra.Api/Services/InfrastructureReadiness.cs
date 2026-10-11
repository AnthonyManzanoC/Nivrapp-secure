using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nivra.Api.Infrastructure;
using Npgsql;
using StackExchange.Redis;

namespace Nivra.Api.Services;

public sealed class InfrastructureReadiness
{
    public bool Enabled { get; }
    public bool DurableSigningKey { get; }
    public bool SharedStorageConfigured { get; }
    public bool RedisConfigured { get; }
    public bool PushProjectConfigured { get; }
    public string? ClusterFingerprint { get; }

    public InfrastructureReadiness(IConfiguration configuration)
    {
        Enabled = configuration.GetValue<bool>("MultiInstance:Enabled");
        var secret = configuration["Security:TokenSigningKey"] ?? "";
        DurableSigningKey = secret.Length >= 32;
        var storage = configuration.GetSection("Storage").Get<NivraStorageOptions>() ?? new();
        SharedStorageConfigured = EncryptedFileStorage.HasSharedConfiguration(storage);
        RedisConfigured = !string.IsNullOrWhiteSpace(configuration.GetConnectionString("RealtimeRedis"));
        PushProjectConfigured = !string.IsNullOrWhiteSpace(configuration["Push:Fcm:ProjectId"]);
        if (!Enabled || !DurableSigningKey || !SharedStorageConfigured || !RedisConfigured) return;
        ClusterFingerprint = Fingerprint(configuration, secret);
    }

    public bool IsReady(IConnectionMultiplexer? redis, PushNotificationService push) =>
        Enabled && DurableSigningKey && SharedStorageConfigured && RedisConfigured &&
        ClusterFingerprint is not null && redis?.IsConnected == true && PushProjectConfigured && push.IsFcmConfigured && push.IsWebPushConfigured;

    // This is a compatibility pin, not a public hash of a weak secret or an identity proof.
    // It changes if hosts point at different databases, file stores, LiveKit, push or Redis namespaces.
    public static string Fingerprint(IConfiguration configuration, string secret)
    {
        var db = new NpgsqlConnectionStringBuilder(PostgresConnection.ToNpgsqlConnectionString(configuration.GetConnectionString("Supabase") ?? ""));
        var redis = ConfigurationOptions.Parse(configuration.GetConnectionString("RealtimeRedis") ?? "");
        var scope = JsonSerializer.Serialize(new
        {
            protocol = 1,
            database = new { host = db.Host?.ToLowerInvariant(), port = db.Port, name = db.Database },
            storage = new { endpoint = configuration["Storage:Endpoint"]?.TrimEnd('/').ToLowerInvariant(), bucket = configuration["Storage:Bucket"] },
            redis = new { servers = redis.EndPoints.Select(endpoint => endpoint.ToString()).Order(StringComparer.Ordinal).ToArray(), database = redis.DefaultDatabase ?? 0, prefix = configuration["MultiInstance:Namespace"] ?? "nivra" },
            liveKit = new { url = configuration["LiveKit:Url"]?.TrimEnd('/'), key = configuration["LiveKit:ApiKey"], secret = configuration["LiveKit:ApiSecret"] },
            push = new { fcmProject = configuration["Push:Fcm:ProjectId"], webPublicKey = configuration["Push:WebPush:PublicKey"], webPrivateKey = configuration["Push:WebPush:PrivateKey"] }
        });
        var key = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes("Nivra.ClusterCompatibility.v1"));
        return Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(scope))).ToLowerInvariant();
    }

    public void ValidateStartup(bool development)
    {
        if (!Enabled) return;
        if (!DurableSigningKey || !SharedStorageConfigured || !RedisConfigured)
            throw new InvalidOperationException("Multi-instance mode requires a durable signing key, shared S3 storage and shared Redis. Refusing unsafe local fallback.");
    }
}
