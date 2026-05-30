using System.Collections.Concurrent;
using System.Security.Cryptography;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public sealed class PhoneOtpService(TimeProvider timeProvider)
{
    private readonly ConcurrentDictionary<string, PhoneOtpChallenge> _challenges = new(StringComparer.Ordinal);
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    public PhoneOtpChallenge Start(string normalizedPhone)
    {
        PurgeExpired();

        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        var challenge = new PhoneOtpChallenge(
            normalizedPhone,
            code,
            timeProvider.GetUtcNow().Add(Lifetime));

        _challenges[normalizedPhone] = challenge;
        return challenge;
    }

    public bool TryVerify(string normalizedPhone, string code)
    {
        PurgeExpired();

        if (!_challenges.TryGetValue(normalizedPhone, out var challenge) ||
            challenge.ExpiresAt <= timeProvider.GetUtcNow() ||
            !CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.UTF8.GetBytes(challenge.Code),
                System.Text.Encoding.UTF8.GetBytes(code.Trim())))
        {
            return false;
        }

        _challenges.TryRemove(normalizedPhone, out _);
        return true;
    }

    private void PurgeExpired()
    {
        var now = timeProvider.GetUtcNow();
        foreach (var item in _challenges)
        {
            if (item.Value.ExpiresAt <= now)
            {
                _challenges.TryRemove(item.Key, out _);
            }
        }
    }
}

public sealed record PhoneOtpChallenge(string Phone, string Code, DateTimeOffset ExpiresAt);
