"""Endpoints REST + SSE de model-pilot (fase 1 / MVP).

Todo se sirve en 127.0.0.1 (lo garantiza el launch de uvicorn). El frontend
(Vite :5173) usa proxy de /api hacia este backend, así que no hay CORS.
"""
from __future__ import annotations

import json
import queue

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from hf_down import MMPROJ_RE, MTP_RE, QUANT_RE, WEIGHT_EXTS

from . import downloads as dl
from . import fit, hfsearch
from .hardware import detect

router = APIRouter(prefix="/api")


class SearchReq(BaseModel):
    query: str
    limit: int = 20


class DownloadReq(BaseModel):
    repo_id: str
    files: list[str]


def _file_label(path: str) -> str:
    """Etiqueta por archivo, con las MISMAS reglas que el core
    (mmproj/MTP antes que la cuantización)."""
    base = path.rsplit("/", 1)[-1]
    if MMPROJ_RE.search(base):
        return "mmproj (visión)"
    if MTP_RE.search(base):
        m = QUANT_RE.search(base)
        return f"MTP (opcional){' ' + m.group(1).upper() if m else ''}"
    m = QUANT_RE.search(path)
    return m.group(1).upper() if m else "(sin etiqueta)"


@router.get("/hardware")
def hardware() -> dict:
    return detect()


@router.post("/search")
def search(body: SearchReq) -> dict:
    return {"models": hfsearch.search_models(body.query, body.limit)}


@router.get("/repo/files")
def repo_files(repo_id: str, regime: str = "gpu") -> dict:
    if regime not in fit.REGIMES:
        raise HTTPException(422, f"regimén inválido: {regime!r} "
                                 f"(usa {', '.join(fit.REGIMES)})")
    try:
        data = hfsearch.repo_files(repo_id)
    except hfsearch.GatedError:
        raise HTTPException(
            403,
            "Repo gated/privado: acepta los términos en huggingface.co y "
            "define HF_TOKEN (o ejecuta `hf auth login`).",
        ) from None
    hw = detect()
    rows = []
    for f in data["files"]:
        if f["ext"] not in WEIGHT_EXTS:
            continue
        rows.append({"path": f["path"], "label": _file_label(f["path"]),
                     "size": f["size"], **fit.estimate(f["size"], regime, hw)})
    return {"repo_id": repo_id, "rows": rows, "groups": data["groups"],
            "hardware": hw}


@router.post("/downloads")
def start_download(body: DownloadReq) -> dict:
    if not body.files:
        raise HTTPException(422, "selección vacía")
    job = dl.manager.submit(body.repo_id, body.files)
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
            if ev["type"] in ("done", "error"):
                break

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
