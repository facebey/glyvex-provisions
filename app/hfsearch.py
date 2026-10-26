"""Búsqueda y listado de repos GGUF en Hugging Face (requisito R3).

Única red saliente de la APP: huggingface.co (requisito R8).
Token (R7): huggingface_hub resuelve solo el env HF_TOKEN o el cache de
`hf auth login`. Nunca se persiste ni se expone en el proyecto.
"""
from __future__ import annotations

import re

from huggingface_hub import HfApi, get_token
from huggingface_hub.utils import HfHubHTTPError

from hf_down import FileEntry, group_files

API = HfApi()

# Query que es un id de repo exacto (o URL pegada del navegador):
# "author/name", "org/sub/name" o "https://huggingface.co/author/name?flag".
_URL_RE = re.compile(r"^\s*(?:https?://)?huggingface\.co/", re.I)
_ID_RE = re.compile(r"^[\w.-]+(?:/[\w.-]+)+$")


class GatedError(Exception):
    """Repo gated/privado: falta aceptar términos y/o token."""


def _token() -> str | None:
    return get_token()  # HF_TOKEN env o cache local; None si no hay


def _status_of(e: HfHubHTTPError) -> int | None:
    """huggingface_hub no garantiza .status; el estatus real vive en e.response."""
    return getattr(getattr(e, "response", None), "status_code", None) or \
        getattr(e, "status", None)


def _parse_repo_id(query: str) -> str | None:
    """Devuelve el id exacto si el query es un id de repo o una URL pegada."""
    q = query.strip().strip("/")
    q = _URL_RE.sub("", q)
    q = q.split("?", 1)[0].split("#", 1)[0]  # ?not-for-all-audiences=true, etc.
    if "/" in q and _ID_RE.fullmatch(q):
        return q
    return None


def search_models(query: str, limit: int = 20) -> list[dict]:
    """Busca modelos GGUF por texto (nombre/autor), ordenados por descargas.

    Si el query es un id de repo exacto o una URL pegada se resuelve primero
    por id: la busqueda de texto de HF NUNCA encuentra queries con "/"
    (author/name devuelve 0 resultados), asi que sin esto pegar el id completo
    daba "Sin resultados" aunque el repo existiera. Como respaldo se busca
    tambien por el nombre sin autor.
    """
    rid = _parse_repo_id(query)
    out: list[dict] = []
    seen: set[str] = set()

    def add(mid, likes, downloads, pipeline):
        if mid not in seen and len(out) < limit:
            seen.add(mid)
            out.append({
                "id": mid,
                "likes": likes or 0,
                "downloads": downloads or 0,
                "pipeline_tag": pipeline,
            })

    text = query
    if rid is not None:
        try:
            info = API.model_info(rid)
            add(info.modelId, getattr(info, "likes", None),
                getattr(info, "downloads", None), info.pipeline_tag)
        except HfHubHTTPError as e:
            # 401/403 gated o 404 inexistente: seguimos con la busqueda de
            # texto; si el repo es gated el usuario lo vera al abrirlo
            # (repo_files ya responde GatedError con mensaje claro).
            if _status_of(e) not in (401, 403, 404):
                raise
        text = rid.rsplit("/", 1)[-1]

    for m in API.list_models(search=text, filter="gguf",
                             sort="downloads", limit=limit):
        add(m.id, getattr(m, "likes", None), getattr(m, "downloads", None),
            getattr(m, "pipeline_tag", None))
    return out


def repo_files(repo_id: str) -> dict:
    """Lista todos los archivos del repo y los agrupa (reutiliza el core).

    Excluye RepoFolder: list_repo_tree tambien devuelve carpetas y no tienen
    .size; una carpeta listada como archivo se intentaba descargar y el
    resolve URL dava 404 "Entry not found" (p.ej. images/ en un repo).
    """
    try:
        items = API.list_repo_tree(repo_id, repo_type="model", recursive=True)
        files = [FileEntry(i.path, getattr(i, "size", 0) or 0) for i in items
                 if hasattr(i, "size")]  # RepoFile siempre trae .size
    except HfHubHTTPError as e:
        if _status_of(e) in (401, 403):
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
