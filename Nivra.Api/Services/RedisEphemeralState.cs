using StackExchange.Redis;

namespace Nivra.Api.Services;

public sealed class RedisEphemeralState(IConnectionMultiplexer connection, SharedStateCipher cipher, InfrastructureReadiness infrastructure) : ISharedEphemeralState
{
    private readonly string prefix = $"nivra:{infrastructure.ClusterFingerprint}:state:";
    private IDatabase Db => connection.GetDatabase();

    public string? Read(string key)
    {
        var value = Db.StringGet(prefix + key);
        return value.IsNull ? null : cipher.Unprotect(value.ToString());
    }

    public void Write(string key, string value, TimeSpan lifetime) => Db.StringSet(prefix + key, cipher.Protect(value), lifetime);

    // The expected value is rechecked atomically against the current encrypted value.
    // Encryption is randomized, so compare the current plaintext first and CAS its ciphertext.
    public bool CompareExchange(string key, string expected, string replacement, TimeSpan lifetime)
    {
        var actual = Db.StringGet(prefix + key);
        if (actual.IsNull || !string.Equals(cipher.Unprotect(actual!), expected, StringComparison.Ordinal)) return false;
        return (long)Db.ScriptEvaluate("if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PSETEX', KEYS[1], ARGV[3], ARGV[2]); return 1 end; return 0",
            [prefix + key], [actual, cipher.Protect(replacement), (long)lifetime.TotalMilliseconds]) == 1;
    }

    public bool TryTake(string key, string expected)
    {
        var actual = Db.StringGet(prefix + key);
        if (actual.IsNull || !string.Equals(cipher.Unprotect(actual!), expected, StringComparison.Ordinal)) return false;
        return (long)Db.ScriptEvaluate("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0", [prefix + key], [actual]) == 1;
    }

    public void Remove(string key) => Db.KeyDelete(prefix + key);

    public async Task<IDisposable?> AcquireLeaseAsync(string key, TimeSpan lifetime, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var owner = Guid.NewGuid().ToString("N");
        var leaseKey = prefix + "lease:" + key;
        // One attempt: a second scan must never issue credentials while the first is pending.
        if (!await Db.StringSetAsync(leaseKey, owner, lifetime, When.NotExists).WaitAsync(cancellationToken)) return null;
        return new Lease(Db, leaseKey, owner);
    }

    private sealed class Lease(IDatabase db, string key, string owner) : IDisposable
    {
        private int disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            try { db.ScriptEvaluate("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0", [key], [owner]); }
            catch (RedisException) { /* TTL releases abandoned leases; never remove another owner's lock. */ }
        }
    }
}
