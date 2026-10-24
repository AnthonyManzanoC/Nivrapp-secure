param(
  [string]$PackageDirectory,
  [string]$OutputDirectory,
  [string]$MakensisPath,
  [switch]$LowDiskUsage,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$desktopDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$workspaceDirectory = (Resolve-Path -LiteralPath (Join-Path $desktopDirectory '..')).Path
$package = Get-Content -LiteralPath (Join-Path $desktopDirectory 'package.json') -Raw | ConvertFrom-Json
$appVersion = [string]$package.version
if ($appVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Desktop package version must have three numeric components.' }
if (-not $PackageDirectory) { $PackageDirectory = Join-Path $desktopDirectory 'dist\Nivra-win32-x64' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $workspaceDirectory 'artifacts' }
$packageDirectoryPath = (Resolve-Path -LiteralPath $PackageDirectory).Path
$outputDirectoryPath = [IO.Path]::GetFullPath($OutputDirectory)

foreach ($requiredFile in @('Nivra.exe', 'icudtl.dat', 'resources.pak', 'locales\en-US.pak', 'resources\app.asar', 'resources\browser\index.html')) {
  if (-not (Test-Path -LiteralPath (Join-Path $packageDirectoryPath $requiredFile) -PathType Leaf)) {
    throw "Incomplete Electron package. Missing: $requiredFile. Run the web build and npm run build-exe first."
  }
}
$executableVersion = (Get-Item -LiteralPath (Join-Path $packageDirectoryPath 'Nivra.exe')).VersionInfo.ProductVersion
if ($executableVersion -ne $appVersion) { throw "Packaged executable version $executableVersion differs from desktop package version $appVersion. Rebuild the Electron package first." }
$packagedFiles = @(Get-ChildItem -LiteralPath $packageDirectoryPath -File -Recurse -Force)
$installedSizeKb = [math]::Ceiling(($packagedFiles | Measure-Object -Property Length -Sum).Sum / 1KB)
if ($ValidateOnly) {
  Write-Output "Verified complete Windows package: Nivra $appVersion, $($packagedFiles.Count) files, $installedSizeKb KiB."
  return
}

if (-not $MakensisPath) {
  $compilerCandidates = @()
  $compilerCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($compilerCommand) { $compilerCandidates += $compilerCommand.Source }
  if (${env:ProgramFiles(x86)}) { $compilerCandidates += Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe' }
  if ($env:ProgramFiles) { $compilerCandidates += Join-Path $env:ProgramFiles 'NSIS\makensis.exe' }
  $nsisCache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis'
  if (Test-Path -LiteralPath $nsisCache) {
    foreach ($cacheEntry in (Get-ChildItem -LiteralPath $nsisCache -Directory -Filter 'nsis-*' | Sort-Object Name -Descending)) {
      $compilerCandidates += Join-Path $cacheEntry.FullName 'Bin\makensis.exe'
      $compilerCandidates += Join-Path $cacheEntry.FullName 'makensis.exe'
    }
  }
  $MakensisPath = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $MakensisPath -or -not (Test-Path -LiteralPath $MakensisPath -PathType Leaf)) {
  throw 'NSIS compiler not found. Install NSIS from https://nsis.sourceforge.io/Download or pass -MakensisPath.'
}

New-Item -ItemType Directory -Path $outputDirectoryPath -Force | Out-Null
$setupPath = Join-Path $outputDirectoryPath "Nivra-$appVersion-Setup.exe"
$manifestPath = Join-Path $outputDirectoryPath "Nivra-$appVersion-uninstall-manifest.nsh"
$manifestLines = [Collections.Generic.List[string]]::new()
foreach ($file in $packagedFiles) {
  $relativePath = $file.FullName.Substring($packageDirectoryPath.TrimEnd('\').Length + 1)
  $escapedRelativePath = $relativePath.Replace('$', '$$')
  $manifestLines.Add('Delete "$INSTDIR\' + $escapedRelativePath + '"')
}
foreach ($directory in (Get-ChildItem -LiteralPath $packageDirectoryPath -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending)) {
  $relativePath = $directory.FullName.Substring($packageDirectoryPath.TrimEnd('\').Length + 1)
  $manifestLines.Add('RMDir "$INSTDIR\' + $relativePath.Replace('$', '$$') + '"')
}
[IO.File]::WriteAllLines($manifestPath, $manifestLines, [Text.UTF8Encoding]::new($false))
$arguments = @(
  '/V2',
  "/DAPP_VERSION=$appVersion",
  "/DPACKAGE_DIR=$packageDirectoryPath",
  "/DSETUP_PATH=$setupPath",
  "/DAPP_ICON=$(Join-Path $desktopDirectory 'icon.ico')",
  "/DUNINSTALL_MANIFEST=$manifestPath",
  "/DINSTALLED_SIZE_KB=$installedSizeKb",
  (Join-Path $PSScriptRoot 'Nivra.nsi')
)
if ($LowDiskUsage) { $arguments = @('/DLOW_DISK_USAGE') + $arguments }
& $MakensisPath @arguments
if ($LASTEXITCODE -ne 0) { throw "NSIS failed with exit code $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw 'NSIS did not produce the expected installer.' }
$setupFile = Get-Item -LiteralPath $setupPath
$setupHashAlgorithm = [Security.Cryptography.SHA256]::Create()
$setupHashStream = [IO.File]::OpenRead($setupPath)
try { $setupHash = [BitConverter]::ToString($setupHashAlgorithm.ComputeHash($setupHashStream)).Replace('-', '').ToLowerInvariant() }
finally { $setupHashStream.Dispose(); $setupHashAlgorithm.Dispose() }
[pscustomobject]@{
  version = $appVersion
  installer = $setupFile.FullName
  size = $setupFile.Length
  sha256 = $setupHash
  packageFiles = $packagedFiles.Count
} | ConvertTo-Json
