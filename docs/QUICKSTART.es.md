# Arranque rápido

> **Idioma:** [English](QUICKSTART.md)

El camino más corto para tener Glyvex Provisions corriendo en tu máquina. El
[README](../README.es.md) tiene el detalle completo;
[LAUNCHER.md](LAUNCHER.es.md) cubre el lanzador de modelos a fondo.

> **¿Solo querés usarla en Windows?** Nada de esto es necesario: bajate el
> instalador `Glyvex Provisions_<version>_x64-setup.exe` desde
> [Releases → latest](https://github.com/facebey/glyvex-provisions/releases/latest),
> ejecutalo y seguí el asistente (instalación por-usuario, sin admin). Si la
> app te ofrece un banner de actualización, "Actualizar y reiniciar" se
> encarga del resto. Esta guía es para correrla desde fuente.

## Prerrequisitos

- **Windows** (la plataforma soportada; x64).
- **Python 3.11+**
- **Node.js 20 LTS+** (frontend Vite/React)
- **Rust** (solo para la shell Tauri; el flujo dev de backend + Vite funciona
  sin él)
- El repo compañero **`hf-downloader`** (el core de descargas): cloná
  [facebey/hf-downloader](https://github.com/facebey/hf-downloader) una vez
  en cualquier lugar de tu máquina.

## Setup

```powershell
git clone https://github.com/facebey/glyvex-provisions
cd glyvex-provisions

# Backend (venv propio: .venv)
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -e <path-to-hf-downloader>

# Frontend
cd web
npm install
cd ..
```

## Primer arranque

```powershell
start.bat
```

`start.ps1` (que envuelve `start.bat`) reutiliza un backend sano ya
corriendo en 8321–8330 o lo levanta en una consola visible, descubre el
puerto asignado y abre la UI (Vite en 8331) en tu browser. Esperado:
`http://127.0.0.1:8331` arriba en pocos segundos, y
`http://127.0.0.1:8321/api/healthz` respondiendo 200.

Para la app de escritorio en su lugar: `cd web` y `npm run tauri:dev`
(splash de marca; la app toma el backend de la misma escalera).

## Primera descarga

1. El panel **Hardware** muestra tu GPU/CPU/RAM/discos — elegí un perfil de
   servidor si tenés varios.
2. **Búsqueda**: tipeá un repo de Hugging Face (por ejemplo un repo
   oficial `*GGUF`). Aparece la tabla completa de archivos (cuantizaciones,
   `mmproj`, configs). Los repos gated responden con un mensaje amigable
   401/403 — ver [TROUBLESHOOTING](TROUBLESHOOTING.es.md).
3. **Carpeta de destino**: elegí un disco local, NAS o UNC escribible
   (validada; la carpeta debe existir).
4. Seleccioná archivos y **colá los en la cola**: reanudable a nivel de
   byte, con pausa/reanudación/reintento y progreso en vivo.

Los archivos descargados pasan a ser tu **librería** — el semáforo
(verde/amarillo/rojo por cuantización contra tu VRAM) se evalúa contra
ellos.

## Primer lanzamiento (0.2.0+)

En el panel **Lanzador de modelos**: elegís el engine (runtime gestionado de
la Suite → tu propio `llama-server` → Ollama), el archivo del modelo de la
librería y un perfil (`gpu` / `multi` / `offload` / `cpu`). Lanzás: la app
verifica el servidor (health → modelos → un ping streaming con TTFB y
tok/s) y muestra el log vivo. Si hay Suite en la máquina también podés
registrar el servidor en ella y abrirla. Detalle completo en
[LAUNCHER.md](LAUNCHER.es.md).

## Dónde vive cada cosa

- **Carpeta de datos** (librería, perfiles, presets, settings, logs):
  `%LOCALAPPDATA%\glyvex-provisions\data` cuando está instalada; el repo
  `data/` en dev. Sobrevive reinstalaciones. `PROV_DATA_DIR` la
  sobreescribe.
- **App**: el default del NSIS es una carpeta por-usuario (en las máquinas
  de la familia, `D:\Glyvex Provisions`).
