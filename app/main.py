"""model-pilot — FastAPI backend (fase 0: esqueleto).

Solo se sirve en 127.0.0.1 (uvicorn --host 127.0.0.1). Sin telemetría;
única red saliente: huggingface.co (vía el core hf-downloader).
"""
from fastapi import FastAPI

app = FastAPI(
    title="model-pilot",
    version="0.0.1",
    description="Detecta tu hardware y te sugiere/descarga modelos GGUF de Hugging Face.",
)


@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, str]:
    return {"app": "model-pilot", "docs": "/docs"}
