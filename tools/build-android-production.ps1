#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [string]$KeyStorePath = (Join-Path $env:USERPROFILE '.android\debug.keystore'),
  [string]$KeyAlias = 'androiddebugkey'
)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath $KeyStorePath -PathType Leaf)) { throw 'Existing signing keystore is required. Never generate a replacement for installed apps.' }
if (-not $env:NIVRA_ANDROID_STORE_PASSWORD -or -not $env:NIVRA_ANDROID_KEY_PASSWORD) { throw 'Set NIVRA_ANDROID_STORE_PASSWORD and NIVRA_ANDROID_KEY_PASSWORD for the existing signing key.' }
$source = Get-Content -LiteralPath (Join-Path $workspace 'android\app\build.gradle') -Raw
if ($source -notmatch ('versionName\s+"' + [regex]::Escape($Version) + '"')) { throw 'Android version differs from requested release.' }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$buildTools = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'lib\apksigner.jar') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'Android build-tools with apksigner are required.' }
$java = Join-Path $env:JAVA_HOME 'bin\java.exe'
if (-not (Test-Path -LiteralPath $java)) { throw 'Set JAVA_HOME to the build JDK (21 or newer).' }
Push-Location -LiteralPath (Join-Path $workspace 'android')
try { & .\gradlew.bat assembleRelease; if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' } }
finally { Pop-Location }
$unsigned = Join-Path $workspace 'android\app\build\outputs\apk\release\app-release-unsigned.apk'
if (-not (Test-Path -LiteralPath $unsigned)) { throw 'Unsigned release APK is missing.' }
$output = Join-Path $workspace "artifacts\Nivra-$Version-debug.apk"
# Retain the public filename contract for old updaters. This file is a release
# build, signed by the existing key; verify-release checks debuggability/signing.
& $java -jar (Join-Path $buildTools.FullName 'lib\apksigner.jar') sign --ks $KeyStorePath --ks-key-alias $KeyAlias --ks-pass env:NIVRA_ANDROID_STORE_PASSWORD --key-pass env:NIVRA_ANDROID_KEY_PASSWORD --out $output $unsigned
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
$signer = @(& $java -jar (Join-Path $buildTools.FullName 'lib\apksigner.jar') verify --verbose --print-certs $output 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'Signed APK verification failed.' }
$links = Get-Content -LiteralPath (Join-Path $workspace 'nivra-app\src\.well-known\assetlinks.json') -Raw | ConvertFrom-Json
$pins = @($links | Where-Object { $_.target.package_name -eq 'com.nivra.app' } | ForEach-Object { $_.target.sha256_cert_fingerprints } | ForEach-Object { $_.Replace(':','').ToLowerInvariant() })
$match = [regex]::Match(($signer -join "`n"), '(?im)^Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)\s*$')
if (-not $match.Success -or $pins -notcontains $match.Groups[1].Value.ToLowerInvariant()) { throw 'APK signer differs from the pinned update certificate. Do not publish this APK.' }
$badging = @(& (Join-Path $buildTools.FullName 'aapt.exe') dump badging $output 2>&1)
if ($LASTEXITCODE -ne 0 -or ($badging -join "`n") -match '(?m)^application-debuggable\s*$') { throw 'The production APK must not be debuggable.' }
Write-Output "Verified signed, non-debuggable Android release: $output"
