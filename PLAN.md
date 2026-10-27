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
- 📌 **Reabierta 2026-10-25 solo para distribución** (decisión §7.9): instalador Tauri/NSIS de Provisions; el stack de desarrollo sigue siendo A.

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
| 4 | Descargas a path de storage (destino = storage elegido, sin fallback a `D:\Downloads`) | ✅ `1677e35` |
| 4b | (Adición UI 2026-10-25) Checkbox select-all en la tabla de archivos del repo | ✅ `5403170` |
| 4c | (Adición 2026-10-25) Detección de hardware completa: CPU (modelo, vendor, relojes, socket), GPU multi-vendor (NVIDIA/AMD/Intel), RAM por módulo (tipo, velocidad, fabricante) | ✅ `dd578b9` |
| 4d | (Adición 2026-10-25) Catálogo de hardware (`app/catalog.json`: CPUs Intel/AMD 2015→hoy, GPUs 3 vendors con VRAM mapeada, velocidades RAM DDR3/4/5) + perfil manual con **selects en cascada** (vendor → modelo, VRAM autofillada y editable, "Otro… (manual)" por campo) + **detección auto enriquecida** con el catálogo (`vram_source`: nvidia-smi/wmi/catalog — corrige el cap de ~4 GB de WMI en GPUs no-NVIDIA; reloj de CPU por fallback) | ✅ `82e6ad5` |
| 5 | Paquetes de modelos por escenario (R12): manifiestos `.json` en `<storage>\packajes\` (texto plano, portables entre servers), entradas `{repo_id, file}` exacto o `{repo_id, pattern}` glob con XOR, descarga = 1 job por repo único | ✅ `cd24d19` |
| 5b | (Adición 2026-10-25) Puertos: Vite dev → **8331** (NO 5173: ese es el de Glyvex-AI-Suite; 8322 quedó descartado, ocupado por proceso ajeno) + `strictPort`; backend con pre-bind + escalera de fallback (8321 → 8322…8330 → puerto 0 del SO, patrón Suite T4.5) + marcador `#PORT_ASSIGNED:<puerto>#` que leerá la shell Tauri (U7) + env `PROV_HOST`/`PROV_PORT` | ✅ `ea4c7f7` (+ `2808a57` fix JSX/vendor; decisión §7.10) |
| 5c | (Adición 2026-10-25) Scripts de arranque: `start.ps1` (raíz, path-agnostic; si 8331 responde → solo abre browser; reutiliza un backend ya asentado en 8321…8330 vía `/api/healthz` o lo levanta en ventana visible; descubre el puerto y lo inyecta como `PROV_BACKEND_URL`; Vite en ventana visible; abre browser) + `start.bat` (wrapper delgado del `.ps1`) + proxy de Vite por `process.env.PROV_BACKEND_URL \|\| 'http://127.0.0.1:8321'` | ✅ `1809a3d` |
| 6 | **U6 — Resume + pausa/reintento + ajustes + estimación v2 + 401 amigable** (diseño aprobado 2026-10-26; decisiones §7.12–15). (1) **Resume byte-level**: módulo `resumable` en el CORE (hf-downloader) — híbrido: hf_hub resuelve metadatos/token, downloader propio `.part` + `Range: bytes=N-` (solo path LFS/HTTP; Xet vía librería), validación tamaño+SHA256 antes del rename, invalidación por ETag, cero deps nuevas; la TUI de `hf_down.py` lo gana gratis. (2) **Pausa/reintento**: pausa = el hilo sale limpio dejando el `.part`; resume/retry = relanza idempotente del job. (3) **Ajustes persistentes**: contexto (KV), umbrales del semáforo (80/95%), margen (5%). (4) **Estimación v2**: metadatos GGUF por parser `struct` propia (sondeo Range **1 MiB** de la cabecera del GGUF, no ~256 KB como draft; ver §7.14), KV cache por contexto real del settings; degradación a v1 (tamaño × margen) si no hay metadatos útiles. (5) **401 amigable**: mensaje accionable en tabla Y cola (términos + token + "reinicia el backend si el token se configuró después"). | ✅ **U6 completa** (2026-10-27): (1)(2) core `resumable` merged a main del core; (3) `e741bae`→`ee9b2e8`; (4) `c656353`→`d726fd7` + core `prefetch_head` `c38ac59`→core main `07e00db`; (5) `a55f0fd`→`3177aa5`. Smokes 11/11 + 3/3 + 10/10 y validación en vivo 2026-10-27 (badge v2 real, mmproj→v1, settings persistidos) |
| 7 | **Instalador Tauri/NSIS** para Glyvex Provisions (distribución, consistente con la Suite; reabre la opción D de §4) | pendiente (decisión §7.9, 2026-10-25) |

## 7. Decisiones

1. **Stack**: ✅ **A — FastAPI + React (Vite + TypeScript)** (elegido por Fabian, 2026-10-24).
2. **Nombre del proyecto**: ✅ **Glyvex Provisions** — tool externa de Glyvex-AI-Suite (ex `model-pilot`, rename 2026-10-25; la única pieza del stack que toca internet, instalable opcionalmente o como fase previa para provisionar el storage). Carpeta + repo git en `D:\Proyectos\glyvex-provisions`.
3. Umbral del semáforo: 80/95% como base, margen 5% — **por confirmar** en fase 1 (quedará ajustable en ajustes).
4. ✅ **Multi-servidor** (2026-10-25): Glyvex Provisions es una **tool para varios servers**: detección automática del hardware local + perfiles manuales (GPU modelo + VRAM, RAM) que agrega el usuario; el semáforo se calcula contra el perfil elegido.
5. ✅ **Storage** (2026-10-25): multi-path configurado por el usuario (ej. `G:\LLM`, `C:\LLM`, NAS, UNC, server Linux — lo más sencillo que se adapte); escaneo **recursivo con subcarpetas** (mismo patrón que el config+scanner de Glyvex); el destino de descarga es uno de los paths de storage.
6. ✅ **Paquetes** (2026-10-25): los paquetes de modelos probados por escenario son **parte de la Fase 2 de Glyvex Provisions** (no un módulo de Glyvex-AI-Suite). **Diseño R12 (implementado 2026-10-25, unidad 5)**: manifiesto = archivo `.json` de texto plano en `<storage>\packajes\` — editables con cualquier editor, copiables entre servers, versionables en git; el storage y sus paquetes viajan juntos. Forma: `{name, scenario?, profile?, files[]}`, y cada entrada es `{repo_id, file}` (archivo exacto del repo) o `{repo_id, pattern}` (glob, p. ej. `*Q4_K_M.gguf` para tomar TODAS las cuantizaciones Q4_K_M) — **XOR validado**: ni ambos ni ninguno. `scenario`/`profile` son metadatos del escenario, no afectan la descarga. Descargar un paquete = **1 job por repo único** (destino = el storage del paquete); los glob pasan directo a `snapshot_download(allow_patterns=...)` sin listado extra por red. Manifiestos inválidos se listan con bandera `error` (se muestran, no se descargan) en vez de romper el listado. REST: `GET/POST/DELETE /api/storage/{id}/packages` + `POST .../packages/{pkg}/download`. Cap de 500 entradas por manifiesto.
7. ✅ **TUI hf-downloader** (2026-10-25): agregar prompt de carpeta de destino con default (gap: la web UI ya lo pide, la TUI no).
8. ✅ **Ejecución de la Fase 2**: todo el rebaselining en una sola rama `feature/fase-2`; commits por unidad de cambio, merge con GO.
9. ✅ **Distribución / instalador** (2026-10-25): Glyvex Provisions se distribuye con **instalador Tauri/NSIS propio** (consistente con el empaquetado Tauri de Glyvex-AI-Suite). Esto **reabre la opción D de §4** (Tauri + React, Python como sidecar), descartada en el MVP por complejidad: se adopta ahora solo para la capa de distribución (shell Tauri que empaqueta la UI build + levanta uvicorn como sidecar; NSIS vía tauri-bundler). El stack de desarrollo sigue siendo el de la opción A. Unidad 7.
10. ✅ **Puertos** (2026-10-25, unidad 5b): Vite dev → **8331** (5173 es el dev server de Glyvex-AI-Suite — Fabian prueba ambas a la vez; 8322 quedó descartado, ocupado por un proceso ajeno en la máquina de Fabian) + `strictPort: true` (fallar a la vista en vez de moverse callado, patrón de la Suite). Backend: preferido **8321** con **pre-bind + escalera de vecinos** (8321 → 8322…8330 → puerto 0 asignado por el SO); el socket pre-bound se hereda por uvicorn sin ventana de re-bind. Imprime el marcador `#PORT_ASSIGNED:<puerto>#` que la shell Tauri (unidad 7) leerá para apuntar la webview. Env `PROV_HOST`/`PROV_PORT` sobrescriben (mismo contrato que `GLYVEX_HOST`/`GLYVEX_PORT` de la Suite). Patrón tomado de la Suite (T4.5, `backend/main.py::_bind_with_fallback`) con una corrección: **sin `SO_REUSEADDR`** en el probe — en Windows ese flag hace que `bind()` exita sobre un puerto con un listener vivo (comparte en vez de fallar) y la escalera no caería. Smoke: 2ª instancia con 8321 ocupado cayó a 8322 y respondió healthz.
11. ✅ **Carpeta / rename** (2026-10-25, unidad 5c): `D:\Proyectos\glyvex-provisions` es el nombre oficial de la carpeta y es la **carpeta real** (cerrado 2026-10-25). El rename directo de `model-pilot` estaba bloqueado por un proceso externo (pitfall confirmado: un proceso con la carpeta como CWD bloquea su rename en Windows; con servicios de dev muertos y terminales cerrados seguía fallando; holder no identificable sin tools de handles con elevación). **Método usado**: (1) junction temporal para liberar el nombre; (2) mover **cada hijo** (incluidos `.git` y `.venv`) a la nueva carpeta real — los hijos siempre pudieron moverse, solo la raíz estaba bloqueada; (3) `rmdir` del `model-pilot` ya vacío: **exito** (el lock impedía renombrar la raíz, pero no borrarla vacía). Estado final: solo existe `glyvex-provisions`; `model-pilot` desapareció. Smoke post-mudanza OK: arranque completo vía `start.bat` desde la nueva ruta (healthz 8321 + UI 8331 + transform de `App.tsx` sin PARSE_ERROR).
12. ✅ **Resume byte-level (U6, 2026-10-26)**: diseño aprobado por Fabian ("me parece excelente ese diseño"). Arquitectura **híbrida**: (1) `huggingface_hub` sigue haciendo la búsqueda, el listado de archivos, los metadatos (URL, tamaño, SHA256) y el token; (2) downloader **propio** en el CORE (`hf-downloader`, módulo `resumable`): `.part` estable por archivo + sidecar `.meta` (ETag/tamaño/SHA256), resume con `Range: bytes=N-` cuando el ETag no cambió, append, validación de tamaño + SHA256 **antes** del rename al nombre final; si el ETag cambió (nuevo commit) se descarta el `.part` y se reinicia desde 0; (3) V1 = **solo path LFS/HTTP** — el path Xet se delega a `hf_hub_download` (librería) sin resume entre ejecuciones; (4) sin multi-conexión (no reinventar aria2); (5) **cero dependencias nuevas**: `httpx2` 2.16.0 ya vive en el venv vía `huggingface_hub` 2.3.0 (NO hay `requests`). Beneficio: la TUI de `hf_down.py` gana resume gratis (una sola implementación en el core). Pausa/reintento: pausa = flag que hace salir al hilo **limpio** dejando el `.part` (status `paused`); resume/retry = relanza idempotente del job que reutiliza el resume byte-level.
13. ✅ **HF_TOKEN en el launch (arranque de U6, 2026-10-26)**: `start.ps1` inyecta `HF_TOKEN` desde el registro (scope User) en el env del proceso **si el entorno no lo trae** — root cause del 401 en repos gated: las env vars de Windows son snapshot al arrancar el proceso, y un backend lanzado desde un padre iniciado antes de configurar el token no lo veía (`get_token()` → None → 401). Solo se muestra la **longitud** del token, nunca su valor. Además: salir en "ya corriendo" solo si frontend Y backend responden, y Vite solo se levanta si el frontend no está corriendo (antes salía si solo vivía el frontend, dejando el backend caído sin aviso). Verificado por Fabian: la descarga gated de 84 GB (`orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF`) funciona. Commit `d80ba37` en `feature/fase-2`.
14. ✅ **Estimación v2 — hechos GGUF verificados en bytes reales (U6-4, 2026-10-26/27)**: el parser propio `app/gguf.py` (solo `struct`, cero deps) se construyó contra archivos GGUF reales, no contra documentación. Confirmado en bytes: (a) enum vtype GGUF **oficial** `u8=0…bool=7, STRING=8, ARRAY=9, u64=10, i64=11, f64=12` (NO el orden alternativo STRING=11/ARRAY=12 que circula por ahí); (b) claves reales con underscore: `<arch>.block_count`, `<arch>.attention.head_count`, `<arch>.embedding_length`; opcionales `head_count_kv`/`layer_count_kv`/`key_length`/`value_length`; (c) el bloque de hparams es **contiguo al inicio** de la metadata (~1 KB), antes del vocabulario (MB) → el sondeo Range de 1 MiB lo cubre siempre; el parse se corta al FINAL del bloque `<arch>.` y si el probe trunca dentro del bloque devuelve None → degradación v1 (nunca semáforo huérfano); (d) `kv/token = capas_kv × heads_kv × (dim_K+dim_V) × 2B` (F16), dims vía `key_length`/`value_length` o `head_dim = embedding_length/head_count`; (e) meta cacheada por repo (los quants comparten hparams — un solo sondeo por repo); (f) los **mmproj van por v1 excluidos por fila** en `api.py` (la KV de atención del LLM no aplica al vision encoder; bug encontrado en vivo: heredaban v2). Valores de referencia verificados: Qwen2.5-7B → 56 KiB/token (448 MiB@8k, 1.75 GiB@32k); Mixtral-8x7B v2 legacy → 128 KiB/token. Core: `prefetch_head` sondea la cabecera vía Range en `resumable.py` (merged a main del core `07e00db`). Validación en vivo 2026-10-27 con backend post-merge: badge `v2·GGUF` real en la tabla, mmproj sin badge, contexto del settings alimenta el KV.
15. ✅ **401/403 amigable (U6-5, 2026-10-27)**: `hfsearch.friendly_message(repo_id, status)` genera el mensaje accionable y lo comparten los dos caminos (tabla `/api/repo/files` y cola de descargas vía `_file_error`, que mapea el `HfHubHTTPError` 401/403 a `GatedError(repo_id, status)`). El mensaje distingue los dos casos reales: **sin token visible** (pasos: aceptar términos en la URL del repo + definir HF_TOKEN/`hf auth login` + reiniciar el backend porque el token se lee solo al arrancar — root cause §7.13) y **con token sin acceso** (el token existe pero el repo no lo autoriza: aceptar términos con esa cuenta o compartir el repo; restart si el token se configuró después). Nunca se muestra el valor del token. Smoke 10/10 incluye integración real (repo gated real de meta-llama → 401 de HF → 403 con mensaje) forzando el caso sin token con `HF_TOKEN` fuera del entorno del test. Commit `a55f0fd`, merge `3177aa5`.
