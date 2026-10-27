"""Entry del sidecar empaquetado (PyInstaller, U7).

`app/main.py` usa imports relativos, así que no puede ser el script directo
del Analysis. Este wrapper importa `app.main` como módulo del paquete y llama
a `main()` (bind con escalera + marcador #PORT_ASSIGNED# + uvicorn).
"""
from app.main import main

if __name__ == "__main__":
    main()
