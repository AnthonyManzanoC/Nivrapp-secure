#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ $_ -match '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))' })]
  [string]$DesktopDirectory,

  [string]$ArtifactDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($ArtifactDirectory)) {
  $ArtifactDirectory = Join-Path $workspacePath 'artifacts'
}

function Resolve-RequiredDirectory {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label directory is missing: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path.TrimEnd([char[]]@('\', '/'))
}

function Resolve-RequiredFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required release file is missing: $Path"
  }
  $file = Get-Item -LiteralPath $Path
  if ($file.Length -eq 0) { throw "Required release file is empty: $Path" }
  return $file.FullName
}

function Get-StreamSha256 {
  param([System.IO.Stream]$Stream)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

function Assert-PeHeader {
  param([System.IO.Stream]$Stream, [string]$Label)
  if ($Stream.ReadByte() -ne 0x4d -or $Stream.ReadByte() -ne 0x5a) {
    throw "$Label is not a Windows executable with an MZ header."
  }
}

function Get-DirectoryHashes {
  param([string]$Directory)
  $hashes = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
  foreach ($file in Get-ChildItem -LiteralPath $Directory -File -Recurse -Force) {
    $relativeName = $file.FullName.Substring($Directory.Length + 1).Replace('\', '/')
    $hashes.Add($relativeName, (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())
  }
  return ,$hashes
}

function Get-ArchiveEntries {
  param([System.IO.Compression.ZipArchive]$Archive, [string]$Prefix)
  $entries = [System.Collections.Generic.Dictionary[string, System.IO.Compression.ZipArchiveEntry]]::new([StringComparer]::Ordinal)
  foreach ($entry in $Archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ($name.EndsWith('/') -or -not $name.StartsWith($Prefix, [StringComparison]::Ordinal)) { continue }
    $relativeName = $name.Substring($Prefix.Length)
    if ($entries.ContainsKey($relativeName)) { throw "Duplicate archive entry: $name" }
    $entries.Add($relativeName, $entry)
  }
  return ,$entries
}

function Assert-ArchiveWebAssets {
  param($Entries, $ExpectedHashes, [string]$Label, [switch]$Android)
  $checkedCount = 0
  foreach ($relativeName in $ExpectedHashes.Keys) {
    # Android aapt omits dot directories; domain association remains a web asset.
    if ($Android -and $relativeName -eq '.well-known/assetlinks.json') { continue }
    if (-not $Entries.ContainsKey($relativeName)) { throw "$Label lacks web asset: $relativeName" }
    $stream = $Entries[$relativeName].Open()
    try { $actualHash = Get-StreamSha256 -Stream $stream }
    finally { $stream.Dispose() }
    if ($actualHash -ne $ExpectedHashes[$relativeName]) { throw "$Label web asset differs: $relativeName" }
    ++$checkedCount
  }
  foreach ($relativeName in $Entries.Keys) {
    if ($ExpectedHashes.ContainsKey($relativeName)) { continue }
    # Capacitor adds these two empty compatibility files during cap sync.
    if ($Android -and $relativeName -in @('cordova.js', 'cordova_plugins.js') -and $Entries[$relativeName].Length -eq 0) { continue }
    throw "$Label contains an unexpected web asset: $relativeName"
  }
  return $checkedCount
}

function Resolve-AndroidVerificationTools {
  $buildToolCandidates = @()
  $sdkRoots = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
  foreach ($sdkRoot in $sdkRoots) {
    $buildToolsRoot = Join-Path $sdkRoot 'build-tools'
    if (-not (Test-Path -LiteralPath $buildToolsRoot -PathType Container)) { continue }
    foreach ($directory in Get-ChildItem -LiteralPath $buildToolsRoot -Directory) {
      $toolVersion = [version]::new()
      if (-not [version]::TryParse($directory.Name, [ref]$toolVersion)) { continue }
      $aapt = Join-Path $directory.FullName 'aapt.exe'
      $signerJar = Join-Path $directory.FullName 'lib\apksigner.jar'
      if ((Test-Path -LiteralPath $aapt -PathType Leaf) -and (Test-Path -LiteralPath $signerJar -PathType Leaf)) {
        $buildToolCandidates += [pscustomobject]@{ version=$toolVersion; aapt=$aapt; signerJar=$signerJar }
      }
    }
  }
  $buildTools = $buildToolCandidates | Sort-Object version -Descending | Select-Object -First 1
  if (-not $buildTools) { throw 'Android APK verification requires SDK build-tools with aapt.exe and lib/apksigner.jar. Set ANDROID_HOME or ANDROID_SDK_ROOT, or install build-tools in LOCALAPPDATA/Android/Sdk.' }
  $javaCandidates = @()
  if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { $javaCandidates += Join-Path $env:JAVA_HOME 'bin\java.exe' }
  $portableJdk = Join-Path $workspacePath 'tools\jdk'
  $javaCandidates += Join-Path $portableJdk 'bin\java.exe'
  if (Test-Path -LiteralPath $portableJdk -PathType Container) {
    foreach ($directory in Get-ChildItem -LiteralPath $portableJdk -Directory) { $javaCandidates += Join-Path $directory.FullName 'bin\java.exe' }
  }
  $pathJava = Get-Command java.exe -ErrorAction SilentlyContinue
  if ($pathJava) { $javaCandidates += $pathJava.Source }
  $java = $javaCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $java) { throw 'Android signature verification requires Java. Set JAVA_HOME or provide tools/jdk/bin/java.exe.' }
  return [pscustomobject]@{ aapt=$buildTools.aapt; signerJar=$buildTools.signerJar; java=$java }
}

function Assert-AndroidApkIdentity {
  param([string]$Badging, [string]$SignerOutput, [int]$SignerExitCode, [string]$ExpectedVersion, [long]$ExpectedVersionCode, $AssetLinks)
  $packageLines = [regex]::Matches($Badging, '(?m)^package:\s+(.+)$')
  if ($packageLines.Count -ne 1) { throw 'Android APK does not contain exactly one readable package manifest.' }
  $fields = @{}
  foreach ($field in @('name', 'versionCode', 'versionName')) {
    $matches = [regex]::Matches($packageLines[0].Groups[1].Value, '(?:^|\s)' + $field + '=[''"]([^''"]+)[''"]')
    if ($matches.Count -ne 1) { throw "Android APK manifest lacks a unique $field." }
    $fields[$field] = $matches[0].Groups[1].Value
  }
  if ($fields.name -cne 'com.nivra.app' -or $fields.versionName -cne $ExpectedVersion -or
      $fields.versionCode -notmatch '^[1-9][0-9]*$' -or [long]$fields.versionCode -ne $ExpectedVersionCode) {
    throw 'Android APK package, versionName or versionCode differs from this verified release.'
  }
  if ($SignerExitCode -ne 0) { throw 'Android APK signature verification failed. Build and sign the release APK with the pinned Nivra certificate.' }
  $targets = @($AssetLinks | Where-Object { $_.target.namespace -ceq 'android_app' -and $_.target.package_name -ceq 'com.nivra.app' })
  if ($targets.Count -eq 0) { throw 'assetlinks.json must pin the com.nivra.app signing certificate.' }
  $pins = @()
  foreach ($target in $targets) {
    foreach ($fingerprint in $target.target.sha256_cert_fingerprints) {
      if ($fingerprint -isnot [string] -or $fingerprint -notmatch '^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$') { throw 'assetlinks.json contains an invalid Android certificate SHA256 fingerprint.' }
      $pins += $fingerprint.Replace(':', '').ToLowerInvariant()
    }
  }
  $certificates = [regex]::Matches($SignerOutput, '(?im)^Signer #[0-9]+ certificate SHA-256 digest:\s*([a-f0-9:]+)\s*$')
  if ($certificates.Count -eq 0) { throw 'apksigner did not report the APK signer certificate SHA256 digest.' }
  $verifiedCertificates = @()
  foreach ($certificate in $certificates) {
    $fingerprint = $certificate.Groups[1].Value.Replace(':', '').ToLowerInvariant()
    if ($fingerprint -notmatch '^[a-f0-9]{64}$' -or $pins -notcontains $fingerprint) {
      throw 'Android APK signer differs from the certificate pinned in assetlinks.json. Publishing would break updates for existing installations.'
    }
    $verifiedCertificates += $fingerprint
  }
  return $verifiedCertificates
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$artifactPath = Resolve-RequiredDirectory -Path $ArtifactDirectory -Label 'Artifacts'
$desktopPath = Resolve-RequiredDirectory -Path $DesktopDirectory -Label 'Desktop'
$webPath = Resolve-RequiredDirectory -Path (Join-Path $workspacePath 'nivra-app\dist\nivra-app\browser') -Label 'Built web'
$desktopWebPath = Resolve-RequiredDirectory -Path (Join-Path $desktopPath 'resources\browser') -Label 'Desktop web'
$apkName = "Nivra-$Version-debug.apk"
$setupName = "Nivra-$Version-Setup.exe"
$zipName = "Nivra-$Version-win32-x64.zip"
$apkPath = Resolve-RequiredFile -Path (Join-Path $artifactPath $apkName)
$setupPath = Resolve-RequiredFile -Path (Join-Path $artifactPath $setupName)
$zipPath = Resolve-RequiredFile -Path (Join-Path $artifactPath $zipName)
$desktopExePath = Resolve-RequiredFile -Path (Join-Path $desktopPath 'Nivra.exe')
$releasePath = Resolve-RequiredFile -Path (Join-Path $webPath 'assets\release.json')
$webRelease = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
if ($webRelease.version -ne $Version) { throw "Built web release.json does not identify version $Version." }

$gradlePath = Resolve-RequiredFile -Path (Join-Path $workspacePath 'android\app\build.gradle')
$gradleSource = Get-Content -LiteralPath $gradlePath -Raw
$codeMatches = [regex]::Matches($gradleSource, '(?m)^\s*versionCode\s*(?:=\s*)?([0-9]+)\s*$')
$nameMatches = [regex]::Matches($gradleSource, '(?m)^\s*versionName\s*(?:=\s*)?["'']([^"'']+)["'']\s*$')
if ($codeMatches.Count -ne 1 -or $nameMatches.Count -ne 1) { throw 'Android Gradle must declare one versionCode and versionName.' }
$versionCode = [long]$codeMatches[0].Groups[1].Value
if ($versionCode -le 0 -or $versionCode -gt [int]::MaxValue) { throw 'Android versionCode must be a positive 32-bit integer.' }
if ($nameMatches[0].Groups[1].Value -ne $Version) { throw "Android Gradle versionName does not match $Version." }

# Inspect the APK's compiled manifest and real signature, not just Gradle source
# or a ZIP hash. The pinned signer preserves upgrade compatibility for users.
$androidTools = Resolve-AndroidVerificationTools
$badgingOutput = @(& $androidTools.aapt dump badging $apkPath 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'aapt could not inspect the release APK manifest.' }
$signerOutput = @(& $androidTools.java -jar $androidTools.signerJar verify --verbose --print-certs $apkPath 2>&1)
$signerExitCode = $LASTEXITCODE
$assetLinksPath = Resolve-RequiredFile -Path (Join-Path $workspacePath 'nivra-app\src\.well-known\assetlinks.json')
$assetLinks = Get-Content -LiteralPath $assetLinksPath -Raw | ConvertFrom-Json
$apkCertificates = @(Assert-AndroidApkIdentity -Badging ($badgingOutput -join "`n") -SignerOutput ($signerOutput -join "`n") -SignerExitCode $signerExitCode -ExpectedVersion $Version -ExpectedVersionCode $versionCode -AssetLinks $assetLinks)

$compatibleVersionPattern = '^' + [regex]::Escape($Version) + '(?:\.0)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$'
foreach ($executablePath in @($desktopExePath, $setupPath)) {
  $versionInfo = (Get-Item -LiteralPath $executablePath).VersionInfo
  foreach ($versionField in @('ProductVersion', 'FileVersion')) {
    if ($versionInfo.$versionField -notmatch $compatibleVersionPattern) {
      throw "$([System.IO.Path]::GetFileName($executablePath)) $versionField does not match $Version."
    }
  }
  $stream = [System.IO.File]::OpenRead($executablePath)
  try { Assert-PeHeader -Stream $stream -Label ([System.IO.Path]::GetFileName($executablePath)) }
  finally { $stream.Dispose() }
}

$webHashes = Get-DirectoryHashes -Directory $webPath
if ($webHashes.Count -eq 0 -or -not $webHashes.ContainsKey('index.html')) { throw 'Built web assets are incomplete.' }
$desktopHashes = Get-DirectoryHashes -Directory $desktopWebPath
foreach ($relativeName in $webHashes.Keys) {
  if (-not $desktopHashes.ContainsKey($relativeName)) { throw "Desktop lacks web asset: $relativeName" }
  if ($desktopHashes[$relativeName] -ne $webHashes[$relativeName]) { throw "Desktop web asset differs: $relativeName" }
}
foreach ($relativeName in $desktopHashes.Keys) {
  if (-not $webHashes.ContainsKey($relativeName)) { throw "Desktop contains an unexpected web asset: $relativeName" }
}

$apkArchive = [System.IO.Compression.ZipFile]::OpenRead($apkPath)
try {
  $apkEntries = Get-ArchiveEntries -Archive $apkArchive -Prefix 'assets/public/'
  $androidCount = Assert-ArchiveWebAssets -Entries $apkEntries -ExpectedHashes $webHashes -Label 'Android APK' -Android
}
finally { $apkArchive.Dispose() }

# Inspect the deliverable ZIP as well as the unpacked desktop build.
$desktopArchive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $exeEntries = @($desktopArchive.Entries | Where-Object { $_.FullName.Replace('\', '/') -match '(^|/)Nivra\.exe$' })
  if ($exeEntries.Count -ne 1) { throw 'Desktop ZIP must contain exactly one Nivra.exe.' }
  $exeEntry = $exeEntries[0]
  $stream = $exeEntry.Open()
  try { Assert-PeHeader -Stream $stream -Label 'Desktop ZIP Nivra.exe' }
  finally { $stream.Dispose() }
  $stream = $exeEntry.Open()
  try { $zippedExeHash = Get-StreamSha256 -Stream $stream }
  finally { $stream.Dispose() }
  if ($zippedExeHash -ne (Get-FileHash -LiteralPath $desktopExePath -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'Desktop ZIP Nivra.exe differs from the verified executable.'
  }
  $exeEntryName = $exeEntry.FullName.Replace('\', '/')
  $archiveRoot = $exeEntryName.Substring(0, $exeEntryName.Length - 'Nivra.exe'.Length)
  $zipEntries = Get-ArchiveEntries -Archive $desktopArchive -Prefix ($archiveRoot + 'resources/browser/')
  $zipCount = Assert-ArchiveWebAssets -Entries $zipEntries -ExpectedHashes $webHashes -Label 'Desktop ZIP'
}
finally { $desktopArchive.Dispose() }

# No release feed, checksum manifest or API metadata is written until every verification above passes.
$packageHashes = [ordered]@{}
foreach ($packagePath in @($apkPath, $setupPath, $zipPath)) {
  $packageHashes[[System.IO.Path]::GetFileName($packagePath)] = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
}
$hashLines = foreach ($packageName in $packageHashes.Keys) { "$($packageHashes[$packageName])  $packageName" }
$checksumPath = Join-Path $artifactPath "Nivra-$Version-SHA256.txt"
$metadataPath = Join-Path $workspacePath 'Nivra.Api\android-release.json'
$updateManifestPath = Join-Path $artifactPath "Nivra-$Version-update-manifest.json"
$metadata = [ordered]@{
  version = $Version
  versionCode = [int]$versionCode
  url = "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v$Version/$apkName"
  sha256 = $packageHashes[$apkName]
  size = (Get-Item -LiteralPath $apkPath).Length
}
$updateManifest = [ordered]@{
  schemaVersion = 1
  version = $Version
  publishedAt = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  android = [ordered]@{
    version = $Version
    versionCode = [int]$versionCode
    url = "https://nivrapp-secure.vercel.app/downloads/$apkName"
    sha256 = $packageHashes[$apkName]
    size = (Get-Item -LiteralPath $apkPath).Length
  }
  windows = [ordered]@{
    version = $Version
    url = "https://nivrapp-secure.vercel.app/downloads/$setupName"
    sha256 = $packageHashes[$setupName]
    size = (Get-Item -LiteralPath $setupPath).Length
  }
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($checksumPath, ($hashLines -join [Environment]::NewLine) + [Environment]::NewLine, $utf8)
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json) + [Environment]::NewLine, $utf8)
[System.IO.File]::WriteAllText($updateManifestPath, ($updateManifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine, $utf8)
Write-Output "Verified Nivra ${Version}: $($webHashes.Count) desktop web files, $androidCount Android web files, $zipCount ZIP web files."
Write-Output "Verified Android package com.nivra.app version $Version build $versionCode; pinned signer SHA256: $($apkCertificates -join ', ')"
Write-Output "SHA256 manifest: $checksumPath"
Write-Output "Updated Android release metadata: $metadataPath"
Write-Output "Verified app update feed (publish as latest.json): $updateManifestPath"
