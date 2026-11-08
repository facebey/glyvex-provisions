# Architecture

> **Language:** [Español](ARCHITECTURE.es.md)

Map of the app: processes, data flows, where state lives, and the contracts
that hold the pieces together.

## The three layers

```
┌────────────────────────────────────────────────────────┐
│ Tauri/Rust shell (web/src-tauri)                       │
│   window + WebView2 + staged splash                    │
│   spawns / reuses the sidecar, reads the port marker   │
└───────────────────────────┬────────────────────────────┘
                            │ stdout: #PORT_ASSIGNED:<port>#
                            │ http://127.0.0.1:<port>/api/*
┌───────────────────────────▼────────────────────────────┐
│ FastAPI sidecar (app/) — PyInstaller onedir, no console│
│   REST + SSE · serves the SPA (StaticFiles)            │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ React/Vite SPA (web/) — same bundle in dev (Vite:8331) │
│   and installed (served by the sidecar)                │
└────────────────────────────────────────────────────────┘
```

- **Shell**: on start it runs a **parallel probe** of the 8321–8330 ladder
  (one thread per port; if several healthy backends answer, the *lowest*
  port wins — same deterministic result as the old sequential version, at
  the cost of one probe). If one is alive it reuses it and **never kills it
  on close**; otherwise it spawns the packaged sidecar, reads the
  `#PORT_ASSIGNED:<port>#` marker from its stdout, redirects the webview to
  that port (production builds only) and shows a staged splash
  ("Starting the local backend…" → "Starting the local service…" → "Service
  ready — connecting…" → "Ready", or "The backend did not start.
  Retrying…"). The spawned sidecar is killed on exit; its stderr is drained
  to `DATA_DIR/logs/sidecar-stderr.log`.
- **Sidecar**: a FastAPI app. It binds 127.0.0.1:8321 with a pre-bound
  socket, falls through the 8321–8330 ladder, then to an OS-assigned port
  (port 0), and prints the marker. It serves the compiled SPA and all the
  `/api/*` endpoints, including `/api/healthz`. Heavy dependencies
  (`huggingface_hub`, `httpx2`, download cores) are imported lazily — this
  is what made 0.2.1 fast (see
  [TROUBLESHOOTING](TROUBLESHOOTING.md) for the startup story).
- **SPA**: one codebase for dev and installed. In dev, Vite on 8331
  (strictPort) proxies to the backend (`PROV_BACKEND_URL`); installed, the
  sidecar serves `web/dist`.

## Backend modules (`app/`)

| Module | Role |
|---|---|
| `main.py` | App factory; `_bind_with_fallback` (ladder + marker); serves the SPA |
| `api.py` | REST + SSE endpoints (healthz, hardware, search, queue, launcher, suite, …) |
| `hardware.py` | GPU via `nvidia-smi`, CPU/RAM via WMI, disks; silent startup |
| `fit.py` | The traffic light: VRAM estimate per GGUF file (weights + KV cache for the chosen context), 80/95% thresholds, regimes `gpu/multi/offload/cpu` |
| `gguf.py` | Real GGUF metadata parsing (the `v2·GGUF` badge) |
| `hfsearch.py` | Hugging Face search (lazy imports; friendly 401/403) |
| `catalog.py` | Built-in catalog (small JSON, cached) |
| `downloads.py` | Resumable byte-level queue: `.part` + sidecar `.meta` (ETag/SHA256), pause/resume/retry, SSE progress |
| `storage.py` | Library and multi-path storage (local disks, NAS, UNC); validated destination |
| `profiles.py` | Multi-server profiles (the light is evaluated against the chosen one) |
| `packages.py` | Scenario model packs (JSON manifests, exact files or globs) |
| `launcher.py` | Model launcher: engine cascade, binary probe, minimal command, session with SSE log |
| `suite.py` | Suite detection and registration over its public API only |
| `paths.py` | The single source for the data dir |
| `settings.py` | User settings persistence |

The download engine itself is the **`hf_down` core** from the companion repo
[facebey/hf-downloader](https://github.com/facebey/hf-downloader)
(pure-Python TUI + library), installed editable and imported lazily.

## Ports and the marker (load-bearing contract)

- Preferred **8321**; ladder **8321 → 8330**; last resort **port 0**
  (OS-assigned). The probe must not set `SO_REUSEADDR` — on Windows that
  makes `bind()` succeed over a live listener and the ladder would not fall.
- The backend prints exactly one marker line, `#PORT_ASSIGNED:<port>#`; the
  shell parses it. Do not break the format.
- The Tauri capabilities allow `http://127.0.0.1:*` (port wildcard) because
  the final port may be OS-assigned.
- `PROV_HOST` / `PROV_PORT` override; `start.ps1` injects
  `PROV_BACKEND_URL` for the Vite proxy.

## Where state lives

- **Data dir** (`app/paths.py`): repo `data/` in dev;
  `%LOCALAPPDATA%\glyvex-provisions\data` when frozen (survives NSIS
  reinstalls); `PROV_DATA_DIR` overrides both. Inside it: library index,
  profiles, `presets.json`, settings, downloads state, `logs/`
  (`sidecar-stderr.log` and friends).
- **App install dir**: per-user (NSIS `currentUser`). Code only — no state
  lives here, so upgrades and reinstalls are non-destructive.

## Updater

Tauri auto-updater, minisign-signed. The shell checks
`https://github.com/facebey/glyvex-provisions/releases/latest/download/latest.json`
(public — the repo is open source), validates the signature, offers
"Update and restart" with download progress, and **stops the local backend
before installing** (custom ACL permission `sidecar-control` authorizes
`stop_sidecar` from the webview). The signing **public** key is versioned;
the private key lives outside the repo (gitignored).

## Network surface (all of it)

1. Hugging Face — search, metadata, downloads.
2. The update feed (GitHub).
3. Outbound calls to `127.0.0.1` / LAN targets the user explicitly launches
  (the Suite API, `llama-server`, Ollama).

No telemetry, nothing else leaves the machine.
