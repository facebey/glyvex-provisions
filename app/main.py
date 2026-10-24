"""model-pilot — FastAPI backend (fase 1: MVP).

Solo se sirve en 127.0.0.1 (uvicorn --host 127.0.0.1). Sin telemetría;
única red saliente: huggingface.co (búsqueda, listado y descargas).
"""
from fastapi import FastAPI

from .api import router as api_router

app = FastAPI(
    title="model-pilot",
    version="0.1.0",
    description="Detecta tu hardware y te sugiere/descarga modelos GGUF de Hugging Face.",
)
app.include_router(api_router)


@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, str]:
    return {"app": "model-pilot", "docs": "/docs"}
