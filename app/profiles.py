"""Perfiles de hardware multi-servidor (requisito R10).

- Perfil "local" (auto): SIEMPRE el primero; se genera al vuelo con
  hardware.detect() (esta máquina). No se persiste: refleja el hardware real.
- Perfiles manuales: nombre + GPU (modelo + VRAM) + RAM, para cada server que
  el usuario quiera correr modelos. Persistidos en data/profiles.json.

El semáforo (fit) se calcula contra el perfil ELEGIDO, no contra la máquina
local: la app no se conecta a ningún server, solo "esto es lo que tiene".
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from .hardware import detect

GB = 1024 ** 3
AUTO_ID = "local"
AUTO_NAME = "Esta máquina (auto)"

PROFILES_FILE = Path(__file__).resolve().parent.parent / "data" / "profiles.json"


class GpuSpec(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    vram_gb: float = Field(gt=0, le=4096)


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    gpus: list[GpuSpec] = Field(default_factory=list)
    ram_gb: float = Field(gt=0, le=65536)
    note: str | None = Field(default=None, max_length=280)


def _load() -> list[dict]:
    try:
        raw = json.loads(PROFILES_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return raw.get("profiles", []) if isinstance(raw, dict) else []


def _save(profiles: list[dict]) -> None:
    PROFILES_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROFILES_FILE.write_text(
        json.dumps({"profiles": profiles}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _auto_profile() -> dict:
    hw = detect()
    return {
        "id": AUTO_ID,
        "name": AUTO_NAME,
        "kind": "auto",
        "gpus": [
            {"name": g["name"], "vram_gb": round(g["vram_total_bytes"] / GB, 1)}
            for g in hw["gpus"]
        ],
        "ram_gb": round(hw["ram_total_bytes"] / GB, 1),
        "note": None,
    }


def list_profiles() -> list[dict]:
    """[auto] + manuales persistidos."""
    return [_auto_profile()] + _load()


def get_profile(profile_id: str) -> dict | None:
    if profile_id == AUTO_ID:
        return _auto_profile()
    return next((p for p in _load() if p["id"] == profile_id), None)


def add_profile(body: ProfileIn) -> dict:
    data = body.model_dump()
    if any(p["name"].lower() == data["name"].lower() for p in list_profiles()):
        raise ValueError(f"ya existe un perfil llamado {data['name']!r}")
    data = dict(data, id=_new_id(), kind="manual",
                 note=(data["note"] or None))
    profiles = _load()
    profiles.append(data)
    _save(profiles)
    return data


def update_profile(profile_id: str, body: ProfileIn) -> dict:
    profiles = _load()
    for i, p in enumerate(profiles):
        if p["id"] == profile_id:
            data = body.model_dump()
            if any(q["name"].lower() == data["name"].lower()
                   for q in profiles if q["id"] != profile_id):
                raise ValueError(f"ya existe un perfil llamado {data['name']!r}")
            data = dict(data, id=profile_id, kind="manual",
                        note=(data["note"] or None))
            profiles[i] = data
            _save(profiles)
            return data
    return {}  # el endpoint convierte en 404


def delete_profile(profile_id: str) -> bool:
    profiles = _load()
    kept = [p for p in profiles if p["id"] != profile_id]
    if len(kept) == len(profiles):
        return False
    _save(kept)
    return True


def caps_for(profile_id: str) -> dict | None:
    """Perfil -> dict en la MISMA forma que hardware.detect(), para que
    fit.estimate/fit.capacity_bytes funcionen sin cambios."""
    if profile_id == AUTO_ID:
        return detect()
    p = get_profile(profile_id)
    if p is None:
        return None
    return {
        "gpus": [
            {"name": g["name"],
             "vram_total_bytes": int(g["vram_gb"] * GB)}
            for g in p.get("gpus", [])
        ],
        "ram_total_bytes": int(p["ram_gb"] * GB),
    }


def _new_id() -> str:
    return f"{time.strftime('%y%m%d')}-{uuid.uuid4().hex[:6]}"
