# Model launcher

> **Language:** [Español](LAUNCHER.es.md)

The launcher (0.2.0+) starts any GGUF in your Provisions library with one
click — and it is the piece that joins Provisions with
[Glyvex-AI-Suite](https://github.com/facebey/Glyvex-Group-AI-Suite-Open-Source).
It is deliberately not a generic launcher: the launch command is minimal on
purpose, the advanced options live in the Suite, and the structured
configuration lives in the presets.

## Engines (cascade)

The launcher resolves an engine in this order, and you can pin any of them:

1. **Glyvex-AI-Suite managed runtime** — when the Suite is detected on the
   machine, Provisions reuses the Suite's own tested `llama-server` binary
   (located by a GLOB of the version pin in the Suite's data dir — never
   hardcoded).
2. **Your own `llama-server`** — a manual path to any llama.cpp binary; the
   launcher probes it (`--help`, `--version`, `--list-devices`) and drops
   the flags the build does not know, so old builds keep working.
3. **Ollama** — the model is pulled into Ollama (Modelfile from the GGUF,
   `create`, then `/api/chat` with `keep_alive -1`).

The probe also reports the **device inventory** with the acceleration
backend (CUDA/Vulkan/ROCm/SYCL/CPU) and warns when only CPU is available.

## Profiles

One profile per regime, matching the traffic light:

| Profile | When | What it does |
|---|---|---|
| `gpu` | green on a single GPU | full offload (`-ngl` high) |
| `multi` | several GPUs, sum of VRAM fits | `-ngl` high + `--tensor-split` across the GPUs |
| `offload` | partially fits | a `-ngl` middle ground (CPU+GPU) |
| `cpu` | nothing fits | pure CPU |

The launch command stays minimal: `-m -c -ngl -host -port`
(+ `--tensor-split` in `multi`, + `--mmproj` for vision). If a launch fails,
the cause is unambiguous — "it does not fit", not "a flag was wrong".

## Vision and advanced arguments

- **Vision**: attach an `mmproj` file from the model library (or a manual
  path). Guards reject a non-existent file; Ollama rejects external mmproj
  (422).
- **Extra arguments**: free-form `extra_args` for the rare cases that need
  something the profiles do not cover.

## Presets

`data/presets.json` stores named launch configurations per scenario
(chat / vision / offload). A preset describes **how** to launch — engine,
profile, context, mmproj, extra args — and **never which model**, so the
same preset applies to any file in the library. Full CRUD from the UI.

## Suite integration

When the Suite is detected (its public API answers):

- **"Register in the Suite"** — an explicit, confirmed action (a cross-app
  action is never automatic): the Suite persists the model through its
  public API and shows it in its Launcher without a rescan.
- **"Open the Suite"** — opens it on the spot.

Hard rule: **Provisions never writes Suite files.** All integration is over
the Suite's public HTTP API; the only filesystem contact is *reading* the
Suite's managed runtime binary. Without the Suite, the launcher works
standalone: launch, verify, keep the server running (other machines on your
network can use its port) or stop it.

## Verification and session

One session at a time. After launch the app verifies the server — health
endpoint → `/v1/models` → a streaming chat ping — and shows **TTFB, tok/s
and a VRAM snapshot**, plus the live server log streamed in the panel.
