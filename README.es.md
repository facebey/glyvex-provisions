# Glyvex Provisions

> **Language:** [English](README.md)

**Glyvex Provisions** es una tool complementaria externa de [Glyvex-AI-Suite](https://ai-suite.glyvexgroup.com/): la única pieza del stack Glyvex que se conecta a internet. Su trabajo es **abastecer tu storage local de modelos**: buscar repos GGUF en Hugging Face, mostrarte un semáforo claro para cada archivo contra el hardware que realmente tienes, y descargarlos con reanudación a nivel de byte. La Suite en sí queda 100% local; Provisions es lo que corres **antes** (o en paralelo) para traer los modelos. Se instala opcionalmente, como parte del flujo de la Suite o como herramienta independiente.

Todo corre en tu máquina (la app solo sirve en `127.0.0.1`). Sin telemetría, sin nube: la única red saliente es `huggingface.co`.

## Descarga / Instalación

- **Windows x64**: bajá el instalador más reciente desde [Releases](https://github.com/facebey/glyvex-provisions/releases) — `Glyvex.Provisions_<versión>_x64-setup.exe`. Instalación por usuario (sin administrador); elegís la carpeta de instalación.
- Los datos de usuario viven en `%LOCALAPPDATA%\glyvex-provisions\data` y sobreviven a reinstalaciones.
- **Auto-update**: cada release publica `latest.json` firmado (updater de Tauri + firma minisign); la app lo consulta y ofrece la actualización desde sí misma.
- El SHA256 de cada instalador se publica en las notas del release.

## Funcionalidades

- **Detección de hardware**: GPU + VRAM vía `nvidia-smi`, CPU/RAM vía WMI, discos — además de perfiles multi-servidor manuales cuando tus modelos apuntan a otra máquina.
- **Semáforo por archivo**: estimación del consumo con la metadata GGUF real del archivo (pesos del modelo + KV cache para el contexto que elijas), umbrales 80/95% y margen de seguridad ajustables; regímenes `gpu` / `multi` / `offload` / `cpu` mapeados a tu hardware.
- **Búsqueda en Hugging Face**: tabla completa de archivos de cada repo (cuantizaciones, `mmproj`, configs, model card), mensajes amigables para repos gated (401/403) y carpeta de destino elegible (validada).
- **Descargas reanudables**: archivos `.part` con metadatos sidecar (ETag/SHA256), reanudación a nivel de byte, pausa/reintento, progreso en vivo por SSE.
- **Storage multi-path**: discos locales, NAS o rutas UNC; las descargas y el semáforo se evalúan contra el perfil de storage que elijas.
- **Paquetes de modelos por escenario**: manifiestos JSON de texto plano (archivos exactos o patrones glob), copiables entre máquinas — una acción descarga un escenario completo.
- **Lanzador de modelos (0.2.0)**: lanzá cualquier GGUF de tu librería con un clic. Cascada de engines (runtime gestionado de Glyvex-AI-Suite → tu propio `llama-server` → Ollama), perfil de lanzamiento por régimen (`gpu` / `multi` / `offload` / `cpu` con `-ngl` por régimen y `--tensor-split` en multi-GPU), log vivo del servidor, TTFB, tok/s y snapshot de VRAM en ejecución.
- **Integración con Glyvex-AI-Suite**: si hay Suite en la máquina, registrá el servidor lanzado en la Suite (vía su API pública, con confirmación) y abrila con un clic; sin Suite el lanzador funciona igual en pie.
- **Presets y visión (0.2.0)**: presets de lanzamiento guardables por escenario (chat / visión / offload), `--mmproj` para modelos de visión, argumentos extra libres e inventario de devices con el backend de aceleración (CUDA/Vulkan/ROCm/SYCL/CPU).
- **Arranque rápido (0.2.1)**: sonda de puertos en paralelo y carga diferida de todo el stack de red — de doble-clic a UI usable en ~4 s en una máquina con stack TCP lento (22,7 s antes del fix) y ~1,5–2 s en una sana.
- **Construida sobre `hf-downloader`**: un core chico de Python puro (TUI + librería, sin dependencias web) reutilizado como motor de descargas. *(repo compañero [facebey/hf-downloader](https://github.com/facebey/hf-downloader), privado por ahora — su apertura está en el roadmap)*

## Privacidad

- Servidor ligado solo a `127.0.0.1`; un usuario, sin auth, sin telemetría.
- El token de Hugging Face se lee de `HF_TOKEN` o `hf auth login` — nunca se persiste en el proyecto ni se muestra en la UI.

## Desarrollo

```powershell
# Backend (venv propio .venv)
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
# Core de descargas (repo compañero facebey/hf-downloader — clonallo una vez):
.venv\Scripts\pip install -e <path-to-hf-downloader>
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8321 --reload

# Frontend (web/)
cd web
npm install
npm run dev
```

O directamente `start.ps1` / `start.bat` en la raíz: reutiliza un backend vivo o levanta uno en ventana visible, descubre el puerto (escalera 8321 → 8322…8330) y abre la UI en `http://127.0.0.1:8331`.

## Producción (instalador Windows)

`build.ps1` en la raíz ejecuta el pipeline completo:

1. `npm run build` → `web/dist` (SPA).
2. PyInstaller → `packaging/dist/provisions-backend/` (sidecar FastAPI onedir; empaqueta el SPA como `_internal/web-dist` y lo sirve él mismo).
3. Junction `web/src-tauri/resources/provisions-backend` → el dist del sidecar.
4. `tauri build` → instalador **NSIS** + artefacts del updater firmados (`web/src-tauri/target/release/bundle/nsis/`).

La app instalada levanta el sidecar al abrir (reutiliza uno ya vivo en la escalera 8321…8330) y la webview se redirige al puerto real; muere al cerrar la ventana. Firmas del updater: `web/src-tauri/updater/` (`private.key` + `password.txt`, gitignored — perderlos invalida las updates firmadas; la pública va embebida en `tauri.conf.json`).

`tauri:dev` (Vite lo levanta Tauri) y `tauri:dev:reuse` (reusa un `npm run dev` ya corriendo en 8331) para desarrollar dentro de la shell.

## Documentación

| A dónde ir | Qué vas a encontrar |
|---|---|
| [README](README.es.md) | El panorama completo: funcionalidades, instalación, desarrollo y release. |
| [`docs/QUICKSTART.md`](docs/QUICKSTART.es.md) | El camino más corto: instalar, primer arranque, storage, primera descarga, primer lanzamiento. |
| [`docs/LAUNCHER.md`](docs/LAUNCHER.es.md) | El lanzador de modelos: engines, perfiles, presets, visión e integración con la Suite. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.es.md) | El mapa de la app: shell Tauri, sidecar FastAPI, escalera de puertos, persistencia y updater. |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.es.md) | Problemas comunes y cómo resolverlos. |
| [`CHANGELOG.md`](CHANGELOG.es.md) | Qué cambió en cada release. |
| [`CONTRIBUTING.md`](CONTRIBUTING.es.md) | Cómo contribuir: setup, ramas, commits y convenciones. |
| [`SECURITY.md`](SECURITY.es.md) | Política de seguridad y cómo reportar una vulnerabilidad. |

Toda la doc está en inglés y en español — cada página enlaza a su contraparte.

## Licencia

[Apache-2.0](LICENSE) — Copyright 2026 Glyvex Group.

Plan y decisiones: [`PLAN.md`](PLAN.md).
