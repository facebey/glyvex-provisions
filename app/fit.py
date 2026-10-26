"""Estimación de ajuste VRAM/RAM (requisito R4) — v1: tamaño × overhead.

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
"""
from __future__ import annotations

REGIMES = ("gpu", "multi", "offload", "cpu")

OVERHEAD = 1.05   # margen fijo ~5% (KV cache + overhead de proceso); v2 lo calcula
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


def estimate(size_bytes: int, regime: str, hw: dict) -> dict:
    """Cabe (o no) un archivo/peso de `size_bytes` bytes bajo `regime`."""
    needed = int(size_bytes * OVERHEAD)
    cap = capacity_bytes(regime, hw)
    if cap <= 0:
        detail = ("el perfil no tiene GPU" if regime in ("gpu", "multi")
                  else "el perfil no tiene RAM")
        return {"needed_bytes": needed, "capacity_bytes": 0,
                "ratio": None, "status": "no", "detail": detail}
    ratio = needed / cap
    if ratio <= OK_FRAC:
        status = "ok"
    elif ratio <= TIGHT_FRAC:
        status = "tight"
    else:
        status = "no"
    return {"needed_bytes": needed, "capacity_bytes": cap,
            "ratio": round(ratio, 3), "status": status}
