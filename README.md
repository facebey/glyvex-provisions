# Glyvex Provisions

> **Language:** [Español](README.es.md)

**Glyvex Provisions** is an external companion tool of [Glyvex-AI-Suite](https://ai-suite.glyvexgroup.com/) — the only piece of the Glyvex stack that connects to the internet. Its job is to **provision your local model storage**: search Hugging Face GGUF repos, show a clear traffic light for every file against the hardware you actually have, and download them with byte-level resumable downloads. Glyvex-AI-Suite itself stays 100% local; Provisions is what you run **before** (or alongside) it to bring the models in. It installs optionally, as part of the Suite workflow or as a standalone tool.

Everything runs on your machine (the app serves only on `127.0.0.1`). No telemetry, no cloud: the only outbound network is `huggingface.co`.

## Download / Install

- **Windows x64**: get the latest installer from [Releases](https://github.com/facebey/glyvex-provisions/releases) — `Glyvex.Provisions_<version>_x64-setup.exe`. Per-user install (no administrator needed); you choose the install folder.
- User data lives in `%LOCALAPPDATA%\glyvex-provisions\data` and survives reinstalls.
- **Auto-update**: releases ship a signed `latest.json` (Tauri updater + minisign signature); the app checks it and offers the update in-app. You can also check manually at any time from the footer's About dialog (© 2026 Glyvex → "Check for updates").
- SHA256 of each installer is published in the release notes.

## Features

- **Hardware detection**: GPU + VRAM via `nvidia-smi`, CPU/RAM via WMI, disks — plus manual multi-server profiles when your models target another machine.
- **Traffic light per file**: consumption estimated from the file's real GGUF metadata (model weights + KV cache for your chosen context length), thresholds 80/95% and safety margin adjustable; regimes `gpu` / `multi` / `offload` / `cpu` mapped to your hardware.
- **Hugging Face search**: complete file table for each repo (quants, `mmproj`, configs, model card), friendly messages for gated repos (401/403), and an eligible destination folder (validated).
- **Resumable downloads**: `.part` files with sidecar metadata (ETag/SHA256), byte-level resume, pause/retry, live progress via SSE.
- **Multi-path storage**: local disks, NAS or UNC paths; downloads and the traffic light are evaluated against the storage profile you choose.
- **Model packs per scenario**: plain-JSON manifests (exact files or glob patterns), copyable between machines — one action downloads a whole scenario.
- **Model launcher (0.2.0)**: launch any GGUF from your library with one click. Engine cascade (Glyvex-AI-Suite managed runtime → your own `llama-server` → Ollama), a launch profile per regime (`gpu` / `multi` / `offload` / `cpu` with per-regime `-ngl`, `--tensor-split` on multi-GPU), live server log, TTFB, tok/s and a VRAM snapshot while running.
- **Glyvex-AI-Suite integration**: when the Suite is detected on the machine, register the launched server in the Suite (through its public API, with confirmation) and open the Suite with one click; without the Suite the launcher works standalone.
- **Presets and vision (0.2.0)**: saveable launch presets per scenario (chat / vision / offload), `--mmproj` for vision models, free-form extra arguments, and a device inventory with the acceleration backend (CUDA/Vulkan/ROCm/SYCL/CPU).
- **Fast startup (0.2.1)**: parallel port probing and lazy loading of the whole network stack — double-click to usable UI in ~4 s on a machine with a slow TCP stack (22.7 s before the fix) and ~1.5–2 s on a healthy one.
- **Web links and manual updates (0.2.2)**: the header title opens the Glyvex-AI-Suite site, and the footer's About dialog shows the current version with links to the site / group / GitHub plus a manual "Check for updates" — the same signed update flow as the banner, on demand.
- **Built on `hf-downloader`**: a small pure-Python core (TUI + library, no web dependencies) reused as the download engine. *(companion repo [facebey/hf-downloader](https://github.com/facebey/hf-downloader), private for now — opening it is on the roadmap)*

## Privacy

- Server bound to `127.0.0.1` only; single user, no auth, no telemetry.
- Hugging Face token is read from `HF_TOKEN` or `hf auth login` — never persisted in the project, never shown in the UI.

## Development

```powershell
# Backend (own venv: .venv)
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
# Download core (companion repo facebey/hf-downloader — clone it once):
.venv\Scripts\pip install -e <path-to-hf-downloader>
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8321 --reload

# Frontend (web/)
cd web
npm install
npm run dev
```

Or just run `start.ps1` / `start.bat` at the repo root: it reuses a live backend or starts one in a visible window, discovers the port (8321 → 8322…8330 ladder), and opens the UI at `http://127.0.0.1:8331`.

## Production build (Windows installer)

`build.ps1` at the root runs the full pipeline:

1. `npm run build` → `web/dist` (SPA).
2. PyInstaller → `packaging/dist/provisions-backend/` (onedir FastAPI sidecar; embeds the SPA as `_internal/web-dist` and serves it itself).
3. Junction `web/src-tauri/resources/provisions-backend` → the sidecar dist.
4. `tauri build` → **NSIS** installer + signed updater artifacts (`web/src-tauri/target/release/bundle/nsis/`).

The installed app spawns the sidecar on open (reusing one already live on the 8321…8330 ladder) and points the webview to the real port; it dies when the window closes. Updater signing keys live in `web/src-tauri/updater/` (`private.key` + `password.txt`, gitignored — losing them invalidates signed updates; the public key is embedded in `tauri.conf.json`).

`tauri:dev` (Tauri starts Vite) and `tauri:dev:reuse` (reuses an `npm run dev` already running on 8331) for developing inside the shell.

## Documentation

| Where to go | What you will find |
|---|---|
| [README](README.md) | The full picture: features, installation, development and release. |
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md) | The shortest path: install, first run, storage, first download, first launch. |
| [`docs/LAUNCHER.md`](docs/LAUNCHER.md) | The model launcher: engines, profiles, presets, vision and Suite integration. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Map of the app: Tauri shell, FastAPI sidecar, port ladder, persistence and updater. |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Common problems and how to solve them. |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in every release. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute: setup, branches, commits and conventions. |
| [`SECURITY.md`](SECURITY.md) | Security policy and how to report a vulnerability. |

All docs are available in English and Spanish — each page links to its counterpart.

## License

[Apache-2.0](LICENSE) — Copyright 2026 Glyvex Group.

Design and decisions live in [`PLAN.md`](PLAN.md) (Spanish).
