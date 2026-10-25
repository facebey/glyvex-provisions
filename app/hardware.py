"""Detección de hardware local (requisito R1).

- GPU NVIDIA: `nvidia-smi` por subprocess (VRAM real, driver); se refresca
  cada 30 s (la VRAM libre cambia).
- GPU AMD / Intel / otras: `Win32_VideoController` (PowerShell + WMI). La VRAM
  de no-NVIDIA viene poco fiable de WMI (cap DWORD de 4 GB): las iGPUs de
  Intel y las sin VRAM se marcan con `shared_memory: true`.
- CPU (modelo, vendor, relojes, socket): `Win32_Processor` (WMI); en no-Windows
  queda solo el conteo de núcleos de psutil.
- RAM: total/disponible de psutil + detalle por módulo (tipo, velocidad,
  fabricante, part number) de `Win32_PhysicalMemory` (WMI).
- Disco: shutil.disk_usage sobre el destino de descargas.

Los datos WMI son estables (no hay hot-swap de CPU/RAM/GPU): se cachean de
por vida por proceso; el primer `/api/hardware` cuesta ~2-3 s extras.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time

import psutil

DEFAULT_DOWNLOADS_DIR = r"D:\Downloads"

_SMI_QUERY = [
    "nvidia-smi",
    "--query-gpu=index,name,memory.total,memory.free,driver_version",
    "--format=csv,noheader,nounits",
]

_NVIDIA_TTL = 30.0  # s: refresco de VRAM libre / driver

# Códigos Win32 MemoryType (los drivers a veces reportan 0: ahí manda el part number)
_MEM_TYPE_CODES = {22: "DRAM", 24: "DDR3", 26: "DDR4", 28: "LPDDR4", 30: "DDR5"}
# Tokens de part number: (token, label) — en orden de prioridad
_MEM_PART_TOKENS = (
    ("X5", "DDR5"), ("PC5", "DDR5"), ("DDR5", "DDR5"),
    ("X4", "DDR4"), ("PC4", "DDR4"), ("DDR4", "DDR4"),
    ("X3", "DDR3"), ("PC3", "DDR3"), ("DDR3", "DDR3"),
)

_wmi_cache: dict[str, list[dict]] = {}
_wmi_lock = threading.Lock()
_smi_cache: tuple[float, list[dict]] | None = None
_smi_lock = threading.Lock()


def _wmi(cim_class: str, props: str) -> list[dict]:
    """Consulta WMI vía PowerShell + ConvertTo-Json. Solo Windows; [] en otro
    lugar o si falla (la app sigue funcionando con lo que da psutil)."""
    with _wmi_lock:
        if cim_class in _wmi_cache:
            return _wmi_cache[cim_class]
    cmd = [
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        f"(Get-CimInstance {cim_class} -Property {props}) | ConvertTo-Json -Compress",
    ]
    data: list[dict] = []
    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=30, check=True).stdout.strip()
        if out:
            parsed = json.loads(out)
            data = parsed if isinstance(parsed, list) else [parsed]
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        data = []
    with _wmi_lock:
        _wmi_cache[cim_class] = data
    return data


def _nvidia_gpus() -> list[dict]:
    """GPU NVIDIA vía nvidia-smi (VRAM real). Cache TTL 30 s."""
    global _smi_cache
    with _smi_lock:
        if _smi_cache and time.monotonic() - _smi_cache[0] < _NVIDIA_TTL:
            return _smi_cache[1]
    try:
        out = subprocess.run(_SMI_QUERY, capture_output=True, text=True,
                             timeout=10, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
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
    with _smi_lock:
        _smi_cache = (time.monotonic(), gpus)
    return gpus


def _gpu_vendor(name: str) -> str:
    n = name.lower()
    if any(k in n for k in ("nvidia", "geforce", "quadro", "rtx", "gtx", "tesla")):
        return "nvidia"
    if any(k in n for k in ("amd", "radeon", "firepro")):
        return "amd"
    if any(k in n for k in ("intel", "iris", "uhd", "hd graphics")):
        return "intel"
    return "other"


def _all_gpus() -> list[dict]:
    """Todas las GPUs (NVIDIA + AMD + Intel): WMI da la lista, nvidia-smi aporta
    la VRAM real de las NVIDIA. Se descartan adaptadores virtuales."""
    smi_by_name = {g["name"]: g for g in _nvidia_gpus()}
    gpus: list[dict] = []
    idx = 0
    for row in _wmi("Win32_VideoController",
                    "Name,DriverVersion,AdapterRAM,VideoModeDescription"):
        name = (row.get("Name") or "").strip()
        if not name:
            continue
        low = name.lower()
        if "microsoft" in low or "remote desktop" in low:
            continue
        g = smi_by_name.get(name)
        if g is not None:
            gpus.append({**g, "vendor": "nvidia", "shared_memory": False})
        else:
            vendor = _gpu_vendor(name)
            vram = int(row.get("AdapterRAM") or 0)
            shared = vendor == "intel" or vram <= 0
            gpus.append({
                "index": idx,
                "name": name,
                "vendor": vendor,
                "vram_total_bytes": 0 if shared else vram,
                "vram_free_bytes": 0,
                "driver": (row.get("DriverVersion") or None),
                "shared_memory": shared,
            })
        idx += 1
    # NVIDIA que WMI no vio (raro): se agrega igual
    seen = {g["name"] for g in gpus}
    for g in _nvidia_gpus():
        if g["name"] not in seen:
            gpus.append({**g, "vendor": "nvidia", "shared_memory": False})
    return gpus


def _cpu_info() -> dict:
    """CPU: modelo + vendor + relojes (WMI) sobre la base de psutil."""
    info = {
        "name": None,
        "vendor": None,
        "cores": 0,
        "logical": psutil.cpu_count(logical=True) or 0,
        "base_mhz": None,
        "socket": None,
    }
    for row in _wmi("Win32_Processor",
                    "Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,"
                    "MaxClockSpeed,CurrentClockSpeed,SocketDesignation"):
        name = (row.get("Name") or "").strip()
        if name:
            info["name"] = name
        mfr = (row.get("Manufacturer") or "").strip()
        info["vendor"] = {"GenuineIntel": "Intel", "AuthenticAMD": "AMD"}.get(mfr) or (mfr or None)
        info["cores"] = int(row.get("NumberOfCores") or 0) or info["cores"]
        info["logical"] = int(row.get("NumberOfLogicalProcessors") or 0) or info["logical"]
        mhz = int(row.get("MaxClockSpeed") or 0)
        info["base_mhz"] = mhz if mhz > 0 else None
        info["socket"] = (row.get("SocketDesignation") or None)
        break
    return info


def _mem_type(part: str | None, code: int) -> str | None:
    p = (part or "").upper()
    for token, label in _MEM_PART_TOKENS:
        if token in p:
            return label
    return _MEM_TYPE_CODES.get(code)


def _ram_modules() -> list[dict]:
    mods: list[dict] = []
    for row in _wmi("Win32_PhysicalMemory",
                    "Capacity,Speed,ConfiguredClockSpeed,Manufacturer,PartNumber,MemoryType"):
        try:
            size = int(row.get("Capacity") or 0)
        except (TypeError, ValueError):
            size = 0
        if size <= 0:
            continue
        try:
            speed = int(row.get("ConfiguredClockSpeed") or row.get("Speed") or 0)
        except (TypeError, ValueError):
            speed = 0
        try:
            code = int(row.get("MemoryType") or 0)
        except (TypeError, ValueError):
            code = 0
        part = (row.get("PartNumber") or "").strip() or None
        mods.append({
            "size_bytes": size,
            "speed_mhz": speed or None,
            "mem_type": _mem_type(part, code),
            "manufacturer": (row.get("Manufacturer") or "").strip() or None,
            "part_number": part,
        })
    return mods


def detect(downloads_dir: str = DEFAULT_DOWNLOADS_DIR) -> dict:
    """Snapshot del hardware: CPU, GPU(s) por vendor, RAM (con módulos) y disco.

    Claves legacy (cpu_cores, ram_total_bytes, gpus con name/vram/driver) se
    mantienen para profiles/fit."""
    ram = psutil.virtual_memory()
    disk = shutil.disk_usage(downloads_dir)
    cpu = _cpu_info()
    return {
        "cpu": cpu,
        "gpus": _all_gpus(),
        "ram_total_bytes": ram.total,
        "ram_available_bytes": ram.available,
        "ram_modules": _ram_modules(),
        "cpu_cores": cpu["logical"],
        "disk_free_bytes": disk.free,
        "disk_total_bytes": disk.total,
        "downloads_dir": downloads_dir,
    }
