# Runtime hook del sidecar (patrón glyvex_console_hook.py de la Suite).
#
# El EXE se construye con console=False (sin consola propia). Reglas:
# - PROV_STDOUT_PIPE=1 (lo pone la shell Tauri al spawnear): stdout/stderr se
#   dejan en la pipe para que Rust lea el marcador #PORT_ASSIGNED#.
# - Sin esa variable (ejecución directa del .exe): sys.stdout puede ser None en
#   Windows y print/uvicorn-crashes; se redirige todo a DATA_DIR/logs.
import os
import sys

if getattr(sys, "frozen", False) and os.environ.get("PROV_STDOUT_PIPE") != "1":
    from pathlib import Path

    try:
        from app.paths import DATA_DIR
    except Exception:
        DATA_DIR = (
            Path(os.environ.get("LOCALAPPDATA") or str(Path.home()))
            / "glyvex-provisions"
            / "data"
        )
    log_dir = DATA_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    _f = open(log_dir / "sidecar-console.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = _f
    sys.stderr = _f
