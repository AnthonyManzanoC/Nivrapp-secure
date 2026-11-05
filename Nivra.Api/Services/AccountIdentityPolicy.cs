using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Nivra.Api.Domain;
using Microsoft.AspNetCore.WebUtilities;

namespace Nivra.Api.Services;
public static class AccountIdentityPolicy
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static byte[] BackupStatement(string userId, AccountIdentityBackup backup) => JsonSerializer.SerializeToUtf8Bytes(new object[] {
        "nivra-account-backup-v1",userId,backup.Identity.RootKey,backup.Identity.SourceDeviceId,backup.Identity.SourceHybrid,backup.Identity.SourceLegacy,backup.Identity.Endorsement,backup.Revision,backup.PasswordBackup,backup.RecoveryBackup },Json);
    public static byte[] DeviceStatement(string userId, AccountDeviceCertificate certificate) => JsonSerializer.SerializeToUtf8Bytes(new object[] {
        "nivra-account-device-v1",userId,certificate.RootKey,certificate.DeviceId,certificate.LegacyKey,certificate.HybridKey },Json);
    public static bool Verify(string root, byte[] statement, string signature)
    {
        try {
            if(root is null||root.Length!=87||signature is null||signature.Length!=88)return false;
            var parts = root.Split(':'); if(parts.Length!=2||parts.Any(p=>p.Length!=43))return false;
            var bytes=Convert.FromBase64String(signature); if(bytes.Length!=64||Convert.ToBase64String(bytes)!=signature)return false;
            using var key=ECDsa.Create(new ECParameters {Curve=ECCurve.NamedCurves.nistP256,Q=new ECPoint {X=WebEncoders.Base64UrlDecode(parts[0]),Y=WebEncoders.Base64UrlDecode(parts[1])}});
            return key.VerifyData(statement,bytes,HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        } catch(Exception error) when(error is FormatException or CryptographicException or ArgumentException) { return false; }
    }
    public static bool ValidBackup(string? serialized, string method)
    {
        if(serialized is null || serialized.Length is < 200 or > 16384)return false;
        try {
            using var doc=JsonDocument.Parse(serialized);var root=doc.RootElement;
            return root.GetProperty("v").GetInt32()==1&&root.GetProperty("method").GetString()==method&&root.GetProperty("iterations").GetInt32()==(method=="password"?600000:0)
                && Convert.FromBase64String(root.GetProperty("salt").GetString()!).Length==32&&Convert.FromBase64String(root.GetProperty("iv").GetString()!).Length==12
                && Convert.FromBase64String(root.GetProperty("ciphertext").GetString()!).Length is >= 128 and <= 12000;
        } catch(Exception error) when(error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or ArgumentException) { return false; }
    }
    public static AccountRootPublic? Read(AccountIdentityRecord? record) => record is null ? null : JsonSerializer.Deserialize<AccountRootPublic>(record.PublicJson,Json);
    public static AccountDeviceCertificate? Certificate(DeviceRecord device) => device.AccountCertificateJson is null ? null : JsonSerializer.Deserialize<AccountDeviceCertificate>(device.AccountCertificateJson,Json);
}
