param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Commit
)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$artifactDirectory = Join-Path $workspacePath 'artifacts'
$metadataPath = Join-Path $workspacePath 'Nivra.Api\android-release.json'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$apkName = "Nivra-$Version-debug.apk"
$apkPath = Join-Path $artifactDirectory $apkName
if ($metadata.version -ne $Version -or $metadata.url -ne "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v$Version/$apkName") { throw 'Release metadata does not match the requested version.' }
$apk = Get-Item -LiteralPath $apkPath
if ($apk.Length -ne $metadata.size -or (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $metadata.sha256) { throw 'Release APK differs from the verified metadata.' }
$notes = Get-Content -LiteralPath (Join-Path $artifactDirectory "Nivra-$Version-release-notes.md") -Raw
$assetPaths = @($apkPath, (Join-Path $artifactDirectory "Nivra-$Version-win32-x64.zip"), (Join-Path $artifactDirectory "Nivra-$Version-SHA256.txt"), $metadataPath)
foreach ($asset in $assetPaths) { if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { throw 'A required release artifact is missing.' } }
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
  $assets = Invoke-RestMethod -Uri "$apiBase/releases/$($release.id)/assets" -Headers $headers
  $publishedAssets = @()
  foreach ($assetPath in $assetPaths) {
    $assetFile = Get-Item -LiteralPath $assetPath
    $expectedDigest = 'sha256:' + (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $uploaded = $assets | Where-Object { $_.name -eq $assetFile.Name } | Select-Object -First 1
    if (-not $uploaded) {
      $uploadUri = $release.upload_url.Split('{')[0] + '?name=' + [Uri]::EscapeDataString($assetFile.Name)
      $uploaded = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -ContentType 'application/octet-stream' -InFile $assetPath -TimeoutSec 1800
    }
    if ($uploaded.state -ne 'uploaded' -or $uploaded.size -ne $assetFile.Length -or $uploaded.digest -ne $expectedDigest) { throw 'The uploaded asset does not match its verified digest.' }
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
