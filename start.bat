@echo off
rem ============================================================================
rem  Glyvex Provisions - arrancador de desarrollo (CMD)
rem
rem  Uso:  start.bat
rem
rem  Este script es un delgado wrapper de start.ps1: la logica completa
rem  (frontend en 8331, backend en la escalera 8321..8330, ventanas visibles,
rem  deteccion de puertos, navegador) vive en el .ps1 para no duplicar la
rem  implementacion. Path-agnostic: %~dp0 es la raiz del repo.
rem
rem  Para parar: cierra las dos ventanas (backend y frontend) que se abren.
rem ============================================================================

setlocal
set "PS1=%~dp0start.ps1"

if not exist "%PS1%" (
    echo [ERROR] No se encontro start.ps1 en la misma carpeta que este script.
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
endlocal
exit /b %errorlevel%
