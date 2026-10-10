using System.Text.Json;

namespace Nivra.Api.Services;

public sealed record AndroidRelease(string Version, int VersionCode, string Url, string Sha256, long Size);

public static class AndroidReleaseService
{
    public static AndroidRelease? Read(string directory)
    {
        try
        {
            var release = JsonSerializer.Deserialize<AndroidRelease>(File.ReadAllText(Path.Combine(directory, "android-release.json")),
                new JsonSerializerOptions(JsonSerializerDefaults.Web));
            return IsValid(release) ? release : null;
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }

    public static bool IsValid(AndroidRelease? release) => release is not null
        && release.Version is not null && release.Sha256 is not null
        && System.Text.RegularExpressions.Regex.IsMatch(release.Version, @"^\d+\.\d+\.\d+$")
        && release.VersionCode > 0 && release.Size > 0 && release.Size <= 256L * 1024 * 1024
        && System.Text.RegularExpressions.Regex.IsMatch(release.Sha256, "^[a-f0-9]{64}$")
        && release.Url == $"https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v{release.Version}/Nivra-{release.Version}-debug.apk";
}
