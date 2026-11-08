# Quickstart

> **Language:** [Español](QUICKSTART.es.md)

The shortest way to get Glyvex Provisions running on your machine. The
[README](../README.md) has the full detail;
[LAUNCHER.md](LAUNCHER.md) covers the model launcher in depth.

> **Just want to use it on Windows?** None of this is needed: download the
> installer `Glyvex Provisions_<version>_x64-setup.exe` from
> [Releases → latest](https://github.com/facebey/glyvex-provisions/releases/latest),
> run it and follow the wizard (per-user install, no admin). If the app
> offers you an update banner, "Update and restart" handles the rest.
> This guide is for running it from source.

## Prerequisites

- **Windows** (the supported platform; x64).
- **Python 3.11+**
- **Node.js 20 LTS+** (Vite/React frontend)
- **Rust** (only for the Tauri shell; the backend + Vite dev flow work
  without it)
- The **`hf-downloader`** companion repo (the download core): clone
  [facebey/hf-downloader](https://github.com/facebey/hf-downloader) once
  anywhere on your machine.

## Setup

```powershell
git clone https://github.com/facebey/glyvex-provisions
cd glyvex-provisions

# Backend (own venv: .venv)
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -e <path-to-hf-downloader>

# Frontend
cd web
npm install
cd ..
```

## First run

```powershell
start.bat
```

`start.ps1` (wrapped by `start.bat`) reuses a healthy backend already
running in 8321–8330 or starts one in a visible console, discovers the
assigned port, and opens the UI (Vite on 8331) in your browser. Expected:
`http://127.0.0.1:8331` up in a few seconds, and
`http://127.0.0.1:8321/api/healthz` answering 200.

For the desktop app instead: `cd web` and `npm run tauri:dev` (branded
splash, the app takes the backend from the same ladder).

## First download

1. The **Hardware** panel shows your GPU/CPU/RAM/disks — pick a server
   profile if you have several.
2. **Search**: type a Hugging Face repo name (e.g. an official `*GGUF`
   repo). The full file table appears (quants, `mmproj`, configs).
   Gated repos answer with a friendly 401/403 message — see
   [TROUBLESHOOTING](TROUBLESHOOTING.md).
3. **Destination folder**: pick a writable local disk, NAS or UNC path
   (validated; the folder must exist).
4. Select files and **queue the download**: byte-level resumable, with
   pause/resume/retry and live progress.

The downloaded files become your **library** — the traffic light
(green/yellow/red per quantization vs. your VRAM) is evaluated against them.

## First launch (0.2.0+)

In the **Model launcher** panel: pick an engine (Suite managed runtime →
your own `llama-server` → Ollama), the model file from the library, and a
profile (`gpu` / `multi` / `offload` / `cpu`). Launch: the app verifies the
server (health → models → a streaming ping with TTFB and tok/s) and shows
the live log. If the Suite is on the machine you can also register the
server in it and open the Suite. Full detail in [LAUNCHER.md](LAUNCHER.md).

## Where things live

- **Data dir** (library, profiles, presets, settings, logs):
  `%LOCALAPPDATA%\glyvex-provisions\data` when installed; the repo `data/`
  in dev. It survives reinstalls. `PROV_DATA_DIR` overrides it.
- **App**: the NSIS default is a per-user folder (on this family's machines,
  `D:\Glyvex Provisions`).
