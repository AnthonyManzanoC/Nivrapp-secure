using System.Text;
using System.Text.Json;
using Nivra.Api.Domain;

namespace Nivra.Api.Endpoints;

public static partial class EndpointExtensions
{
    private sealed record BroadcastEnvelopeRecipient(string UserId, string DeviceId, string Header, string Ciphertext);

    private static List<BroadcastEnvelopeRecipient>? ParseBroadcastEnvelope(string? encrypted, string ownerId, string? sourceIdentity)
    {
        if (string.IsNullOrEmpty(encrypted) || Encoding.UTF8.GetByteCount(encrypted) > 1_048_576 || !ValidHistoryPublicKey(sourceIdentity)) return null;
        try
        {
            using var payload = JsonDocument.Parse(encrypted);
            using var source = JsonDocument.Parse(sourceIdentity!);
            var value = payload.RootElement;
            if (!ExactEnvelopeFields(value, ["v", "purpose", "recipients"]) || value.GetProperty("v").GetInt32() != 1 ||
                value.GetProperty("purpose").GetString() != "nivra-broadcast-list" || value.GetProperty("recipients").ValueKind != JsonValueKind.Array) return null;
            var result = new List<BroadcastEnvelopeRecipient>();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var recipient in value.GetProperty("recipients").EnumerateArray())
            {
                if (result.Count >= 256 || !ExactEnvelopeFields(recipient, ["userId", "deviceId", "header", "ciphertext"])) return null;
                var userId = recipient.GetProperty("userId").GetString();
                var deviceId = recipient.GetProperty("deviceId").GetString();
                var header = recipient.GetProperty("header").GetString();
                var ciphertext = recipient.GetProperty("ciphertext").GetString();
                if (userId != ownerId || string.IsNullOrWhiteSpace(deviceId) || deviceId.Length > 64 || !ids.Add(deviceId)
                    || string.IsNullOrEmpty(header) || header.Length > 8192 || string.IsNullOrEmpty(ciphertext) || ciphertext.Length > 1_048_576
                    || Convert.FromBase64String(ciphertext).Length < 16) return null;
                using var headerDocument = JsonDocument.Parse(header);
                var meta = headerDocument.RootElement;
                if (!ExactEnvelopeFields(meta, ["v", "alg", "senderPublicKey", "iv"]) || meta.GetProperty("v").GetInt32() != 1 ||
                    meta.GetProperty("alg").GetString() != "ECDH-P256-A256GCM" || Convert.FromBase64String(meta.GetProperty("iv").GetString()!).Length != 12) return null;
                var sender = meta.GetProperty("senderPublicKey");
                if (sender.ValueKind != JsonValueKind.Object || sender.TryGetProperty("d", out _) ||
                    sender.EnumerateObject().GroupBy(property => property.Name, StringComparer.Ordinal).Any(group => group.Count() != 1) ||
                    sender.EnumerateObject().Any(property => property.Name is not ("kty" or "crv" or "x" or "y" or "ext" or "key_ops"))) return null;
                foreach (var field in new[] { "kty", "crv", "x", "y" })
                    if (sender.GetProperty(field).GetString() != source.RootElement.GetProperty(field).GetString()) return null;
                if (sender.TryGetProperty("ext", out var ext) && ext.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
                if (sender.TryGetProperty("key_ops", out var operations) && (operations.ValueKind != JsonValueKind.Array ||
                    operations.EnumerateArray().Any(operation => operation.ValueKind != JsonValueKind.String || operation.GetString() is not ("deriveKey" or "deriveBits")))) return null;
                result.Add(new(userId, deviceId, header, ciphertext));
            }
            return result.Count > 0 ? result : null;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException)
        { return null; }
    }

    private static bool ExactEnvelopeFields(JsonElement value, string[] fields) => value.ValueKind == JsonValueKind.Object
        && value.EnumerateObject().Count() == fields.Length && fields.All(field => value.TryGetProperty(field, out _));

    private static bool ValidBroadcastDevices(IReadOnlyCollection<BroadcastEnvelopeRecipient> recipients, IReadOnlyCollection<DeviceRecord> devices, string ownerId) =>
        recipients.Count > 0 && recipients.All(recipient => recipient.UserId == ownerId && devices.Any(device => device.Id == recipient.DeviceId &&
            device.UserId == ownerId && device.IsTrusted && device.RevokedAt == null && ValidHistoryPublicKey(device.KeyBundle.IdentityKey)));
}
