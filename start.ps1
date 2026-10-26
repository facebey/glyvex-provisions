# ============================================================================
# Glyvex Provisions - arrancador de desarrollo (PowerShell)
#
# Uso:  .\start.ps1
#
# Comportamiento:
#   0. Si HF_TOKEN no esta en el entorno del proceso, lo inyecta desde el
#      registro (nivel User) — ver bloque abajo.
#   1. Si frontend (8331) Y backend (escalera) ya responden -> solo abre el
#      navegador y sale.
#   2. Si el backend ya esta en la escalera 8321..8330 -> lo reutiliza.
#   3. Si no, levanta el backend en una ventana visible y pulea la escalera
#      (8321..8330) con /api/healthz para descubrir el puerto final.
#   4. Levanta Vite en otra ventana visible SOLO si el frontend no esta ya
#      corriendo, esperando http://127.0.0.1:8331 y abre el navegador.
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

# --- HF_TOKEN: inyectar desde el registro si el entorno no lo tiene --------
# Las env vars de Windows son un SNAPSHOT en el arranque del proceso: un
# backend lanzado desde un padre iniciado ANTES de configurar el token no lo
# ve (get_token() -> None -> 401 en repos gated). La verdad absoluta es el
# registro (nivel User); si el env del proceso no lo trae, lo leemos ahi.
# El cmd del backend se lanza como hijo y hereda lo que pongamos en $env.
if (-not $env:HF_TOKEN) {
    $regToken = [Environment]::GetEnvironmentVariable('HF_TOKEN', 'User')
    if ($regToken) {
        $env:HF_TOKEN = $regToken
        Write-Host "HF_TOKEN inyectado desde el registro (longitud $($regToken.Length))."
    } else {
        Write-Host '[AVISO] HF_TOKEN no configurado: repos gated fallaran con 401 (hf auth login).'
    }
}

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

# --- 1) Todo corriendo (frontend Y backend): abrir navegador y salir --------
$FrontendUp = Test-Http -Port $FrontendPort -Path '/'
$BackendUp = $false
foreach ($p in $BackendLadder) {
    if (Test-Http -Port $p -Path '/api/healthz') { $BackendUp = $true; break }
}

if ($FrontendUp -and $BackendUp) {
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

# --- 4) Frontend: reutilizar si ya corre, si no levantar Vite ---------------
# PROV_BACKEND_URL viaja por el entorno: Vite lo lee en vite.config.ts para
# el proxy /api (el backend puede no estar en 8321 si cayendo de la escalera).
$env:PROV_BACKEND_URL = "http://${HostIP}:${BackendPort}"

if ($FrontendUp) {
    Write-Host "Frontend ya corriendo en http://${HostIP}:${FrontendPort} (se reutiliza)."
    Start-Process "http://${HostIP}:${FrontendPort}"
} else {
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
}

Write-Host ''
Write-Host 'Para parar: cierra las dos ventanas (backend y frontend).'
