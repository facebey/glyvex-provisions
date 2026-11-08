# Registro de cambios

> **Language:** [English](CHANGELOG.md)

Todos los cambios notables de Glyvex Provisions. El SHA256 y el tamaño del instalador se publican en cada [release](https://github.com/facebey/glyvex-provisions/releases).

## [0.2.1] — 2026-11-08

Release de rendimiento: **el arranque es hasta un 82 % más rápido** (22,7 s → 4,0 s medidos en una máquina real, con su anomalía de red local incluida). Sin cambios en semáforo, descargas, perfiles ni lanzador.

### Añadido

- **Splash con etapas**: el splash muestra el progreso real del arranque ("Iniciando el backend local…" → "Arrancando el servicio local…" → "Servicio listo — conectando…" → "Listo"); si el backend falla, muestra "El backend no arrancó. Reintentando…".

### Cambiado

- **Sonda del puerto en paralelo (U19)**: la comprobación de la escalera 8321–8330 corre un hilo por puerto en vez de diez encadenados (en máquinas con stack TCP lento eso costaba ~20 s); sigue ganando el puerto sano más bajo — mismo resultado determinista.
- **Poll fino del arranque (U20)**: tras recibir el marcador de puerto del backend, el bucle de espera baja de 1 s a 250 ms.
- **Import diferido del stack de red (U23)**: `huggingface_hub`, `httpx2` y los cores de descarga se cargan solo cuando de verdad se busca, descarga o sondea algo. `import app.main`: 8,45 s → 0,98 s (−88 %); el sidecar arranca sin ninguna de esas dependencias en memoria.

## [0.2.0] — 2026-11-04

Release funcional: **lanzador de modelos** (lanzar un GGUF con un clic desde Provisions, con integración del ecosistema Glyvex-AI-Suite) y **presets + visión** en el lanzador.

### Añadido

- **Lanzador de modelos (U15)**: elegís el engine (runtime gestionado de la Suite → binario propio de `llama-server` → Ollama, configurable), el modelo/archivo de la librería de Provisions (o ruta manual) y el perfil (`gpu` / `multi` / `offload` / `cpu` con `-ngl` por régimen y `--tensor-split` en multi-GPU). Lanzás, verificás y detenés el servidor desde la app: log vivo, TTFB, tok/s y snapshot de VRAM.
- **Integración con Glyvex-AI-Suite**: si hay Suite detectada, "Registrar en la Suite" (la Suite persiste vía su API pública, con confirmación) y "Abrir la Suite". Sin Suite, el servidor se lanza y se gestiona igual.
- **Presets (U16)**: configuraciones de lanzamiento guardables por escenario (chat / visión / offload) en `data/presets.json`. Un preset describe CÓMO lanzar, nunca qué modelo; CRUD desde la UI.
- **Visión + args avanzados (U16)**: `--mmproj` desde la librería del modelo (o ruta manual) y `extra_args` libres; los guards rechazan un mmproj inexistente y Ollama rechaza mmproj externo (422).
- **`--list-devices` en el probe del binario (U16)**: inventario de devices + backend de aceleración (CUDA/Vulkan/ROCm/SYCL/CPU) con advertencia si solo hay CPU.

## [0.1.3] — 2026-11-02

### Cambiado

- **Icono nuevo de la app** (glyph "descarga en bandeja"): el hexágono-nodo anterior se confundía con el cubo de la Suite. Favicons regenerados.
- **Lockups de marca**: el header y el splash usan el glyph recortado al trazo; los 8 bitmaps NSIS (claro/oscuro) se regeneraron desde un script generador versionado.

## [0.1.2] — 2026-10-30

### Corregido

- **Fix ACL del auto-update in-app**: en Tauri v2 todo comando IPC pasa el chequeo ACL de la ventana, incluidos los definidos por la propia app. "Actualizar y reiniciar" fallaba con `Command stop_sidecar not allowed by ACL`. Se añadió el permission custom `sidecar-control`. **0.1.2 es el primer release realmente auto-actualizable** — las versiones anteriores pueden comprobar el feed pero necesitan reinstalar a mano.

## [0.1.1] — 2026-10-30

### Añadido

- **Sidebar y header NSIS propios de Provisions** (isotipo de átomo, degradado de marca, "IA local, sin nube") reemplazando los assets genéricos heredados de la Suite (variantes claro/oscuro).
- **Auto-update in-app habilitado**: la app consulta `releases/latest/download/latest.json`, valida la firma minisign y ofrece "Actualizar y reiniciar" con progreso de descarga; detiene el backend local antes de instalar para que el instalador nunca tropiece con archivos bloqueados.
- Repo **público** (Apache-2.0): el feed de actualización es accesible sin token. El flujo 0.1.0 → 0.1.1 es la prueba E2E del updater en máquina real.

## [0.1.0] — 2026-10-30

Primera versión instalable (cierra la Fase 2).

### Añadido

- **Detección de hardware local**: GPU vía `nvidia-smi`, CPU/RAM vía WMI, discos. Arranque silencioso: sin ventanas de consola hijas.
- **Semáforo de cuantización por archivo**: consumo de VRAM estimado con metadata GGUF real (pesos + KV cache para el contexto elegido), umbrales 80/95 % y contexto ajustables, regímenes `gpu` / `multi` / `offload` / `cpu`.
- **Búsqueda de GGUF en Hugging Face**: tabla completa de archivos por repo (cuantizaciones, `mmproj`, configs), mensajes amigables 401/403 para repos gated y carpeta de destino elegible (validada).
- **Cola de descargas reanudables a nivel de byte**: `.part` + sidecar `.meta` (ETag/SHA256), pausa/reanudación/reintento, progreso en vivo por SSE.
- **Perfiles multi-servidor** y **storage multi-path** (discos locales, NAS, UNC); el semáforo se evalúa contra el perfil que elegís.
- **App de escritorio Tauri** con splash de arranque de marca e **instalador NSIS** con la identidad visual de Glyvex-AI-Suite (selector de idioma, desinstalador con marca).
- Los datos de usuario sobreviven reinstalaciones: `%LOCALAPPDATA%\glyvex-provisions\data`.
