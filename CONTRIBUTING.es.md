# Contribuyendo a Glyvex Provisions

> **Idioma:** [English](CONTRIBUTING.md)

Gracias por querer contribuir. Acá está cómo funciona el flujo.

## Reglas básicas

- **Local-first, pero la excepción de red autorizada**: Provisions es la
  única pieza del stack de Glyvex-AI-Suite que está autorizada a tocar
  internet. El tráfico saliente está limitado por diseño a Hugging Face
  (búsqueda, metadata, descargas) y al feed de actualizaciones (GitHub).
  Cualquier uso nuevo de red debe ser intencional, documentado en este set
  de docs, y NUNCA agregar telemetría.
- **La Suite es una caja negra**: Provisions NUNCA escribe archivos de la
  Suite. La integración es exclusivamente vía la API HTTP pública de la
  Suite (ver `app/suite.py`). Si una feature parece necesitar escribir estado
  de la Suite, no pertenece acá.
- **Mantener el arranque lazy**: las dependencias pesadas
  (`huggingface_hub`, `httpx2`, los cores de descarga) se importan de forma
  diferida a propósito (la release 0.2.1 bajó `import app.main` de 8,45 s a
  0,98 s). No reintroduzcan imports a nivel de módulo de esos paquetes en
  `app/`.
- **Un cambio por PR**: no mezclar feature + fixes + refactor.
- **Idioma del código**: comentarios de intención y mensajes de commit en
  español con prefijo convencional, siguiendo el historial del repo.

## Buenas primeras contribuciones (up-for-grabs)

Tareas acotadas, aptas para entrar al proyecto:

- Ampliar `docs/TROUBLESHOOTING.md` con casos reales que resuelvas (mantener
  la estructura síntoma / qué pasa / qué hacer).
- Agregar una suite de tests automática: todavía no hay. `pytest` + `httpx`
  contra la app FastAPI (`app/main.py`) con red mockeada sería una fuerte
  primera contribución (ver `tests/` de los proyectos compañeros para el
  estilo).
- Documentar el soporte formal de Linux/macOS (Windows es la plataforma
  soportada hoy; el código es portable en principio).

## Setup

```powershell
# Backend (Python 3.11+) — desde la raíz del repo
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
# Core de descargas: clonar el repo compañero facebey/hf-downloader una vez
.venv\Scripts\pip install -e <path-to-hf-downloader>

# Frontend (Node.js 20 LTS+) — desde web/
cd web
npm install
```

Arranque completo con `start.ps1` (o `start.bat`): reutiliza un backend sano
ya corriendo en el rango 8321–8330 (o lo levanta en una consola visible),
descubre el puerto asignado, lo inyecta como `PROV_BACKEND_URL` y abre el
dev server de Vite en 8331 en ventana visible + el browser.

Para la shell de escritorio: `npm run tauri:dev` desde `web/` (Tauri levanta
Vite) o `npm run tauri:dev:reuse` (reusa un `npm run dev` ya en 8331).

## Verificación

Todavía no hay suite de tests automática. Antes de proponer un cambio, correr:

```powershell
# Build del frontend (tsc + vite), desde web/
npm run build

# Shell Rust, desde web/src-tauri
cargo check

# Smoke en vivo: start.ps1 y luego
curl.exe http://127.0.0.1:8321/api/healthz
```

Un cambio no está listo hasta que lo hayas ejercitado en la app corriendo
(UI + endpoints en vivo). Si agregan la suite de tests, el smoke en vivo
sigue siendo obligatorio para lo que toque la shell Tauri o el ciclo de vida
del sidecar.

## Git

- Ramas descriptivas desde `main`: `feature/<tema>`, `fix/<tema>`,
  `docs/<tema>`, `release/vX.Y.Z`.
- Commits con prefijo convencional, mensaje en español:
  `feat(lanzador): ...`, `fix(arranque): ...`, `docs: ...`.
- Un commit por unidad de cambio; no mezclar una feature con fixes
  ajenos.
- No commitear estado runtime: `data/` (salvo ejemplos), logs,
  `node_modules`, `target/`, la salida PyInstaller de `packaging/dist` y la
  clave **privada** del updater (`web/src-tauri/updater/` está gitignored;
  solo `pubkey.txt` está versionada). Ver `.gitignore`.

## Convenciones

- Los comentarios explican el POR QUÉ, no el código, y solo cuando el por
  qué no es obvio.
- El contrato de puertos es load-bearing: el backend se une en 8321, cae por
  la escalera 8321–8330, luego a un puerto asignado por el SO, e imprime el
  marcador `#PORT_ASSIGNED:<puerto>#`. La shell Rust lee ese marcador. No
  romper el formato del marcador ni la regla "gana el puerto sano más bajo"
  (la sonda de la escalera es en paralelo: un hilo por puerto).
- Carpeta de datos: `app/paths.py` la resuelve (repo `data/` en dev,
  `%LOCALAPPDATA%\glyvex-provisions\data` congelado; `PROV_DATA_DIR`
  sobrescribe en ambos). Persistencia nueva pasa por ella, nunca por rutas
  hardcodeadas.
- Si tu cambio agrega comportamiento visible para el usuario, actualizá el
  README y el `docs/` correspondiente en la misma PR — **ambas** versiones,
  inglesa y española (son pares; cada página enlaza a su contraparte).
- `CHANGELOG.md` / `CHANGELOG.es.md` — el maintainer los actualiza en cada
  release.

## Releases

Semver `mayor.minor.patch`. La versión vive en `web/src-tauri/Cargo.toml` y
`web/src-tauri/tauri.conf.json` y debe mantenerse igual en ambos. El
maintainer corta el tag `vX.Y.Z` en el commit de bump de versión, arma con
`build.ps1` (instalador NSIS + `.sig` minisign + `latest.json`) y publica la
release con los tres assets. Detalle en la sección "Release" del README.
