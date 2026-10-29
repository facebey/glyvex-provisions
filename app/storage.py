"""Storage multi-path configurable (R11) + librería local (R9).

- El usuario agrega paths donde vive la librería de modelos: disco local
  (G:\\LLM), NAS, UNC (\\\\server\\share), mount de un server Linux, etc.
  El tipo no importa: se valida que sea un directorio alcanzable, nada más.
- Los paths de storage son la base de la librería: escaneo RECURSIVO
  (incluye subcarpetas; mismo patrón que el config+scanner de Glyvex) que
  agrupa los archivos de pesos por carpeta (cada carpeta con >=1 peso =
  un modelo).
- Persistencia en data/storage.json (runtime, gitignored).

v1: el escaneo es síncrono (el endpoint FastAPI lo corre en thread pool);
los paths de NAS lentos pueden tardar — por eso hay cap de archivos y
conteo de errores en vez de timeout.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from hf_down import MMPROJ_RE, MTP_RE, QUANT_RE, WEIGHT_EXTS

from .paths import DATA_DIR

STORAGE_FILE = DATA_DIR / "storage.json"

MAX_FILES = 50_000  # cap de seguridad para storages gigantes (NAS)

# Carpetas ocultas que nunca son modelos (caches parciales, git, etc.)
_SKIP_DIRS = frozenset({".git", ".cache", ".venv", "venv", "node_modules", "__pycache__"})


class StorageIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    path: str = Field(min_length=1, max_length=500)
    note: str | None = Field(default=None, max_length=280)


def _load() -> list[dict]:
    try:
        raw = json.loads(STORAGE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return raw.get("storages", []) if isinstance(raw, dict) else []


def _save(storages: list[dict]) -> None:
    STORAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STORAGE_FILE.write_text(
        json.dumps({"storages": storages}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _new_id() -> str:
    return f"{time.strftime('%y%m%d')}-{uuid.uuid4().hex[:6]}"


def _norm_path(p: str) -> str:
    # strip + quitar slash/backslash finales (excepto raiz de disco: "G:" -> "G:\\")
    p = p.strip().rstrip("/\\")
    if len(p) == 2 and p[1] == ":":
        return p + "\\"
    return p


def _check(path: str) -> str:
    """Normaliza y valida que sea un directorio alcanzable. Devuelve la
    ruta normalizada; ValueError si no existe / no es directorio."""
    p = _norm_path(path)
    if not p:
        raise ValueError("la ruta quedó vacía tras limpiarla")
    if not Path(p).is_dir():
        raise ValueError(f"el directorio no existe o no es alcanzable: {p}")
    return p


def list_storages() -> list[dict]:
    return _load()


def get_storage(storage_id: str) -> dict | None:
    return next((s for s in _load() if s["id"] == storage_id), None)


def add_storage(body: StorageIn) -> dict:
    data = body.model_dump()
    if any(s["name"].lower() == data["name"].lower() for s in _load()):
        raise ValueError(f"ya existe un storage llamado {data['name']!r}")
    p = _check(data["path"])
    if any(s["path"].lower() == p.lower() for s in _load()):
        raise ValueError(f"ya hay un storage en {p!r}")
    data = dict(data, id=_new_id(), path=p, note=(data["note"] or None))
    storages = _load()
    storages.append(data)
    _save(storages)
    return data


def update_storage(storage_id: str, body: StorageIn) -> dict:
    storages = _load()
    for i, s in enumerate(storages):
        if s["id"] == storage_id:
            data = body.model_dump()
            if any(q["name"].lower() == data["name"].lower()
                   for q in storages if q["id"] != storage_id):
                raise ValueError(f"ya existe un storage llamado {data['name']!r}")
            p = _check(data["path"])
            if any(q["path"].lower() == p.lower()
                   for q in storages if q["id"] != storage_id):
                raise ValueError(f"ya hay un storage en {p!r}")
            data = dict(data, id=storage_id, path=p, note=(data["note"] or None))
            storages[i] = data
            _save(storages)
            return data
    return {}  # el endpoint convierte en 404


def delete_storage(storage_id: str) -> bool:
    storages = _load()
    kept = [s for s in storages if s["id"] != storage_id]
    if len(kept) == len(storages):
        return False
    _save(kept)
    return True


def _weight_label(path: str) -> str:
    """Mismas reglas de etiquetado que api._file_label (mmproj/MTP antes
    que la cuantización)."""
    base = path.rsplit(os.sep, 1)[-1]
    if MMPROJ_RE.search(base):
        return "mmproj (visión)"
    if MTP_RE.search(base):
        m = QUANT_RE.search(base)
        return f"MTP (opcional){' ' + m.group(1).upper() if m else ''}"
    m = QUANT_RE.search(base)
    return m.group(1).upper() if m else "(sin etiqueta)"


def scan_library(storage_id: str | None = None) -> dict:
    """Escaneo recursivo de los paths de storage -> modelos (R9).

    `storage_id=None` escanea TODOS los storages. Cada directorio que
    contiene al menos un archivo de peso = un modelo (sus subcarpetas,
    ej. gguf/, quedan agrupadas dentro del mismo directorio padre).
    """
    storages = [get_storage(storage_id)] if storage_id else _load()
    storages = [s for s in storages if s is not None]

    models_by_dir: dict[tuple[str, str], dict] = {}  # (storage_id, dir) -> model
    scanned_dirs = 0
    n_files = 0
    n_errors = 0
    truncated = False

    for s in storages:
        root = s["path"]
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            scanned_dirs += 1
            # recortar: ocultas/venvs/caches y subdirectorios ya cubiertos
            dirnames[:] = [
                d for d in dirnames
                if d not in _SKIP_DIRS and not d.startswith(".")
            ]
            for fn in filenames:
                if truncated:
                    break
                ext = os.path.splitext(fn)[1].lower()
                if ext not in WEIGHT_EXTS:
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    n_errors += 1
                    continue
                n_files += 1
                key = (s["id"], os.path.normcase(dirpath))
                m = models_by_dir.get(key)
                if m is None:
                    m = {
                        "storage_id": s["id"],
                        "storage_name": s["name"],
                        "model_dir": dirpath,
                        "name": os.path.basename(os.path.normpath(dirpath)) or dirpath,
                        "files": [],
                        "total_bytes": 0,
                        "_labels": [],
                    }
                    models_by_dir[key] = m
                m["files"].append({"path": full, "size": size,
                                   "ext": ext, "label": _weight_label(fn)})
                m["total_bytes"] += size
                m["_labels"].append(_weight_label(fn))
                if n_files >= MAX_FILES:
                    truncated = True
                    break

    models = []
    for m in models_by_dir.values():
        quants = sorted(set(m.pop("_labels")))
        m["files"].sort(key=lambda f: f["path"].lower())
        m["quants"] = quants
        models.append(m)
    models.sort(key=lambda m: (m["storage_name"], m["name"].lower()))

    return {
        "models": models,
        "scanned_storages": len(storages),
        "scanned_dirs": scanned_dirs,
        "files": n_files,
        "errors": n_errors,
        "truncated": truncated,
    }
