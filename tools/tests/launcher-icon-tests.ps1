[CmdletBinding()]
param([switch]$CompileResources)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Res = Join-Path $Root 'android\app\src\main\res'
$AndroidNs = 'http://schemas.android.com/apk/res/android'
$checks = 0
function Assert-Icon([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}

$densities = [ordered]@{ 'mipmap-mdpi' = 1; 'mipmap-hdpi' = 1.5; 'mipmap-xhdpi' = 2; 'mipmap-xxhdpi' = 3; 'mipmap-xxxhdpi' = 4 }
foreach ($bucket in $densities.Keys) {
    foreach ($variant in @(@('ic_launcher', 48), @('ic_launcher_round', 48), @('ic_launcher_foreground', 108))) {
        $image = [System.Drawing.Bitmap]::FromFile((Join-Path $Res "$bucket\$($variant[0]).png"))
        try {
            $size = [int]($variant[1] * $densities[$bucket])
            Assert-Icon ($image.Width -eq $size -and $image.Height -eq $size) "Wrong launcher size: $bucket/$($variant[0])"
            Assert-Icon ($image.GetPixel(0, 0).A -eq 0) "Launcher corners must stay transparent: $bucket/$($variant[0])"
        } finally { $image.Dispose() }
    }
}

$foreground = [System.Drawing.Bitmap]::FromFile((Join-Path $Res 'mipmap-xxxhdpi\ic_launcher_foreground.png'))
$maxRadius = 0.0
try {
    for ($py = 0; $py -lt $foreground.Height; $py++) {
        for ($px = 0; $px -lt $foreground.Width; $px++) {
            if ($foreground.GetPixel($px, $py).A -gt 16) {
                $dx = (($px + 0.5) / 4) - 54
                $dy = (($py + 0.5) / 4) - 54
                $maxRadius = [Math]::Max($maxRadius, [Math]::Sqrt($dx * $dx + $dy * $dy))
            }
        }
    }
    Assert-Icon ($maxRadius -gt 24 -and $maxRadius -le 33) "Essential mark leaves the 66dp safe circle: radius $maxRadius"
} finally { $foreground.Dispose() }

foreach ($version in @(26, 33)) {
    foreach ($name in @('ic_launcher', 'ic_launcher_round')) {
        [xml]$adaptive = [System.IO.File]::ReadAllText((Join-Path $Res "mipmap-anydpi-v$version\$name.xml"))
        $layers = $adaptive.'adaptive-icon'
        Assert-Icon ($layers.background.GetAttribute('drawable', $AndroidNs) -eq '@drawable/ic_launcher_background') "Wrong background reference: $version/$name"
        Assert-Icon ($layers.foreground.GetAttribute('drawable', $AndroidNs) -eq '@drawable/ic_launcher_foreground') "Wrong foreground reference: $version/$name"
        if ($version -ge 33) {
            Assert-Icon ($layers.monochrome.GetAttribute('drawable', $AndroidNs) -eq '@drawable/ic_launcher_monochrome') "Missing themed icon: $name"
        } else { Assert-Icon ($null -eq $layers.monochrome) "Themed layer must use the Android 13 resource qualifier: $name" }
    }
}

foreach ($relative in @('drawable-v24\ic_launcher_foreground.xml', 'drawable\ic_launcher_background.xml', 'drawable\ic_launcher_monochrome.xml')) {
    [xml]$vector = [System.IO.File]::ReadAllText((Join-Path $Res $relative))
    Assert-Icon ($vector.vector.GetAttribute('viewportWidth', $AndroidNs) -eq '108' -and $vector.vector.GetAttribute('viewportHeight', $AndroidNs) -eq '108') "Wrong adaptive layer canvas: $relative"
}
[xml]$monochrome = [System.IO.File]::ReadAllText((Join-Path $Res 'drawable\ic_launcher_monochrome.xml'))
Assert-Icon (@($monochrome.vector.path).Count -eq 2) 'The themed mark must preserve both shield and bolt.'
foreach ($path in $monochrome.vector.path) {
    foreach ($attribute in @('fillColor', 'strokeColor')) {
        if ($path.HasAttribute($attribute, $AndroidNs)) {
            Assert-Icon ($path.GetAttribute($attribute, $AndroidNs) -in @('#FFFFFFFF', '#00000000')) "Monochrome layer has colored pixels: $attribute"
        }
    }
}

# Launcher alias migration must never disable the real deep-link/share/call activity.
[xml]$manifest = [System.IO.File]::ReadAllText((Join-Path $Root 'android\app\src\main\AndroidManifest.xml'))
$main = @($manifest.manifest.application.activity) | Where-Object { $_.GetAttribute('name', $AndroidNs) -eq '.MainActivity' }
Assert-Icon ($main.GetAttribute('enabled', $AndroidNs) -eq 'true') 'MainActivity must remain enabled for links, sharing and calls.'
$mainActions = @($main.'intent-filter'.action | ForEach-Object { $_.GetAttribute('name', $AndroidNs) })
Assert-Icon ('android.intent.action.MAIN' -notin $mainActions) 'Launcher entry must use aliases, never toggle MainActivity.'
foreach ($action in @('android.intent.action.VIEW', 'android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE')) {
    Assert-Icon ($action -in $mainActions) "MainActivity lost an existing integration: $action"
}
$aliases = @($manifest.manifest.application.'activity-alias')
Assert-Icon ($aliases.Count -eq 3) 'Only three curated launcher aliases are allowed.'
foreach ($entry in @(@('original', 'Original'), @('emerald', 'Emerald'), @('ivory', 'Ivory'))) {
    $id = $entry[0]
    $suffix = if ($id -eq 'original') { '' } else { "_$id" }
    $alias = $aliases | Where-Object { $_.GetAttribute('name', $AndroidNs) -eq ".Launcher$($entry[1])" }
    Assert-Icon ($null -ne $alias -and $alias.GetAttribute('targetActivity', $AndroidNs) -eq '.MainActivity') "Invalid stable alias: $id"
    Assert-Icon ($alias.GetAttribute('enabled', $AndroidNs) -eq $(if ($id -eq 'original') { 'true' } else { 'false' })) "Wrong default alias state: $id"
    Assert-Icon ($alias.'intent-filter'.action.GetAttribute('name', $AndroidNs) -eq 'android.intent.action.MAIN' -and $alias.'intent-filter'.category.GetAttribute('name', $AndroidNs) -eq 'android.intent.category.LAUNCHER') "Wrong launcher intent: $id"
    Assert-Icon ($alias.GetAttribute('icon', $AndroidNs) -eq "@mipmap/ic_launcher$suffix") "Wrong alias icon: $id"
    foreach ($version in @(26, 33)) {
        foreach ($round in @('', '_round')) {
            [xml]$variant = [System.IO.File]::ReadAllText((Join-Path $Res "mipmap-anydpi-v$version\ic_launcher$suffix$round.xml"))
            $background = '@drawable/ic_launcher_background' + $suffix
            $foregroundName = '@drawable/ic_launcher_foreground' + $suffix
            Assert-Icon ($variant.'adaptive-icon'.background.GetAttribute('drawable', $AndroidNs) -eq $background) "Wrong variant background: $id/$version"
            Assert-Icon ($variant.'adaptive-icon'.foreground.GetAttribute('drawable', $AndroidNs) -eq $foregroundName) "Wrong variant foreground: $id/$version"
            if ($version -eq 33) { Assert-Icon ($null -ne $variant.'adaptive-icon'.monochrome) "Missing themed variant: $id" }
        }
    }
    foreach ($bucket in $densities.Keys) {
        foreach ($round in @('', '_round')) {
            $bitmap = [System.Drawing.Bitmap]::FromFile((Join-Path $Res "$bucket\ic_launcher$suffix$round.png"))
            try { Assert-Icon ($bitmap.Width -eq [int](48 * $densities[$bucket]) -and $bitmap.Height -eq $bitmap.Width) "Wrong legacy variant size: $id/$bucket" }
            finally { $bitmap.Dispose() }
        }
    }
    [xml]$previewSvg = [System.IO.File]::ReadAllText((Join-Path $Root "nivra-app\src\assets\brand\launcher-$id.svg"))
    Assert-Icon ($previewSvg.svg.viewBox -eq '18 18 72 72') "Preview does not match the native visible viewport: $id"
    $previewPng = [System.Drawing.Bitmap]::FromFile((Join-Path $Root "nivra-app\src\assets\brand\launcher-$id.png"))
    try { Assert-Icon ($previewPng.Width -eq 512 -and $previewPng.Height -eq 512) "Wrong PNG preview: $id" } finally { $previewPng.Dispose() }
    $ico = [System.IO.File]::ReadAllBytes((Join-Path $Root "Nivra.Desktop\icons\launcher-$id.ico"))
    Assert-Icon ([BitConverter]::ToUInt16($ico, 0) -eq 0 -and [BitConverter]::ToUInt16($ico, 2) -eq 1 -and [BitConverter]::ToUInt16($ico, 4) -eq 7) "Malformed bundled ICO: $id"
}

if ($CompileResources) {
    $buildToolsRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk\build-tools'
    $aapt = Get-ChildItem $buildToolsRoot -Directory | Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'aapt2.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $aapt) { throw 'Android aapt2 is unavailable; cannot claim resource compilation.' }
    $output = Join-Path $Root 'artifacts\launcher-compiled-resources.zip'
    [System.IO.Directory]::CreateDirectory((Split-Path $output -Parent)) | Out-Null
    & $aapt compile --dir $Res -o $output
    if ($LASTEXITCODE -ne 0) { throw "Android aapt2 resource compile failed: $LASTEXITCODE" }
    Assert-Icon (Test-Path $output) 'Android compiled resource output missing.'
}
Write-Host "$checks launcher resource checks passed; visible foreground radius $([Math]::Round($maxRadius, 2))dp / 33dp."
