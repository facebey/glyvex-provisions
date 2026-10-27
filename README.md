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

## Producción (instalador Windows, U7)

`build.ps1` en la raíz ejecuta el pipeline completo:

1. `npm run build` → `web/dist` (SPA).
2. PyInstaller → `packaging/dist/provisions-backend/` (sidecar FastAPI onedir;
   empaqueta el SPA como `_internal/web-dist` y lo sirve él mismo).
3. Junction `web/src-tauri/resources/provisions-backend` → el dist del sidecar.
4. `tauri build` → instalador **NSIS** + artefacts del updater firmados
   (`web/src-tauri/target/release/bundle/nsis/`).

La app instalada levanta el sidecar al abrir (reutiliza uno ya vivo en la
escalera 8321…8330) y la webview se redirige al puerto real; muere al cerrar
la ventana. Datos de usuario en `%LOCALAPPDATA%\glyvex-provisions\data`
(sobreviven a reinstalaciones). Deps de empaquetado (solo build-time):
PyInstaller en el `.venv` + `@tauri-apps/cli` (devDep) + Rust/cargo.

Firma del updater: `web/src-tauri/updater/` (`private.key` + `password.txt`,
gitignored — perderlos invalida las updates firmadas; la pública va embebida en
`tauri.conf.json`).

`tauri:dev` (Vite lo levanta Tauri) y `tauri:dev:reuse` (usa el `npm run dev`
que ya tengas en 8331) para desarrollar dentro de la shell.
