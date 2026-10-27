"""Glyvex Provisions — FastAPI backend (fase 1: MVP).

Solo se sirve en 127.0.0.1. Sin telemetría; única red saliente:
huggingface.co (búsqueda, listado y descargas).

Arranque: `.venv\\Scripts\\python -m app.main` (o uvicorn app.main:app --port 8321).
El puerto preferido es 8321; si está ocupado cae a la escalera de vecinos
(patrón de Glyvex-AI-Suite, T4.5) y reporta el puerto final con el marcador
`#PORT_ASSIGNED:<puerto>#` que lee la shell Tauri (unidad 7).

U7 (espejo de la Suite): si existe el SPA pre-construido (`web/dist` en dev,
`_internal/web-dist` en el bundle PyInstaller), el backend lo sirve también —
la webview de Tauri se redirige aquí tras detectar el marcador. `main()` es
invocable desde el entry del sidecar empaquetado (packaging/entry.py).
"""
from __future__ import annotations

import os
import socket

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from . import hfsearch, paths
from .api import router as api_router

app = FastAPI(
    title="Glyvex Provisions",
    version="0.1.0",
    description="Detecta tu hardware y te sugiere/descarga modelos GGUF de Hugging Face.",
)
app.include_router(api_router)


# Traductores globales (U6-5 + pitfall 404-con-token): cualquier endpoint
# (tabla, cola, paquetes) que deje subir un error de acceso de HF lo ve aqui
# y responde el mensaje accionable, sin 500 crudo.
@app.exception_handler(hfsearch.GatedError)
async def _gated_handler(_, exc: hfsearch.GatedError) -> JSONResponse:
    return JSONResponse({"detail": hfsearch.friendly_message(exc.repo_id, exc.status)},
                        status_code=403)


@app.exception_handler(hfsearch.RepoNotFound)
async def _notfound_handler(_, exc: hfsearch.RepoNotFound) -> JSONResponse:
    return JSONResponse({"detail": hfsearch.friendly_message(exc.repo_id, 404)},
                        status_code=404)


@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _spa_index() -> "FileResponse | None":
    """index.html del SPA pre-construido, si existe (U7: el backend sirve la UI)."""
    index = paths.WEB_DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return None


@app.get("/")
def root():
    # Con el SPA construido (build de producción o `npm run build` en dev),
    # "/" sirve la UI: la webview de Tauri se redirige al origen del backend
    # y el navegador normal puede abrir la app sin Vite. Sin SPA: JSON.
    spa = _spa_index()
    if spa is not None:
        return spa
    return {"app": "glyvex-provisions", "docs": "/docs"}


# El mount va DESPUES de todas las rutas: /api/* y "/" explícitas ganan;
# el mount solo resuelve /assets/*, iconos y demas estaticos del SPA.
if paths.WEB_DIST.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(paths.WEB_DIST), html=True), name="spa")


def _bind_with_fallback(host: str, preferred: int) -> tuple[socket.socket, int]:
    """Bind de `preferred` con escalera de vecinos (patrón de la Suite):
    el puerto pedido, luego +1…+9 y, si todo falla, uno libre asignado por
    el SO (puerto 0). Devuelve (socket YA bound, puerto final): uvicorn
    hereda el socket, sin ventana entre bind y re-bind en que otro proceso
    pudiera ocuparlo. Con `preferred == 0` se pide directo al SO."""
    candidates = [preferred] if preferred else [0]
    candidates += [p for p in range(preferred + 1, preferred + 10)]
    last_err: OSError | None = None
    for candidate in candidates:
        # Sin SO_REUSEADDR: en Windows ese flag hace que bind() EXITA sobre un
        # puerto con un listener vivo (compartir en vez de fallar) y la escalera
        # no caería. Sin el flag, un puerto ocupado da EADDRINUSE y se prueba el
        # siguiente candidato. (Windows no necesita SO_REUSEADDR para rebindear
        # tras un cierre; la escalera cubre ese caso igual.)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, candidate))
            return s, s.getsockname()[1]
        except OSError as err:
            last_err = err
            s.close()
    raise last_err  # type: ignore[misc]


def main() -> None:
    """Arranque del sidecar: resuelve host/puerto, emite el marcador y corre
    uvicorn heredando el socket ya-bound. Llamado desde `python -m app.main`
    (dev) y desde el entry del bundle PyInstaller (packaging/entry.py)."""
    import uvicorn

    # 127.0.0.1 por defecto (app local, sin autenticación); PROV_HOST y
    # PROV_PORT lo sobreescriben (mismo contrato que GLYVEX_HOST/GLYVEX_PORT
    # de la Suite).
    host = os.environ.get("PROV_HOST", "127.0.0.1")
    port = int(os.environ.get("PROV_PORT", "8321"))
    sock, port = _bind_with_fallback(host, port)
    # Marker para el orquestador (shell Tauri): línea limpia con el puerto
    # final, el SO ya lo confirmó vía bind.
    print(f"#PORT_ASSIGNED:{port}#", flush=True)
    uvicorn.Server(uvicorn.Config(app, loop="asyncio")).run(sockets=[sock])


if __name__ == "__main__":
    main()
