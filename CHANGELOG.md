# Changelog

> **Language:** [Español](CHANGELOG.es.md)

All notable changes to Glyvex Provisions. The installer's SHA256 and size are published in each [release](https://github.com/facebey/glyvex-provisions/releases).

## [0.2.1] — 2026-11-08

Performance release: **the app starts up to 82% faster** (22.7 s → 4.0 s measured on a real machine, including its local network anomaly). No changes to the traffic light, downloads, profiles or launcher.

### Added

- **Staged splash screen**: the splash shows the real startup progress ("Starting the local backend…" → "Starting the local service…" → "Service ready — connecting…" → "Ready"); if the backend fails it shows "The backend did not start. Retrying…".

### Changed

- **Parallel port probe (U19)**: the 8321–8330 ladder check runs one thread per port instead of ten in a row (on machines with a slow TCP stack this used to cost ~20 s); the lowest healthy port still wins — same deterministic result.
- **Fine-grained startup poll (U20)**: once the port marker arrives from the backend, the wait loop drops from 1 s to 250 ms.
- **Lazy import of the network stack (U23)**: `huggingface_hub`, `httpx2` and the download cores load only when you actually search, download or probe. `import app.main`: 8.45 s → 0.98 s (−88%); the sidecar starts without any of those dependencies in memory.

## [0.2.0] — 2026-11-04

Feature release: **model launcher** (launch a GGUF with one click from Provisions, with Glyvex-AI-Suite ecosystem integration) and **presets + vision** in the launcher.

### Added

- **Model launcher (U15)**: pick the engine (Suite managed runtime → own `llama-server` binary → Ollama, configurable), the model/file from the Provisions library (or a manual path), and the profile (`gpu` / `multi` / `offload` / `cpu` with per-regime `-ngl` and `--tensor-split` on multi-GPU). Launch, verify and stop the server from the app: live log, TTFB, tok/s and VRAM snapshot.
- **Glyvex-AI-Suite integration**: when the Suite is detected, "Register in the Suite" (the Suite persists it through its public API, with confirmation) and "Open the Suite". Without the Suite the server launches and is managed the same way.
- **Presets (U16)**: saveable launch configurations per scenario (chat / vision / offload) in `data/presets.json`. A preset describes HOW to launch, never which model; CRUD from the UI.
- **Vision + advanced args (U16)**: `--mmproj` from the model library (or manual path) and free-form `extra_args`; guards reject a non-existent mmproj and Ollama rejects external mmproj (422).
- **`--list-devices` on binary probe (U16)**: device inventory + acceleration backend (CUDA/Vulkan/ROCm/SYCL/CPU) with a warning when only CPU is available.

## [0.1.3] — 2026-11-02

### Changed

- **New app icon** ("arrow into tray" glyph) — the old hexagon-node looked too close to the Suite's cube. Favicons regenerated.
- **Brand lockups**: the header and the splash use the glyph cropped to the stroke; the 8 NSIS bitmaps (light/dark) were regenerated from a versioned generator script.

## [0.1.2] — 2026-10-30

### Fixed

- **In-app auto-update ACL fix**: in Tauri v2 every IPC command passes the window's ACL check, including commands defined by the app itself. "Update and restart" failed with `Command stop_sidecar not allowed by ACL`. Added the custom permission `sidecar-control`. **0.1.2 is the first truly self-updatable release** — earlier versions can check the feed but need a manual reinstall.

## [0.1.1] — 2026-10-30

### Added

- **Provisions' own NSIS sidebar and header** (atom isotype, brand gradient, "IA local, sin nube") replacing the generic assets inherited from the Suite (light/dark variants).
- **In-app auto-update enabled**: the app checks `releases/latest/download/latest.json`, validates the minisign signature and offers "Update and restart" with download progress; it stops the local backend before installing so the installer never hits locked files.
- Repo made **public** (Apache-2.0): the update feed is accessible without a token. The 0.1.0 → 0.1.1 flow is the updater's E2E proof on a real machine.

## [0.1.0] — 2026-10-30

First installable version (closes Phase 2).

### Added

- **Local hardware detection**: GPU via `nvidia-smi`, CPU/RAM via WMI, disks. Silent startup: no child console windows.
- **Per-file quantization traffic light**: VRAM consumption estimated from real GGUF metadata (weights + KV cache for the chosen context), adjustable 80/95% thresholds and context, regimes `gpu` / `multi` / `offload` / `cpu`.
- **Hugging Face GGUF search**: complete file table per repo (quants, `mmproj`, configs), friendly 401/403 messages for gated repos, and a validated eligible destination folder.
- **Byte-level resumable download queue**: `.part` + sidecar `.meta` (ETag/SHA256), pause/resume/retry, live progress via SSE.
- **Multi-server profiles** and **multi-path storage** (local disks, NAS, UNC); the traffic light is evaluated against the profile you choose.
- **Tauri desktop app** with a branded startup splash and a **NSIS installer** with Glyvex-AI-Suite's visual identity (language selector, branded uninstaller).
- User data survives reinstalls: `%LOCALAPPDATA%\glyvex-provisions\data`.
