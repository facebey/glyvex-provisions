"""Glyvex Provisions — FastAPI backend (fase 1: MVP).

Solo se sirve en 127.0.0.1. Sin telemetría; única red saliente:
huggingface.co (búsqueda, listado y descargas).

Arranque: `.venv\\Scripts\\python -m app.main` (o uvicorn app.main:app --port 8321).
El puerto preferido es 8321; si está ocupado cae a la escalera de vecinos
(patrón de Glyvex-AI-Suite, T4.5) y reporta el puerto final con el marcador
`#PORT_ASSIGNED:<puerto>#` que leerá la shell Tauri (unidad 7).
"""
from __future__ import annotations

import os
import socket

from fastapi import FastAPI

from .api import router as api_router

app = FastAPI(
    title="Glyvex Provisions",
    version="0.1.0",
    description="Detecta tu hardware y te sugiere/descarga modelos GGUF de Hugging Face.",
)
app.include_router(api_router)


@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, str]:
    return {"app": "glyvex-provisions", "docs": "/docs"}


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


if __name__ == "__main__":
    import uvicorn

    # 127.0.0.1 por defecto (app local, sin autenticación); PROV_HOST y
    # PROV_PORT lo sobreescriben (mismo contrato que GLYVEX_HOST/GLYVEX_PORT
    # de la Suite).
    host = os.environ.get("PROV_HOST", "127.0.0.1")
    port = int(os.environ.get("PROV_PORT", "8321"))
    sock, port = _bind_with_fallback(host, port)
    # Marker para el orquestador (shell Tauri, unidad 7): línea limpia con
    # el puerto final, el SO ya lo confirmó vía bind.
    print(f"#PORT_ASSIGNED:{port}#", flush=True)
    uvicorn.Server(uvicorn.Config(app, loop="asyncio")).run(sockets=[sock])
