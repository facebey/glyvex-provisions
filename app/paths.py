"""Resolución de paths para modo dev y modo empaquetado (U7).

- Dev (script normal): recursos y datos relativos a la raíz del repo —
  comportamiento idéntico al de Fase 1/2 (`data/` dentro del repo).
- Congelado (PyInstaller onedir): los recursos viajan en `_internal/`
  (`sys._MEIPASS`); los datos del usuario se mueven FUERA del bundle a
  `%LOCALAPPDATA%\\glyvex-provisions` para que ajustes/perfiles/storage
  sobrevivan a reinstalaciones y actualizaciones del instalador NSIS.
- `PROV_DATA_DIR` sobrescribe la ubicación de datos en ambos modos.

El SPA prebuilded se sirve desde `web/dist` (dev) o `_internal/web-dist`
(bundle, via datas del spec) — mismo patrón que el sidecar de la Suite.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)

if FROZEN:
    RES_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent / "_internal"))
    _user_base = Path(os.environ.get("LOCALAPPDATA") or str(Path.home())) / "glyvex-provisions"
else:
    RES_DIR = Path(__file__).resolve().parent.parent  # raíz del repo
    _user_base = RES_DIR

DATA_DIR = Path(os.environ.get("PROV_DATA_DIR") or str(_user_base / "data"))

# SPA pre-construido: dev → web/dist; bundle → _internal/web-dist (datas del spec).
WEB_DIST = RES_DIR / ("web-dist" if FROZEN else str(Path("web") / "dist"))
