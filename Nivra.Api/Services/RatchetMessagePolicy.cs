using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nivra.Api.Contracts;
using Nivra.Api.Domain;
using Nivra.Api.Infrastructure;

namespace Nivra.Api.Services;

public static class RatchetMessagePolicy
{
    public const string Algorithm = "NIVRA-LIBSIGNAL-MESSAGE-1";
    public static async Task<bool> ValidAsync(NivraDbContext db, string senderUserId, string senderDeviceId, string conversationId, string clientMessageId, IEnumerable<RecipientCipherRequest> recipients, CancellationToken ct)
    {
        var list = recipients.ToList(); var ids = list.Select(row => row.DeviceId).Append(senderDeviceId).Distinct().ToArray();
        var registrations = await db.Set<RatchetPilotDevice>().AsNoTracking().Where(row => ids.Contains(row.DeviceId) && row.AddressMode == 1).ToDictionaryAsync(row => row.DeviceId, ct);
        var sender = registrations.GetValueOrDefault(senderDeviceId);
        var contextMessageId = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(clientMessageId))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        foreach (var recipient in list)
        {
            try
            {
                JsonDocument header;
                try { header = JsonDocument.Parse(recipient.Header ?? "{}"); }
                catch (JsonException) { if (sender is not null && registrations.ContainsKey(recipient.DeviceId)) return false; continue; }
                using var headerLifetime = header; var value = header.RootElement;
                var ratchet = value.TryGetProperty("v", out var version) && version.ValueKind == JsonValueKind.Number && version.TryGetInt32(out var v) && v == 4;
                if (!ratchet)
                {
                    if (sender is not null && registrations.ContainsKey(recipient.DeviceId)) return false;
                    continue;
                }
                if (sender is null || sender.UserId != senderUserId || !registrations.ContainsKey(recipient.DeviceId) ||
                    value.GetProperty("alg").GetString() != Algorithm || value.GetProperty("senderDeviceId").GetString() != senderDeviceId || value.GetProperty("recipientDeviceId").GetString() != recipient.DeviceId ||
                    value.GetProperty("identityKey").GetString() != sender.IdentityKey || value.GetProperty("registrationId").GetInt32() != sender.RegistrationId) return false;
                if (value.TryGetProperty("local", out var local) && local.ValueKind == JsonValueKind.True)
                {
                    if (recipient.DeviceId != senderDeviceId || recipient.UserId != senderUserId || recipient.Ciphertext != "local-history-v1") return false;
                    continue;
                }
                using var packet = JsonDocument.Parse(recipient.Ciphertext); var envelope = packet.RootElement; var context = envelope.GetProperty("context");
                if (envelope.GetProperty("v").GetInt32() != 3 || envelope.GetProperty("suite").GetString() != "NIVRA-LIBSIGNAL-A256GCM-PILOT-1" ||
                    envelope.GetProperty("type").GetInt32() is not (2 or 3) || context.GetProperty("conversationId").GetString() != conversationId || context.GetProperty("messageId").GetString() != contextMessageId ||
                    context.GetProperty("sender").GetString() != $"{senderDeviceId}.1" || context.GetProperty("recipient").GetString() != $"{recipient.DeviceId}.1") return false;
                if (Convert.FromBase64String(envelope.GetProperty("iv").GetString()!).Length != 12 ||
                    Convert.FromBase64String(envelope.GetProperty("keyMessage").GetString()!).Length is < 1 or > 131072 ||
                    Convert.FromBase64String(envelope.GetProperty("ciphertext").GetString()!).Length is < 16 or > 1048592) return false;
            }
            catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or ArgumentException) { return false; }
        }
        return true;
    }
}
