$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$SourcePath = Join-Path $Root "Nivra.Api\wwwroot\assets\icon-512.png"
$DesktopIconPath = Join-Path $Root "Nivra.Desktop\icon.ico"
$DesktopPngPath = Join-Path $Root "Nivra.Desktop\icon.png"
$AndroidRes = Join-Path $Root "android\app\src\main\res"

if (-not (Test-Path $SourcePath)) {
    throw "Logo source not found: $SourcePath"
}

function New-Bitmap($width, $height) {
    $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    return $bitmap
}

function New-Graphics($bitmap) {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    return $graphics
}

function Copy-SourceImage($path) {
    $loaded = [System.Drawing.Image]::FromFile($path)
    try {
        return New-Object System.Drawing.Bitmap($loaded)
    }
    finally {
        $loaded.Dispose()
    }
}

function Save-Png($bitmap, $path) {
    $directory = Split-Path $path -Parent
    if (-not (Test-Path $directory)) {
        New-Item -ItemType Directory -Force $directory | Out-Null
    }

    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Draw-Contained($graphics, $image, $width, $height, $scale) {
    $target = [Math]::Round([Math]::Min($width, $height) * $scale)
    $x = [Math]::Round(($width - $target) / 2)
    $y = [Math]::Round(($height - $target) / 2)
    $graphics.DrawImage($image, $x, $y, $target, $target)
}

function New-LauncherIcon($source, $size, $round) {
    $bitmap = New-Bitmap $size $size
    $graphics = New-Graphics $bitmap
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        if ($round) {
            $path = New-Object System.Drawing.Drawing2D.GraphicsPath
            $path.AddEllipse(0, 0, $size, $size)
            $graphics.SetClip($path)
            $path.Dispose()
        }

        $graphics.DrawImage($source, 0, 0, $size, $size)
    }
    finally {
        $graphics.Dispose()
    }

    return $bitmap
}

function New-AdaptiveForeground($source, $size) {
    $bitmap = New-Bitmap $size $size
    $graphics = New-Graphics $bitmap
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        Draw-Contained $graphics $source $size $size 0.72
    }
    finally {
        $graphics.Dispose()
    }

    return $bitmap
}

function New-Splash($source, $width, $height) {
    $bitmap = New-Bitmap $width $height
    $graphics = New-Graphics $bitmap
    try {
        $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#09110F"))
        Draw-Contained $graphics $source $width $height 0.28
    }
    finally {
        $graphics.Dispose()
    }

    return $bitmap
}

function Get-PngBytes($bitmap) {
    $stream = New-Object System.IO.MemoryStream
    try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    }
    finally {
        $stream.Dispose()
    }
}

function Save-Ico($source, $path) {
    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $entries = @()

    foreach ($size in $sizes) {
        $bitmap = New-LauncherIcon $source $size $false
        try {
            $entries += [pscustomobject]@{
                Size = $size
                Data = Get-PngBytes $bitmap
            }
        }
        finally {
            $bitmap.Dispose()
        }
    }

    $directory = Split-Path $path -Parent
    if (-not (Test-Path $directory)) {
        New-Item -ItemType Directory -Force $directory | Out-Null
    }

    $stream = [System.IO.File]::Create($path)
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$entries.Count)

        $offset = 6 + ($entries.Count * 16)
        foreach ($entry in $entries) {
            $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
            $writer.Write([Byte]$dimension)
            $writer.Write([Byte]$dimension)
            $writer.Write([Byte]0)
            $writer.Write([Byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$entry.Data.Length)
            $writer.Write([UInt32]$offset)
            $offset += $entry.Data.Length
        }

        foreach ($entry in $entries) {
            $writer.Write([Byte[]]$entry.Data)
        }
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

$source = Copy-SourceImage $SourcePath

try {
    $legacySizes = @{
        "mipmap-mdpi" = 48
        "mipmap-hdpi" = 72
        "mipmap-xhdpi" = 96
        "mipmap-xxhdpi" = 144
        "mipmap-xxxhdpi" = 192
    }

    $foregroundSizes = @{
        "mipmap-mdpi" = 108
        "mipmap-hdpi" = 162
        "mipmap-xhdpi" = 216
        "mipmap-xxhdpi" = 324
        "mipmap-xxxhdpi" = 432
    }

    foreach ($bucket in $legacySizes.Keys) {
        $size = $legacySizes[$bucket]

        $icon = New-LauncherIcon $source $size $false
        try { Save-Png $icon (Join-Path $AndroidRes "$bucket\ic_launcher.png") }
        finally { $icon.Dispose() }

        $roundIcon = New-LauncherIcon $source $size $true
        try { Save-Png $roundIcon (Join-Path $AndroidRes "$bucket\ic_launcher_round.png") }
        finally { $roundIcon.Dispose() }
    }

    foreach ($bucket in $foregroundSizes.Keys) {
        $size = $foregroundSizes[$bucket]
        $foreground = New-AdaptiveForeground $source $size
        try { Save-Png $foreground (Join-Path $AndroidRes "$bucket\ic_launcher_foreground.png") }
        finally { $foreground.Dispose() }
    }

    Get-ChildItem -Path $AndroidRes -Recurse -Filter splash.png | ForEach-Object {
        $existing = [System.Drawing.Image]::FromFile($_.FullName)
        try {
            $width = $existing.Width
            $height = $existing.Height
        }
        finally {
            $existing.Dispose()
        }

        $splash = New-Splash $source $width $height
        try { Save-Png $splash $_.FullName }
        finally { $splash.Dispose() }
    }

    $desktopPng = New-LauncherIcon $source 512 $false
    try { Save-Png $desktopPng $DesktopPngPath }
    finally { $desktopPng.Dispose() }

    Save-Ico $source $DesktopIconPath
}
finally {
    $source.Dispose()
}

Write-Host "Generated Android launcher/splash assets and Windows icons."
