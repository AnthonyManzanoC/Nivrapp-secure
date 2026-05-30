using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Security;

public sealed class NivraSecurityOptions
{
    public string? TokenSigningKey { get; set; }
    public int AccessTokenMinutes { get; set; } = 60;
    public int RefreshTokenDays { get; set; } = 30;
}

public sealed record TokenPair(
    string AccessToken,
    DateTimeOffset AccessTokenExpiresAt,
    string RefreshToken,
    DateTimeOffset RefreshTokenExpiresAt);

public sealed record CurrentUser(string UserId, string DeviceId, string SessionId);

internal sealed record AccessTokenPayload(
    string UserId,
    string DeviceId,
    string SessionId,
    string Jti,
    long ExpiresUnixSeconds);

public sealed class TokenService
{
    private readonly byte[] _signingKey;
    private readonly TimeProvider _timeProvider;
    private readonly NivraSecurityOptions _options;
    private readonly ILogger<TokenService> _logger;

    public TokenService(IOptions<NivraSecurityOptions> options, TimeProvider timeProvider, ILogger<TokenService> logger)
    {
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;

        if (string.IsNullOrWhiteSpace(_options.TokenSigningKey))
        {
            _signingKey = RandomNumberGenerator.GetBytes(32);
            _logger.LogWarning("Nivra is using an ephemeral token signing key. Set Security:TokenSigningKey before production.");
        }
        else
        {
            _signingKey = SHA256.HashData(Encoding.UTF8.GetBytes(_options.TokenSigningKey));
        }
    }

    public async Task<TokenPair> CreateSessionAsync(INivraStore store, UserAccount user, DeviceRecord device, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default)
    {
        var now = _timeProvider.GetUtcNow();
        var refreshToken = CreateOpaqueToken();
        var session = new SessionRecord
        {
            Id = NivraIds.NewId("ses"),
            UserId = user.Id,
            DeviceId = device.Id,
            RefreshTokenHash = HashOpaqueToken(refreshToken),
            CreatedAt = now,
            ExpiresAt = now.AddDays(_options.RefreshTokenDays),
            CreatedIp = ipAddress,
            UserAgent = userAgent
        };

        await store.AddSessionAsync(session, cancellationToken);
        return CreateTokenPair(session, refreshToken);
    }

    public async Task<TokenPair?> RefreshSessionAsync(INivraStore store, string refreshToken, CancellationToken cancellationToken = default)
    {
        var now = _timeProvider.GetUtcNow();
        var refreshHash = HashOpaqueToken(refreshToken);
        var session = await store.FindSessionByRefreshHashAsync(refreshHash, now, cancellationToken);

        if (session is null ||
            !await store.UserExistsAsync(session.UserId, cancellationToken) ||
            await store.GetDeviceAsync(session.DeviceId, cancellationToken) is not { RevokedAt: null })
        {
            return null;
        }

        var nextRefresh = CreateOpaqueToken();
        session.RefreshTokenHash = HashOpaqueToken(nextRefresh);
        session.ExpiresAt = now.AddDays(_options.RefreshTokenDays);
        await store.SaveChangesAsync(cancellationToken);

        return CreateTokenPair(session, nextRefresh);
    }

    public async Task<CurrentUser?> ValidateAccessTokenAsync(string token, INivraStore store, CancellationToken cancellationToken = default)
    {
        try
        {
            var parts = token.Split('.', 2);
            if (parts.Length != 2)
            {
                return null;
            }

            var payloadBytes = Base64UrlDecode(parts[0]);
            var expectedSignature = Sign(parts[0]);
            var actualSignature = Base64UrlDecode(parts[1]);

            if (expectedSignature.Length != actualSignature.Length ||
                !CryptographicOperations.FixedTimeEquals(expectedSignature, actualSignature))
            {
                return null;
            }

            var payload = JsonSerializer.Deserialize<AccessTokenPayload>(payloadBytes);
            if (payload is null || payload.ExpiresUnixSeconds <= _timeProvider.GetUtcNow().ToUnixTimeSeconds())
            {
                return null;
            }

            var session = await store.GetSessionAsync(payload.SessionId, cancellationToken);
            if (session is null ||
                session.RevokedAt is not null ||
                session.UserId != payload.UserId ||
                session.DeviceId != payload.DeviceId)
            {
                return null;
            }

            var user = await store.GetUserAsync(payload.UserId, cancellationToken);
            if (user is null || user.DisabledAt is not null)
            {
                return null;
            }

            var device = await store.GetDeviceAsync(payload.DeviceId, cancellationToken);
            if (device is null || device.RevokedAt is not null)
            {
                return null;
            }

            return new CurrentUser(payload.UserId, payload.DeviceId, payload.SessionId);
        }
        catch (FormatException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public string HashOpaqueToken(string token)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    }

    public Task RevokeSessionAsync(INivraStore store, string sessionId, CancellationToken cancellationToken = default)
    {
        return store.RevokeSessionAsync(sessionId, _timeProvider.GetUtcNow(), cancellationToken);
    }

    private TokenPair CreateTokenPair(SessionRecord session, string refreshToken)
    {
        var now = _timeProvider.GetUtcNow();
        var accessExpiresAt = now.AddMinutes(_options.AccessTokenMinutes);
        var refreshExpiresAt = session.ExpiresAt;
        var payload = new AccessTokenPayload(
            session.UserId,
            session.DeviceId,
            session.Id,
            NivraIds.NewId("tok"),
            accessExpiresAt.ToUnixTimeSeconds());

        var payloadJson = JsonSerializer.SerializeToUtf8Bytes(payload);
        var encodedPayload = Base64UrlEncode(payloadJson);
        var encodedSignature = Base64UrlEncode(Sign(encodedPayload));

        return new TokenPair($"{encodedPayload}.{encodedSignature}", accessExpiresAt, refreshToken, refreshExpiresAt);
    }

    private byte[] Sign(string encodedPayload)
    {
        using var hmac = new HMACSHA256(_signingKey);
        return hmac.ComputeHash(Encoding.UTF8.GetBytes(encodedPayload));
    }

    private static string CreateOpaqueToken() => Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private static string Base64UrlEncode(byte[] bytes)
    {
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }
}
