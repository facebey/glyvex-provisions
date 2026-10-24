"""Búsqueda y listado de repos GGUF en Hugging Face (requisito R3).

Única red saliente de la APP: huggingface.co (requisito R8).
Token (R7): huggingface_hub resuelve solo el env HF_TOKEN o el cache de
`hf auth login`. Nunca se persiste ni se expone en el proyecto.
"""
from __future__ import annotations

from huggingface_hub import HfApi, get_token
from huggingface_hub.utils import HfHubHTTPError

from hf_down import FileEntry, group_files

API = HfApi()


class GatedError(Exception):
    """Repo gated/privado: falta aceptar términos y/o token."""


def _token() -> str | None:
    return get_token()  # HF_TOKEN env o cache local; None si no hay


def search_models(query: str, limit: int = 20) -> list[dict]:
    """Busca modelos GGUF por texto (nombre/autor), ordenados por descargas."""
    out = []
    for m in API.list_models(search=query, filter="gguf",
                             sort="downloads", limit=limit):
        out.append({
            "id": m.id,
            "likes": m.likes or 0,
            "downloads": m.downloads or 0,
            "pipeline_tag": getattr(m, "pipeline_tag", None),
        })
    return out


def repo_files(repo_id: str) -> dict:
    """Lista todos los archivos del repo y los agrupa (reutiliza el core)."""
    try:
        items = API.list_repo_tree(repo_id, repo_type="model", recursive=True)
        files = [FileEntry(i.path, getattr(i, "size", 0) or 0) for i in items]
    except HfHubHTTPError as e:
        if getattr(e, "status", None) in (401, 403):
            raise GatedError() from e
        raise
    return {
        "repo_id": repo_id,
        "files": [{"path": f.path, "size": f.size, "ext": f.ext} for f in files],
        "groups": [
            {"kind": g.kind, "name": g.name, "files": [f.path for f in g.files]}
            for g in group_files(files)
        ],
    }
