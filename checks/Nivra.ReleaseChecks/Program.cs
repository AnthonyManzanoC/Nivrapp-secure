using Nivra.Api.Services;

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
Console.WriteLine($"PASS {assertions} Android release metadata checks");
