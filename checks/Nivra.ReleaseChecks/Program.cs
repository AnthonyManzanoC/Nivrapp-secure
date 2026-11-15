using Nivra.Api.Services;
using System.Text.Json;
using System.Text.RegularExpressions;

var release = new AndroidRelease("2.0.0", 21,
    "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v2.0.0/Nivra-2.0.0-debug.apk", new string('a', 64), 80000000);
var assertions = 0;
void Check(bool condition) { assertions++; if (!condition) throw new Exception($"Release check {assertions} failed"); }
Check(AndroidReleaseService.IsValid(release));
Check(!AndroidReleaseService.IsValid(null));
Check(!AndroidReleaseService.IsValid(release with { Version = null! }));
Check(!AndroidReleaseService.IsValid(release with { Sha256 = null! }));
Check(!AndroidReleaseService.IsValid(release with { Version = "../2.0.0" }));
Check(!AndroidReleaseService.IsValid(release with { VersionCode = 0 }));
Check(!AndroidReleaseService.IsValid(release with { Size = 0 }));
Check(!AndroidReleaseService.IsValid(release with { Size = 300000000 }));
Check(!AndroidReleaseService.IsValid(release with { Sha256 = "bad" }));
Check(!AndroidReleaseService.IsValid(release with { Url = release.Url + "?redirect=other" }));
Check(!AndroidReleaseService.IsValid(release with { Url = "http://localhost/latest.apk" }));
Check(AndroidReleaseService.Read(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString())) is null);
// Catch a release that updates installers and web metadata but leaves the public
// compatibility/readiness response reporting an older application version.
var root = new DirectoryInfo(AppContext.BaseDirectory);
while (root is not null && !File.Exists(Path.Combine(root.FullName, "Nivra.sln"))) root = root.Parent;
if (root is null) throw new InvalidOperationException("Run release checks from the Nivra source checkout.");
var apiVersion = Regex.Match(File.ReadAllText(Path.Combine(root.FullName, "Nivra.Api/Services/ClientCompatibility.cs")), "public const string Version = \"([^\"]+)\";");
Check(apiVersion.Success);
foreach (var relative in new[] { "package.json", "nivra-app/package.json", "Nivra.Desktop/package.json", "nivra-app/src/assets/release.json", "Nivra.Api/android-release.json" })
{
    using var metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(root.FullName, relative)));
    Check(metadata.RootElement.GetProperty("version").GetString() == apiVersion.Groups[1].Value);
}
var clientVersion = Regex.Match(File.ReadAllText(Path.Combine(root.FullName, "nivra-app/src/app/core/release.ts")), @"export const NIVRA_VERSION = '([^']+)';");
Check(clientVersion.Success && clientVersion.Groups[1].Value == apiVersion.Groups[1].Value);
Console.WriteLine($"PASS {assertions} release metadata and cross-platform version checks");
