namespace Nivra.Api.Services;

public sealed record EncryptedDownloadAccess(string Url, DateTimeOffset ExpiresAt, long EncryptedSize, string ContentType);

public static class EncryptedDownloadPolicy
{
    public const long MaxEncryptedBytes = 256L * 1024 * 1024 + 4096;

    public static bool IsValidUrl(string url, string configuredEndpoint) =>
        Uri.TryCreate(url, UriKind.Absolute, out var signed) &&
        Uri.TryCreate(configuredEndpoint, UriKind.Absolute, out var endpoint) &&
        signed.Scheme == Uri.UriSchemeHttps && endpoint.Scheme == Uri.UriSchemeHttps &&
        string.IsNullOrEmpty(signed.UserInfo) && string.IsNullOrEmpty(endpoint.UserInfo) &&
        signed.IsDefaultPort && endpoint.IsDefaultPort &&
        string.IsNullOrEmpty(signed.Fragment) &&
        string.Equals(signed.Host, endpoint.Host, StringComparison.OrdinalIgnoreCase);

    public static DateTimeOffset Deadline(DateTimeOffset now, DateTimeOffset? fileExpiry) =>
        fileExpiry is { } expiry && expiry < now.AddSeconds(60) ? expiry : now.AddSeconds(60);
}
