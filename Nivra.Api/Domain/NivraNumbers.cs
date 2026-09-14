using System.Globalization;
using System.Security.Cryptography;

namespace Nivra.Api.Domain;

/// <summary>A public account identifier. It is never a phone number, password or bearer token.</summary>
public static class NivraNumbers
{
    public const string IndexName = "IX_users_NivraNumber";
    public const string DatabaseDefaultSql = "((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 900000000) + 100000000)::text";

    public static string Generate() => RandomNumberGenerator.GetInt32(100_000_000, 1_000_000_000).ToString(CultureInfo.InvariantCulture);

    public static string? Normalize(string? identifier)
    {
        var value = identifier?.Trim() ?? string.Empty;
        if (value.StartsWith('@')) return null;
        var digits = new string(value.Where(character => !char.IsWhiteSpace(character) && character != '-').ToArray());
        return digits.Length == 9 && digits[0] is >= '1' and <= '9' && digits.All(character => character is >= '0' and <= '9')
            ? digits : null;
    }

    public static string NormalizeAlias(string? identifier) => (identifier ?? string.Empty).Trim().TrimStart('@').ToLowerInvariant();
}
