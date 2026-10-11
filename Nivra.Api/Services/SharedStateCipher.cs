using System.Security.Cryptography;
using System.Text;

namespace Nivra.Api.Services;

// QR authorization contains session credentials. Never store it as plaintext in Redis.
public sealed class SharedStateCipher
{
    private readonly byte[] key;
    private static readonly byte[] Purpose = Encoding.UTF8.GetBytes("Nivra.SharedState.v1");

    public SharedStateCipher(string signingKey)
    {
        if (string.IsNullOrWhiteSpace(signingKey)) throw new ArgumentException("A durable signing key is required.");
        key = HMACSHA256.HashData(Encoding.UTF8.GetBytes(signingKey), Purpose);
    }

    public string Protect(string plaintext)
    {
        var clear = Encoding.UTF8.GetBytes(plaintext);
        var result = new byte[12 + 16 + clear.Length];
        RandomNumberGenerator.Fill(result.AsSpan(0, 12));
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(result.AsSpan(0, 12), clear, result.AsSpan(28), result.AsSpan(12, 16), Purpose);
        return Convert.ToBase64String(result);
    }

    public string Unprotect(string ciphertext)
    {
        var encrypted = Convert.FromBase64String(ciphertext);
        if (encrypted.Length < 28) throw new CryptographicException("Invalid shared state.");
        var result = new byte[encrypted.Length - 28];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(encrypted.AsSpan(0, 12), encrypted.AsSpan(28), encrypted.AsSpan(12, 16), result, Purpose);
        return Encoding.UTF8.GetString(result);
    }
}
