# build-latest-json.ps1 — genera el latest.json del updater de Tauri a partir
# de los artefactos NSIS firmados (spec: tauri v2 updater + notas del release).
# Espejo del build-latest-json.ps1 de Glyvex-AI-Suite (versión mínima, Windows).
# Uso:
#   .\build-latest-json.ps1 -Notes "texto de notas del release"
# Lee la version de web/src-tauri/tauri.conf.json y toma exe+.sig de
# web/src-tauri/target/release/bundle/nsis/. Escribe Installer/latest.json.
# Nota: los nombres de asset se normalizan como GitHub (espacios -> puntos).
param(
  [Parameter(Mandatory = $true)][string]$Notes,
  [string]$PubDate = ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$conf = Get-Content (Join-Path $root "web\src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$ver = $conf.version

$nsisDir = Join-Path $root "web\src-tauri\target\release\bundle\nsis"
$exeLocal = Get-ChildItem $nsisDir -Filter "*_${ver}_x64-setup.exe" | Select-Object -First 1
$sigLocal = Get-ChildItem $nsisDir -Filter "*_${ver}_x64-setup.exe.sig" | Select-Object -First 1
if (-not $exeLocal -or -not $sigLocal) { throw "faltan artefactos NSIS para $ver en $nsisDir" }

$assetName = $exeLocal.Name -replace ' ', '.'   # GitHub normaliza espacios a puntos al subir
$signature = (Get-Content $sigLocal.FullName -Raw).Trim()

$out = [ordered]@{
  version   = $ver
  notes     = $Notes
  pub_date  = $PubDate
  url       = "https://github.com/facebey/glyvex-provisions/releases/download/v$ver/$assetName"
  signature = $signature
}

$outDir = Join-Path $root "Installer"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir "latest.json"
# sin BOM (JSON parsers estrictos lo rechazan; patrón ya usado en Phase 2)
$enc = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($outFile, ($out | ConvertTo-Json -Depth 4), $enc)
Write-Host "OK -> $outFile (version $ver, asset $assetName)"
