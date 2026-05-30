using System.Collections.Concurrent;
using System.Security.Cryptography;
using Nivra.Api.Contracts;

namespace Nivra.Api.Services;

public sealed class QrLoginService(TimeProvider timeProvider)
{
    private readonly ConcurrentDictionary<string, QrLoginChallenge> _challenges = new(StringComparer.Ordinal);
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);

    public QrLoginChallenge Start(string deviceName, KeyBundleRequest keyBundle)
    {
        PurgeExpired();

        var id = $"qr_{Guid.NewGuid():N}";
        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        var challenge = new QrLoginChallenge(
            id,
            code,
            deviceName.Trim(),
            keyBundle,
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
            challenge.Auth is null &&
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

    public bool TryAuthorize(string qrId, string code, AuthResponse auth)
    {
        var challenge = GetPending(qrId, code);
        if (challenge is null)
        {
            return false;
        }

        challenge.Auth = auth;
        challenge.AuthorizedAt = timeProvider.GetUtcNow();
        return true;
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
            if (item.Value.ExpiresAt <= now && item.Value.Auth is null)
            {
                _challenges.TryRemove(item.Key, out _);
            }
        }
    }
}

public sealed class QrLoginChallenge(
    string id,
    string code,
    string deviceName,
    KeyBundleRequest keyBundle,
    DateTimeOffset createdAt,
    DateTimeOffset expiresAt)
{
    public string Id { get; } = id;
    public string Code { get; } = code;
    public string DeviceName { get; } = deviceName;
    public KeyBundleRequest KeyBundle { get; } = keyBundle;
    public DateTimeOffset CreatedAt { get; } = createdAt;
    public DateTimeOffset ExpiresAt { get; } = expiresAt;
    public DateTimeOffset? AuthorizedAt { get; set; }
    public AuthResponse? Auth { get; set; }
}
