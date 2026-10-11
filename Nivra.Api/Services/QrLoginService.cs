using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Nivra.Api.Contracts;

namespace Nivra.Api.Services;

public sealed class QrLoginService(TimeProvider timeProvider, ISharedEphemeralState? shared = null)
{
    private readonly ConcurrentDictionary<string, QrLoginChallenge> _challenges = new(StringComparer.Ordinal);
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan DeliveryLifetime = TimeSpan.FromSeconds(30);

    public QrLoginChallenge Start(string deviceName, KeyBundleRequest? keyBundle, string? publicKey, string? hardwareId)
    {
        PurgeExpired();

        var id = $"qr_{Guid.NewGuid():N}";
        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        var challenge = new QrLoginChallenge(
            id,
            code,
            deviceName.Trim(),
            keyBundle,
            publicKey?.Trim(),
            hardwareId?.Trim(),
            timeProvider.GetUtcNow(),
            timeProvider.GetUtcNow().Add(Lifetime));

        if (shared is null) _challenges[id] = challenge;
        else shared.Write(Key(id), Serialize(challenge), Lifetime);
        return challenge;
    }

    public bool IsValid(string qrId, string code)
    {
        PurgeExpired();
        var challenge = Find(qrId);
        return challenge is not null &&
            challenge.ExpiresAt > timeProvider.GetUtcNow() &&
            challenge.Authorization is null &&
            string.Equals(challenge.Code, code.Trim(), StringComparison.Ordinal);
    }

    public QrLoginChallenge? GetPending(string qrId, string code)
    {
        var challenge = Get(qrId, code);
        return challenge is not null && challenge.ExpiresAt > timeProvider.GetUtcNow() && challenge.Authorization is null ? challenge : null;
    }

    public QrLoginChallenge? Get(string qrId, string code)
    {
        PurgeExpired();
        var challenge = Find(qrId);
        return challenge is not null &&
            (challenge.AuthorizedAt is { } authorizedAt ? authorizedAt.Add(DeliveryLifetime) : challenge.ExpiresAt) > timeProvider.GetUtcNow() &&
            string.Equals(challenge.Code, code.Trim(), StringComparison.Ordinal)
            ? challenge
            : null;
    }

    public void AttachConnection(string qrId, string code, string connectionId)
    {
        var challenge = GetPending(qrId, code);
        if (challenge is null || string.IsNullOrWhiteSpace(connectionId))
        {
            return;
        }

        var previous = Serialize(challenge);
        challenge.ConnectionId = connectionId.Trim();
        if (shared is not null) shared.CompareExchange(Key(qrId), previous, Serialize(challenge), challenge.ExpiresAt - timeProvider.GetUtcNow());
    }

    public bool TryAuthorize(string qrId, string code, QrLoginAuthorizedResponse authorization)
    {
        var challenge = Get(qrId, code);
        if (challenge is null)
        {
            return false;
        }

        if (shared is not null)
        {
            if (challenge.Authorization is not null || challenge.ExpiresAt <= timeProvider.GetUtcNow()) return false;
            var previous = Serialize(challenge);
            challenge.AuthorizedAt = timeProvider.GetUtcNow();
            challenge.Authorization = authorization;
            return shared.CompareExchange(Key(qrId), previous, Serialize(challenge), DeliveryLifetime);
        }

        lock (challenge)
        {
            if (challenge.Authorization is not null || challenge.ExpiresAt <= timeProvider.GetUtcNow())
            {
                return false;
            }
            challenge.AuthorizedAt = timeProvider.GetUtcNow();
            challenge.Authorization = authorization;
            return true;
        }
    }

    // Hold this lease before issuing any device credentials, so repeated scans cannot
    // create extra sessions while the first authorization is still awaiting the database.
    public async Task<IDisposable?> AcquireAuthorizationAsync(string qrId, string code, CancellationToken cancellationToken)
    {
        var challenge = GetPending(qrId, code);
        if (challenge is null)
        {
            return null;
        }
        if (shared is not null)
        {
            var lease = await shared.AcquireLeaseAsync(Key(qrId), Lifetime.Add(DeliveryLifetime), cancellationToken);
            if (lease is null) return null;
            try
            {
                if (GetPending(qrId, code) is not null) return lease;
                lease.Dispose();
                return null;
            }
            catch { lease.Dispose(); throw; }
        }
        await challenge.AuthorizationGate.WaitAsync(cancellationToken);
        if (!IsValid(qrId, code))
        {
            challenge.AuthorizationGate.Release();
            return null;
        }
        return new AuthorizationLease(challenge.AuthorizationGate);
    }

    public void Consume(string qrId)
    {
        if (shared is null) _challenges.TryRemove(qrId, out _);
        else shared.Remove(Key(qrId));
    }

    private static string Key(string qrId) => $"qr:{qrId}";
    private static string Serialize(QrLoginChallenge challenge) => JsonSerializer.Serialize(challenge);
    private QrLoginChallenge? Find(string qrId)
    {
        if (shared is null) return _challenges.TryGetValue(qrId, out var challenge) ? challenge : null;
        var value = shared.Read(Key(qrId));
        return value is null ? null : JsonSerializer.Deserialize<QrLoginChallenge>(value);
    }

    private void PurgeExpired()
    {
        if (shared is not null) return; // Redis TTL removes abandoned challenges across hosts.
        var now = timeProvider.GetUtcNow();
        foreach (var item in _challenges)
        {
            var deadline = item.Value.AuthorizedAt is { } authorizedAt
                ? authorizedAt.Add(DeliveryLifetime)
                : item.Value.ExpiresAt;
            if (deadline <= now)
            {
                _challenges.TryRemove(item.Key, out _);
            }
        }
    }

    private sealed class AuthorizationLease(SemaphoreSlim gate) : IDisposable
    {
        private int _released;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                gate.Release();
            }
        }
    }
}

public sealed class QrLoginChallenge(
    string id,
    string code,
    string deviceName,
    KeyBundleRequest? keyBundle,
    string? publicKey,
    string? hardwareId,
    DateTimeOffset createdAt,
    DateTimeOffset expiresAt)
{
    internal SemaphoreSlim AuthorizationGate { get; } = new(1, 1);
    public string Id { get; } = id;
    public string Code { get; } = code;
    public string DeviceName { get; } = deviceName;
    public KeyBundleRequest? KeyBundle { get; } = keyBundle;
    public string? PublicKey { get; } = publicKey;
    public string? HardwareId { get; } = hardwareId;
    public string? ConnectionId { get; set; }
    public DateTimeOffset CreatedAt { get; } = createdAt;
    public DateTimeOffset ExpiresAt { get; } = expiresAt;
    public DateTimeOffset? AuthorizedAt { get; set; }
    public QrLoginAuthorizedResponse? Authorization { get; set; }
}
