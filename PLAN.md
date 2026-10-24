# Plan — APP de modelos con detección de hardware

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
| R9 | Librería local: escanear `D:\Downloads` para ver qué modelos ya hay | v2 |

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
| **1 (MVP)** | Panel de hardware (R1) + regímenes (R2); búsqueda HF (R3); tabla de cuantizaciones con semáforo (R4); descarga con progreso SSE (R5, R6); gated (R7) |
| **2** | Librería local escaneando `D:\Downloads` (R9); pausa/reintentos; ajustes (contexto, umbrales, margen); estimación v2 por metadatos GGUF |
| **3 (opcional)** | Arrancar el modelo descargado (llama.cpp/Ollama) con la configuración elegida; presets; multi-GPU/AMD |

## 7. Decisiones

1. **Stack**: ✅ **A — FastAPI + React (Vite + TypeScript)** (elegido por Fabian, 2026-10-24).
2. **Nombre del proyecto**: ✅ **model-pilot** (carpeta + repo git en `D:\Proyectos\model-pilot`).
3. Umbral del semáforo: 80/95% como base, margen 5% — **por confirmar** en fase 1 (quedará ajustable en ajustes).
