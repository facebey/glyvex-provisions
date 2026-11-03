# generate-app-icons.ps1 — set de iconos de aplicacion (Windows + favicons PNG).
# Fuente canonica: assets/brand/app-icon.png (1024, derivada de app-icon.svg).
#
# Por que un generador propio: `tauri icon` re-muestrea el PNG 1024 con Lanczos,
# que produce OVERSHOOT (ringing) en trazos brillantes sobre tile oscuro -> las
# puntas superiores de la bandeja salen con pixels blancos en 16-32px (reportado
# por Fabian 2026-11-02). Este script re-muestrea con BOX (promedio de area
# separable, luz lineal alfa-premultiplicada) en piramide por halvings: 1024 ->
# 512 -> 256 -> 128 -> 64 -> 32 -> 16, y desde el nivel mas cercano >=2x al
# target genera los tamaños no-binarios (24 desde 32, 48 desde 64, 180 desde
# 256). Sin ringing: bordes limpios, sin puntas blancas.
#
# Escribe:
#   web/src-tauri/icons/  32x32.png 64x64.png 128x128.png 128x128@2x.png
#                         icon.png(512) icon.ico (frames PNG 16/24/32/48/64/256)
#   web/public/           favicon-512.png  favicon-180.png
# No toca icon.icns (macOS no es target) ni favicon.svg (vector, sin artefactos).
# Adicion: probes de verificacion (zoom nearest-neighbor x12 de 16px y x8 de
# 24/32px) en $env:TEMP\prov-icon-probes\ — para inspeccion visual, fuera del repo.
$ErrorActionPreference = "Stop"
# script vive en assets/brand/app-icons/ -> raiz del repo = tres niveles arriba
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))

Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot "resample.cs") -ReferencedAssemblies System.Drawing.dll

$iconsDir = Join-Path $root "web\src-tauri\icons"
$publicDir = Join-Path $root "web\public"
$srcPath = Join-Path $root "assets\brand\app-icon.png"

$src = [IconResample]::FromFile($srcPath)
if ($src.W -ne 1024 -or $src.H -ne 1024) { throw "app-icon.png debe ser 1024x1024" }

# Piramide por halvings (box exacto en cada paso).
$p512 = [IconResample]::Box($src, 512, 512)
$p256 = [IconResample]::Box($p512, 256, 256)
$p128 = [IconResample]::Box($p256, 128, 128)
$p64  = [IconResample]::Box($p128, 64, 64)
$p32  = [IconResample]::Box($p64, 32, 32)
$p16  = [IconResample]::Box($p32, 16, 16)
# Tamanos no-binarios desde el nivel mas cercano >=2x.
$p24  = [IconResample]::Box($p32, 24, 24)
$p48  = [IconResample]::Box($p64, 48, 48)
$p180 = [IconResample]::Box($p256, 180, 180)

[IconResample]::SavePng((Join-Path $iconsDir "32x32.png"), $p32)
[IconResample]::SavePng((Join-Path $iconsDir "64x64.png"), $p64)
[IconResample]::SavePng((Join-Path $iconsDir "128x128.png"), $p128)
[IconResample]::SavePng((Join-Path $iconsDir "128x128@2x.png"), $p256)
[IconResample]::SavePng((Join-Path $iconsDir "icon.png"), $p512)
[IconResample]::SavePng((Join-Path $publicDir "favicon-512.png"), $p512)
[IconResample]::SavePng((Join-Path $publicDir "favicon-180.png"), $p180)
Write-Host "OK pngs (32/64/128/128@2x/icon512/favicon-512/favicon-180)"

# icon.ico con frames PNG embebidos (orden ascendente; 256 se codifica como 0).
$frames = @(
  @{ s = 16;   img = $p16 },
  @{ s = 24;   img = $p24 },
  @{ s = 32;   img = $p32 },
  @{ s = 48;   img = $p48 },
  @{ s = 64;   img = $p64 },
  @{ s = 256;  img = $p256 }
)
# OJO: no usar $frames | ForEach-Object {...ToPng...} dentro de @(): PowerShell
# aplanaria los byte[] de cada PNG y $blob[i] seria un solo byte (size=1 en el ico).
$blob = New-Object System.Collections.Generic.List[byte[]]
foreach ($fr in $frames) { $blob.Add([IconResample]::ToPng($fr.img)) }
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
for ($i = 0; $i -lt $frames.Count; $i++) {
  $s = $frames[$i].s
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]0)          # paleta
  $bw.Write([byte]0)          # reservado
  $bw.Write([uint16]1)        # planes
  $bw.Write([uint16]32)      # bpp
  $bw.Write([uint32]$blob[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $blob[$i].Length
}
for ($i = 0; $i -lt $blob.Count; $i++) { $bw.Write($blob[$i]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $iconsDir "icon.ico"), $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
Write-Host "OK icon.ico (16/24/32/48/64/256)"

# Probes de verificacion visual (zoom nearest-neighbor, fuera del repo).
$probes = Join-Path $env:TEMP "prov-icon-probes"
New-Item -ItemType Directory -Force -Path $probes | Out-Null
$probesSpec = @(
  @{ img = $p16; name = "probe-16.png";  factor = 12 },
  @{ img = $p24; name = "probe-24.png";  factor = 8 },
  @{ img = $p32; name = "probe-32.png";  factor = 8 }
)
foreach ($pr in $probesSpec) {
  $bytes = [IconResample]::ToPng($pr.img)
  $tmp = Join-Path $probes ("native-" + $pr.name)
  [System.IO.File]::WriteAllBytes($tmp, $bytes)
  $small = [System.Drawing.Bitmap]::FromFile($tmp)
  $side = $small.Width * $pr.factor
  $zoom = New-Object System.Drawing.Bitmap($side, $side)
  $g = [System.Drawing.Graphics]::FromImage($zoom)
  $g.InterpolationMode = 'NearestNeighbor'; $g.PixelOffsetMode = 'Half'
  $g.DrawImage($small, 0, 0, $side, $side)
  $g.Dispose(); $small.Dispose()
  $zoom.Save((Join-Path $probes $pr.name))
  $zoom.Dispose()
}
Write-Host ("probes -> " + $probes)
Write-Host "listo"
