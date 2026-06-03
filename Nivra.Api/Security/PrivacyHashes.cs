using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Nivra.Api.Security;

public static partial class PrivacyHashes
{
    private const string PhoneHashPrefix = "nivra-phone:v1:";

    public static string PhoneContactHash(string normalizedPhone)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{PhoneHashPrefix}{normalizedPhone.Trim()}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public static string OpaqueCodeHash(string code)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(code.Trim()));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public static bool IsSha256Hex(string value)
    {
        return Sha256HexPattern().IsMatch(value);
    }

    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.Compiled)]
    private static partial Regex Sha256HexPattern();
}
