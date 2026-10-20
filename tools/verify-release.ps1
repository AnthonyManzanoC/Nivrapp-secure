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

# No checksum manifest or API metadata is written until every verification above passes.
$packageHashes = [ordered]@{}
foreach ($packagePath in @($apkPath, $setupPath, $zipPath)) {
  $packageHashes[[System.IO.Path]::GetFileName($packagePath)] = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
}
$hashLines = foreach ($packageName in $packageHashes.Keys) { "$($packageHashes[$packageName])  $packageName" }
$checksumPath = Join-Path $artifactPath "Nivra-$Version-SHA256.txt"
$metadataPath = Join-Path $workspacePath 'Nivra.Api\android-release.json'
$metadata = [ordered]@{
  version = $Version
  versionCode = [int]$versionCode
  url = "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v$Version/$apkName"
  sha256 = $packageHashes[$apkName]
  size = (Get-Item -LiteralPath $apkPath).Length
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($checksumPath, ($hashLines -join [Environment]::NewLine) + [Environment]::NewLine, $utf8)
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json) + [Environment]::NewLine, $utf8)
Write-Output "Verified Nivra ${Version}: $($webHashes.Count) desktop web files, $androidCount Android web files, $zipCount ZIP web files."
Write-Output "SHA256 manifest: $checksumPath"
Write-Output "Updated Android release metadata: $metadataPath"
