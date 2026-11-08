# Contributing to Glyvex Provisions

> **Language:** [Español](CONTRIBUTING.es.md)

Thanks for wanting to contribute. Here is how the flow works.

## Basic rules

- **Local-first, but the sanctioned network exception**: Provisions is the
  only piece of the Glyvex-AI-Suite stack allowed to touch the internet.
  Outgoing traffic is limited by design to Hugging Face (search, metadata,
  downloads) and the update feed (GitHub). Any new network use must be
  intentional, documented in this doc set, and never add telemetry.
- **The Suite is a black box**: Provisions NEVER writes Suite files. The
  integration is exclusively through the Suite's public HTTP API (see
  `app/suite.py`). If a feature seems to need writing Suite state, it does
  not belong here.
- **Keep startup lazy**: heavy dependencies (`huggingface_hub`, `httpx2`, the
  download cores) are imported lazily on purpose (release 0.2.1 cut
  `import app.main` from 8.45 s to 0.98 s). Do not re-introduce top-level
  imports of those modules in `app/`.
- **One change per PR**: do not mix features + fixes + refactors.
- **Language of the codebase**: intent comments and commit messages in
  Spanish with a conventional prefix, following the repo history.

## Good first contributions (up-for-grabs)

Bounded tasks suitable for entering the project:

- Extend `docs/TROUBLESHOOTING.md` with real cases you solve (keep the
  symptom / what happens / what to do structure).
- Add an automated test suite: there is none yet. `pytest` + `httpx` against
  the FastAPI app (`app/main.py`) with mocked network would be a strong
  first contribution (see `tests/` of the companion projects for the style).
- Document formal Linux/macOS support (Windows is the supported platform
  today; the code is portable in principle).

## Setup

```powershell
# Backend (Python 3.11+) — from the repo root
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
# Download core: clone the companion repo facebey/hf-downloader once, then
.venv\Scripts\pip install -e <path-to-hf-downloader>

# Frontend (Node.js 20 LTS+) — from web/
cd web
npm install
```

Full startup with `start.ps1` (or `start.bat`): it reuses a healthy backend
already running in the 8321–8330 range (or starts one in a visible console),
discovers the assigned port, injects it as `PROV_BACKEND_URL`, and opens the
Vite dev server on 8331 in a visible window plus the browser.

For the desktop shell: `npm run tauri:dev` from `web/` (Tauri starts Vite)
or `npm run tauri:dev:reuse` (reuses an `npm run dev` already on 8331).

## Verification

There is no automated test suite yet. Before proposing a change, run:

```powershell
# Frontend build (tsc + vite), from web/
npm run build

# Rust shell, from web/src-tauri
cargo check

# Live smoke: start.ps1, then
curl.exe http://127.0.0.1:8321/api/healthz
```

A change is not done until you have exercised it in the running app (UI +
live endpoints). If you add a test suite, the live smoke stays mandatory for
anything that touches the Tauri shell or the sidecar lifecycle.

## Git

- Descriptive branches from `main`: `feature/<tema>`, `fix/<tema>`,
  `docs/<tema>`, `release/vX.Y.Z`.
- Commits with a conventional prefix, message in Spanish:
  `feat(lanzador): ...`, `fix(arranque): ...`, `docs: ...`.
- One commit per unit of change; do not mix a feature with unrelated fixes.
- Do not commit runtime state: `data/` (except examples), logs,
  `node_modules`, `target/`, the PyInstaller `packaging/dist` output, and
  the updater's **private** key (`web/src-tauri/updater/` is gitignored;
  only `pubkey.txt` is versioned). See `.gitignore`.

## Conventions

- Comments explain the WHY, not the code, and only when the WHY is not
  obvious.
- The port contract is load-bearing: the backend binds 8321, falls through
  the 8321–8330 ladder, then to an OS-assigned port, and prints
  `#PORT_ASSIGNED:<port>#`. The Rust shell reads that marker. Do not break
  the marker format or the "lowest healthy port wins" rule (the ladder probe
  is parallel: one thread per port).
- Data dir: `app/paths.py` resolves it (repo `data/` in dev,
  `%LOCALAPPDATA%\glyvex-provisions\data` when frozen; `PROV_DATA_DIR`
  overrides both). New persistence goes through it, never a hardcoded path.
- If your change adds user-visible behavior, update the README and the
  relevant `docs/` page in the same PR — **both** the English and Spanish
  versions (they are pairs; each page links to its counterpart).
- `CHANGELOG.md` / `CHANGELOG.es.md` — the maintainer updates them at every
  release.

## Releasing

Semver `mayor.minor.patch`. The version lives in `web/src-tauri/Cargo.toml`
and `web/src-tauri/tauri.conf.json` and must stay equal in both. The
maintainer cuts the tag `vX.Y.Z` on the version-bump commit, builds with
`build.ps1` (NSIS installer + minisign `.sig` + `latest.json`) and publishes
the release with the three assets. Details in the README "Release" section.
