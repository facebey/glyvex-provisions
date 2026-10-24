"""Detección de hardware local (requisito R1).

- GPU NVIDIA: `nvidia-smi` por subprocess (el driver ya lo provee; no hace
  falta pynvml). Sin driver/GPU -> lista vacía.
- RAM / CPU: psutil.
- Disco: shutil.disk_usage sobre el destino de descargas.
"""
from __future__ import annotations

import shutil
import subprocess

import psutil

DEFAULT_DOWNLOADS_DIR = r"D:\Downloads"

_SMI_QUERY = [
    "nvidia-smi",
    "--query-gpu=index,name,memory.total,memory.free,driver_version",
    "--format=csv,noheader,nounits",
]


def _nvidia_gpus() -> list[dict]:
    try:
        out = subprocess.run(_SMI_QUERY, capture_output=True, text=True,
                             timeout=10, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    gpus: list[dict] = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        idx, name, mem_total, mem_free, driver = parts[:5]
        try:
            gpus.append({
                "index": int(idx),
                "name": name,
                "vram_total_bytes": int(mem_total) * 1024 * 1024,
                "vram_free_bytes": int(mem_free) * 1024 * 1024,
                "driver": driver,
            })
        except ValueError:
            continue
    return gpus


def detect(downloads_dir: str = DEFAULT_DOWNLOADS_DIR) -> dict:
    """Snapshot del hardware: GPU(s), RAM, CPU y espacio en disco."""
    ram = psutil.virtual_memory()
    disk = shutil.disk_usage(downloads_dir)
    return {
        "gpus": _nvidia_gpus(),
        "ram_total_bytes": ram.total,
        "ram_available_bytes": ram.available,
        "cpu_cores": psutil.cpu_count(logical=True) or 0,
        "disk_free_bytes": disk.free,
        "disk_total_bytes": disk.total,
        "downloads_dir": downloads_dir,
    }
