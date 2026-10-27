"""Estimación de ajuste VRAM/RAM (requisito R4).

v1: tamaño x margen (la cifra honesta cuando no hay metadatos).
v2 (U6-4): pesos x margen + KV cache calculada desde la cabecera GGUF
    (app/gguf) según el contexto elegido en Ajustes. El margen deja de
    cubrir la KV (ahora tiene cifra propia) y pasa a cubrir solo los
    buffers de cómputo; sin metadatos útiles la v2 degrada a v1.

Semáforo (referencia de UX: panel "Hardware compatibility" de huggingface.co):
  ok    <= OK_FRAC de la capacidad
  tight <= TIGHT_FRAC de la capacidad
  no    por encima

Regímenes (a elección del usuario, R2):
  gpu     -> compara contra la VRAM de la GPU INDIVIDUAL más grande del
             perfil: fiel a difusión/ComfyUI, que carga el modelo completo
             en UNA GPU
  multi   -> suma la VRAM de TODAS las GPUs del perfil: orientativo, válido
             solo para inferencia multi-GPU real (llama.cpp repartiendo
             capas GGUF); NO lo uses para modelos de difusión
  offload -> el modelo vive en RAM y capas en GPU: compara contra RAM total
  cpu     -> todo en CPU: RAM total

Los umbrales y el margen son ajustables en Ajustes (U6-3, app/settings):
las funciones reciben `limits` con overhead/ok_frac/tight_frac; los valores
del módulo son solo el default histórico (idéntico a lo que trae settings).
"""
from __future__ import annotations

from . import gguf

REGIMES = ("gpu", "multi", "offload", "cpu")

OVERHEAD = 1.05   # margen (buffers de cómputo); la KV se suma aparte en v2
OK_FRAC = 0.80
TIGHT_FRAC = 0.95


def capacity_bytes(regime: str, hw: dict) -> int:
    gpus = hw.get("gpus") or []
    if regime == "gpu":
        # GPU principal = la de más VRAM: orden de WMI no es fiable (iGPU
        # primero) y un perfil manual puede listar varias GPUs.
        return max((g["vram_total_bytes"] for g in gpus), default=0)
    if regime == "multi":
        return sum(g["vram_total_bytes"] for g in gpus)
    return hw["ram_total_bytes"]


def _overhead(limits: dict | None) -> float:
    return (limits or {}).get("overhead", OVERHEAD)


def _judge(needed: int, regime: str, hw: dict, limits: dict | None) -> dict:
    ok_frac = (limits or {}).get("ok_frac", OK_FRAC)
    tight_frac = (limits or {}).get("tight_frac", TIGHT_FRAC)
    cap = capacity_bytes(regime, hw)
    if cap <= 0:
        detail = ("el perfil no tiene GPU" if regime in ("gpu", "multi")
                  else "el perfil no tiene RAM")
        return {"needed_bytes": needed, "capacity_bytes": 0,
                "ratio": None, "status": "no", "detail": detail}
    ratio = needed / cap
    if ratio <= ok_frac:
        status = "ok"
    elif ratio <= tight_frac:
        status = "tight"
    else:
        status = "no"
    return {"needed_bytes": needed, "capacity_bytes": cap,
            "ratio": round(ratio, 3), "status": status}


def _human(n: int) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.1f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.1f} MB"
    return f"{n // 1024} KB"


def estimate(size_bytes: int, regime: str, hw: dict,
             limits: dict | None = None) -> dict:
    """v1: cabe (o no) un archivo/peso de `size_bytes` bajo `regime`,
    solo por tamaño x margen. `limits` (U6-3): valores de app/settings."""
    d = _judge(int(size_bytes * _overhead(limits)), regime, hw, limits)
    d["fit_version"] = 1
    d["kv_bytes"] = 0
    return d


def estimate_v2(size_bytes: int, regime: str, hw: dict,
                limits: dict | None, meta: dict | None,
                context: int) -> dict:
    """Estimación v2 (U6-4): pesos x margen + KV GGUF para `context`.

    `meta` viene de app.gguf.parse_header sobre el prefijo que baja el core
    (prefetch_head). Sin metadatos que permitan estimar KV (no-GGUF,
    arquitectura no estándar, cabecera fuera del prefijo) degrada a v1 con
    fit_version=1 y kv_bytes=0 — la tabla nunca se queda sin semáforo.
    """
    kv = gguf.kv_cache_bytes(meta, context)
    if kv is None:
        return estimate(size_bytes, regime, hw, limits)
    kv_bytes, detail = kv
    d = _judge(int(size_bytes * _overhead(limits)) + kv_bytes,
               regime, hw, limits)
    d["fit_version"] = 2
    d["kv_bytes"] = kv_bytes
    base = d.get("detail")
    d["detail"] = (f"v2 GGUF: {detail} a {context} tokens -> KV "
                   f"{_human(kv_bytes)}"
                   + (f" · {base}" if base else ""))
    return d
