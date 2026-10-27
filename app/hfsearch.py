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

    def __init__(self, repo_id: str, status: int | None = None) -> None:
        super().__init__(f"repo gated/privado: {repo_id} (HTTP {status})")
        self.repo_id = repo_id
        self.status = status  # 401 o 403 reales, para afinar el mensaje (U6-5)


def has_token() -> bool:
    """True si hay token visible (HF_TOKEN del proceso o cache `hf auth login`)."""
    return bool(get_token())


class RepoNotFound(Exception):
    """404 de HF: inexistente, privado ajeno o gated sin acceso.

    HF no los distingue a proposito (no quiere filtrar que un repo existe
    pero es privado/gated): con token responde 404 en los tres casos y sin
    token responde 401. Confirmado en vivo 2026-10-27; cualquier sonda
    (model_info/resolve, anonima o con token) da lo mismo para los tres.
    """

    def __init__(self, repo_id: str) -> None:
        super().__init__(f"repo no disponible (404): {repo_id}")
        self.repo_id = repo_id


def classify_http_error(repo_id: str, e: HfHubHTTPError) -> Exception | None:
    """Mapea 401/403/404 de HF a GatedError/RepoNotFound; otro estatus: None.

    Pitfall descubierto en vivo (2026-10-27): con token configurado, HF
    responde **404** (no 401/403) a los repos gated cuyos terminos no fueron
    aceptados con esa cuenta; el 401 anonimo solo aparece sin token. Sin esto,
    todo gated con token subia como RepositoryNotFoundError -> 500.
    El 404 NO es desambiguable (HF lo usa igual para inexistente/privado/
    gated-sin-acceso, ver RepoNotFound): se traduce a RepoNotFound, cuyo
    mensaje cubre los casos con pasos accionables.
    """
    status = _status_of(e)
    if status in (401, 403):
        return GatedError(repo_id, status)
    if status == 404:
        return RepoNotFound(repo_id)
    return None


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
        mapped = classify_http_error(repo_id, e)
        if mapped is not None:
            raise mapped from e
        raise
    return {
        "repo_id": repo_id,
        "files": [{"path": f.path, "size": f.size, "ext": f.ext} for f in files],
        "groups": [
            {"kind": g.kind, "name": g.name, "files": [f.path for f in g.files]}
            for g in group_files(files)
        ],
    }


def friendly_message(repo_id: str, status: int | None) -> str:
    """Mensaje accionable para 401/403 (U6-5: '401 amigable').

    Distingue los dos casos reales que ve el usuario:
      - sin token visible: falta definir HF_TOKEN o `hf auth login`
        (y avisar que el token solo se ve tras reiniciar el backend, porque
        las env vars de Windows son snapshot al arrancar el proceso — §7.13);
      - con token: el token existe pero no tiene acceso al repo (términos
        sin aceptar, repo privado, o token de otra cuenta).
    Nunca muestra el valor del token.
    """
    head = (f"El repositorio {repo_id} es gated o privado y tu acceso no está "
            "habilitado")
    if status == 404:  # HF no distingue inexistente/privado/gated-sin-acceso
        return (f"No se pudo abrir el repositorio {repo_id}. Hugging Face "
                "responde 404 en tres casos: el id no existe (o fue "
                "borrado/renombrado), es un repo privado que tu token no ve, "
                "o es gated y sus términos no fueron aceptados con tu cuenta. "
                "Pasos: 1) verifica el id exacto author/name (tal cual aparece "
                "en la URL); 2) ábrelo manualmente en huggingface.co/" + repo_id +
                " con tu cuenta: si pide aceptar términos, hazlo; 3) si no "
                "tienes token, define HF_TOKEN o ejecuta `hf auth login` y "
                "reinicia el backend (el token se lee solo al arrancar el "
                "proceso).")
    if not has_token():
        return (head + ". Pasos: 1) abre huggingface.co/" + repo_id +
                " y acepta los términos si el repo los tiene; 2) configura tu "
                "token de Hugging Face (HF_TOKEN o `hf auth login`); 3) reinicia "
                "el backend (Abrir Provisions de nuevo), porque el token se lee "
                "solo al arrancar el proceso.")
    return (head + ". Tu token está configurado pero este repo no lo autoriza. "
            "Pasos: 1) abre huggingface.co/" + repo_id +
            " con la cuenta de ese token y acepta los términos (o comparte el "
            "repo); 2) si el token se configuró DESPUÉS de abrir Provisions, "
            "reinicia el backend: el token se lee solo al arrancar el proceso.")
