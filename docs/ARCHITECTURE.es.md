# Arquitectura

> **Idioma:** [English](ARCHITECTURE.md)

El mapa de la app: procesos, flujos de datos, dónde vive el estado y los
contratos que sostienen las piezas.

## Las tres capas

```
┌────────────────────────────────────────────────────────┐
│ Shell Tauri/Rust (web/src-tauri)                       │
│   ventana + WebView2 + splash por etapas               │
│   spunea / reutiliza el sidecar, lee el marcador       │
└───────────────────────────┬────────────────────────────┘
                            │ stdout: #PORT_ASSIGNED:<puerto>#
                            │ http://127.0.0.1:<puerto>/api/*
┌───────────────────────────▼────────────────────────────┐
│ Sidecar FastAPI (app/) — PyInstaller onedir, sin consola│
│   REST + SSE · sirve la SPA (StaticFiles)              │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ SPA React/Vite (web/) — mismo bundle en dev (Vite:8331)│
│   e instalada (servida por el sidecar)                 │
└────────────────────────────────────────────────────────┘
```

- **Shell**: al arrancar corre una **sonda en paralelo** de la escalera
  8321–8330 (un hilo por puerto; si varios backends sanos responden, gana el
  puerto *más bajo* — mismo resultado determinista que la versión secuencial,
  al costo de una sonda). Si hay uno vivo lo reutiliza y **nunca lo mata al
  cerrar**; si no, spawnea el sidecar empaquetado, lee el marcador
  `#PORT_ASSIGNED:<puerto>#` de su stdout, redirige la webview a ese puerto
  (solo builds de producción) y muestra el splash por etapas ("Iniciando el
  backend local…" → "Arrancando el servicio local…" → "Servicio listo —
  conectando…" → "Listo", o "El backend no arrancó. Reintentando…"). El
  sidecar spawneado se mata al salir; su stderr se drena a
  `DATA_DIR/logs/sidecar-stderr.log`.
- **Sidecar**: una app FastAPI. Se une a 127.0.0.1:8321 con socket
  pre-bound, cae por la escalera 8321–8330, luego a un puerto asignado por el
  SO (puerto 0), e imprime el marcador. Sirve la SPA compilada y todos los
  endpoints `/api/*`, incluido `/api/healthz`. Las dependencias pesadas
  (`huggingface_hub`, `httpx2`, los cores de descarga) se importan de forma
  diferida — esto es lo que hizo rápida a la 0.2.1 (ver
  [TROUBLESHOOTING](TROUBLESHOOTING.es.md) para la historia del arranque).
- **SPA**: un solo codebase para dev e instalada. En dev, Vite en 8331
  (strictPort) hace proxy al backend (`PROV_BACKEND_URL`); instalada, el
  sidecar sirve `web/dist`.

## Módulos del backend (`app/`)

| Módulo | Rol |
|---|---|
| `main.py` | Fábrica de la app; `_bind_with_fallback` (escalera + marcador); sirve la SPA |
| `api.py` | Endpoints REST + SSE (healthz, hardware, búsqueda, cola, lanzador, suite, …) |
| `hardware.py` | GPU vía `nvidia-smi`, CPU/RAM vía WMI, discos; arranque silencioso |
| `fit.py` | El semáforo: estimación de VRAM por archivo GGUF (pesos + KV cache para el contexto elegido), umbrales 80/95 %, regímenes `gpu/multi/offload/cpu` |
| `gguf.py` | Parsing real de metadata GGUF (el badge `v2·GGUF`) |
| `hfsearch.py` | Búsqueda en Hugging Face (imports lazy; 401/403 amigables) |
| `catalog.py` | Catálogo integrado (JSON chico, cacheado) |
| `downloads.py` | Cola reanudable a nivel de byte: `.part` + sidecar `.meta` (ETag/SHA256), pausa/reanudación/reintento, progreso SSE |
| `storage.py` | Librería y storage multi-path (discos locales, NAS, UNC); destino validado |
| `profiles.py` | Perfiles multi-servidor (el semáforo se evalúa contra el elegido) |
| `packages.py` | Paquetes de modelos por escenario (manifiestos JSON, archivos exactos o globs) |
| `launcher.py` | Lanzador de modelos: cascada de engines, probe del binario, comando mínimo, sesión con log SSE |
| `suite.py` | Detección y registro de la Suite, exclusivamente vía su API pública |
| `paths.py` | La única fuente de la carpeta de datos |
| `settings.py` | Persistencia de settings del usuario |

El motor de descargas en sí es el **core `hf_down`** del repo compañero
[facebey/hf-downloader](https://github.com/facebey/hf-downloader)
(TUI + librería de Python puro), instalado editable e importado de forma
diferida.

## Puertos y el marcador (contrato load-bearing)

- Preferido **8321**; escalera **8321 → 8330**; último recurso **puerto 0**
  (asignado por el SO). La sonda NO debe poner `SO_REUSEADDR` — en Windows
  ese flag hace que `bind()` exita sobre un listener vivo y la escalera no
  caería.
- El backend imprime exactamente una línea de marcador,
  `#PORT_ASSIGNED:<puerto>#`; la shell la parsea. No romper el formato.
- Las capabilities de Tauri permiten `http://127.0.0.1:*` (wildcard de
  puerto) porque el puerto final puede ser asignado por el SO.
- `PROV_HOST` / `PROV_PORT` sobrescriben; `start.ps1` inyecta
  `PROV_BACKEND_URL` para el proxy de Vite.

## Dónde vive el estado

- **Carpeta de datos** (`app/paths.py`): repo `data/` en dev;
  `%LOCALAPPDATA%\glyvex-provisions\data` congelado (sobrevive reinstalaciones
  del NSIS); `PROV_DATA_DIR` sobreescribe en ambos. Adentro: índice de
  librería, perfiles, `presets.json`, settings, estado de descargas, `logs/`
  (`sidecar-stderr.log` y afines).
- **Carpeta de instalación de la app**: por-usuario (NSIS `currentUser`).
  Solo código — ningún estado vive acá, así los upgrades y reinstalaciones
  son no destructivos.

## Updater

Auto-updater de Tauri, firmado con minisign. La shell consulta
`https://github.com/facebey/glyvex-provisions/releases/latest/download/latest.json`
(público — el repo es open source), valida la firma, ofrece "Actualizar y
reiniciar" con progreso de descarga y **detiene el backend local antes de
instalar** (la permission custom de ACL `sidecar-control` autoriza
`stop_sidecar` desde la webview). La clave **pública** de firma está
versionada; la privada vive fuera del repo (gitignored).

El **banner** automático aparece solo cuando el feed publica una versión
nueva. El modal **"Acerca de"** del footer (© 2026 Glyvex → "Verificar
actualizaciones") corre la misma consulta a demanda a través del updater de
Tauri, con estados de verificando / al día / disponible / descargando con
progreso / error con reintento, y el mismo flujo de instalación: primero
`stop_sidecar`, después la actualización NSIS y luego el reinicio.

## Superficie de red (toda)

1. Hugging Face — búsqueda, metadata, descargas.
2. El feed de actualizaciones (GitHub).
3. Salidas a `127.0.0.1` / destinos LAN que el usuario lanza explícitamente
  (la API de la Suite, `llama-server`, Ollama).

Sin telemetría; nada más sale de la máquina.
