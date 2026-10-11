using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

namespace Nivra.Api.Services;

public sealed class PhoneOtpService(TimeProvider timeProvider, ILogger<PhoneOtpService> logger, ISharedEphemeralState? shared = null)
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

        if (shared is null) _challenges[normalizedPhone] = challenge;
        else shared.Write(OtpKey(normalizedPhone), JsonSerializer.Serialize(challenge), Lifetime);
        logger.LogWarning("Nivra legacy OTP development fallback for {Phone}: {Code}. Firebase Phone Auth is the production phone login path.", normalizedPhone, code);
        return challenge;
    }

    public bool TryVerify(string normalizedPhone, string code)
    {
        PurgeExpired();

        PhoneOtpChallenge? challenge;
        string? value = null;
        if (shared is null) _challenges.TryGetValue(normalizedPhone, out challenge);
        else { value = shared.Read(OtpKey(normalizedPhone)); challenge = value is null ? null : JsonSerializer.Deserialize<PhoneOtpChallenge>(value); }
        if (challenge is null ||
            challenge.ExpiresAt <= timeProvider.GetUtcNow() ||
            !CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.UTF8.GetBytes(challenge.Code),
                System.Text.Encoding.UTF8.GetBytes(code.Trim())))
        {
            return false;
        }

        return shared is null ? _challenges.TryRemove(normalizedPhone, out _) : shared.TryTake(OtpKey(normalizedPhone), value!);
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

        if (shared is null) _aliasSetupChallenges[token] = challenge;
        else shared.Write(AliasKey(token), JsonSerializer.Serialize(challenge), AliasSetupLifetime);
        return challenge;
    }

    public bool TryGetAliasSetup(string token, out PhoneAliasSetupChallenge challenge)
    {
        PurgeExpired();

        var normalizedToken = token.Trim();
        if (shared is not null)
        {
            var value = shared.Read(AliasKey(normalizedToken));
            challenge = value is null ? default! : JsonSerializer.Deserialize<PhoneAliasSetupChallenge>(value)!;
            return challenge is not null && challenge.ExpiresAt > timeProvider.GetUtcNow();
        }
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
        if (shared is null) _aliasSetupChallenges.TryRemove(token.Trim(), out _);
        else shared.Remove(AliasKey(token.Trim()));
    }

    private void PurgeExpired()
    {
        if (shared is not null) return;
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

    private static string OtpKey(string phone) => "otp:" + Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(phone)));
    private static string AliasKey(string token) => "alias:" + Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token)));

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
