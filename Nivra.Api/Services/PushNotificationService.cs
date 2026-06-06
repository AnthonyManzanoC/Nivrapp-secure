using System.Net;
using System.Buffers.Binary;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FirebaseAdmin;
using Google.Apis.Auth.OAuth2;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public sealed class NivraPushOptions
{
    public bool Enabled { get; init; }
    public string Provider { get; init; } = "Fcm";
    public bool IncludeNotificationPayload { get; init; }
    public FcmPushOptions Fcm { get; init; } = new();
    public StandardWebPushOptions WebPush { get; init; } = new();
}

public sealed class FcmPushOptions
{
    public string ProjectId { get; init; } = "";
    public string ServiceAccountPath { get; init; } = "";
    public string ServiceAccountJson { get; init; } = "";
    public string ServiceAccountJsonBase64 { get; init; } = "";
    public string TokenUri { get; init; } = "https://oauth2.googleapis.com/token";
}

public sealed class StandardWebPushOptions
{
    public bool Enabled { get; init; } = true;
    public string PublicKey { get; init; } = "";
    public string PrivateKey { get; init; } = "";
    public string Subject { get; init; } = "mailto:security@nivra.local";
    public int TtlSeconds { get; init; } = 86400;
}

public sealed class PushNotificationService(
    IServiceScopeFactory scopeFactory,
    IHttpClientFactory httpClientFactory,
    IDataProtectionProvider dataProtectionProvider,
    IConfiguration configuration,
    IOptionsMonitor<NivraPushOptions> options,
    ILogger<PushNotificationService> logger)
{
    private static readonly object FirebaseAppLock = new();
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IDataProtector _tokenProtector = dataProtectionProvider.CreateProtector("Nivra.PushTokens.v1");
    private readonly SemaphoreSlim _accessTokenLock = new(1, 1);
    private string? _accessToken;
    private string? _accessTokenCredentialKey;
    private DateTimeOffset _accessTokenExpiresAt;

    public bool IsConfigured
    {
        get
        {
            try
            {
                return ResolveFcmRuntimeConfig(options.CurrentValue, initializeFirebaseApp: true) is not null ||
                    ResolveStandardWebPushRuntimeConfig(options.CurrentValue) is not null;
            }
            catch
            {
                try
                {
                    return ResolveStandardWebPushRuntimeConfig(options.CurrentValue) is not null;
                }
                catch
                {
                    return false;
                }
            }
        }
    }

    public string StandardWebPushPublicKey
    {
        get
        {
            try
            {
                return ResolveStandardWebPushRuntimeConfig(options.CurrentValue)?.PublicKey ?? "";
            }
            catch
            {
                return "";
            }
        }
    }

    public bool TryEnsureFirebaseAdminApp()
    {
        try
        {
            var fcmOptions = EffectiveFcmOptions(options.CurrentValue.Fcm);
            if (!HasFcmCredentialSource(fcmOptions))
            {
                return false;
            }

            _ = FcmServiceAccount.FromOptions(fcmOptions, initializeFirebaseApp: true);
            return FirebaseApp.DefaultInstance is not null;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Firebase Admin could not be initialized.");
            return false;
        }
    }

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
                ["pushIntent"] = "wake_call",
                ["silent"] = "1",
                ["tag"] = $"nivra-call-{callId}"
            },
            cancellationToken,
            silentDataOnly: true);
    }

    public async Task SendCallEndedAsync(
        string userId,
        string? conversationId,
        string callId,
        string endedByUserId,
        CallType callType,
        CancellationToken cancellationToken)
    {
        await SendToUserAsync(
            userId,
            "Nivra",
            "Llamada finalizada",
            new Dictionary<string, string>
            {
                ["type"] = "end_call",
                ["callId"] = callId,
                ["endedByUserId"] = endedByUserId,
                ["callType"] = callType.ToString(),
                ["conversationId"] = conversationId ?? "",
                ["tag"] = $"nivra-call-{callId}"
            },
            cancellationToken,
            includeNotificationPayloadOverride: true);
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
                ["type"] = "missed_call",
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

    public async Task SendContactJoinedAsync(string userId, CancellationToken cancellationToken)
    {
        await SendToUserAsync(
            userId,
            "Nivra",
            "Un contacto de tu agenda se ha unido a Nivra.",
            new Dictionary<string, string>
            {
                ["type"] = "contact_joined",
                ["radarHint"] = "1",
                ["tag"] = "nivra-contact-joined"
            },
            cancellationToken,
            silentDataOnly: true);
    }

    private async Task SendToUserAsync(
        string userId,
        string title,
        string body,
        Dictionary<string, string> data,
        CancellationToken cancellationToken,
        bool? includeNotificationPayloadOverride = null,
        bool silentDataOnly = false)
    {
        var pushOptions = options.CurrentValue;
        FcmRuntimeConfig? fcmConfig = null;
        try
        {
            fcmConfig = ResolveFcmRuntimeConfig(pushOptions, initializeFirebaseApp: true);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Push notification skipped because FCM is not ready.");
        }

        var webPushConfig = ResolveStandardWebPushRuntimeConfig(pushOptions);
        if (fcmConfig is null && webPushConfig is null)
        {
            return;
        }

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<NivraDbContext>();
        var tokens = await db.PushTokens
            .Where(token => token.UserId == userId &&
                token.RevokedAt == null &&
                (token.Provider == "fcm" ||
                 token.Provider == "Fcm" ||
                 token.Provider == "FCM" ||
                 token.Provider == "fcm-fid" ||
                 token.Provider == "FcmFid" ||
                 token.Provider == "FCM-FID" ||
                 token.Provider == "webpush" ||
                 token.Provider == "WebPush"))
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

            FcmSendResult result;
            if (IsStandardWebPushProvider(token.Provider))
            {
                if (webPushConfig is null)
                {
                    continue;
                }
                result = await SendStandardWebPushAsync(webPushConfig, rawToken, title, body, data, includeNotificationPayload, silentDataOnly, cancellationToken);
            }
            else
            {
                if (fcmConfig is null)
                {
                    continue;
                }
                result = await SendFcmAsync(fcmConfig, rawToken, title, body, data, includeNotificationPayload, silentDataOnly, cancellationToken);
            }
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
        FcmRuntimeConfig fcmConfig,
        string token,
        string title,
        string body,
        Dictionary<string, string> data,
        bool includeNotificationPayload,
        bool silentDataOnly,
        CancellationToken cancellationToken)
    {
        try
        {
            var accessToken = await GetAccessTokenAsync(fcmConfig, cancellationToken);
            var client = httpClientFactory.CreateClient();
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"https://fcm.googleapis.com/v1/projects/{Uri.EscapeDataString(fcmConfig.ProjectId)}/messages:send");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            request.Content = new StringContent(
                JsonSerializer.Serialize(new { message = CreateFcmMessage(token, title, body, data, includeNotificationPayload, silentDataOnly) }, JsonOptions),
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

    private async Task<FcmSendResult> SendStandardWebPushAsync(
        StandardWebPushRuntimeConfig webPushConfig,
        string subscriptionJson,
        string title,
        string body,
        Dictionary<string, string> data,
        bool includeNotificationPayload,
        bool silentDataOnly,
        CancellationToken cancellationToken)
    {
        _ = title;
        _ = body;
        _ = includeNotificationPayload;
        _ = silentDataOnly;
        try
        {
            var subscription = JsonSerializer.Deserialize<StandardWebPushSubscription>(subscriptionJson, JsonOptions);
            if (subscription is null ||
                string.IsNullOrWhiteSpace(subscription.Endpoint) ||
                string.IsNullOrWhiteSpace(subscription.Keys?.P256dh) ||
                string.IsNullOrWhiteSpace(subscription.Keys.Auth))
            {
                return FcmSendResult.Invalid;
            }

            var pushData = data.ToDictionary(pair => pair.Key, pair => pair.Value ?? "", StringComparer.Ordinal);
            pushData.Remove("title");
            pushData.Remove("body");
            pushData["nivraWebPush"] = "1";
            var payloadBytes = JsonSerializer.SerializeToUtf8Bytes(new { data = pushData }, JsonOptions);
            var encrypted = EncryptStandardWebPushPayload(webPushConfig, subscription, payloadBytes);

            var client = httpClientFactory.CreateClient();
            using var request = new HttpRequestMessage(HttpMethod.Post, subscription.Endpoint);
            request.Headers.TryAddWithoutValidation("TTL", webPushConfig.TtlSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
            request.Headers.TryAddWithoutValidation("Urgency", "high");
            request.Headers.TryAddWithoutValidation("Authorization", CreateVapidAuthorizationHeader(webPushConfig, subscription.Endpoint));
            request.Content = new ByteArrayContent(encrypted);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            request.Content.Headers.ContentEncoding.Add("aes128gcm");

            using var response = await client.SendAsync(request, cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                return FcmSendResult.Success;
            }

            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            logger.LogWarning("Web Push rejected a notification with status {StatusCode}: {Body}", response.StatusCode, responseBody);
            return response.StatusCode is HttpStatusCode.Gone or HttpStatusCode.NotFound
                ? FcmSendResult.Invalid
                : FcmSendResult.TransientFailure;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not send standard Web Push notification.");
            return FcmSendResult.TransientFailure;
        }
    }

    private static Dictionary<string, object?> CreateFcmMessage(
        string token,
        string title,
        string body,
        Dictionary<string, string> data,
        bool includeNotificationPayload,
        bool silentDataOnly)
    {
        _ = title;
        _ = body;
        _ = includeNotificationPayload;
        var tag = data.TryGetValue("tag", out var value) ? value : "nivra-event";
        var normalizedType = data.TryGetValue("type", out var type)
            ? type.Replace('_', '-').ToLowerInvariant()
            : "";
        var isTerminalCall = normalizedType is "end-call" or "missed-call" or "call-ended";
        var isIncomingCall = normalizedType.Contains("call", StringComparison.Ordinal) && !isTerminalCall;
        var androidTtl = isIncomingCall ? "75s" : isTerminalCall ? "300s" : "86400s";
        var webTtl = isIncomingCall ? "75" : isTerminalCall ? "300" : "86400";
        var pushData = data.ToDictionary(pair => pair.Key, pair => pair.Value ?? "", StringComparer.Ordinal);
        pushData.Remove("title");
        pushData.Remove("body");
        if (silentDataOnly)
        {
            pushData["silent"] = "1";
            pushData["contentAvailable"] = "1";
        }
        var android = new Dictionary<string, object?>
        {
            ["priority"] = "HIGH",
            ["ttl"] = androidTtl,
            ["collapse_key"] = tag
        };
        var aps = new Dictionary<string, object?>
        {
            ["content-available"] = 1
        };
        var message = new Dictionary<string, object?>
        {
            ["token"] = token,
            ["data"] = pushData,
            ["android"] = android,
            ["apns"] = new Dictionary<string, object?>
            {
                ["headers"] = new Dictionary<string, string>
                {
                    ["apns-priority"] = "5",
                    ["apns-push-type"] = "background",
                    ["apns-expiration"] = DateTimeOffset.UtcNow
                        .AddSeconds(int.Parse(webTtl, System.Globalization.CultureInfo.InvariantCulture))
                        .ToUnixTimeSeconds()
                        .ToString(System.Globalization.CultureInfo.InvariantCulture)
                },
                ["payload"] = new Dictionary<string, object?>
                {
                    ["aps"] = aps
                }
            },
            ["webpush"] = new Dictionary<string, object?>
            {
                ["headers"] = new Dictionary<string, string>
                {
                    ["Urgency"] = "high",
                    ["TTL"] = webTtl
                }
            }
        };

        return message;
    }

    private static bool IsStandardWebPushProvider(string provider)
    {
        return string.Equals(provider, "webpush", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(provider, "web-push", StringComparison.OrdinalIgnoreCase);
    }

    private static byte[] EncryptStandardWebPushPayload(
        StandardWebPushRuntimeConfig webPushConfig,
        StandardWebPushSubscription subscription,
        byte[] payload)
    {
        var receiverPublicKey = Base64UrlDecode(subscription.Keys.P256dh);
        var authSecret = Base64UrlDecode(subscription.Keys.Auth);
        var salt = RandomNumberGenerator.GetBytes(16);

        using var sender = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        using var receiver = ECDiffieHellman.Create(RawPublicKeyParameters(receiverPublicKey));
        var sharedSecret = sender.DeriveRawSecretAgreement(receiver.PublicKey);
        var senderPublicKey = RawPublicKey(sender.ExportParameters(false));

        var prk = HkdfExtract(authSecret, sharedSecret);
        var info = Combine(Encoding.ASCII.GetBytes("WebPush: info\0"), receiverPublicKey, senderPublicKey);
        var ikm = HkdfExpand(prk, info, 32);
        var cek = Hkdf(salt, ikm, Encoding.ASCII.GetBytes("Content-Encoding: aes128gcm\0"), 16);
        var nonce = Hkdf(salt, ikm, Encoding.ASCII.GetBytes("Content-Encoding: nonce\0"), 12);
        var plaintext = Combine(payload, [0x02]);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(cek, 16))
        {
            aes.Encrypt(nonce, plaintext, ciphertext, tag);
        }

        var recordSize = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(recordSize, 4096);
        return Combine(
            salt,
            recordSize,
            [(byte)senderPublicKey.Length],
            senderPublicKey,
            ciphertext,
            tag);
    }

    private static string CreateVapidAuthorizationHeader(StandardWebPushRuntimeConfig webPushConfig, string endpoint)
    {
        var uri = new Uri(endpoint);
        var audience = $"{uri.Scheme}://{uri.Host}{(uri.IsDefaultPort ? "" : $":{uri.Port}")}";
        var now = DateTimeOffset.UtcNow;
        var header = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["typ"] = "JWT",
            ["alg"] = "ES256"
        }));
        var payload = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["aud"] = audience,
            ["exp"] = now.AddHours(12).ToUnixTimeSeconds(),
            ["sub"] = webPushConfig.Subject
        }));
        var unsigned = $"{header}.{payload}";
        using var signer = ECDsa.Create(webPushConfig.PrivateKey);
        var signature = signer.SignData(
            Encoding.ASCII.GetBytes(unsigned),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"vapid t={unsigned}.{Base64Url(signature)}, k={webPushConfig.PublicKey}";
    }

    private StandardWebPushRuntimeConfig? ResolveStandardWebPushRuntimeConfig(NivraPushOptions pushOptions)
    {
        if (!pushOptions.Enabled)
        {
            return null;
        }

        var webPushOptions = EffectiveStandardWebPushOptions(pushOptions.WebPush);
        if (!webPushOptions.Enabled)
        {
            return null;
        }

        var privateKey = ResolveStandardWebPushPrivateKey(webPushOptions);
        var publicKey = Base64Url(RawPublicKey(privateKey));
        var subject = FirstNonBlank(webPushOptions.Subject, "mailto:security@nivra.local");
        var ttl = Math.Clamp(webPushOptions.TtlSeconds <= 0 ? 86400 : webPushOptions.TtlSeconds, 60, 2_419_200);
        return new StandardWebPushRuntimeConfig(publicKey, privateKey, subject, ttl);
    }

    private StandardWebPushOptions EffectiveStandardWebPushOptions(StandardWebPushOptions options)
    {
        return new StandardWebPushOptions
        {
            Enabled = FirstBoolean(
                configuration["Push:WebPush:Enabled"],
                configuration["Push__WebPush__Enabled"],
                options.Enabled),
            PublicKey = FirstNonBlank(options.PublicKey, configuration["Push:WebPush:PublicKey"], configuration["Push__WebPush__PublicKey"]),
            PrivateKey = FirstNonBlank(options.PrivateKey, configuration["Push:WebPush:PrivateKey"], configuration["Push__WebPush__PrivateKey"]),
            Subject = FirstNonBlank(options.Subject, configuration["Push:WebPush:Subject"], configuration["Push__WebPush__Subject"], "mailto:security@nivra.local"),
            TtlSeconds = FirstInt(
                options.TtlSeconds,
                configuration["Push:WebPush:TtlSeconds"],
                configuration["Push__WebPush__TtlSeconds"],
                86400)
        };
    }

    private ECParameters ResolveStandardWebPushPrivateKey(StandardWebPushOptions webPushOptions)
    {
        if (!string.IsNullOrWhiteSpace(webPushOptions.PrivateKey))
        {
            return ImportWebPushPrivateKey(webPushOptions.PrivateKey);
        }

        var seed = FirstNonBlank(
            configuration["Push:WebPush:Seed"],
            configuration["Push__WebPush__Seed"],
            configuration["Security:TokenSigningKey"],
            configuration["Security__TokenSigningKey"],
            "nivra-local-standard-webpush-seed-v1");
        for (var attempt = 0; attempt < 128; attempt++)
        {
            var candidate = SHA256.HashData(Encoding.UTF8.GetBytes($"{seed}:standard-webpush:{attempt}"));
            try
            {
                using var key = ECDsa.Create(new ECParameters
                {
                    Curve = ECCurve.NamedCurves.nistP256,
                    D = candidate
                });
                return key.ExportParameters(true);
            }
            catch (CryptographicException)
            {
                // Try the next deterministic candidate if this scalar is outside the curve order.
            }
        }

        throw new InvalidOperationException("Could not derive a valid standard Web Push VAPID key.");
    }

    private static ECParameters ImportWebPushPrivateKey(string value)
    {
        var clean = CleanConfigValue(value);
        if (clean.Contains("BEGIN", StringComparison.OrdinalIgnoreCase))
        {
            using var pemKey = ECDsa.Create();
            pemKey.ImportFromPem(clean);
            return pemKey.ExportParameters(true);
        }

        var raw = Base64UrlDecode(clean);
        if (raw.Length != 32)
        {
            throw new InvalidOperationException("Push:WebPush:PrivateKey must be a PEM key or a base64url P-256 private scalar.");
        }

        using var key = ECDsa.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            D = raw
        });
        return key.ExportParameters(true);
    }

    private static ECParameters RawPublicKeyParameters(byte[] rawPublicKey)
    {
        if (rawPublicKey.Length != 65 || rawPublicKey[0] != 0x04)
        {
            throw new InvalidOperationException("Web Push subscription p256dh key is not an uncompressed P-256 public key.");
        }

        return new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint
            {
                X = rawPublicKey[1..33],
                Y = rawPublicKey[33..65]
            }
        };
    }

    private static byte[] RawPublicKey(ECParameters parameters)
    {
        if (parameters.Q.X is null || parameters.Q.Y is null)
        {
            throw new InvalidOperationException("P-256 public key is missing coordinates.");
        }

        return Combine([0x04], parameters.Q.X, parameters.Q.Y);
    }

    private static byte[] Hkdf(byte[] salt, byte[] ikm, byte[] info, int length)
    {
        return HkdfExpand(HkdfExtract(salt, ikm), info, length);
    }

    private static byte[] HkdfExtract(byte[] salt, byte[] ikm)
    {
        using var hmac = new HMACSHA256(salt);
        return hmac.ComputeHash(ikm);
    }

    private static byte[] HkdfExpand(byte[] prk, byte[] info, int length)
    {
        var output = new List<byte>(length);
        var previous = Array.Empty<byte>();
        byte counter = 1;
        while (output.Count < length)
        {
            using var hmac = new HMACSHA256(prk);
            var blockInput = Combine(previous, info, [counter++]);
            previous = hmac.ComputeHash(blockInput);
            output.AddRange(previous);
        }

        return output.Take(length).ToArray();
    }

    private static byte[] Combine(params byte[][] values)
    {
        var length = values.Sum(value => value.Length);
        var output = new byte[length];
        var offset = 0;
        foreach (var value in values)
        {
            Buffer.BlockCopy(value, 0, output, offset, value.Length);
            offset += value.Length;
        }

        return output;
    }

    private FcmRuntimeConfig? ResolveFcmRuntimeConfig(NivraPushOptions pushOptions, bool initializeFirebaseApp)
    {
        if (!pushOptions.Enabled)
        {
            return null;
        }

        if (!string.Equals(pushOptions.Provider, "Fcm", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        try
        {
            var fcmOptions = EffectiveFcmOptions(pushOptions.Fcm);
            if (!HasFcmCredentialSource(fcmOptions))
            {
                throw new InvalidOperationException(
                    "FCM is enabled but no service account credentials were configured. Set Push__Fcm__ServiceAccountPath to the Render secret file path, for example /etc/secrets/firebase-key.json.");
            }

            var account = FcmServiceAccount.FromOptions(fcmOptions, initializeFirebaseApp);
            var projectId = FirstNonBlank(fcmOptions.ProjectId, account.ProjectId);
            if (string.IsNullOrWhiteSpace(projectId))
            {
                throw new InvalidOperationException(
                    "FCM project id is missing. Set Push__Fcm__ProjectId or include project_id in the Firebase service account JSON.");
            }

            if (string.IsNullOrWhiteSpace(account.ClientEmail) || string.IsNullOrWhiteSpace(account.PrivateKey))
            {
                throw new InvalidOperationException(
                    "FCM service account JSON is missing client_email or private_key.");
            }

            return new FcmRuntimeConfig(projectId, fcmOptions, account);
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "FCM could not be configured. Check Push__Fcm__ServiceAccountPath and the Render secret file.");
            throw new InvalidOperationException(
                "FCM could not be configured. Check Push__Fcm__ServiceAccountPath and the Render secret file.",
                exception);
        }
    }

    private FcmPushOptions EffectiveFcmOptions(FcmPushOptions fcmOptions)
    {
        return new FcmPushOptions
        {
            ProjectId = FirstNonBlank(fcmOptions.ProjectId, configuration["Push:Fcm:ProjectId"], configuration["Push__Fcm__ProjectId"]),
            ServiceAccountPath = FirstNonBlank(fcmOptions.ServiceAccountPath, configuration["Push:Fcm:ServiceAccountPath"], configuration["Push__Fcm__ServiceAccountPath"]),
            ServiceAccountJson = FirstNonBlank(fcmOptions.ServiceAccountJson, configuration["Push:Fcm:ServiceAccountJson"], configuration["Push__Fcm__ServiceAccountJson"]),
            ServiceAccountJsonBase64 = FirstNonBlank(fcmOptions.ServiceAccountJsonBase64, configuration["Push:Fcm:ServiceAccountJsonBase64"], configuration["Push__Fcm__ServiceAccountJsonBase64"]),
            TokenUri = FirstNonBlank(fcmOptions.TokenUri, configuration["Push:Fcm:TokenUri"], configuration["Push__Fcm__TokenUri"], "https://oauth2.googleapis.com/token")
        };
    }

    private async Task<string> GetAccessTokenAsync(FcmRuntimeConfig fcmConfig, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var credentialKey = $"{fcmConfig.ProjectId}:{fcmConfig.Account.ClientEmail}";
        if (_accessTokenCredentialKey == credentialKey &&
            !string.IsNullOrWhiteSpace(_accessToken) &&
            _accessTokenExpiresAt > now.AddMinutes(5))
        {
            return _accessToken;
        }

        await _accessTokenLock.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (_accessTokenCredentialKey == credentialKey &&
                !string.IsNullOrWhiteSpace(_accessToken) &&
                _accessTokenExpiresAt > now.AddMinutes(5))
            {
                return _accessToken;
            }

            var assertion = CreateJwtAssertion(fcmConfig.Account, fcmConfig.Options.TokenUri, now);
            using var content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
                ["assertion"] = assertion
            });

            var client = httpClientFactory.CreateClient();
            using var response = await client.PostAsync(fcmConfig.Options.TokenUri, content, cancellationToken);
            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            response.EnsureSuccessStatusCode();
            var token = JsonSerializer.Deserialize<OAuthTokenResponse>(responseBody, JsonOptions)
                ?? throw new InvalidOperationException("FCM OAuth response did not include an access token.");

            _accessToken = token.AccessToken;
            _accessTokenCredentialKey = credentialKey;
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

    private static bool HasFcmCredentialSource(FcmPushOptions fcmOptions)
    {
        return !string.IsNullOrWhiteSpace(fcmOptions.ServiceAccountPath) ||
            !string.IsNullOrWhiteSpace(fcmOptions.ServiceAccountJson) ||
            !string.IsNullOrWhiteSpace(fcmOptions.ServiceAccountJsonBase64);
    }

    private static string FirstNonBlank(params string?[] values)
    {
        foreach (var value in values)
        {
            var clean = CleanConfigValue(value);
            if (!string.IsNullOrWhiteSpace(clean))
            {
                return clean;
            }
        }

        return "";
    }

    private static string CleanConfigValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? ""
            : value.Trim().Trim('"', '\'').Trim();
    }

    private static void EnsureDefaultFirebaseAppFromFile(string path)
    {
        if (FirebaseApp.DefaultInstance == null)
        {
            lock (FirebaseAppLock)
            {
                if (FirebaseApp.DefaultInstance == null)
                {
#pragma warning disable CS0618
                    FirebaseApp.Create(new AppOptions()
                    {
                        Credential = GoogleCredential.FromFile(path)
                    });
#pragma warning restore CS0618
                }
            }
        }
    }

    private static void EnsureDefaultFirebaseAppFromJson(string json)
    {
        if (FirebaseApp.DefaultInstance == null)
        {
            lock (FirebaseAppLock)
            {
                if (FirebaseApp.DefaultInstance == null)
                {
#pragma warning disable CS0618
                    FirebaseApp.Create(new AppOptions
                    {
                        Credential = GoogleCredential.FromJson(json)
                    });
#pragma warning restore CS0618
                }
            }
        }
    }

    private static string Base64Url(byte[] value)
    {
        return Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var normalized = CleanConfigValue(value)
            .Replace('-', '+')
            .Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        return Convert.FromBase64String(normalized);
    }

    private static bool FirstBoolean(string? first, string? second, bool fallback)
    {
        if (bool.TryParse(CleanConfigValue(first), out var parsedFirst))
        {
            return parsedFirst;
        }

        if (bool.TryParse(CleanConfigValue(second), out var parsedSecond))
        {
            return parsedSecond;
        }

        return fallback;
    }

    private static int FirstInt(int optionValue, string? first, string? second, int fallback)
    {
        if (optionValue > 0)
        {
            return optionValue;
        }

        if (int.TryParse(CleanConfigValue(first), out var parsedFirst) && parsedFirst > 0)
        {
            return parsedFirst;
        }

        if (int.TryParse(CleanConfigValue(second), out var parsedSecond) && parsedSecond > 0)
        {
            return parsedSecond;
        }

        return fallback;
    }

    private sealed record OAuthTokenResponse(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);

    private sealed record FcmRuntimeConfig(
        string ProjectId,
        FcmPushOptions Options,
        FcmServiceAccount Account);

    private sealed record StandardWebPushRuntimeConfig(
        string PublicKey,
        ECParameters PrivateKey,
        string Subject,
        int TtlSeconds);

    private sealed record StandardWebPushSubscription(
        string Endpoint,
        StandardWebPushSubscriptionKeys Keys,
        long? ExpirationTime);

    private sealed record StandardWebPushSubscriptionKeys(
        string P256dh,
        string Auth);

    private sealed record FcmSendResult(bool InvalidToken)
    {
        public static readonly FcmSendResult Success = new(false);
        public static readonly FcmSendResult TransientFailure = new(false);
        public static readonly FcmSendResult Invalid = new(true);

        public static FcmSendResult FromError(string responseBody)
        {
            var invalid = responseBody.Contains("UNREGISTERED", StringComparison.OrdinalIgnoreCase) ||
                responseBody.Contains("registration-token-not-registered", StringComparison.OrdinalIgnoreCase) ||
                responseBody.Contains("NOT_FOUND", StringComparison.OrdinalIgnoreCase) ||
                responseBody.Contains("Requested entity was not found", StringComparison.OrdinalIgnoreCase);
            return new FcmSendResult(invalid);
        }
    }

    private sealed record FcmServiceAccount(string ProjectId, string ClientEmail, string PrivateKey)
    {
        public static FcmServiceAccount FromOptions(FcmPushOptions options, bool initializeFirebaseApp)
        {
            var json = options.ServiceAccountJson;
            if (string.IsNullOrWhiteSpace(json) && !string.IsNullOrWhiteSpace(options.ServiceAccountJsonBase64))
            {
                json = Encoding.UTF8.GetString(Convert.FromBase64String(options.ServiceAccountJsonBase64));
                if (initializeFirebaseApp)
                {
                    EnsureDefaultFirebaseAppFromJson(json);
                }
            }
            if (string.IsNullOrWhiteSpace(json) && !string.IsNullOrWhiteSpace(options.ServiceAccountPath))
            {
                var path = ResolveConfiguredPath(options.ServiceAccountPath);
                if (!File.Exists(path))
                {
                    throw new FileNotFoundException(
                        $"FCM service account file was not found at '{path}'. Check Render Secret Files and Push__Fcm__ServiceAccountPath.",
                        path);
                }

                if (initializeFirebaseApp)
                {
                    EnsureDefaultFirebaseAppFromFile(path);
                }

                json = File.ReadAllText(path);
            }
            else if (initializeFirebaseApp && !string.IsNullOrWhiteSpace(json))
            {
                EnsureDefaultFirebaseAppFromJson(json);
            }

            if (string.IsNullOrWhiteSpace(json))
            {
                throw new InvalidOperationException("Push:Fcm service account credentials are not configured.");
            }

            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            return new FcmServiceAccount(
                root.TryGetProperty("project_id", out var projectId) ? projectId.GetString() ?? options.ProjectId : options.ProjectId,
                root.GetProperty("client_email").GetString() ?? "",
                root.GetProperty("private_key").GetString() ?? "");
        }

        private static string ResolveConfiguredPath(string path)
        {
            var expanded = Environment.ExpandEnvironmentVariables(path.Trim());
            if (expanded.StartsWith("~/", StringComparison.Ordinal) ||
                expanded.StartsWith("~\\", StringComparison.Ordinal))
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                expanded = Path.Combine(home, expanded[2..]);
            }

            return Path.GetFullPath(expanded);
        }
    }
}
