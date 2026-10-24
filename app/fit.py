"""Estimación de ajuste VRAM/RAM (requisito R4) — v1: tamaño × overhead.

Semáforo (referencia de UX: panel "Hardware compatibility" de huggingface.co):
  ok    <= OK_FRAC de la capacidad
  tight <= TIGHT_FRAC de la capacidad
  no    por encima

Regímenes (a elección del usuario, R2):
  gpu     -> compara contra la VRAM de la GPU principal (v1; multi-GPU va en fase 2/3)
  offload -> el modelo vive en RAM y capas en GPU: compara contra RAM total
  cpu     -> todo en CPU: RAM total
"""
from __future__ import annotations

REGIMES = ("gpu", "offload", "cpu")

OVERHEAD = 1.05   # margen fijo ~5% (KV cache + overhead de proceso); v2 lo calcula
OK_FRAC = 0.80
TIGHT_FRAC = 0.95


def capacity_bytes(regime: str, hw: dict) -> int:
    if regime == "gpu":
        gpus = hw.get("gpus") or []
        return gpus[0]["vram_total_bytes"] if gpus else 0
    return hw["ram_total_bytes"]


def estimate(size_bytes: int, regime: str, hw: dict) -> dict:
    """Cabe (o no) un archivo/peso de `size_bytes` bytes bajo `regime`."""
    needed = int(size_bytes * OVERHEAD)
    cap = capacity_bytes(regime, hw)
    if cap <= 0:
        detail = ("no se detectó GPU NVIDIA" if regime == "gpu"
                  else "sin datos de RAM")
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
