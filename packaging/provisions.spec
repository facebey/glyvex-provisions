# -*- mode: python ; coding: utf-8 -*-
"""Spec PyInstaller del sidecar de Glyvex Provisions (U7).

Mismo patrón que la Suite (`backend/glyvex.spec`): onedir, console=False,
runtime hook para la consola; el SPA pre-construido viaja como datas
(`web-dist`) porque el backend lo sirve, y la metadata de los paquetes se
copia porque huggingface_hub/fastapi consultan importlib.metadata.

Requiere que `web/dist` ya esté construido (build.ps1 lo hace en orden).
"""
import os

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
# Core editable de hf-downloader (hf_down/resumable). Sobrescribible con
# HF_DOWNLOADER_CORE para otras máquinas.
CORE = os.environ.get("HF_DOWNLOADER_CORE", r"D:\Proyectos\hf-downloader")

hiddenimports = []
hiddenimports += collect_submodules("app")
# uvicorn selecciona loop/protocolo por import dinámico.
hiddenimports += collect_submodules("uvicorn")
for _pkg in ("huggingface_hub", "httpx2", "hf_xet"):
    try:
        hiddenimports += collect_submodules(_pkg)
    except Exception:
        pass
# Core de descargas: son módulos top-level del repo hf-downloader (pathex).
hiddenimports += ["hf_down", "resumable"]

datas = []
for _dist in ("huggingface_hub", "hf-xet", "httpx2", "fastapi", "starlette",
              "pydantic", "pydantic-core", "uvicorn", "psutil", "anyio"):
    try:
        datas += copy_metadata(_dist)
    except Exception:
        pass
# Catálogo de hardware: solo lectura, viaja junto al módulo catalog.
datas += [(os.path.join(ROOT, "app", "catalog.json"), "app")]
# SPA: el backend lo sirve desde _internal/web-dist (paths.WEB_DIST congelado).
_webdist = os.path.join(ROOT, "web", "dist")
if os.path.isdir(_webdist):
    datas += [(_webdist, "web-dist")]
else:
    warn("web/dist no existe: construye el frontend antes del sidecar "
         "(el instalador saldria sin UI servida por el backend)")

icon = os.path.join(SPECPATH, "..", "web", "src-tauri", "icons", "icon.ico")

a = Analysis(
    [os.path.join(SPECPATH, "entry.py")],
    pathex=[ROOT, CORE],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[os.path.join(SPECPATH, "console_hook.py")],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="provisions-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=icon if os.path.exists(icon) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="provisions-backend",
)
