"""Ajustes persistentes (U6-3): umbrales del semáforo, margen y contexto.

Persistidos en data/settings.json (runtime, gitignored) — mismo patrón que
profiles/storage. Los campos ausentes en disco usan los valores por defecto
de fit.py, así que borrar el archivo o usar una versión vieja de la app
nunca rompe nada.

Semáforo (aplicado por fit.estimate según estos valores):
  ok    <= ok_frac  de la capacidad   (verde)
  tight <= tight_frac de la capacidad (naranja); siempre ok_frac <= tight_frac
  no    por encima                    (rojo)
  needed = tamaño * (1 + margen/100) en v1 (el margen cubre KV + overhead);
           en v2 el margen cubre solo buffers y la KV GGUF se suma aparte

`context` (tokens de contexto) define la KV cache que la estimación v2
(app/gguf + fit.estimate_v2) suma a los archivos GGUF; sin metadatos
útiles la estimación degrada a v1 (tamaño × margen).
"""
from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

from .paths import DATA_DIR

SETTINGS_FILE = DATA_DIR / "settings.json"

CONTEXTS = (4096, 8192, 32768)  # opciones de contexto (4k/8k/32k)
DEFAULTS: dict = {
    "context": 8192,     # U6-4 lo usará para la KV cache
    "margin_pct": 5.0,   # margen ~5% (equivale a fit.OVERHEAD = 1.05)
    "ok_frac": 0.80,     # verde  <= 80 %
    "tight_frac": 0.95,  # naranja <= 95 %
}


class SettingsIn(BaseModel):
    context: int
    margin_pct: float
    ok_frac: float
    tight_frac: float


def _load() -> dict:
    try:
        raw = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def get_settings() -> dict:
    """Defaults + lo persistido en disco (un archivo parcial se completa)."""
    disk = _load()
    out = {}
    for k, default in DEFAULTS.items():
        v = disk.get(k, default)
        out[k] = v if isinstance(v, type(default)) else default
    return out


def save_settings(body: SettingsIn) -> dict:
    """Valida y persiste. Raise: ValueError con mensaje accionable (el
    endpoint lo convierte en 422 con detalle de texto)."""
    if body.context not in CONTEXTS:
        raise ValueError(
            f"contexto inválido: {body.context} (usa {', '.join(str(c) for c in CONTEXTS)})")
    if not 0 <= body.margin_pct <= 50:
        raise ValueError("margen inválido: debe estar entre 0 y 50 %")
    if not 0 < body.ok_frac <= body.tight_frac <= 1:
        raise ValueError(
            "umbrales inválidos: 0 < verde <= naranja <= 1 "
            "(p. ej. 0.80 y 0.95)")
    data = body.model_dump()
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return data


def limits() -> dict:
    """Ajustes -> valores listos para fit.estimate (overhead = 1+margen)."""
    s = get_settings()
    return {
        "overhead": 1.0 + s["margin_pct"] / 100.0,
        "ok_frac": s["ok_frac"],
        "tight_frac": s["tight_frac"],
    }
