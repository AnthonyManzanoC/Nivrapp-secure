#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Commit,
  [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$artifactDirectory = Join-Path $workspacePath 'artifacts'
$metadataPath = Join-Path $workspacePath 'Nivra.Api\android-release.json'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$apkName = "Nivra-$Version-debug.apk"
$apkPath = Join-Path $artifactDirectory $apkName
$setupName = "Nivra-$Version-Setup.exe"
$setupPath = Join-Path $artifactDirectory $setupName
$updateManifestPath = Join-Path $artifactDirectory "Nivra-$Version-update-manifest.json"
if ($metadata.version -ne $Version -or $metadata.url -ne "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v$Version/$apkName") { throw 'Release metadata does not match the requested version.' }
$apk = Get-Item -LiteralPath $apkPath
if ($apk.Length -ne $metadata.size -or (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $metadata.sha256) { throw 'Release APK differs from the verified metadata.' }
$notes = Get-Content -LiteralPath (Join-Path $artifactDirectory "Nivra-$Version-release-notes.md") -Raw
$assetPaths = @($apkPath, $setupPath, (Join-Path $artifactDirectory "Nivra-$Version-win32-x64.zip"), (Join-Path $artifactDirectory "Nivra-$Version-SHA256.txt"), $metadataPath, $updateManifestPath)
foreach ($asset in $assetPaths) { if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { throw 'A required release artifact is missing.' } }
$checksumLines = @(Get-Content -LiteralPath (Join-Path $artifactDirectory "Nivra-$Version-SHA256.txt"))
foreach ($binaryPath in $assetPaths[0..2]) {
  $binaryName = [IO.Path]::GetFileName($binaryPath)
  $binaryHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($checksumLines -notcontains "$binaryHash  $binaryName") { throw 'The checksum manifest differs from the release binaries. Run verify-release.ps1 first.' }
}

# A release without this verified feed cannot become the latest app update.
# These checks deliberately run before accessing any publishing credential.
function Test-JsonInteger {
  param($Value)
  return $Value -is [int] -or $Value -is [long]
}

function Assert-UpdateArtifact {
  param($Entry, [string]$Path, [string]$ExpectedUrl)
  $file = Get-Item -LiteralPath $Path
  if ($Entry.version -cne $Version -or $Entry.url -cne $ExpectedUrl) {
    throw 'The app update manifest has a different version or download URL. Run verify-release.ps1 first.'
  }
  if (-not (Test-JsonInteger $Entry.size) -or $Entry.size -le 0 -or $Entry.size -ne $file.Length -or
      $Entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $Entry.sha256 -cne (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'The app update manifest differs from the release binaries. Run verify-release.ps1 first.'
  }
}

$manifestJsonOptions = @{}
# PowerShell 7.5+ otherwise converts ISO strings into DateTime objects, unlike
# Windows PowerShell 5.1. Preserve the wire-format timestamp for validation.
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $manifestJsonOptions.DateKind = 'String' }
$updateManifest = Get-Content -LiteralPath $updateManifestPath -Raw | ConvertFrom-Json @manifestJsonOptions
if (-not (Test-JsonInteger $updateManifest.schemaVersion) -or $updateManifest.schemaVersion -ne 1 -or $updateManifest.version -cne $Version) {
  throw 'The app update manifest schema or version is invalid.'
}
$publishedAt = [DateTimeOffset]::MinValue
if ($updateManifest.publishedAt -isnot [string] -or
    $updateManifest.publishedAt -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$' -or
    -not [DateTimeOffset]::TryParse($updateManifest.publishedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$publishedAt)) {
  throw 'The app update manifest needs a valid UTC publication timestamp.'
}
Assert-UpdateArtifact -Entry $updateManifest.android -Path $apkPath -ExpectedUrl "https://nivrapp-secure.vercel.app/downloads/$apkName"
Assert-UpdateArtifact -Entry $updateManifest.windows -Path $setupPath -ExpectedUrl "https://nivrapp-secure.vercel.app/downloads/$setupName"
if (-not (Test-JsonInteger $updateManifest.android.versionCode) -or
    $updateManifest.android.versionCode -le 0 -or $updateManifest.android.versionCode -gt [int]::MaxValue -or
    $updateManifest.android.versionCode -ne $metadata.versionCode -or
    $updateManifest.android.sha256 -cne $metadata.sha256 -or $updateManifest.android.size -ne $metadata.size) {
  throw 'The app update manifest and verified Android metadata disagree.'
}

# Pin bytes before authentication; neither a resumed draft nor a changed local
# artifact may silently replace what was validated above.
$assetPlans = foreach ($assetPath in $assetPaths) {
  $assetFile = Get-Item -LiteralPath $assetPath
  if ($assetFile.Length -le 0) { throw 'A required release artifact is empty.' }
  [pscustomobject]@{
    path = $assetPath
    name = $(if ($assetPath -eq $updateManifestPath) { 'latest.json' } else { $assetFile.Name })
    size = $assetFile.Length
    digest = 'sha256:' + (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
if ($ValidateOnly) {
  Write-Output "Verified Nivra ${Version} release assets and latest.json; no credentials or network accessed."
  return
}

$credentialMap = @{}
$headers = @{}
try {
  Push-Location -LiteralPath $workspacePath
  try { $credentialLines = "protocol=https`nhost=github.com`n`n" | & git credential fill }
  finally { Pop-Location }
  foreach ($entry in $credentialLines) { $pair = $entry.Split('=',2); if ($pair.Length -eq 2) { $credentialMap[$pair[0]] = $pair[1] } }
  if (-not $credentialMap['password']) { throw 'An authenticated GitHub publishing credential is required.' }
  $headers = @{ Authorization = 'Bearer ' + $credentialMap['password']; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
  $apiBase = 'https://api.github.com/repos/AnthonyManzanoC/Nivrapp-secure'
  $remoteCommit = Invoke-RestMethod -Uri "$apiBase/commits/$Commit" -Headers $headers
  if ($remoteCommit.sha -ne $Commit) { throw 'Publish the verified commit before creating a release.' }
  $release = $null
  try { $release = Invoke-RestMethod -Uri "$apiBase/releases/tags/v$Version" -Headers $headers }
  catch { if ([int]$_.Exception.Response.StatusCode -ne 404) { throw 'Could not inspect the GitHub release.' } }
  if ($release -and -not $release.draft) { throw 'An existing published release must not be replaced.' }
  if (-not $release) {
    $body = @{ tag_name="v$Version"; target_commitish=$Commit; name="Nivra $Version"; body=$notes; draft=$true; prerelease=$false } | ConvertTo-Json
    $release = Invoke-RestMethod -Method Post -Uri "$apiBase/releases" -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))
  }
  if ($release.target_commitish -ne $Commit) { throw 'The draft release targets a different commit.' }
  $assets = @(Invoke-RestMethod -Uri "$apiBase/releases/$($release.id)/assets" -Headers $headers)
  $publishedAssets = @()
  foreach ($assetPlan in $assetPlans) {
    $assetFile = Get-Item -LiteralPath $assetPlan.path
    $expectedDigest = 'sha256:' + (Get-FileHash -LiteralPath $assetPlan.path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($assetFile.Length -ne $assetPlan.size -or $expectedDigest -cne $assetPlan.digest) { throw 'A local release artifact changed after validation.' }
    $uploaded = $assets | Where-Object { $_.name -ceq $assetPlan.name } | Select-Object -First 1
    if (-not $uploaded) {
      Write-Output "Uploading GitHub asset: $($assetPlan.name)"
      $uploadUri = $release.upload_url.Split('{')[0] + '?name=' + [Uri]::EscapeDataString($assetPlan.name)
      $uploaded = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -ContentType 'application/octet-stream' -InFile $assetPlan.path -TimeoutSec 1800
    }
    if ($uploaded.name -cne $assetPlan.name -or $uploaded.state -ne 'uploaded' -or $uploaded.size -ne $assetPlan.size -or $uploaded.digest -cne $assetPlan.digest) { throw 'The uploaded asset does not match its verified name, size or digest.' }
    $publishedAssets += [pscustomobject]@{ name=$uploaded.name; size=$uploaded.size; digest=$uploaded.digest; url=$uploaded.browser_download_url }
    Write-Output "Verified GitHub asset: $($uploaded.name)"
  }
  $publishBody = @{ draft=$false } | ConvertTo-Json
  $published = Invoke-RestMethod -Method Patch -Uri "$apiBase/releases/$($release.id)" -Headers $headers -ContentType 'application/json' -Body $publishBody
  [pscustomobject]@{ version=$Version; commit=$Commit; url=$published.html_url; assets=$publishedAssets } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $artifactDirectory "release-$Version-publication.json") -Encoding UTF8
  Write-Output "Published release: $($published.html_url)"
} catch {
  # Credentials and raw HTTP request/error objects are deliberately never printed.
  Write-Output 'Release publishing did not complete. Existing artifacts and any draft remain recoverable.'
  exit 1
} finally {
  $credentialMap.Clear(); $headers.Clear(); $credentialLines = $null
}
