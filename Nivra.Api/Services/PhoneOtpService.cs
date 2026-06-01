using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Nivra.Api.Services;

public sealed class PhoneOtpService(TimeProvider timeProvider, ILogger<PhoneOtpService> logger)
{
    private readonly ConcurrentDictionary<string, PhoneOtpChallenge> _challenges = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PhoneAliasSetupChallenge> _aliasSetupChallenges = new(StringComparer.Ordinal);
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan AliasSetupLifetime = TimeSpan.FromMinutes(10);

    public PhoneOtpChallenge Start(string normalizedPhone)
    {
        PurgeExpired();

        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        var challenge = new PhoneOtpChallenge(
            normalizedPhone,
            code,
            timeProvider.GetUtcNow().Add(Lifetime),
            $"Codigo dev: {code}");

        _challenges[normalizedPhone] = challenge;
        logger.LogWarning("Nivra legacy OTP development fallback for {Phone}: {Code}. Firebase Phone Auth is the production phone login path.", normalizedPhone, code);
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

    public PhoneAliasSetupChallenge CreateAliasSetup(string userId, string normalizedPhone)
    {
        PurgeExpired();

        var token = CreateOpaqueToken();
        var challenge = new PhoneAliasSetupChallenge(
            token,
            userId,
            normalizedPhone,
            timeProvider.GetUtcNow().Add(AliasSetupLifetime));

        _aliasSetupChallenges[token] = challenge;
        return challenge;
    }

    public bool TryGetAliasSetup(string token, out PhoneAliasSetupChallenge challenge)
    {
        PurgeExpired();

        var normalizedToken = token.Trim();
        if (_aliasSetupChallenges.TryGetValue(normalizedToken, out challenge!) &&
            challenge.ExpiresAt > timeProvider.GetUtcNow())
        {
            return true;
        }

        challenge = default!;
        return false;
    }

    public void ConsumeAliasSetup(string token)
    {
        _aliasSetupChallenges.TryRemove(token.Trim(), out _);
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

        foreach (var item in _aliasSetupChallenges)
        {
            if (item.Value.ExpiresAt <= now)
            {
                _aliasSetupChallenges.TryRemove(item.Key, out _);
            }
        }
    }

    private static string CreateOpaqueToken()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }
}

public sealed record PhoneOtpChallenge(string Phone, string Code, DateTimeOffset ExpiresAt, string DeliveryHint);

public sealed record PhoneAliasSetupChallenge(string Token, string UserId, string Phone, DateTimeOffset ExpiresAt);
