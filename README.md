# Glyvex Provisions

Tool externa de **Glyvex-AI-Suite**: la única pieza del stack que se conecta a
internet (búsqueda y descarga de modelos en Hugging Face). La Suite se queda
100% local; esta tool se instala opcionalmente (o como fase previa, para
provisionar el storage de modelos antes de usar la Suite).

APP local (solo `127.0.0.1`) que detecta tu hardware (GPU + VRAM, RAM, disco),
te muestra qué modelos y cuantizaciones de [Hugging Face](https://huggingface.co)
te funcionan según el régimen que elijas (**solo GPU** / **offload** / **CPU**)
y los descarga a `D:\Downloads\<repo>` con progreso en vivo.

- **Core de descargas**: [`hf-downloader`](../hf-downloader) (editable install;
  `hf_down.py` puro, reutilizable sin dependencias web).
- **Backend**: FastAPI + uvicorn (SSE para progreso).
- **Frontend**: React + Vite + TypeScript (`web/`).
- **Local 100%**: sin telemetría; única red saliente `huggingface.co`.
  Token HF por `HF_TOKEN` o `hf auth login` — nunca se persiste en el proyecto.

Plan y decisiones: [`PLAN.md`](PLAN.md).

## Desarrollo

```powershell
# Backend (venv propio .venv)
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -e D:\Proyectos\hf-downloader
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8321 --reload

# Frontend (web/)
cd web
npm install
npm run dev
```
