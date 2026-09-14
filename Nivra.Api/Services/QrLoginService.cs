using System.Collections.Concurrent;
using System.Security.Cryptography;
using Nivra.Api.Contracts;

namespace Nivra.Api.Services;

public sealed class QrLoginService(TimeProvider timeProvider)
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

        _challenges[id] = challenge;
        return challenge;
    }

    public bool IsValid(string qrId, string code)
    {
        PurgeExpired();
        return _challenges.TryGetValue(qrId, out var challenge) &&
            challenge.ExpiresAt > timeProvider.GetUtcNow() &&
            challenge.Authorization is null &&
            string.Equals(challenge.Code, code.Trim(), StringComparison.Ordinal);
    }

    public QrLoginChallenge? GetPending(string qrId, string code)
    {
        return IsValid(qrId, code) && _challenges.TryGetValue(qrId, out var challenge)
            ? challenge
            : null;
    }

    public QrLoginChallenge? Get(string qrId, string code)
    {
        PurgeExpired();
        return _challenges.TryGetValue(qrId, out var challenge) &&
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

        challenge.ConnectionId = connectionId.Trim();
    }

    public bool TryAuthorize(string qrId, string code, QrLoginAuthorizedResponse authorization)
    {
        var challenge = Get(qrId, code);
        if (challenge is null)
        {
            return false;
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
        _challenges.TryRemove(qrId, out _);
    }

    private void PurgeExpired()
    {
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
