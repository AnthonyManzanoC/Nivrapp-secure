using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;

namespace Nivra.Api.Services;

public sealed class LiveKitOptions
{
    public string? Url { get; set; }
    public string? ApiKey { get; set; }
    public string? ApiSecret { get; set; }
    public int TokenMinutes { get; set; } = 45;
}

public sealed record LiveKitRoomToken(string ServerUrl, string Token);

public sealed class LiveKitTokenService
{
    private readonly LiveKitOptions _options;
    private readonly TimeProvider _timeProvider;

    public LiveKitTokenService(IOptions<LiveKitOptions> options, TimeProvider timeProvider)
    {
        _options = options.Value;
        _timeProvider = timeProvider;
    }

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(_options.Url) &&
        !string.IsNullOrWhiteSpace(_options.ApiKey) &&
        !string.IsNullOrWhiteSpace(_options.ApiSecret);

    public LiveKitRoomToken CreateRoomToken(ConversationRecord group, UserAccount user)
    {
        return CreateRoomToken(RoomName(group.Id), user);
    }

    public LiveKitRoomToken CreateRoomToken(string roomName, UserAccount user)
    {
        if (!IsConfigured)
        {
            throw new InvalidOperationException("LiveKit is not configured.");
        }

        var now = _timeProvider.GetUtcNow();
        var expiresAt = now.AddMinutes(Math.Clamp(_options.TokenMinutes, 5, 180));
        var identity = user.Id;
        var displayName = string.IsNullOrWhiteSpace(user.DisplayName) ? user.Alias : user.DisplayName;
        var payload = new LiveKitJwtPayload(
            Issuer: _options.ApiKey!.Trim(),
            Subject: identity,
            Name: displayName,
            NotBefore: now.ToUnixTimeSeconds(),
            ExpiresAt: expiresAt.ToUnixTimeSeconds(),
            JwtId: NivraIds.NewId("lk"),
            Video: new LiveKitVideoGrant(
                RoomJoin: true,
                Room: roomName,
                CanPublish: true,
                CanSubscribe: true,
                CanPublishData: true));

        var token = Sign(payload, _options.ApiSecret!.Trim());
        return new LiveKitRoomToken(_options.Url!.Trim(), token);
    }

    public static string RoomName(string groupId) => $"nivra-group-{groupId}";

    public static string VaultVoiceRoomName(string roomId) => $"nivra-vault-audio-{roomId}";

    private static string Sign(LiveKitJwtPayload payload, string secret)
    {
        var header = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new
        {
            alg = "HS256",
            typ = "JWT"
        }));
        var body = Base64Url(JsonSerializer.SerializeToUtf8Bytes(payload, LiveKitJson.Options));
        var unsigned = $"{header}.{body}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return $"{unsigned}.{Base64Url(hmac.ComputeHash(Encoding.UTF8.GetBytes(unsigned)))}";
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

internal sealed record LiveKitJwtPayload(
    [property: JsonPropertyName("iss")] string Issuer,
    [property: JsonPropertyName("sub")] string Subject,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("nbf")] long NotBefore,
    [property: JsonPropertyName("exp")] long ExpiresAt,
    [property: JsonPropertyName("jti")] string JwtId,
    [property: JsonPropertyName("video")] LiveKitVideoGrant Video);

internal sealed record LiveKitVideoGrant(
    [property: JsonPropertyName("roomJoin")] bool RoomJoin,
    [property: JsonPropertyName("room")] string Room,
    [property: JsonPropertyName("canPublish")] bool CanPublish,
    [property: JsonPropertyName("canSubscribe")] bool CanSubscribe,
    [property: JsonPropertyName("canPublishData")] bool CanPublishData);

internal static class LiveKitJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}
