[CmdletBinding()]
param(
    # The Android launcher is intentionally independent of web/Desktop/splash branding.
    [switch]$IncludeDesktopAndSplash
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AndroidRes = Join-Path $Root 'android\app\src\main\res'
$ArtworkPath = Join-Path $PSScriptRoot 'brand\nivra-launcher.svg'
$PreviewPath = Join-Path $Root 'artifacts\nivra-android-launcher-preview.png'
[xml]$Artwork = [System.IO.File]::ReadAllText($ArtworkPath)
$SvgNs = New-Object System.Xml.XmlNamespaceManager($Artwork.NameTable)
$SvgNs.AddNamespace('svg', 'http://www.w3.org/2000/svg')
$Gradients = @{}
foreach ($gradient in $Artwork.SelectNodes('//svg:linearGradient', $SvgNs)) {
    $Gradients[$gradient.GetAttribute('id')] = $gradient
}

function Save-Text([string]$Path, [string]$Content) {
    [System.IO.Directory]::CreateDirectory((Split-Path $Path -Parent)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Content + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function New-Bitmap([int]$Width, [int]$Height) {
    $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    return $bitmap
}

function New-Graphics($Bitmap) {
    $graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    return $graphics
}

function Save-Png($Bitmap, [string]$Path) {
    [System.IO.Directory]::CreateDirectory((Split-Path $Path -Parent)) | Out-Null
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Get-Scalar([string]$Text) {
    return [single]::Parse($Text, [System.Globalization.CultureInfo]::InvariantCulture)
}

# The canonical SVG deliberately uses only absolute M/L/C/Z so GDI+, SVG and Android
# share the exact geometry. Fail for other commands instead of silently losing detail.
function New-VectorPath([string]$Data) {
    $tokens = [regex]::Matches($Data, '[A-Za-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?')
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cursor = New-Object System.Drawing.PointF(0, 0)
    $start = $cursor
    $index = 0
    try {
        while ($index -lt $tokens.Count) {
            $command = $tokens[$index++].Value
            switch -CaseSensitive ($command) {
                'M' {
                    $cursor = New-Object System.Drawing.PointF((Get-Scalar $tokens[$index++].Value), (Get-Scalar $tokens[$index++].Value))
                    $start = $cursor
                    $path.StartFigure()
                }
                'L' {
                    $next = New-Object System.Drawing.PointF((Get-Scalar $tokens[$index++].Value), (Get-Scalar $tokens[$index++].Value))
                    $path.AddLine($cursor, $next)
                    $cursor = $next
                }
                'C' {
                    $one = New-Object System.Drawing.PointF((Get-Scalar $tokens[$index++].Value), (Get-Scalar $tokens[$index++].Value))
                    $two = New-Object System.Drawing.PointF((Get-Scalar $tokens[$index++].Value), (Get-Scalar $tokens[$index++].Value))
                    $next = New-Object System.Drawing.PointF((Get-Scalar $tokens[$index++].Value), (Get-Scalar $tokens[$index++].Value))
                    $path.AddBezier($cursor, $one, $two, $next)
                    $cursor = $next
                }
                'Z' { $path.CloseFigure(); $cursor = $start }
                default { throw "Unsupported SVG path command: $command" }
            }
        }
        return $path
    }
    catch { $path.Dispose(); throw }
}

function New-SvgBrush([string]$Value, [single]$Opacity = 1) {
    if ($Value -match '^url\(#([\w-]+)\)$') {
        $gradient = $Gradients[$Matches[1]]
        if (-not $gradient) { throw "Missing SVG gradient: $Value" }
        $stops = @($gradient.SelectNodes('svg:stop', $SvgNs))
        $first = New-Object System.Drawing.PointF((Get-Scalar $gradient.GetAttribute('x1')), (Get-Scalar $gradient.GetAttribute('y1')))
        $last = New-Object System.Drawing.PointF((Get-Scalar $gradient.GetAttribute('x2')), (Get-Scalar $gradient.GetAttribute('y2')))
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($first, $last, [System.Drawing.Color]::Black, [System.Drawing.Color]::White)
        $blend = New-Object System.Drawing.Drawing2D.ColorBlend($stops.Count)
        $blend.Positions = [single[]]@($stops | ForEach-Object { Get-Scalar $_.GetAttribute('offset') })
        $blend.Colors = [System.Drawing.Color[]]@($stops | ForEach-Object {
            [System.Drawing.Color]::FromArgb([int](255 * $Opacity), [System.Drawing.ColorTranslator]::FromHtml($_.GetAttribute('stop-color')))
        })
        $brush.InterpolationColors = $blend
        $brush.WrapMode = [System.Drawing.Drawing2D.WrapMode]::TileFlipXY
        return $brush
    }
    return New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](255 * $Opacity), [System.Drawing.ColorTranslator]::FromHtml($Value)))
}

function Draw-SvgLayer($Graphics, [string]$Layer) {
    foreach ($node in $Artwork.SelectNodes("//svg:g[@id='$Layer']/svg:path", $SvgNs)) {
        $path = New-VectorPath $node.GetAttribute('d')
        try {
            $fill = $node.GetAttribute('fill')
            if ($fill -and $fill -ne 'none') {
                $opacity = if ($node.HasAttribute('fill-opacity')) { Get-Scalar $node.GetAttribute('fill-opacity') } else { 1 }
                $brush = New-SvgBrush $fill $opacity
                try { $Graphics.FillPath($brush, $path) } finally { $brush.Dispose() }
            }
            if ($node.HasAttribute('stroke')) {
                $opacity = if ($node.HasAttribute('stroke-opacity')) { Get-Scalar $node.GetAttribute('stroke-opacity') } else { 1 }
                $brush = New-SvgBrush $node.GetAttribute('stroke') $opacity
                $pen = New-Object System.Drawing.Pen($brush, (Get-Scalar $node.GetAttribute('stroke-width')))
                $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
                try { $Graphics.DrawPath($pen, $path) } finally { $pen.Dispose(); $brush.Dispose() }
            }
        }
        finally { $path.Dispose() }
    }
}

function New-RoundedMask([single]$Size, [single]$Radius) {
    $mask = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $Radius * 2
    $mask.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $mask.AddArc(($Size - $diameter), 0, $diameter, $diameter, 270, 90)
    $mask.AddArc(($Size - $diameter), ($Size - $diameter), $diameter, $diameter, 0, 90)
    $mask.AddArc(0, ($Size - $diameter), $diameter, $diameter, 90, 90)
    $mask.CloseFigure()
    return $mask
}

function New-Launcher([int]$Size, [ValidateSet('Round', 'Square', 'Foreground', 'Themed')] [string]$Mode) {
    $working = New-Bitmap ($Size * 4) ($Size * 4)
    $graphics = New-Graphics $working
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        if ($Mode -ne 'Foreground') {
            $mask = if ($Mode -eq 'Round') {
                $ellipse = New-Object System.Drawing.Drawing2D.GraphicsPath
                $ellipse.AddEllipse(0, 0, $working.Width, $working.Height)
                $ellipse
            } else { New-RoundedMask $working.Width ($working.Width * 0.25) }
            try { $graphics.SetClip($mask) } finally { $mask.Dispose() }
            # Android's visible adaptive viewport is the middle 72dp of each 108dp layer.
            $graphics.TranslateTransform([single](-$working.Width * 0.25), [single](-$working.Height * 0.25))
            $graphics.ScaleTransform([single]($working.Width / 72), [single]($working.Height / 72))
            if ($Mode -eq 'Themed') {
                $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#D7E6D3'))
                $foreground = New-VectorPath $Artwork.SelectSingleNode("//svg:g[@id='foreground']/svg:path[1]", $SvgNs).GetAttribute('d')
                $bolt = New-VectorPath $Artwork.SelectSingleNode("//svg:g[@id='foreground']/svg:path[4]", $SvgNs).GetAttribute('d')
                $pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#213E30'), 2.4)
                $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#213E30'))
                try { $graphics.DrawPath($pen, $foreground); $graphics.FillPath($brush, $bolt) }
                finally { $foreground.Dispose(); $bolt.Dispose(); $pen.Dispose(); $brush.Dispose() }
            } else { Draw-SvgLayer $graphics 'background'; Draw-SvgLayer $graphics 'foreground' }
        } else {
            $graphics.ScaleTransform([single]($working.Width / 108), [single]($working.Height / 108))
            Draw-SvgLayer $graphics 'foreground'
        }
    }
    finally { $graphics.Dispose() }
    $result = New-Bitmap $Size $Size
    $graphics = New-Graphics $result
    try { $graphics.DrawImage($working, 0, 0, $Size, $Size) }
    finally { $graphics.Dispose(); $working.Dispose() }
    return $result
}

function Get-AndroidPaint([string]$Kind, [string]$Value) {
    if ($Value -match '^url\(#([\w-]+)\)$') {
        $gradient = $Gradients[$Matches[1]]
        $stops = @($gradient.SelectNodes('svg:stop', $SvgNs) | ForEach-Object {
            '                    <item android:offset="' + $_.GetAttribute('offset') + '" android:color="' + $_.GetAttribute('stop-color') + '" />'
        }) -join "`n"
        return @"
            <aapt:attr name="android:$Kind">
                <gradient android:type="linear" android:startX="$($gradient.GetAttribute('x1'))" android:startY="$($gradient.GetAttribute('y1'))" android:endX="$($gradient.GetAttribute('x2'))" android:endY="$($gradient.GetAttribute('y2'))">
$stops
                </gradient>
            </aapt:attr>
"@
    }
    return ''
}

function New-AndroidVector([string]$Layer) {
    $paths = foreach ($node in $Artwork.SelectNodes("//svg:g[@id='$Layer']/svg:path", $SvgNs)) {
        $attributes = @('android:pathData="' + $node.GetAttribute('d') + '"')
        $paint = @()
        foreach ($kind in @('fill', 'stroke')) {
            $value = $node.GetAttribute($kind)
            if (-not $value -or $value -eq 'none') { continue }
            if ($value.StartsWith('url(')) { $paint += Get-AndroidPaint ($kind + 'Color') $value }
            else { $attributes += 'android:' + $kind + 'Color="' + $value + '"' }
            if ($node.HasAttribute($kind + '-opacity')) { $attributes += 'android:' + $kind + 'Alpha="' + $node.GetAttribute($kind + '-opacity') + '"' }
        }
        if ($node.HasAttribute('stroke-width')) {
            $attributes += 'android:strokeWidth="' + $node.GetAttribute('stroke-width') + '"'
            $attributes += 'android:strokeLineJoin="round"'
        }
        if (-not $node.HasAttribute('fill') -or $node.GetAttribute('fill') -eq 'none') { $attributes += 'android:fillColor="#00000000"' }
        "    <path $($attributes -join ' ')>`n$($paint -join "`n")`n    </path>"
    }
    return @"
<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from tools/brand/nivra-launcher.svg; 108dp layer, 66dp safe circle. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
$($paths -join "`n")
</vector>
"@
}

function Set-LauncherVariant([string]$Id) {
    $source = [System.IO.File]::ReadAllText($ArtworkPath)
    $palette = switch ($Id) {
        'original' { @{} }
        'emerald' { @{ '#163D31'='#176048'; '#09271F'='#0B4333'; '#041710'='#05281E'; '#153E31'='#165139'; '#08251C'='#0A3325'; '#D8FAE9'='#E4FFF1'; '#99E4BF'='#94F0C1'; '#42B88B'='#39CC91' } }
        'ivory' { @{ '#163D31'='#FBFAF0'; '#09271F'='#EFF1E4'; '#041710'='#DFE6D6'; '#153E31'='#EDF2E2'; '#08251C'='#DDE8D4'; '#D8FAE9'='#173F2B'; '#99E4BF'='#275A3D'; '#42B88B'='#3D7651'; '#C4EFDA'='#365848'; '#EEFFF4'='#123E2B'; '#BEF3D6'='#245A3D'; '#67D4A5'='#477C50'; '#DFF9EA'='#244832' } }
        default { throw 'Unknown launcher variant.' }
    }
    foreach ($color in $palette.Keys) { $source = $source.Replace($color, $palette[$color]) }
    $script:Artwork = [xml]$source
    $script:SvgNs = New-Object System.Xml.XmlNamespaceManager($script:Artwork.NameTable)
    $script:SvgNs.AddNamespace('svg', 'http://www.w3.org/2000/svg')
    $script:Gradients = @{}
    foreach ($gradient in $script:Artwork.SelectNodes('//svg:linearGradient', $script:SvgNs)) { $script:Gradients[$gradient.GetAttribute('id')] = $gradient }
}

function Save-LauncherIco([string]$Path) {
    $entries = foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
        $bitmap = New-Launcher $size 'Square'
        $stream = New-Object System.IO.MemoryStream
        try {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            [pscustomobject]@{ Size = $size; Data = $stream.ToArray() }
        } finally { $bitmap.Dispose(); $stream.Dispose() }
    }
    [System.IO.Directory]::CreateDirectory((Split-Path $Path -Parent)) | Out-Null
    $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Create($Path))
    try {
        $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$entries.Count)
        $offset = 6 + ($entries.Count * 16)
        foreach ($entry in $entries) {
            $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
            $writer.Write([Byte]$dimension); $writer.Write([Byte]$dimension); $writer.Write([Byte]0); $writer.Write([Byte]0)
            $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$entry.Data.Length); $writer.Write([UInt32]$offset)
            $offset += $entry.Data.Length
        }
        foreach ($entry in $entries) { $writer.Write([Byte[]]$entry.Data) }
    } finally { $writer.Dispose() }
}

Save-Text (Join-Path $AndroidRes 'drawable\ic_launcher_background.xml') (New-AndroidVector 'background')
Save-Text (Join-Path $AndroidRes 'drawable-v24\ic_launcher_foreground.xml') (New-AndroidVector 'foreground')
$shieldData = $Artwork.SelectSingleNode("//svg:g[@id='foreground']/svg:path[1]", $SvgNs).GetAttribute('d')
$boltData = $Artwork.SelectSingleNode("//svg:g[@id='foreground']/svg:path[4]", $SvgNs).GetAttribute('d')
$monochrome = @"
<?xml version="1.0" encoding="utf-8"?>
<!-- Alpha-only shield and bolt for Android 13+ themed launcher icons. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    <path android:pathData="$shieldData" android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="2.4" android:strokeLineJoin="round" />
    <path android:pathData="$boltData" android:fillColor="#FFFFFFFF" />
</vector>
"@
Save-Text (Join-Path $AndroidRes 'drawable\ic_launcher_monochrome.xml') $monochrome
Save-Text (Join-Path $AndroidRes 'values\ic_launcher_background.xml') '<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">#09271F</color></resources>'

$adaptive = @'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
'@
$adaptiveThemed = $adaptive.Replace('</adaptive-icon>', "    <monochrome android:drawable=`"@drawable/ic_launcher_monochrome`" />`n</adaptive-icon>")
foreach ($name in @('ic_launcher.xml', 'ic_launcher_round.xml')) {
    Save-Text (Join-Path $AndroidRes "mipmap-anydpi-v26\$name") $adaptive
    Save-Text (Join-Path $AndroidRes "mipmap-anydpi-v33\$name") $adaptiveThemed
}

$densities = [ordered]@{ 'mipmap-mdpi' = 1; 'mipmap-hdpi' = 1.5; 'mipmap-xhdpi' = 2; 'mipmap-xxhdpi' = 3; 'mipmap-xxxhdpi' = 4 }
foreach ($bucket in $densities.Keys) {
    foreach ($variant in @(@('ic_launcher', 'Square', 48), @('ic_launcher_round', 'Round', 48), @('ic_launcher_foreground', 'Foreground', 108))) {
        $bitmap = New-Launcher ([int]($variant[2] * $densities[$bucket])) $variant[1]
        try { Save-Png $bitmap (Join-Path $AndroidRes "$bucket\$($variant[0]).png") }
        finally { $bitmap.Dispose() }
    }
}

$preview = New-Bitmap 1240 570
$graphics = New-Graphics $preview
$ink = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#19362A'))
$muted = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#607467'))
$font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Regular)
$heading = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Bold)
try {
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#F5F5ED'))
    $graphics.DrawString('Nivra', $heading, $ink, 52, 35)
    $graphics.DrawString('Android launcher · escudo y rayo · capas adaptables', $font, $muted, 54, 87)
    $variants = @(@('Square', 'Cuadrado suave'), @('Round', 'Circular'), @('Themed', 'Tema del sistema'))
    for ($index = 0; $index -lt $variants.Count; $index++) {
        $left = 62 + $index * 400
        $bitmap = New-Launcher 240 $variants[$index][0]
        $small = New-Launcher 48 $variants[$index][0]
        try { $graphics.DrawImage($bitmap, $left, 153, 240, 240); $graphics.DrawImage($small, ($left + 280), 335, 48, 48) }
        finally { $bitmap.Dispose(); $small.Dispose() }
        $graphics.DrawString($variants[$index][1], $font, $ink, $left, 424)
    }
    $graphics.DrawString('Vista previa de recursos generados · el launcher aplica su propia forma y tema', $font, $muted, 54, 510)
    Save-Png $preview $PreviewPath
}
finally { $graphics.Dispose(); $preview.Dispose(); $font.Dispose(); $heading.Dispose(); $ink.Dispose(); $muted.Dispose() }

# Fixed, bundled choices only. These IDs, resources and activity-alias names are
# stable across future releases so Android keeps the user's installed selection.
foreach ($variantId in @('original', 'emerald', 'ivory')) {
    Set-LauncherVariant $variantId
    $previewSvg = $Artwork.OuterXml.Replace('viewBox="0 0 108 108"', 'viewBox="18 18 72 72"')
    $previewSvg = $previewSvg.Replace('</defs>', '<clipPath id="launcher-mask"><rect x="18" y="18" width="72" height="72" rx="18" /></clipPath></defs>')
    $previewSvg = $previewSvg.Replace('<g id="background">', '<g id="background" clip-path="url(#launcher-mask)">').Replace('<g id="foreground">', '<g id="foreground" clip-path="url(#launcher-mask)">')
    Save-Text (Join-Path $Root "nivra-app\src\assets\brand\launcher-$variantId.svg") $previewSvg
    $previewIcon = New-Launcher 512 'Square'
    try { Save-Png $previewIcon (Join-Path $Root "nivra-app\src\assets\brand\launcher-$variantId.png") }
    finally { $previewIcon.Dispose() }
    Save-LauncherIco (Join-Path $Root "Nivra.Desktop\icons\launcher-$variantId.ico")
    if ($variantId -eq 'original') { continue }
    Save-Text (Join-Path $AndroidRes "drawable\ic_launcher_background_$variantId.xml") (New-AndroidVector 'background')
    Save-Text (Join-Path $AndroidRes "drawable-v24\ic_launcher_foreground_$variantId.xml") (New-AndroidVector 'foreground')
    foreach ($name in @("ic_launcher_$variantId", "ic_launcher_$($variantId)_round")) {
        $variantAdaptive = $adaptive.Replace('@drawable/ic_launcher_background', "@drawable/ic_launcher_background_$variantId").Replace('@drawable/ic_launcher_foreground', "@drawable/ic_launcher_foreground_$variantId")
        $variantThemed = $variantAdaptive.Replace('</adaptive-icon>', "    <monochrome android:drawable=`"@drawable/ic_launcher_monochrome`" />`n</adaptive-icon>")
        Save-Text (Join-Path $AndroidRes "mipmap-anydpi-v26\$name.xml") $variantAdaptive
        Save-Text (Join-Path $AndroidRes "mipmap-anydpi-v33\$name.xml") $variantThemed
    }
    foreach ($bucket in $densities.Keys) {
        foreach ($shape in @(@("ic_launcher_$variantId", 'Square'), @("ic_launcher_$($variantId)_round", 'Round'))) {
            $bitmap = New-Launcher ([int](48 * $densities[$bucket])) $shape[1]
            try { Save-Png $bitmap (Join-Path $AndroidRes "$bucket\$($shape[0]).png") }
            finally { $bitmap.Dispose() }
        }
    }
}
Set-LauncherVariant 'original'

if ($IncludeDesktopAndSplash) {
    # Keep existing Desktop/splash artwork unless explicitly requested by the caller.
    $legacySourcePath = Join-Path $Root 'Nivra.Api\wwwroot\assets\icon-512.png'
    $source = [System.Drawing.Image]::FromFile($legacySourcePath)
    try {
        $source.Save((Join-Path $Root 'Nivra.Desktop\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
        $entries = foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
            $bitmap = New-Bitmap $size $size
            $graphics = New-Graphics $bitmap
            $stream = New-Object System.IO.MemoryStream
            try {
                $graphics.DrawImage($source, 0, 0, $size, $size)
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                [pscustomobject]@{ Size = $size; Data = $stream.ToArray() }
            } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
        }
        $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Create((Join-Path $Root 'Nivra.Desktop\icon.ico')))
        try {
            $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$entries.Count)
            $offset = 6 + ($entries.Count * 16)
            foreach ($entry in $entries) {
                $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
                $writer.Write([Byte]$dimension); $writer.Write([Byte]$dimension); $writer.Write([Byte]0); $writer.Write([Byte]0)
                $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$entry.Data.Length); $writer.Write([UInt32]$offset)
                $offset += $entry.Data.Length
            }
            foreach ($entry in $entries) { $writer.Write([Byte[]]$entry.Data) }
        } finally { $writer.Dispose() }
        Get-ChildItem $AndroidRes -Recurse -Filter splash.png | ForEach-Object {
            $existing = [System.Drawing.Image]::FromFile($_.FullName)
            try { $width = $existing.Width; $height = $existing.Height } finally { $existing.Dispose() }
            $bitmap = New-Bitmap $width $height
            $graphics = New-Graphics $bitmap
            try {
                $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#09110F'))
                $target = [Math]::Round([Math]::Min($width, $height) * 0.28)
                $graphics.DrawImage($source, [int](($width - $target) / 2), [int](($height - $target) / 2), [int]$target, [int]$target)
                Save-Png $bitmap $_.FullName
            } finally { $graphics.Dispose(); $bitmap.Dispose() }
        }
    } finally { $source.Dispose() }
}

Write-Host 'Generated Android launcher: vector adaptive layers, Android 13 monochrome and five legacy PNG densities.'
Write-Host "Preview: $PreviewPath"
