using System.Security.Cryptography;
using System.Text;
using StackExchange.Redis;

namespace Nivra.Api.Services;

public sealed class SharedAuthRateLimiter(IConnectionMultiplexer connection, InfrastructureReadiness infrastructure)
{
    public const int PermitLimit = 20;
    public const int WindowSeconds = 60;
    public static string ScopeKey(string? userId, string? ipAddress) => Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(userId is null ? $"ip:{ipAddress ?? "unknown"}" : $"user:{userId}"))).ToLowerInvariant();

    public async Task<int> RetryAfterAsync(string? userId, string? ipAddress, CancellationToken cancellationToken)
    {
        if (!connection.IsConnected) throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "Shared authentication limit unavailable.");
        var key = $"nivra:{infrastructure.ClusterFingerprint}:auth-limit:{ScopeKey(userId, ipAddress)}";
        // Redis's clock and one atomic script prevent each API from granting its own quota.
        var result = await connection.GetDatabase().ScriptEvaluateAsync("""
            local now = tonumber(redis.call('TIME')[1])
            local window = tonumber(ARGV[2])
            local bucket = math.floor(now / window)
            local stored = tonumber(redis.call('HGET', KEYS[1], 'bucket'))
            local count = 0
            if stored == bucket then count = tonumber(redis.call('HGET', KEYS[1], 'count')) or 0 end
            count = count + 1
            redis.call('HSET', KEYS[1], 'bucket', bucket, 'count', count)
            redis.call('EXPIRE', KEYS[1], window * 2)
            if count > tonumber(ARGV[1]) then return window - (now % window) end
            return 0
            """, [key], [PermitLimit, WindowSeconds]).WaitAsync(cancellationToken);
        return checked((int)(long)result);
    }
}
