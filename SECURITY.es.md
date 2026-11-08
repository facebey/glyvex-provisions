# Política de Seguridad

> **Idioma:** [English](SECURITY.md)

## Versiones Soportadas

Solo se dan actualizaciones de seguridad a la última versión publicada.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reportar una Vulnerabilidad

Si encontrás una vulnerabilidad de seguridad, **no abras un issue público**.

Reportala de forma privada por uno de estos medios:
- **GitHub Security Advisories**: usá el botón "Report a vulnerability" en la
  pestaña **Security** de este repo (forma preferida — crea un draft
  privado).
- **Email**: info@glyvexgroup.com

### Qué esperar

- Confirmación de recepción dentro de 72 horas.
- Una primera evaluación (aceptada / rechazada / necesita más info) dentro de
  7 días.
- Si se acepta, te mantengo al tanto del progreso hasta que salga el fix. El
  crédito se da en el changelog/release notes, salvo que pidas lo contrario.
- Si se rechaza, te explico el motivo.

### Alcance

Provisions se une solo a `127.0.0.1` y no tiene telemetría. Su tráfico
saliente está limitado a Hugging Face (búsqueda, metadata, descargas) y al
feed de actualizaciones (GitHub) — las vulnerabilidades de esos servicios
les corresponden a esos proveedores. Las vulnerabilidades en binarios de
terceros que lanza (por ejemplo `llama-server` de llama.cpp, o Ollama) deben
reportarse a sus proyectos correspondientes.

Dentro del alcance de esta política: el backend FastAPI (`app/`), la shell
Tauri/Rust (`web/src-tauri/`), la UI React (`web/src/`), el instalador NSIS y
el updater (la clave **pública** minisign está versionada por diseño; la
clave privada y la contraseña viven fuera del repo y están gitignored — si
alguna vez aparecen dentro del repo, eso en sí mismo es un incidente de
seguridad).
