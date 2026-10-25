# Plan — Glyvex Provisions (tool externa de Glyvex-AI-Suite; ex model-pilot)

> Borrador de decisión (2026-10-24). Propósito: elegir stack y arquitectura de la APP
> que envolverá `hf-downloader` como core de descarga.

## 1. Qué debe hacer (requisitos)

| # | Requisito | Nota |
|---|---|---|
| R1 | Detectar hardware local: GPU (modelo + VRAM), RAM, CPU, espacio en disco | Windows primero (RTX 3090 de Fabian); AMD/Intel GPU en v2 |
| R2 | Regímenes a elegir por el usuario: **solo GPU** / **offload (CPU+GPU)** / CPU | Opciones del usuario, no autómáticas |
| R3 | Buscar/listar modelos GGUF de Hugging Face | API pública de HF (search + files) |
| R4 | Tabla de cuantizaciones **por archivo** (no agrupada) con semáforo de compatibilidad: verde entra / naranja justo / rojo no entra | Referencia de UX: panel "Hardware compatibility" de huggingface.co |
| R5 | Descargar la selección a `D:\Downloads\<repo>` reanudable y paralela | Reutiliza el core de `hf-downloader` (allow_patterns, Xet, fallback LFS) |
| R6 | Progreso en vivo por archivo | SSE (o WebSocket) desde el callback de tqdm de huggingface_hub |
| R7 | Repos gated: token por `HF_TOKEN` o `hf auth login` | Nunca se escribe en archivos del proyecto |
| R8 | **Local 100%**: servidor solo en `127.0.0.1`, sin telemetría | Única salidas de red: `huggingface.co` + consultas locales de hardware |
| R9 | Librería local: escanear los **paths de storage** (múltiples, recursivo, incluye subcarpetas) para ver qué modelos ya hay | v2 |
| R10 | **Hardware multi-servidor**: además de detectar el local, el usuario **agrega servers manualmente** (GPU modelo + VRAM, RAM); el semáforo se calcula contra el perfil elegido | Glyvex Provisions es una tool para varios servers con hardware distinto (Fabian, 2026-10-25) |
| R11 | **Storage configurable**: el usuario agrega paths (disco local, NAS, UNC, server Linux, etc.) = destino de descargas + base de la librería | Lo más sencillo que se adapte al usuario/empresa: cualquier ruta, sin asumir el tipo de server |
| R12 | **Paquetes**: conjuntos de modelos ya probados por escenario/uso (manifiesto + notas), exportables | Parte de la Fase 2 (decisión Fabian, 2026-10-25) |

## 2. Qué queda como está (no se toca)

- `hf_down.py` sigue siendo una librería pura (sin deps web): `parse_repo_input`,
  `list_files`, `group_files`, `resolve_direct`, `run_download`.
- El core se consume por **editable install**: `pip install -e ../hf-downloader`
  (requisito: agregarle `pyproject.toml` pequeño al repo — cambio mínimo con su GO).

## 3. Componentes nuevos de la APP

| Módulo | Qué hace | Herramientas candidatas |
|---|---|---|
| `hardware.py` | Detección GPU/RAM/CPU/disco | `nvidia-smi` por subprocess o `pynvml` (NVIDIA); `psutil` (RAM/CPU); `shutil.disk_usage` |
| `fit.py` | Estimación VRAM/RAM + colores verde/naranja/rojo | v1: tamaño de archivos + margen fijo; v2: leer metadatos del GGUF (lib `gguf`) para estimar KV cache según contexto elegido |
| `downloads.py` | Cola de descargas + progreso | `snapshot_download` + `tqdm_callback` → cola → SSE |
| `api.py` | Endpoints REST + SSE | FastAPI |
| Frontend | UI | Ver opciones abajo |

### Estimación v1 (simple, ajustable)
- `VRAM_necesaria ≈ total_peso * 1.05` (margen fijo ~5% por KV cache/overhead).
- Umbrales (ajustables en ajustes): verde ≤ 80% VRAM · naranja ≤ 95% · rojo > 95%.
- Regímenes: **solo GPU** → compara contra VRAM; **offload** → compara contra RAM
  disponible (el modelo vive en RAM, capas en GPU); **CPU** → RAM.

### Estimación v2 (precisa)
- Parsear cabecera GGUF (`gguf` pip): layers, kv_heads, head_dim, dtype →
  KV cache = `2 * layers * kv_heads * head_dim * ctx * bytes_dtype`.
- Usuario elige contexto (4k/8k/32k) y la cifra se recalcula.

## 4. Opciones de stack

### A) FastAPI + React (Vite + TypeScript) — *recomendada si se quiere UI de producto*
- Backend: FastAPI + uvicorn (127.0.0.1), SSE para progreso.
- Frontend: React 18 + Vite + TS; TanStack Query para datos; CSS propio o Tailwind.
- Toolchain: **Node.js 20 LTS nuevo** (`winget install OpenJS.NodeJS.LTS`) + Python.
- ✅ Estándar de la industria, ecosistema enorme; UI densa (tablas, semáforos,
  gauges, cola) queda elegante; fácil de extender (ajustes, librería, multi-GPU).
- ⚠️ Dos toolchains (Python + Node); ~1 día extra de scaffold.

### B) FastAPI + HTMX — *la opción 100% Python*
- Mismo backend; frontend = Jinja + HTMX (SSE nativo) + algo de JS vanilla.
- ✅ Cero Node, un solo proceso, scaffold en horas; trivial de arrancar por `.bat`.
- ⚠️ Menos expresiva para UI rica (estado complejo, animaciones); se topan los
  límites cuando la APP crece (librería, ajustes, multi-descargas).

### C) Electron + React — *ventana desktop "de verdad"*
- ✅ Look nativo, tray, dialogs.
- ⚠️ Pesado (100+ MB), requiere Node igual que A, packaging/autoupdate dolor.
  Overkill para esta fase.

### D) Tauri + React (Python como sidecar) — *desktop ligero*
- ✅ Binario chico, shell nativa.
- ⚠️ Toolchain de Rust + management de sidecar = mayor complejidad de A sin ganancia clara hoy.

### E) Gradio — *prototipo en un día*
- ✅ Rapidísimo para validar la estimación VRAM.
- ⚠️ UX limitada, difícil de convertir en "la APP" (se reescribe después).

### F) Next.js — descartada
- SSR/noise extra sin beneficio para una app de escritorio local de un usuario.

### Cuadro resumido

| | Node | Velocidad MVP | UI rica | Extensibilidad | Peso |
|---|---|---|---|---|---|
| **A: FastAPI+React** | sí | días | alta | alta | medio |
| **B: FastAPI+HTMX** | no | horas | media | media | bajo |
| C: Electron | sí | semanas | alta | alta | alto |
| D: Tauri | sí (+Rust) | semanas | alta | alta | medio |
| E: Gradio | no | horas | baja | baja | bajo |

**Recomendación: A (FastAPI + React)** — la UI planeada (panel de hardware,
semáforos por cuantización, cola con progreso) es exactamente donde React rinde,
y el único coste real es instalar Node una vez. **B** es la alternativa sólida
si Fabian prefiere mantenerse 100% Python y arrancar el MVP en horas.

## 5. Seguridad (reglas duras)

- Servidor **solo en 127.0.0.1** (uvicorn `--host 127.0.0.1`); sin auth local (1 usuario).
- Token HF: `HF_TOKEN` o login del propio huggingface_hub; **nunca** en archivos de la APP.
- Unica red saliente: `huggingface.co`. Sin telemetría, sin analytics, sin CDN.
- **Auditar cada dep nueva** (telemetría/red) antes de `pip install`/`npm install` — regla del workspace.

## 6. Fases

| Fase | Entregable |
|---|---|
| **0** | Decisión de stack + nombre; scaffold del repo (git, venv, toolchain); `pyproject.toml` en hf-downloader |
| **1 (MVP)** | Panel de hardware (R1) + regímenes (R2); búsqueda HF (R3); tabla de cuantizaciones con semáforo (R4); descarga con progreso SSE (R5, R6); gated (R7). ✅ Mergeado 2026-10-24 (`72b0c51`). **Adición 2026-10-25** (merge `2ae2e2a`): tabla lista TODOS los archivos (model card README.md, config/soporte, otros — status `na`, sin semáforo, marcables) y **carpeta de destino elegible** (input en la UI, default `D:\Downloads`, validado en backend con 422) |
| **2** | **Rebaselining 2026-10-25**: perfiles de hardware multi-servidor (R10) + storage multi-path configurable (R11) + librería del storage (R9) + paquetes de modelos por escenario (R12) + pausa/reintentos + ajustes (contexto, umbrales, margen) + estimación v2 por metadatos GGUF + prompt de carpeta de destino en la TUI de hf-downloader. Una sola rama `feature/fase-2`, commits por unidad de cambio. (Destino elegible + model card YA listos desde la adición de fase 1) |
| **3 (opcional)** | Arrancar el modelo descargado (llama.cpp/Ollama) con la configuración elegida; presets; multi-GPU/AMD |

### Progreso Fase 2 (rama `feature/fase-2`, commits por unidad)

| # | Unidad | Estado |
|---|---|---|
| 1 | TUI hf-downloader: prompt de carpeta de destino | ✅ repo hf-downloader, `22846bc` + `6c6f6cd` (rama `feature/tui-destino`, sin mergear) |
| 2 | Perfiles de hardware multi-servidor (R10) | ✅ `ab47686` |
| 3 | Storage multi-path (R11) + librería con escaneo recursivo (R9) | ✅ `e18a4fc` |
| 4 | Descargas a path de storage (destino = storage elegido, sin fallback a `D:\Downloads`) | ✅ commit actual |
| 5 | Paquetes de modelos por escenario (R12) | pendiente |
| 6 | Pausa/reintento + ajustes (contexto, umbrales, margen) + estimación v2 por metadatos GGUF | pendiente |

## 7. Decisiones

1. **Stack**: ✅ **A — FastAPI + React (Vite + TypeScript)** (elegido por Fabian, 2026-10-24).
2. **Nombre del proyecto**: ✅ **Glyvex Provisions** — tool externa de Glyvex-AI-Suite (ex `model-pilot`, rename 2026-10-25; la única pieza del stack que toca internet, instalable opcionalmente o como fase previa para provisionar el storage). Carpeta + repo git en `D:\Proyectos\glyvex-provisions`.
3. Umbral del semáforo: 80/95% como base, margen 5% — **por confirmar** en fase 1 (quedará ajustable en ajustes).
4. ✅ **Multi-servidor** (2026-10-25): Glyvex Provisions es una **tool para varios servers**: detección automática del hardware local + perfiles manuales (GPU modelo + VRAM, RAM) que agrega el usuario; el semáforo se calcula contra el perfil elegido.
5. ✅ **Storage** (2026-10-25): multi-path configurado por el usuario (ej. `G:\LLM`, `C:\LLM`, NAS, UNC, server Linux — lo más sencillo que se adapte); escaneo **recursivo con subcarpetas** (mismo patrón que el config+scanner de Glyvex); el destino de descarga es uno de los paths de storage.
6. ✅ **Paquetes** (2026-10-25): los paquetes de modelos probados por escenario son **parte de la Fase 2 de Glyvex Provisions** (no un módulo de Glyvex-AI-Suite).
7. ✅ **TUI hf-downloader** (2026-10-25): agregar prompt de carpeta de destino con default (gap: la web UI ya lo pide, la TUI no).
8. ✅ **Ejecución de la Fase 2**: todo el rebaselining en una sola rama `feature/fase-2`; commits por unidad de cambio, merge con GO.
