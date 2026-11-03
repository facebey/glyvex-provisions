# generate-nsis.ps1 — regenera los 4 bitmaps del instalador NSIS (header/sidebar, claro/oscuro)
# con el isotopo "descarga en bandeja" (assets/brand/app-icon.svg), misma tipografía y paleta
# que los originales. Renderiza HTML a 4x con Edge headless y downscalea a 150x57 / 164x314.
# Uso: pwsh -File generate-nsis.ps1   (desde esta carpeta src/)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcDir   = $PSScriptRoot
$outDir   = Split-Path $srcDir -Parent            # assets/brand/installer/nsis
$fontPath = Join-Path $srcDir 'fonts\glyvex-sans-wght.woff2'
$edge     = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Microsoft\Edge\Application\msedge.exe') |
            Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Edge no encontrado' }

$fontB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($fontPath))

# Glyph recortado (sin tile) — mismas coords que assets/brand/app-icon.svg
$glyphSvg = @'
<svg class="glyph" viewBox="176 180 672 672" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:__GX__px;top:__GY__px;width:__GW__px;height:__GH__px">
  <defs><linearGradient id="g" x1="208" y1="190" x2="816" y2="842" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#0d9488"/><stop offset="0.5" stop-color="#06b6d4"/><stop offset="1" stop-color="#8b5cf6"/>
  </linearGradient></defs>
  <path d="M250 560 V735 Q250 800 315 800 H709 Q774 800 774 735 V560" fill="none" stroke="url(#g)" stroke-width="84" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M472 190 H552 V420 H640 L512 585 L384 420 H472 Z" fill="url(#g)"/>
  <circle cx="512" cy="452" r="44" fill="#f97316"/>
</svg>
'@

$baseCss = @'
@font-face{font-family:'GS';src:url(data:font/woff2;base64,__B64__) format('woff2');font-weight:100 900;}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:__W__px;height:__H__px;overflow:hidden;background:__BG__;font-family:'GS','Segoe UI',sans-serif}
'@

function headerHtml($variant) {
  $dark = $variant -eq 'oscuro'
  $p = @{
    BG    = if ($dark) { '#16142b' } else { '#f4f5f7' }
    WM    = if ($dark) { '#eef0f6' } else { '#12131a' }
    SUB   = if ($dark) { '#3fd9e8' } else { '#0e94a8' }
    GX = 34; GY = 38; GW = 148; GH = 148
  }
  $css = $baseCss + @'
.wm{position:absolute;left:200px;top:40px;font-weight:800;font-size:78px;line-height:1;color:__WM__}
.sub{position:absolute;left:276px;top:132px;font-weight:700;font-size:39px;letter-spacing:8px;color:__SUB__;line-height:1}
.bar{position:absolute;left:0;bottom:0;width:100%;height:12px;background:linear-gradient(90deg,#189cea,#07b6d5)}
'@
  foreach ($k in 'BG','WM','SUB') { $css = $css -replace "__${k}__", $p[$k] }
  $svg = $glyphSvg
  foreach ($k in 'GX','GY','GW','GH') { $svg = $svg -replace "__${k}__", $p[$k] }
  "<!doctype html><html><head><meta charset='utf-8'><style>$css</style></head><body>$svg" +
  "<div class='wm'>Glyvex</div><div class='sub'>PROVISIONS</div><div class='bar'></div></body></html>"
}

function sidebarHtml($variant) {
  $dark = $variant -eq 'oscuro'
  $bg = if ($dark) { 'radial-gradient(120% 60% at 50% 8%, #17142b 0%, #101121 55%, #0a0b13 100%)' } else { '#f4f5f7' }
  $p = @{
    BG  = $bg
    WM  = if ($dark) { '#eef0f6' } else { '#12131a' }
    TAG = if ($dark) { '#8a90a6' } else { '#64748b' }
    FTR = if ($dark) { '#5e5e6e' } else { '#6b7280' }
    GSUB1 = if ($dark) { '#22d3ee' } else { '#06b6d4' }
    GSUB2 = '#7c3aed'
    GX = 176; GY = 90; GW = 304; GH = 326
  }
  $css = $baseCss + @'
.wm{position:absolute;left:0;top:650px;width:100%;text-align:center;font-weight:800;font-size:110px;line-height:1;color:__WM__}
.sub{position:absolute;left:0;top:806px;width:100%;text-align:center;font-weight:700;font-size:66px;line-height:1;color:__GSUB1__}
.tag{position:absolute;left:0;top:920px;width:100%;text-align:center;font-weight:500;font-size:49px;line-height:1;color:__TAG__}
.ftr{position:absolute;left:0;top:1150px;width:100%;text-align:center;font-weight:600;font-size:38px;letter-spacing:16px;color:__FTR__}
'@
  foreach ($k in 'BG','WM','TAG','FTR','GSUB1') { $css = $css -replace "__${k}__", $p[$k] }
  $svg = $glyphSvg
  foreach ($k in 'GX','GY','GW','GH') { $svg = $svg -replace "__${k}__", $p[$k] }
  "<!doctype html><html><head><meta charset='utf-8'><style>$css</style></head><body>$svg" +
  "<div class='wm'>Glyvex</div><div class='sub'>Provisions</div><div class='tag'>IA local, sin nube</div><div class='ftr'>GLYVEX GROUP</div></body></html>"
}

$tmp = Join-Path $env:TEMP ("prov-nsis-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$jobs = @(
  @{ name='nsis-header-oscuro';  w=600; h=228;  target=@(150,57)  }
  @{ name='nsis-header-claro';   w=600; h=228;  target=@(150,57)  }
  @{ name='nsis-sidebar-oscuro'; w=656; h=1256; target=@(164,314) }
  @{ name='nsis-sidebar-claro';  w=656; h=1256; target=@(164,314) }
)

$idx = 0
foreach ($j in $jobs) {
  $idx++
  $variant = if ($j.name -match 'claro') { 'claro' } else { 'oscuro' }
  $html = if ($j.name -like 'nsis-header*') { headerHtml $variant } else { sidebarHtml $variant }
  $html = $html -replace '__B64__', $fontB64
  $html = $html -replace '__W__', $j.w
  $html = $html -replace '__H__', $j.h
  $htmlFile = Join-Path $tmp ("r$idx-$($j.name).html")
  [IO.File]::WriteAllText($htmlFile, $html)
  $shot = Join-Path $tmp ("r$idx-$($j.name).png")
  for ($try = 1; $try -le 2 -and -not (Test-Path $shot); $try++) {
    # Start-Process + límite de tiempo: Edge a veces no termina solo tras capturar
    $p = Start-Process -FilePath $edge -ArgumentList @(
      '--headless','--disable-gpu','--no-first-run','--disable-extensions','--disable-component-update',
      "--user-data-dir=$tmp\p$idx-$try","--window-size=$($j.w),$($j.h)",
      "--screenshot=$shot","file:///$($htmlFile -replace '\\','/')"
    ) -PassThru
    $p | Wait-Process -Timeout 25 -ErrorAction SilentlyContinue
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt $p.StartTime } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  if (-not (Test-Path $shot)) { throw "render falló: $($j.name)" }
  # downscale 4x -> target + guardado PNG (32bpp) y BMP 24bpp (NSIS)
  $big = [Drawing.Bitmap]::FromFile($shot)
  $small = New-Object Drawing.Bitmap($j.target[0], $j.target[1])
  $g = [Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($big, (New-Object Drawing.Rectangle(0,0,$small.Width,$small.Height)))
  $g.Dispose(); $big.Dispose()
  $small.Save((Join-Path $outDir "$($j.name).png"), [Drawing.Imaging.ImageFormat]::Png)
  $rgb = New-Object Drawing.Bitmap($small.Width, $small.Height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g2 = [Drawing.Graphics]::FromImage($rgb); $g2.DrawImage($small, 0, 0); $g2.Dispose()
  $rgb.Save((Join-Path $outDir "$($j.name).bmp"), [Drawing.Imaging.ImageFormat]::Bmp)
  $rgb.Dispose(); $small.Dispose()
  Write-Host "OK $($j.name)"
}
Write-Host "listo -> $outDir"
