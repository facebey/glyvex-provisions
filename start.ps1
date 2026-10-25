# ============================================================================
# Glyvex Provisions - arrancador de desarrollo (PowerShell)
#
# Uso:  .\start.ps1
#
# Comportamiento:
#   1. Si el frontend (8331) ya responde -> solo abre el navegador y sale.
#   2. Si el backend ya esta en la escalera 8321..8330 -> lo reutiliza.
#   3. Si no, levanta el backend en una ventana visible y pulea la escalera
#      (8321..8330) con /api/healthz para descubrir el puerto final.
#   4. Levanta Vite en otra ventana visible, esperando http://127.0.0.1:8331
#      y abre el navegador.
#
# Path-agnostic: todo se resuelve desde $PSScriptRoot (raiz del repo).
# Sin CORS: el proxy de Vite (/api -> backend) queda todo en 127.0.0.1.
# ============================================================================

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$HostIP = '127.0.0.1'
$FrontendPort = 8331
$BackendLadder = 8321..8330

# --- python: venv local si existe, si no el del PATH ------------------------
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) { $Python = 'python' }

function Test-Http {
    # Devuelve $true si el puerto responde con algun estado HTTP.
    param([int]$Port, [string]$Path = '/', [int]$Timeout = 1)
    try {
        $null = Invoke-WebRequest -Uri "http://${HostIP}:${Port}${Path}" `
            -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Wait-Http {
    # Pulea cada segundo hasta que el puerto responde o se agota el tiempo.
    param([int]$Port, [string]$Path = '/', [int]$Seconds = 90)
    $stop = (Get-Date).AddSeconds($Seconds)
    do {
        if (Test-Http -Port $Port -Path $Path) { return $true }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $stop)
    return $false
}

# --- 1) Frontend ya corriendo: abrir navegador y salir -----------------------
if (Test-Http -Port $FrontendPort -Path '/') {
    Write-Host "Glyvex Provisions ya esta corriendo en http://${HostIP}:${FrontendPort}"
    Write-Host 'Abriendo el navegador...'
    Start-Process "http://${HostIP}:${FrontendPort}"
    exit 0
}

# --- 2) Backend: reutilizar si ya esta en la escalera ------------------------
$BackendPort = $null
foreach ($p in $BackendLadder) {
    if (Test-Http -Port $p -Path '/api/healthz') { $BackendPort = $p; break }
}

if ($null -ne $BackendPort) {
    Write-Host "Backend ya en ejecucion en http://${HostIP}:${BackendPort}/api/healthz"
} else {
    # --- 3) Levantar el backend en ventana visible ---------------------------
    $BackendTitle = 'Glyvex Provisions - backend (escalera 8321-8330)'
    $backendLine = "title `"$BackendTitle`" && cd /d `"$Root`" && `"$Python`" -m app.main"
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/k `"$backendLine`""
    Write-Host 'Backend lanzado en su propia ventana. Puleando la escalera 8321..8330...'

    # Pulear la escalera completa hasta que alguna responde (el backend puede
    # caerse de 8321 si estaba ocupado y se asienta en 8322, 8323, ...).
    $stop = (Get-Date).AddSeconds(120)
    do {
        foreach ($p in $BackendLadder) {
            if (Test-Http -Port $p -Path '/api/healthz') { $BackendPort = $p; break }
        }
        if ($null -ne $BackendPort) { break }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $stop)

    if ($null -eq $BackendPort) {
        Write-Error 'El backend no respondio en la escalera 8321..8330 en 120 s. Revisa la ventana "Glyvex Provisions - backend".'
        exit 1
    }
    Write-Host "Backend listo en http://${HostIP}:${BackendPort} (PORT_ASSIGNED)"
}

# --- 4) Levantar Vite en ventana visible -------------------------------------
# PROV_BACKEND_URL viaja por el entorno: Vite lo lee en vite.config.ts para
# el proxy /api (el backend puede no estar en 8321 si cayendo de la escalera).
$env:PROV_BACKEND_URL = "http://${HostIP}:${BackendPort}"
$WebDir = Join-Path $Root 'web'
$FrontTitle = 'Glyvex Provisions - frontend (Vite, 8331)'
$viteLine = "title `"$FrontTitle`" && cd /d `"$WebDir`" && npm run dev"
Start-Process -FilePath 'cmd.exe' -ArgumentList "/k `"$viteLine`""
Write-Host 'Vite lanzado en su propia ventana. Esperando http://127.0.0.1:8331...'

if (Wait-Http -Port $FrontendPort -Path '/' -Seconds 90) {
    Write-Host "Frontend listo en http://${HostIP}:${FrontendPort} - abriendo el navegador..."
    Start-Process "http://${HostIP}:${FrontendPort}"
} else {
    Write-Warning 'Vite no respondio en 90 s. Revisa la ventana "Glyvex Provisions - frontend (Vite, 8331)".'
}

Write-Host ''
Write-Host 'Para parar: cierra las dos ventanas (backend y frontend).'
