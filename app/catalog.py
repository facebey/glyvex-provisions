"""Catálogo de hardware (adición 4d) — datos curados 2015→presente.

Dos usos:
1. Perfil manual (R10): selects en cascada (vendor → modelo) con VRAM
   autocompletada desde el mapeo; "Otro…" permite modelos fuera del
   catálogo (hardware de empresa variado).
2. Detección automática: los nombres detectados se cruzan con el catálogo
   para enriquecer la VRAM real de GPUs no-NVIDIA (WMI capotea en ~4 GB)
   y los relojes de CPU cuando WMI no los da.

El catálogo (catalog.json) es de solo lectura para la app; se edita a mano
para extenderlo. El match tolera prefixes de vendor, "(R)"/"(TM)",
"Gen N", etc., comparando sets de tokens (el modelo más largo que encaja).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

CATALOG_FILE = Path(__file__).resolve().parent / "catalog.json"

# Tokens que no identifican el modelo (vendors, marcas genéricas, marcas
# de nombre WMI): se descartan antes de comparar.
_STRIP = re.compile(
    r"nvidia|geforce|quadro|rtx|gtx|rt[xy]? ?a|intel|genuineintel|authenticamd|amd|"
    r"radeon|firepro|arc|geforce|core|pentium|celeron|xeon|ryzen|threadripper|"
    r"epyc|ap[uv]|gtx|processor|graphics|hd|iris|uhd",
    re.IGNORECASE,
)
_GEN_PREFIX = re.compile(r"\b\d+(st|nd|rd|th)\s*gen\b", re.IGNORECASE)


@lru_cache(maxsize=1)
def _load() -> dict:
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def _tokens(name: str) -> frozenset[str]:
    """Nombre de hardware -> tokens significantes (lowercase, sin ruido)."""
    name = _GEN_PREFIX.sub(" ", name.replace("(R)", " ").replace("(TM)", " "))
    name = _STRIP.sub(" ", name)
    name = re.sub(r"[^a-z0-9]+", " ", name.lower())
    return frozenset(t for t in name.split() if t)


def _best_match(name: str, entries: list[dict]) -> dict | None:
    """Entrada del catálogo cuyo set de tokens está contenido en el nombre
    detectado; gana la más específica (más tokens). Exige que el match
    incluya al menos un token alfanumérico 'dura' (número o código)."""
    have = _tokens(name)
    if not have:
        return None
    best: dict | None = None
    best_n = 0
    for e in entries:
        want = _tokens(e["model"])
        if not want or not (want <= have):
            continue
        if len(want) > best_n:
            best, best_n = e, len(want)
    return best


def match_gpu(name: str) -> dict | None:
    """GPU detectada -> entrada de catálogo {model, vram_gb} de cualquier
    vendor (o None si no está en el catálogo)."""
    gpus = _load().get("gpus", {})
    for entries in gpus.values():
        hit = _best_match(name, entries)
        if hit:
            return dict(hit)
    return None


def match_cpu(name: str) -> dict | None:
    """CPU detectada -> entrada de catálogo (o None)."""
    cpus = _load().get("cpus", {})
    for entries in cpus.values():
        hit = _best_match(name, entries)
        if hit:
            return dict(hit)
    return None


def payload() -> dict:
    """Catálogo completo para /api/catalog (UI: selects en cascada)."""
    cat = _load()
    return {
        "cpus": {v: [dict(e) for e in es] for v, es in cat.get("cpus", {}).items()},
        "gpus": {v: [dict(e) for e in es] for v, es in cat.get("gpus", {}).items()},
        "ram": cat.get("ram", {}),
    }
