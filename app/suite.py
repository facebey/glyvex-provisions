"""Integración con Glyvex-AI-Suite (U15 — ecosistema Glyvex).

Regla dura: Provisions NUNCA escribe archivos de la Suite. Todo el contacto
es por su API HTTP pública (127.0.0.1:7981, override GLYVEX_PORT); la única
tocada al filesystem es LEER el runtime gestionado (llama-server.exe bajo
<data>/runtime/llama.cpp-<pin>/, layout plano con sus DLLs).

La Suite:
- guarda `model_dirs` en config.json (la persiste ella, vía POST /api/config);
- mantiene el inventario en memoria + data/models.json (cache que ELLA
  regenera al escanear; un scan solo elimina entradas cuyo archivo dejó de
  existir físicamente, así que escanear solo la carpeta nueva es seguro).
- el registro es un handoff de una vez: la carpeta queda bajo jurisdicción
  de la Suite (al reabrir la app, el modelo sigue en el Launcher sin re-scan).

DATA_DIR de la Suite (dónde vive su runtime gestionado):
- BUNDLE (app instalada): %LOCALAPPDATA%\\Glyvex-AI-Suite\\data
- DEV (repo corriendo): <repo>/data — Provisions NO puede descubrir esa
  ruta (es propia de la máquina del desarrollador); para apuntarla se usa
  `PROV_SUITE_DATA_DIR`. `find_managed_runtime()` recorre TODOS los
  candidatos (override propio, GLYVEX_DATA_DIR, bundle) y elige el pin más
  alto entre todos.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import httpx2

DATA_DIR_DEFAULT = Path(
    os.environ.get("LOCALAPPDATA") or str(Path.home())
) / "Glyvex-AI-Suite" / "data"
BINARY_NAME = "llama-server.exe" if os.name == "nt" else "llama-server"


class SuiteNotRunning(Exception):
    """El backend de la Suite no responde en su puerto (no está abierto)."""


def candidate_data_dirs() -> list[Path]:
    """Candidatos de DATA_DIR de la Suite, en orden de preferencia:

    1. PROV_SUITE_DATA_DIR — override de Provisions: apunta al data dir de
       una Suite en modo dev (el repo usa <repo>/data, que la app instalada
       no conoce; sin esto, el runtime dev sería invisible para Provisions).
    2. GLYVEX_DATA_DIR — la misma variable que respeta la Suite (si el
       proceso de Provisions la hereda, p. ej. arrancado desde su entorno).
    3. %LOCALAPPDATA%\\Glyvex-AI-Suite\\data — default del bundle instalado.
    """
    dirs: list[Path] = []
    for raw in (os.environ.get("PROV_SUITE_DATA_DIR"),
                os.environ.get("GLYVEX_DATA_DIR")):
        p = (raw or "").strip()
        if p and Path(p) not in dirs:
            dirs.append(Path(p))
    if DATA_DIR_DEFAULT not in dirs:
        dirs.append(DATA_DIR_DEFAULT)
    return dirs


def suite_data_dir() -> Path:
    """DATA_DIR primario de la Suite (el primero de `candidate_data_dirs`)."""
    return candidate_data_dirs()[0]


def suite_port() -> int:
    try:
        return int(os.environ.get("GLYVEX_PORT") or 7981)
    except ValueError:
        return 7981


def _base() -> str:
    return f"http://127.0.0.1:{suite_port()}"


def find_managed_runtime() -> dict | None:
    """Runtime gestionado por la Suite: el pin más alto entre TODOS los
    data dirs candidatos (bundle + dev + overrides).

    GLOB del pin (nunca hardcodeado): la Suite descarga la build en
    <data>/runtime/llama.cpp-<pin>/ con el exe junto a sus DLLs.
    """
    candidates = []
    for data_dir in candidate_data_dirs():
        runtime_root = data_dir / "runtime"
        if not runtime_root.is_dir():
            continue
        for exe in runtime_root.glob(f"llama.cpp-*{os.sep}{BINARY_NAME}"):
            if exe.is_file():
                pin = exe.parent.name.removeprefix("llama.cpp-")
                digits = int("".join(c for c in pin if c.isdigit()) or 0)
                candidates.append((digits, pin, exe))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    digits, pin, exe = candidates[-1]
    return {"path": str(exe), "pin": pin, "executable": BINARY_NAME,
            "data_dir": str(exe.parent.parent.parent)}


def health() -> dict | None:
    """{status, version} si la Suite está viva; None si no responde."""
    try:
        r = httpx2.get(f"{_base()}/api/health", timeout=2.0)
        if r.status_code == 200:
            return r.json()
    except (httpx2.HTTPError, ValueError):
        pass
    return None


def status() -> dict:
    """Estado para la UI: ¿Suite corriendo? ¿runtime gestionado en disco?"""
    h = health()
    rt = find_managed_runtime()
    return {
        "running": h is not None,
        "port": suite_port(),
        "version": (h or {}).get("version"),
        "data_dir": str(suite_data_dir()),
        "managed_runtime": rt,
    }


def _ensure_running() -> None:
    if health() is None:
        raise SuiteNotRunning(
            "Glyvex-AI-Suite no está abierta (sin respuesta en "
            f"{_base()}). Abrila y reintenta."
        )


def register_folder(folder: str | Path) -> dict:
    """Registra una carpeta de modelos en la Suite vía su API.

    1) GET /api/config  -> model_dirs actuales
    2) POST /api/config -> la Suite persiste la lista con la carpeta nueva
       (idempotente si ya está)
    3) POST /api/models/scan (SSE) con solo esa carpeta -> la Suite lee los
       headers GGUF, arma la ficha completa y guarda el inventario. El scan
       solo borra entradas cuyo archivo desapareció del disco, así que no
       toca el resto de la librería.

    Raise: SuiteNotRunning, ValueError (la carpeta no existe), httpx2.HTTPError
    """
    p = Path(folder)
    if not p.is_dir():
        raise ValueError(f"carpeta inexistente: {p}")
    _ensure_running()

    with httpx2.Client(timeout=30.0) as client:
        cfg = client.get(f"{_base()}/api/config").json()
        dirs: list[str] = list(cfg.get("model_dirs") or [])
        resolved = p.resolve()
        already = any(Path(d).resolve() == resolved for d in dirs)
        if not already:
            new_dirs = dirs + [str(p)]
            r = client.post(
                f"{_base()}/api/config", json={"model_dirs": new_dirs})
            r.raise_for_status()
            dirs = new_dirs

        # SSE: eventos `data: {json}`; el último tiene status="complete".
        summary: dict = {}
        with client.stream(
            "POST", f"{_base()}/api/models/scan",
            json={"model_dirs": [str(p)]},
        ) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[len("data:"):].strip())
                if ev.get("status") == "complete":
                    summary = ev
                    break

    return {
        "registered_folder": str(p),
        "was_already_configured": already,
        "model_dirs": dirs,
        "new_models": summary.get("new_count", 0),
        "total": summary.get("total"),
    }
