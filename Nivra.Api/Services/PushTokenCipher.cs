using System.Security.Cryptography;
using System.Text;

namespace Nivra.Api.Services;

/// <summary>Protects stored push destinations across restarts of ephemeral hosts.</summary>
public sealed class PushTokenCipher
{
    public const string Prefix = "nivra-push:v2:";
    private static readonly byte[] Purpose = Encoding.UTF8.GetBytes("Nivra.PushTokenCipher.v2");
    private readonly byte[] _key;

    public PushTokenCipher(string signingSecret)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(signingSecret);
        _key = HMACSHA256.HashData(Encoding.UTF8.GetBytes(signingSecret), Purpose);
    }

    public string Protect(string token)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var plaintext = Encoding.UTF8.GetBytes(token);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(nonce, plaintext, ciphertext, tag, Purpose);
        CryptographicOperations.ZeroMemory(plaintext);
        return Prefix + Convert.ToBase64String(nonce.Concat(tag).Concat(ciphertext).ToArray());
    }

    public string Unprotect(string value)
    {
        if (!value.StartsWith(Prefix, StringComparison.Ordinal)) throw new CryptographicException("Unsupported push destination format.");
        var bytes = Convert.FromBase64String(value[Prefix.Length..]);
        if (bytes.Length <= 28 || bytes.Length > 32768) throw new CryptographicException("Invalid push destination size.");
        var plaintext = new byte[bytes.Length - 28];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(bytes.AsSpan(0, 12), bytes.AsSpan(28), bytes.AsSpan(12, 16), plaintext, Purpose);
        try { return Encoding.UTF8.GetString(plaintext); }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
    }
}
