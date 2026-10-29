# build.ps1 — pipeline de producción Glyvex Provisions (U7).
# Orden (como build.ps1 de la Suite):
#   1) Frontend (web/dist)  -> 2) Sidecar PyInstaller (empaqueta el SPA como
#   datas) -> 3) Junction resources para el bundler -> 4) tauri build (NSIS +
#   artefacts del updater firmados).
# Uso: .\build.ps1 [-SkipBundle]   (SkipBundle = hasta el sidecar, sin NSIS)
param([switch]$SkipBundle)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "[1/4] Frontend build (web/dist)..." -ForegroundColor Cyan
npm --prefix "$root\web" run build
if ($LASTEXITCODE -ne 0) { throw "npm run build fallo" }

Write-Host "[2/4] Sidecar PyInstaller (packaging/dist/provisions-backend)..." -ForegroundColor Cyan
& "$root\.venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean `
  --distpath "$root\packaging\dist" --workpath "$root\packaging\build" `
  "$root\packaging\provisions.spec"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller fallo" }

Write-Host "[3/4] Junction web/src-tauri/resources/provisions-backend..." -ForegroundColor Cyan
$resDir = Join-Path $root "web\src-tauri\resources"
New-Item -ItemType Directory -Force -Path $resDir | Out-Null
$link = Join-Path $resDir "provisions-backend"
if (Test-Path $link) { cmd /c rmdir "`"$link`"" }  # rmdir quita la junction sin tocar el destino
cmd /c mklink /J "`"$link`"" "`"$root\packaging\dist\provisions-backend`"" | Out-Null

if ($SkipBundle) { Write-Host "OK (SkipBundle): sidecar listo." -ForegroundColor Green; exit 0 }

Write-Host "[4/4] tauri build (NSIS + updater firmado)..." -ForegroundColor Cyan
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content (Join-Path $root "web\src-tauri\updater\private.key") -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content (Join-Path $root "web\src-tauri\updater\password.txt") -Raw).Trim()
Push-Location (Join-Path $root "web")
try {
  # node directo (no el wrapper .cmd de npm): evita el hang conocido del cmd-wrapper
  node ".\node_modules\@tauri-apps\cli\tauri.js" build
  if ($LASTEXITCODE -ne 0) { throw "tauri build fallo" }
} finally {
  Pop-Location
}
Write-Host "OK. Instalador NSIS en web\src-tauri\target\release\bundle\nsis\" -ForegroundColor Green
