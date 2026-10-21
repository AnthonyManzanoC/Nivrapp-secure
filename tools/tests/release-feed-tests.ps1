#requires -Version 5.1
# Offline publisher contract checks. All files, credentials and HTTP responses
# are disposable fixtures; this script never accesses a real publishing token.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$testWorkspace = Join-Path ([IO.Path]::GetTempPath()) ('nivra-release-feed-' + [Guid]::NewGuid().ToString('N'))
$fixtureTools = Join-Path $testWorkspace 'tools'
$fixtureArtifacts = Join-Path $testWorkspace 'artifacts'
$fixtureApi = Join-Path $testWorkspace 'Nivra.Api'
foreach ($directory in @($fixtureTools, $fixtureArtifacts, $fixtureApi)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
$fixturePublisher = Join-Path $fixtureTools 'publish-android-release.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\publish-android-release.ps1') -Destination $fixturePublisher
$testVersion = '4.1.0'
$testCommit = '1234567890123456789012345678901234567890'
$testApk = Join-Path $fixtureArtifacts 'Nivra-4.1.0-debug.apk'
$testSetup = Join-Path $fixtureArtifacts 'Nivra-4.1.0-Setup.exe'
$testZip = Join-Path $fixtureArtifacts 'Nivra-4.1.0-win32-x64.zip'
$testManifestPath = Join-Path $fixtureArtifacts 'Nivra-4.1.0-update-manifest.json'
$utf8 = [Text.UTF8Encoding]::new($false)
$testState = [pscustomobject]@{ checks=0; credentialCalls=0; networkCalls=0; published=$false; wrongFeedDigest=$false; uploads=@() }
$testState.credentialCalls = 0
$testState.networkCalls = 0
$testState.published = $false
$testState.wrongFeedDigest = $false
$testState.uploads = @()

function Write-TestJson {
  param([string]$Path, $Value)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8), $utf8)
}

function Reset-Fixture {
  [IO.File]::WriteAllBytes($testApk, [byte[]](80, 75, 3, 4, 10, 20, 30))
  [IO.File]::WriteAllBytes($testSetup, [byte[]](77, 90, 40, 50, 60, 70, 80, 90))
  [IO.File]::WriteAllBytes($testZip, [byte[]](80, 75, 3, 4, 100))
  $androidHash = (Get-FileHash -LiteralPath $testApk -Algorithm SHA256).Hash.ToLowerInvariant()
  $setupHash = (Get-FileHash -LiteralPath $testSetup -Algorithm SHA256).Hash.ToLowerInvariant()
  $metadata = [ordered]@{ version=$testVersion; versionCode=28; url='https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/Nivra-4.1.0-debug.apk'; sha256=$androidHash; size=(Get-Item -LiteralPath $testApk).Length }
  Write-TestJson -Path (Join-Path $fixtureApi 'android-release.json') -Value $metadata
  $manifest = [ordered]@{
    schemaVersion=1; version=$testVersion; publishedAt='2026-10-21T00:00:00.0000000Z'
    android=[ordered]@{ version=$testVersion; versionCode=28; url='https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.0-debug.apk'; sha256=$androidHash; size=(Get-Item -LiteralPath $testApk).Length }
    windows=[ordered]@{ version=$testVersion; url='https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.0-Setup.exe'; sha256=$setupHash; size=(Get-Item -LiteralPath $testSetup).Length }
  }
  Write-TestJson -Path $testManifestPath -Value $manifest
  $lines = foreach ($binary in @($testApk, $testSetup, $testZip)) { (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($binary) }
  [IO.File]::WriteAllText((Join-Path $fixtureArtifacts 'Nivra-4.1.0-SHA256.txt'), ($lines -join "`n"), $utf8)
  [IO.File]::WriteAllText((Join-Path $fixtureArtifacts 'Nivra-4.1.0-release-notes.md'), 'Offline fixture release.', $utf8)
  $testState.credentialCalls = 0; $testState.networkCalls = 0; $testState.published = $false; $testState.wrongFeedDigest = $false; $testState.uploads = @()
  return $manifest
}

# Command mocks take precedence over executable git and the HTTP cmdlet within
# the child publisher. The sentinel credential is never accepted by a server.
function git { $testState.credentialCalls++; return @('protocol=https', 'host=github.com', 'password=offline-fixture-sentinel') }
function Invoke-RestMethod {
  param([string]$Uri, [string]$Method='Get', $Headers, [string]$ContentType, $Body, [string]$InFile, [int]$TimeoutSec)
  $testState.networkCalls++
  if ($Uri -match '/commits/') { return [pscustomobject]@{ sha=$testCommit } }
  if ($Uri -match '/releases/tags/') { return [pscustomobject]@{ id=123; draft=$true; target_commitish=$testCommit; upload_url='https://offline.invalid/upload{?name,label}' } }
  # Match Invoke-RestMethod's non-enumerated JSON-array output, including [].
  if ($Uri.EndsWith('/assets')) { Write-Output -NoEnumerate ([object[]]@()); return }
  if ($Method -eq 'Post' -and $Uri.StartsWith('https://offline.invalid/upload?name=')) {
    $name = [Uri]::UnescapeDataString($Uri.Substring($Uri.IndexOf('?name=') + 6))
    $digest = 'sha256:' + (Get-FileHash -LiteralPath $InFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($testState.wrongFeedDigest -and $name -eq 'latest.json') { $digest = 'sha256:' + ('0' * 64) }
    $testState.uploads += $name
    return [pscustomobject]@{ name=$name; state='uploaded'; size=(Get-Item -LiteralPath $InFile).Length; digest=$digest; browser_download_url='https://offline.invalid/' + $name }
  }
  if ($Method -eq 'Patch' -and $Uri.EndsWith('/releases/123')) { $testState.published=$true; return [pscustomobject]@{ html_url='https://offline.invalid/release' } }
  throw 'Unexpected offline HTTP fixture request.'
}

function Assert-Rejected {
  param([string]$Label, [scriptblock]$Mutate)
  $manifest = Reset-Fixture
  & $Mutate $manifest
  if (Test-Path -LiteralPath $testManifestPath) { Write-TestJson -Path $testManifestPath -Value $manifest }
  $rejected = $false
  try { & $fixturePublisher -Version $testVersion -Commit $testCommit -ValidateOnly | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected -or $testState.credentialCalls -ne 0 -or $testState.networkCalls -ne 0) { throw "Preflight did not safely reject: $Label" }
  $testState.checks++
}

try {
  $null = Reset-Fixture
  & $fixturePublisher -Version $testVersion -Commit $testCommit -ValidateOnly | Out-Null
  if ($testState.credentialCalls -ne 0 -or $testState.networkCalls -ne 0) { throw 'Validation-only mode accessed credentials or network.' }
  $testState.checks++
  Assert-Rejected 'missing feed' { param($m) Remove-Item -LiteralPath $testManifestPath }
  Assert-Rejected 'unsupported schema' { param($m) $m.schemaVersion=2 }
  Assert-Rejected 'schema string' { param($m) $m.schemaVersion='1' }
  Assert-Rejected 'root version mismatch' { param($m) $m.version='4.0.1' }
  Assert-Rejected 'Android version mismatch' { param($m) $m.android.version='4.0.1' }
  Assert-Rejected 'Windows version mismatch' { param($m) $m.windows.version='4.0.1' }
  Assert-Rejected 'unexpected Android host' { param($m) $m.android.url='https://example.invalid/Nivra-4.1.0-debug.apk' }
  Assert-Rejected 'unexpected Windows file' { param($m) $m.windows.url='https://nivrapp-secure.vercel.app/downloads/Nivra-4.0.1-Setup.exe' }
  Assert-Rejected 'Android digest mismatch' { param($m) $m.android.sha256='0' * 64 }
  Assert-Rejected 'Windows digest mismatch' { param($m) $m.windows.sha256='0' * 64 }
  Assert-Rejected 'Windows size mismatch' { param($m) $m.windows.size++ }
  Assert-Rejected 'Android size string' { param($m) $m.android.size=[string]$m.android.size }
  Assert-Rejected 'Android code mismatch' { param($m) $m.android.versionCode=29 }
  Assert-Rejected 'Android code string' { param($m) $m.android.versionCode='28' }
  Assert-Rejected 'non-UTC timestamp' { param($m) $m.publishedAt='2026-10-21T00:00:00+02:00' }
  Assert-Rejected 'impossible timestamp' { param($m) $m.publishedAt='2026-13-99T00:00:00Z' }
  Assert-Rejected 'missing Windows entry' { param($m) $m.Remove('windows') }

  $null = Reset-Fixture
  $publisherOutput = @(& $fixturePublisher -Version $testVersion -Commit $testCommit)
  if (-not $testState.published -or $testState.uploads -notcontains 'latest.json' -or $testState.uploads -contains 'Nivra-4.1.0-update-manifest.json') {
    throw "The offline feed upload failed: $($publisherOutput -join ' | '); requests=$($testState.networkCalls); uploads=$($testState.uploads -join ','); fixture error=$($Error[0].Exception.Message)"
  }
  $publication = Get-Content -LiteralPath (Join-Path $fixtureArtifacts 'release-4.1.0-publication.json') -Raw | ConvertFrom-Json
  $feedAsset = $publication.assets | Where-Object { $_.name -eq 'latest.json' }
  if (-not $feedAsset -or $feedAsset.digest -ne ('sha256:' + (Get-FileHash -LiteralPath $testManifestPath -Algorithm SHA256).Hash.ToLowerInvariant())) { throw 'The publication record does not pin the feed digest.' }
  $testState.checks++

  $null = Reset-Fixture
  $testState.wrongFeedDigest=$true
  & $fixturePublisher -Version $testVersion -Commit $testCommit | Out-Null
  if ($testState.published) { throw 'The publisher released a feed whose remote digest did not match.' }
  $testState.checks++
  Write-Output "Passed $($testState.checks) offline release-feed checks; no real network or credentials used."
} finally {
  # Only a verified, uniquely named fixture directory may be recursively removed.
  $resolvedFixture = [IO.Path]::GetFullPath($testWorkspace)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedFixture) -notmatch '^nivra-release-feed-[a-f0-9]{32}$') { throw 'Refusing to remove an unexpected fixture path.' }
  Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
