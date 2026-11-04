"""Endpoints REST + SSE de Glyvex Provisions (fase 1 / MVP).

Todo se sirve en 127.0.0.1 (lo garantiza el launch de uvicorn). El frontend
(Vite :5173) usa proxy de /api hacia este backend, así que no hay CORS.
"""
from __future__ import annotations

import json
import queue
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from hf_down import (MMPROJ_RE, MTP_RE, QUANT_RE, SUPPORT_EXTS,
                     SUPPORT_MAX_SIZE, WEIGHT_EXTS)

from . import catalog
from . import downloads as dl
from . import fit, gguf, hfsearch
from . import launcher
from . import suite
from . import packages
from . import profiles
from . import settings as st
from . import storage
from .hardware import detect

router = APIRouter(prefix="/api")


class SearchReq(BaseModel):
    query: str
    limit: int = 20


class DownloadReq(BaseModel):
    repo_id: str
    files: list[str]
    dest: str | None = None  # R11: path de storage configurado (obligatorio)


def _file_label(path: str) -> str:
    """Etiqueta de ARCHIVOS DE PESOS, con las MISMAS reglas que el core
    (mmproj/MTP antes que la cuantización)."""
    base = path.rsplit("/", 1)[-1]
    if MMPROJ_RE.search(base):
        return "mmproj (visión)"
    if MTP_RE.search(base):
        m = QUANT_RE.search(base)
        return f"MTP (opcional){' ' + m.group(1).upper() if m else ''}"
    m = QUANT_RE.search(path)
    return m.group(1).upper() if m else "(sin etiqueta)"


def _is_main_gguf(path: str) -> bool:
    """True para el GGUF del CUERPO PRINCIPAL: ni mmproj (visor de visión)
    ni MTP (módulo multi-token-predicción). El MTP importa aparte: su
    cabecera NO son los hparams del cuerpo (cachearla contamina la meta del
    repo) y no hereda la KV del principal (va por v1, peso x margen)."""
    base = path.rsplit("/", 1)[-1]
    return not (MMPROJ_RE.search(base) or MTP_RE.search(base))


def _aux_label(path: str, ext: str, size: int) -> str:
    """Etiqueta de archivos no-peso (model card, config, otros).
    Mismas categorías que el core (README, soporte <=1 MB, resto)."""
    base = path.rsplit("/", 1)[-1]
    if base.lower() == "readme.md":
        return "Model card"
    if ext in SUPPORT_EXTS and size <= SUPPORT_MAX_SIZE:
        return "Config / soporte"
    return "Otros archivos"


@router.get("/hardware")
def hardware() -> dict:
    return detect()


# ---- Catálogo de hardware (adición 4d): selects en cascada ------------------

@router.get("/catalog")
def get_catalog() -> dict:
    return catalog.payload()


# ---- Perfiles de hardware (R10): "local" (auto) + manuales -----------------

@router.get("/profiles")
def list_profiles() -> dict:
    return {"profiles": profiles.list_profiles()}


@router.post("/profiles", status_code=201)
def create_profile(body: profiles.ProfileIn) -> dict:
    try:
        return profiles.add_profile(body)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None


@router.put("/profiles/{profile_id}")
def update_profile(profile_id: str, body: profiles.ProfileIn) -> dict:
    if profile_id == profiles.AUTO_ID:
        raise HTTPException(409, "el perfil auto (local) no se edita")
    try:
        p = profiles.update_profile(profile_id, body)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    if not p:
        raise HTTPException(404, f"perfil inexistente: {profile_id}")
    return p


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str) -> dict:
    if profile_id == profiles.AUTO_ID:
        raise HTTPException(409, "el perfil auto (local) no se borra")
    if not profiles.delete_profile(profile_id):
        raise HTTPException(404, f"perfil inexistente: {profile_id}")
    return {"ok": True}


# ---- Ajustes persistentes (U6-3): semáforo + margen + contexto -------------

@router.get("/settings")
def get_settings() -> dict:
    return st.get_settings()


@router.put("/settings")
def put_settings(body: st.SettingsIn) -> dict:
    try:
        return st.save_settings(body)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


# ---- Storage multi-path (R11) + librería local (R9) -------------------------

@router.get("/storage")
def list_storages() -> dict:
    return {"storages": storage.list_storages()}


@router.post("/storage", status_code=201)
def create_storage(body: storage.StorageIn) -> dict:
    try:
        return storage.add_storage(body)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


@router.put("/storage/{storage_id}")
def update_storage(storage_id: str, body: storage.StorageIn) -> dict:
    try:
        s = storage.update_storage(storage_id, body)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    if not s:
        raise HTTPException(404, f"storage inexistente: {storage_id}")
    return s


@router.delete("/storage/{storage_id}")
def delete_storage(storage_id: str) -> dict:
    if not storage.delete_storage(storage_id):
        raise HTTPException(404, f"storage inexistente: {storage_id}")
    return {"ok": True}


@router.get("/library")
def library(storage_id: str | None = None) -> dict:
    """Librería local: escaneo recursivo de los paths de storage (R9)."""
    if storage_id is not None and storage.get_storage(storage_id) is None:
        raise HTTPException(404, f"storage inexistente: {storage_id}")
    return storage.scan_library(storage_id)


# ---- Paquetes de modelos por escenario (R12) -----------------------------
# Manifiestos: .json en <storage>\packajes\ (ver app/packages.py).

@router.get("/storage/{storage_id}/packages")
def list_packages(storage_id: str) -> dict:
    s = storage.get_storage(storage_id)
    if s is None:
        raise HTTPException(404, f"storage inexistente: {storage_id}")
    return {"packages": packages.list_packages(Path(s["path"]))}


@router.post("/storage/{storage_id}/packages", status_code=201)
def create_package(storage_id: str, body: packages.Package) -> dict:
    s = storage.get_storage(storage_id)
    if s is None:
        raise HTTPException(404, f"storage inexistente: {storage_id}")
    try:
        return packages.create_package(Path(s["path"]), body)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


@router.delete("/storage/{storage_id}/packages/{package_id}")
def delete_package(storage_id: str, package_id: str) -> dict:
    s = storage.get_storage(storage_id)
    if s is None:
        raise HTTPException(404, f"storage inexistente: {storage_id}")
    try:
        ok = packages.delete_package(Path(s["path"]), package_id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    if not ok:
        raise HTTPException(404, f"paquete inexistente: {package_id}")
    return {"ok": True}


@router.post("/storage/{storage_id}/packages/{package_id}/download")
def download_package(storage_id: str, package_id: str) -> dict:
    """Descarga el paquete: 1 job por repo único, destino = el storage del
    paquete. Los glob del manifiesto se expanden a paths exactos en
    `dl.manager.submit` (R12)."""
    s = storage.get_storage(storage_id)
    if s is None:
        raise HTTPException(404, f"storage inexistente: {storage_id}")
    try:
        pkg = packages.read_package(Path(s["path"]), package_id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    if pkg is None:
        raise HTTPException(404, f"paquete inexistente: {package_id}")
    by_repo: dict[str, list[str]] = {}
    for f in pkg["files"]:
        spec = f.get("file") or f.get("pattern")
        by_repo.setdefault(f["repo_id"], []).append(spec)
    dest = Path(s["path"])
    jobs = []
    for repo_id in sorted(by_repo):
        job = dl.manager.submit(repo_id, by_repo[repo_id], dest=dest)
        jobs.append({"id": job.id, "repo_id": repo_id,
                     "files": len(by_repo[repo_id])})
    return {"jobs": jobs, "dest": str(dest)}


@router.post("/search")
def search(body: SearchReq) -> dict:
    return {"models": hfsearch.search_models(body.query, body.limit)}


@router.get("/repo/files")
def repo_files(repo_id: str, regime: str = "gpu", profile: str = "local") -> dict:
    if regime not in fit.REGIMES:
        raise HTTPException(422, f"regimén inválido: {regime!r} "
                                 f"(usa {', '.join(fit.REGIMES)})")
    # Perfil primero (check local, sin red): 404 determinista antes de llamar a HF.
    prof = profiles.get_profile(profile)
    if prof is None:
        raise HTTPException(404, f"perfil inexistente: {profile}")
    try:
        data = hfsearch.repo_files(repo_id)
    except hfsearch.GatedError as e:
        raise HTTPException(403, hfsearch.friendly_message(e.repo_id, e.status)) from None
    hw = profiles.caps_for(profile)
    # Ajustes del usuario (U6-3): umbrales y margen del semáforo;
    # el contexto alimenta la estimación v2 de KV (U6-4).
    limits = st.limits()
    context = st.get_settings()["context"]
    # v2: la cabecera GGUF se sondea UNA vez por repo (los quant comparten
    # hparams). Los mmproj (visor, arquitectura clip/mt5), los MTP (módulo
    # opcional: su cabecera no son los hparams del cuerpo) y los no-GGUF van
    # por v1: la KV de atención del LLM no les aplica.
    gg_paths = [f["path"] for f in data["files"]
                if f["ext"] == ".gguf" and _is_main_gguf(f["path"])]
    gg_meta = gguf.repo_gguf_meta(repo_id, gg_paths) if gg_paths else None
    rows = []
    aux = []
    for f in data["files"]:
        if f["ext"] in WEIGHT_EXTS:
            # mmproj (visor clip/mt5) y MTP van por v1 aunque el repo tenga
            # meta: la KV de atención del LLM no les aplica (el MTP ni la
            # hereda: es un módulo opcional, peso x margen).
            if (f["ext"] == ".gguf" and gg_meta is not None
                    and _is_main_gguf(f["path"])):
                est = fit.estimate_v2(f["size"], regime, hw, limits,
                                      gg_meta, context)
            else:
                est = fit.estimate(f["size"], regime, hw, limits)
            rows.append({"path": f["path"], "label": _file_label(f["path"]),
                         "size": f["size"], **est})
        else:
            # No-peso: se lista (model card, config, otros) pero sin semáforo.
            aux.append({"path": f["path"], "label": _aux_label(
                f["path"], f["ext"], f["size"]), "size": f["size"],
                "needed_bytes": 0, "capacity_bytes": 0, "ratio": None,
                "status": "na", "detail": "no es un peso (sin semáforo)"})
    # Model card primero, luego config/soporte, luego el resto.
    aux.sort(key=lambda r: (r["label"] != "Model card",
                            r["label"] != "Config / soporte", r["path"]))
    rows.extend(aux)
    return {"repo_id": repo_id, "rows": rows, "groups": data["groups"],
            "hardware": hw,
            "profile": {"id": prof["id"], "name": prof["name"]}}


def _validate_dest(dest: str | None) -> Path:
    """R11: el destino de descarga es uno de los paths de storage
    configurados (o una subcarpeta de alguno). Sin storage -> 422."""
    if dest is None or not dest.strip():
        raise HTTPException(422, "sin destino: elegí un path de storage")
    p = Path(dest.strip())
    if not p.is_absolute():
        raise HTTPException(422, f"destino no absoluto: {dest!r}")
    if not p.is_dir():
        raise HTTPException(422, f"directorio no existe: {p}")
    rp = p.resolve()
    for s in storage.list_storages():
        sp = Path(s["path"]).resolve()
        if rp == sp or sp in rp.parents:
            return p
    raise HTTPException(
        422,
        f"el destino no es un path de storage configurado ({p}): agregalo "
        "en la sección 'Storage y librería'",
    )


@router.post("/downloads")
def start_download(body: DownloadReq) -> dict:
    if not body.files:
        raise HTTPException(422, "selección vacía")
    dest = _validate_dest(body.dest)
    job = dl.manager.submit(body.repo_id, body.files, dest=dest)
    return {"id": job.id}


@router.get("/downloads")
def list_downloads() -> dict:
    return {"jobs": [
        {"id": j.id, "repo_id": j.repo_id, "status": j.status,
         "files": len(j.files), "error": j.error, "dest": j.dest}
        for j in dl.manager.list()
    ]}


@router.get("/downloads/{job_id}/events")
def download_events(job_id: str) -> StreamingResponse:
    """SSE: eventos de progreso del job (data: {json} por línea)."""
    job = dl.manager.get(job_id)
    if job is None:
        raise HTTPException(404, "job inexistente")

    def gen():
        while True:
            try:
                ev = job.events.get(timeout=15)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(ev)}\n\n"
            # paused también termina el stream: el frontend cierra el
            # EventSource y al reanudar se re-suscribe (un solo
            # consumidor de la cola por vez, sin "generador fantasma").
            if ev["type"] in ("done", "error", "paused"):
                break

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/downloads/{job_id}/pause")
def pause_download(job_id: str) -> dict:
    try:
        job = dl.manager.pause(job_id)
    except KeyError:
        raise HTTPException(404, "job inexistente")
    except ValueError as e:
        raise HTTPException(409, f"no se puede pausar un job en estado {e!r}")
    return {"id": job.id, "status": job.status}


@router.post("/downloads/{job_id}/resume")
def resume_download(job_id: str) -> dict:
    try:
        job = dl.manager.resume(job_id)
    except KeyError:
        raise HTTPException(404, "job inexistente")
    except ValueError as e:
        raise HTTPException(
            409,
            f"no se puede reanudar un job en estado {e!r} "
            "(solo paused o error)",
        )
    return {"id": job.id, "status": job.status}


@router.post("/downloads/{job_id}/retry")
def retry_download(job_id: str) -> dict:
    """Alias de resume: relanza un job en paused/error (idempotente)."""
    return resume_download(job_id)


# ---------------------------------------------------------------------------
# U15: engines, Suite (ecosistema) y lanzador de modelos
# ---------------------------------------------------------------------------


class EnginesBody(BaseModel):
    user_binary: str | None = None


class LaunchReq(BaseModel):
    model_path: str
    engine: str = "auto"          # auto | suite | user | ollama
    profile_id: str = profiles.AUTO_ID
    regime: str = "gpu"           # fit.REGIMES
    context: int = st.DEFAULTS["context"]
    port: int | None = None


@router.get("/engines")
def list_engines() -> dict:
    return {"engines": launcher.detect_engines(), **launcher.get_engines()}


@router.put("/engines")
def put_engines(body: EnginesBody) -> dict:
    path = (body.user_binary or "").strip()
    if path:
        p = Path(path)
        if not p.is_file():
            raise HTTPException(422, f"binario inexistente: {p}")
    return launcher.save_engines(path or None)


# U16: presets de lanzamiento (cómo lanzar, no qué modelo)
class PresetReq(BaseModel):
    name: str
    scenario: str = "chat"          # chat | vision | offload
    engine: str = "auto"            # auto | suite | user | ollama
    profile_id: str = profiles.AUTO_ID
    regime: str = "gpu"             # fit.REGIMES (offload lo fija el escenario)
    context: int | None = None      # st.CONTEXTS (default: st.DEFAULTS)
    port: int | None = None
    mmproj: str | None = None
    extra_args: str = ""            # free-form; se ve tal cual en el preview


@router.get("/launcher/presets")
def list_presets() -> dict:
    return {"presets": launcher.get_presets()}


@router.post("/launcher/presets", status_code=201)
def create_preset(body: PresetReq) -> dict:
    try:
        return launcher.create_preset(body.model_dump())
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.put("/launcher/presets/{preset_id}")
def update_preset(preset_id: str, body: PresetReq) -> dict:
    try:
        return launcher.update_preset(preset_id, body.model_dump())
    except KeyError:
        raise HTTPException(404, f"preset inexistente: {preset_id}")
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.delete("/launcher/presets/{preset_id}")
def delete_preset(preset_id: str) -> dict:
    try:
        launcher.delete_preset(preset_id)
    except KeyError:
        raise HTTPException(404, f"preset inexistente: {preset_id}")
    return {"ok": True}


@router.get("/suite")
def suite_status() -> dict:
    return suite.status()


@router.post("/suite/register")
def suite_register(body: dict) -> dict:
    """Registra una carpeta en la Suite (POST /api/config + scan).
    409 si la Suite no está abierta — el registro es intencional y la UI
    debe decir 'abrila y reintenta'."""
    folder = (body or {}).get("folder")
    if not folder:
        raise HTTPException(422, "faltó 'folder'")
    try:
        return suite.register_folder(folder)
    except suite.SuiteNotRunning as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:  # noqa: BLE001 — error HTTP de la Suite
        raise HTTPException(502, f"la Suite devolvió un error: {e}"[:300])


@router.post("/engines/launch", status_code=201)
def launch_session(body: LaunchReq) -> dict:
    if body.regime not in fit.REGIMES:
        raise HTTPException(422, f"régimen inválido: {body.regime}")
    if body.context not in st.CONTEXTS:
        raise HTTPException(422, f"contexto inválido: {body.context}")
    try:
        s = launcher.manager.launch(
            body.model_path, body.engine, body.profile_id,
            body.regime, body.context, body.port)
    except launcher.BusyError as e:
        raise HTTPException(409, str(e))
    except launcher.PortBusyError as e:
        raise HTTPException(409, str(e))
    except launcher.EngineUnavailable as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"id": s.id, "port": s.port, "engine": s.engine,
            "ngl": s.ngl, "state": s.state}


@router.get("/engines/session")
def get_session(tail: int = 60) -> dict:
    snap = launcher.manager.snapshot(tail=tail)
    if snap is None:
        raise HTTPException(404, "no hay sesión activa")
    return snap


@router.get("/engines/session/events")
def session_events() -> StreamingResponse:
    """SSE de la sesión activa: launched/log/state/verified/stopped."""
    s = launcher.manager.current
    if s is None:
        raise HTTPException(404, "no hay sesión activa")

    def gen():
        while True:
            try:
                ev = s.events.get(timeout=15)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(ev)}\n\n"
            # failed/stopped cierran el stream: la UI lee el estado final y
            # puede re-suscribirse si lanza de nuevo.
            if ev.get("type") == "state" and ev.get("state") in ("failed", "stopped"):
                break

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/engines/session/stop")
def stop_session() -> dict:
    out = launcher.manager.stop()
    if not out["stopped"] and out["state"] == "none":
        raise HTTPException(404, "no hay sesión activa")
    return out
