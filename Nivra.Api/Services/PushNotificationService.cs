using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public sealed class NivraPushOptions
{
    public bool Enabled { get; init; }
    public string Provider { get; init; } = "Fcm";
    public bool IncludeNotificationPayload { get; init; } = true;
    public FcmPushOptions Fcm { get; init; } = new();
}

public sealed class FcmPushOptions
{
    public string ProjectId { get; init; } = "";
    public string ServiceAccountJson { get; init; } = "";
    public string ServiceAccountJsonBase64 { get; init; } = "";
    public string TokenUri { get; init; } = "https://oauth2.googleapis.com/token";
}

public sealed class PushNotificationService(
    IServiceScopeFactory scopeFactory,
    IHttpClientFactory httpClientFactory,
    IDataProtectionProvider dataProtectionProvider,
    IOptionsMonitor<NivraPushOptions> options,
    ILogger<PushNotificationService> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IDataProtector _tokenProtector = dataProtectionProvider.CreateProtector("Nivra.PushTokens.v1");
    private readonly SemaphoreSlim _accessTokenLock = new(1, 1);
    private string? _accessToken;
    private DateTimeOffset _accessTokenExpiresAt;

    public bool IsConfigured => IsFcmConfigured(options.CurrentValue);

    public string ProtectToken(string token)
    {
        return _tokenProtector.Protect(token);
    }

    public async Task SendMessageAsync(
        string userId,
        string conversationId,
        string messageId,
        string senderUserId,
        CancellationToken cancellationToken)
    {
        await SendToUserAsync(
            userId,
            "Nivra",
            "Nuevo mensaje privado",
            new Dictionary<string, string>
            {
                ["type"] = "message",
                ["conversationId"] = conversationId,
                ["messageId"] = messageId,
                ["senderUserId"] = senderUserId,
                ["tag"] = $"nivra-message-{conversationId}"
            },
            cancellationToken);
    }

    public async Task SendIncomingCallAsync(
        string userId,
        string? conversationId,
        string callId,
        string callerUserId,
        string callerName,
        CallType callType,
        CancellationToken cancellationToken)
    {
        await SendToUserAsync(
            userId,
            "Nivra",
            callType == CallType.Video ? $"{callerName} te llama por video" : $"{callerName} te llama",
            new Dictionary<string, string>
            {
                ["type"] = "incoming_call",
                ["callId"] = callId,
                ["callerId"] = callerUserId,
                ["callerUserId"] = callerUserId,
                ["callerName"] = callerName,
                ["callType"] = callType.ToString(),
                ["conversationId"] = conversationId ?? "",
                ["tag"] = $"nivra-call-{callId}"
            },
            cancellationToken);
    }

    public async Task SendMissedCallAsync(
        string userId,
        string? conversationId,
        string callerUserId,
        CallType callType,
        CancellationToken cancellationToken)
    {
        await SendToUserAsync(
            userId,
            "Nivra",
            callType == CallType.Video ? "Videollamada perdida" : "Llamada perdida",
            new Dictionary<string, string>
            {
                ["type"] = "missed-call",
                ["callerUserId"] = callerUserId,
                ["callType"] = callType.ToString(),
                ["conversationId"] = conversationId ?? "",
                ["tag"] = $"nivra-missed-call-{conversationId ?? callerUserId}"
            },
            cancellationToken);
    }

    public async Task SendEventAsync(
        string userId,
        string title,
        string body,
        string type,
        string tag,
        Dictionary<string, string>? data,
        CancellationToken cancellationToken)
    {
        var payload = data is null
            ? new Dictionary<string, string>(StringComparer.Ordinal)
            : new Dictionary<string, string>(data, StringComparer.Ordinal);
        payload["type"] = type;
        payload["tag"] = tag;

        await SendToUserAsync(userId, title, body, payload, cancellationToken);
    }

    private async Task SendToUserAsync(
        string userId,
        string title,
        string body,
        Dictionary<string, string> data,
        CancellationToken cancellationToken,
        bool? includeNotificationPayloadOverride = null)
    {
        var pushOptions = options.CurrentValue;
        if (!IsFcmConfigured(pushOptions))
        {
            return;
        }

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
        var tokens = await db.PushTokens
            .Where(token => token.UserId == userId &&
                token.RevokedAt == null &&
                (token.Provider == "fcm" || token.Provider == "Fcm" || token.Provider == "FCM"))
            .ToListAsync(cancellationToken);
        if (tokens.Count == 0)
        {
            return;
        }

        var changed = false;
        var includeNotificationPayload = includeNotificationPayloadOverride ?? pushOptions.IncludeNotificationPayload;
        foreach (var token in tokens)
        {
            var rawToken = TryUnprotectToken(token.TokenCiphertext);
            if (string.IsNullOrWhiteSpace(rawToken))
            {
                continue;
            }

            var result = await SendFcmAsync(pushOptions, rawToken, title, body, data, includeNotificationPayload, cancellationToken);
            if (result.InvalidToken)
            {
                token.RevokedAt = DateTimeOffset.UtcNow;
                changed = true;
            }
        }

        if (changed)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    private async Task<FcmSendResult> SendFcmAsync(
        NivraPushOptions pushOptions,
        string token,
        string title,
        string body,
        Dictionary<string, string> data,
        bool includeNotificationPayload,
        CancellationToken cancellationToken)
    {
        try
        {
            var accessToken = await GetAccessTokenAsync(pushOptions.Fcm, cancellationToken);
            var client = httpClientFactory.CreateClient();
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"https://fcm.googleapis.com/v1/projects/{Uri.EscapeDataString(pushOptions.Fcm.ProjectId)}/messages:send");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            request.Content = new StringContent(
                JsonSerializer.Serialize(new { message = CreateFcmMessage(token, title, body, data, includeNotificationPayload) }, JsonOptions),
                Encoding.UTF8,
                "application/json");

            using var response = await client.SendAsync(request, cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                return FcmSendResult.Success;
            }

            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            logger.LogWarning("FCM rejected a push notification with status {StatusCode}: {Body}", response.StatusCode, responseBody);
            return FcmSendResult.FromError(responseBody);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not send FCM push notification.");
            return FcmSendResult.TransientFailure;
        }
    }

    private static Dictionary<string, object?> CreateFcmMessage(
        string token,
        string title,
        string body,
        Dictionary<string, string> data,
        bool includeNotificationPayload)
    {
        var tag = data.TryGetValue("tag", out var value) ? value : "nivra-event";
        var isIncomingCall = data.TryGetValue("type", out var type) &&
            type.Contains("call", StringComparison.OrdinalIgnoreCase) &&
            !type.Contains("missed", StringComparison.OrdinalIgnoreCase);
        var channelId = isIncomingCall ? "nivra_calls" : "nivra_messages";
        var pushData = data.ToDictionary(pair => pair.Key, pair => pair.Value ?? "", StringComparer.Ordinal);
        pushData["title"] = title;
        pushData["body"] = body;
        var message = new Dictionary<string, object?>
        {
            ["token"] = token,
            ["data"] = pushData,
            ["android"] = new Dictionary<string, object?>
            {
                ["priority"] = "HIGH",
                ["ttl"] = isIncomingCall ? "30s" : "86400s",
                ["collapse_key"] = tag,
                ["notification"] = new Dictionary<string, object?>
                {
                    ["title"] = title,
                    ["body"] = body,
                    ["channel_id"] = channelId,
                    ["tag"] = tag,
                    ["sound"] = "default",
                    ["default_sound"] = true,
                    ["notification_priority"] = isIncomingCall ? "PRIORITY_MAX" : "PRIORITY_HIGH"
                }
            },
            ["apns"] = new Dictionary<string, object?>
            {
                ["headers"] = new Dictionary<string, string>
                {
                    ["apns-priority"] = "10"
                },
                ["payload"] = new Dictionary<string, object?>
                {
                    ["aps"] = new Dictionary<string, object?>
                    {
                        ["sound"] = "default",
                        ["content-available"] = 1
                    }
                }
            },
            ["webpush"] = new Dictionary<string, object?>
            {
                ["headers"] = new Dictionary<string, string>
                {
                    ["Urgency"] = isIncomingCall ? "high" : "normal",
                    ["TTL"] = isIncomingCall ? "30" : "86400"
                },
                ["notification"] = new Dictionary<string, object?>
                {
                    ["title"] = title,
                    ["body"] = body,
                    ["icon"] = "/assets/icon-192.png",
                    ["badge"] = "/assets/icon-192.png",
                    ["tag"] = tag,
                    ["requireInteraction"] = isIncomingCall,
                    ["renotify"] = isIncomingCall,
                    ["silent"] = false,
                    ["actions"] = isIncomingCall
                        ? new[]
                        {
                            new Dictionary<string, string> { ["action"] = "accept", ["title"] = "Contestar" },
                            new Dictionary<string, string> { ["action"] = "decline", ["title"] = "Rechazar" }
                        }
                        : Array.Empty<Dictionary<string, string>>()
                }
            }
        };

        if (includeNotificationPayload)
        {
            message["notification"] = new Dictionary<string, string>
            {
                ["title"] = title,
                ["body"] = body
            };
        }

        return message;
    }

    private async Task<string> GetAccessTokenAsync(FcmPushOptions fcmOptions, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        if (!string.IsNullOrWhiteSpace(_accessToken) && _accessTokenExpiresAt > now.AddMinutes(5))
        {
            return _accessToken;
        }

        await _accessTokenLock.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (!string.IsNullOrWhiteSpace(_accessToken) && _accessTokenExpiresAt > now.AddMinutes(5))
            {
                return _accessToken;
            }

            var account = FcmServiceAccount.FromOptions(fcmOptions);
            var assertion = CreateJwtAssertion(account, fcmOptions.TokenUri, now);
            using var content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
                ["assertion"] = assertion
            });

            var client = httpClientFactory.CreateClient();
            using var response = await client.PostAsync(fcmOptions.TokenUri, content, cancellationToken);
            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            response.EnsureSuccessStatusCode();
            var token = JsonSerializer.Deserialize<OAuthTokenResponse>(responseBody, JsonOptions)
                ?? throw new InvalidOperationException("FCM OAuth response did not include an access token.");

            _accessToken = token.AccessToken;
            _accessTokenExpiresAt = now.AddSeconds(Math.Max(token.ExpiresIn - 60, 60));
            return _accessToken;
        }
        finally
        {
            _accessTokenLock.Release();
        }
    }

    private static string CreateJwtAssertion(FcmServiceAccount account, string tokenUri, DateTimeOffset now)
    {
        var header = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["alg"] = "RS256",
            ["typ"] = "JWT"
        }));
        var payload = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["iss"] = account.ClientEmail,
            ["scope"] = "https://www.googleapis.com/auth/firebase.messaging",
            ["aud"] = tokenUri,
            ["iat"] = now.ToUnixTimeSeconds(),
            ["exp"] = now.AddMinutes(55).ToUnixTimeSeconds()
        }));
        var unsigned = $"{header}.{payload}";

        using var rsa = RSA.Create();
        rsa.ImportFromPem(account.PrivateKey);
        var signature = rsa.SignData(Encoding.ASCII.GetBytes(unsigned), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{unsigned}.{Base64Url(signature)}";
    }

    private string? TryUnprotectToken(string? tokenCiphertext)
    {
        if (string.IsNullOrWhiteSpace(tokenCiphertext))
        {
            return null;
        }

        try
        {
            return _tokenProtector.Unprotect(tokenCiphertext);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Stored push token could not be unprotected.");
            return null;
        }
    }

    private static bool IsFcmConfigured(NivraPushOptions pushOptions)
    {
        return pushOptions.Enabled &&
            string.Equals(pushOptions.Provider, "Fcm", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrWhiteSpace(pushOptions.Fcm.ProjectId) &&
            (!string.IsNullOrWhiteSpace(pushOptions.Fcm.ServiceAccountJson) ||
             !string.IsNullOrWhiteSpace(pushOptions.Fcm.ServiceAccountJsonBase64));
    }

    private static string Base64Url(byte[] value)
    {
        return Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private sealed record OAuthTokenResponse(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);

    private sealed record FcmSendResult(bool InvalidToken)
    {
        public static readonly FcmSendResult Success = new(false);
        public static readonly FcmSendResult TransientFailure = new(false);

        public static FcmSendResult FromError(string responseBody)
        {
            var invalid = responseBody.Contains("UNREGISTERED", StringComparison.OrdinalIgnoreCase) ||
                responseBody.Contains("registration-token-not-registered", StringComparison.OrdinalIgnoreCase);
            return new FcmSendResult(invalid);
        }
    }

    private sealed record FcmServiceAccount(string ProjectId, string ClientEmail, string PrivateKey)
    {
        public static FcmServiceAccount FromOptions(FcmPushOptions options)
        {
            var json = options.ServiceAccountJson;
            if (string.IsNullOrWhiteSpace(json) && !string.IsNullOrWhiteSpace(options.ServiceAccountJsonBase64))
            {
                json = Encoding.UTF8.GetString(Convert.FromBase64String(options.ServiceAccountJsonBase64));
            }

            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            return new FcmServiceAccount(
                root.TryGetProperty("project_id", out var projectId) ? projectId.GetString() ?? options.ProjectId : options.ProjectId,
                root.GetProperty("client_email").GetString() ?? "",
                root.GetProperty("private_key").GetString() ?? "");
        }
    }
}
