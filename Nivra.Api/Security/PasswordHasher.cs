using System.Security.Cryptography;
using Nivra.Api.Domain;

namespace Nivra.Api.Security;

public sealed class PasswordHasher
{
    private const int SaltSize = 16;
    private const int KeySize = 32;
    private const int Iterations = 150_000;
    private const string Algorithm = "PBKDF2-SHA256";

    public PasswordHash Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, KeySize);

        return new PasswordHash(
            Algorithm,
            Iterations,
            Convert.ToBase64String(salt),
            Convert.ToBase64String(hash));
    }

    public bool Verify(string password, PasswordHash stored)
    {
        if (!string.Equals(stored.Algorithm, Algorithm, StringComparison.Ordinal))
        {
            return false;
        }

        var salt = Convert.FromBase64String(stored.Salt);
        var expected = Convert.FromBase64String(stored.Hash);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, stored.Iterations, HashAlgorithmName.SHA256, expected.Length);

        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
