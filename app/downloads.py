"""Cola de descargas con progreso en vivo (requisitos R5, R6).

Cada job corre `snapshot_download` en su propio hilo con un `tqdm_class`
propio que publica eventos (start / progress / done / error) a una cola por
job; el endpoint SSE (`GET /api/downloads/<id>/events`) los reenvía al
navegador. Destino: el path de storage elegido (R11): `<storage>\<repo>`.

Fallback Xet -> LFS idéntico al del core para repos legacy.
Token: el propio huggingface_hub (env HF_TOKEN o `hf auth login`).
"""
from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from huggingface_hub import snapshot_download
from huggingface_hub.utils import HfHubHTTPError

DEFAULT_DEST = Path(r"D:\Downloads")
MAX_WORKERS = 8
_PUBLISH_EVERY = 0.25  # s: thottle de eventos de progreso por job


@dataclass
class Job:
    id: str
    repo_id: str
    files: list[str]
    dest: str
    status: str = "queued"  # queued | running | done | error
    error: str | None = None
    events: queue.Queue = field(default_factory=queue.Queue)


class DownloadManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(self, repo_id: str, files: list[str],
               dest: Path = DEFAULT_DEST) -> Job:
        job = Job(id=uuid.uuid4().hex[:8], repo_id=repo_id,
                  files=sorted(files), dest=str(dest))
        with self._lock:
            self._jobs[job.id] = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda j: j.id)

    # ------------------------------------------------------------------ #

    def _run(self, job: Job) -> None:
        job.status = "running"
        last = {"t": 0.0}

        def publish(event: dict) -> None:
            job.events.put(event)

        publish({"type": "start", "files": job.files,
                 "dest": str(Path(job.dest) / job.repo_id)})

        class _Progress:
            """Duck-typing de tqdm para el callback de huggingface_hub.

            snapshot_download crea 2 barras parent (transfer + reconstruct)
            con esta clase y les lee/escribe atributos del protocolo tqdm
            (`n`, `total`, `format_dict`) además de llamar métodos
            (update/close/refresh/set_description...). Si cambia la versión de
            huggingface_hub y falta algún método, agregarlo como no-op aquí
            (NO usar __getattr__: huggingface_hub LEE atributos y espera
            valores numéricos, no funciones).
            """

            def __init__(self, total: int | None = None, **kwargs) -> None:
                self.total = total or 0
                self.n = 0  # bytes acumulados (huggingface_hub lo lee y compara)
                self.desc = str(kwargs.get("desc", ""))
                self._closed = False

            @property
            def format_dict(self) -> dict:
                # _set_aggregate_rate_postfix hace bar.format_dict.get("rate")
                return {"rate": None}

            def update(self, n: int | float | None = 1, **kwargs) -> float:
                self.n += int(n or 0)
                now = time.monotonic()
                if now - last["t"] >= _PUBLISH_EVERY:
                    last["t"] = now
                    publish({"type": "progress", "path": self.desc,
                             "done": self.n, "total": self.total})
                return self.n

            def close(self) -> None:
                if self._closed:
                    return
                self._closed = True
                publish({"type": "progress", "path": self.desc,
                         "done": self.n, "total": self.total})

            def __enter__(self) -> "_Progress":
                return self

            def __exit__(self, *exc) -> bool:
                self.close()
                return False

            def refresh(self) -> None:
                pass

            def set_description(self, *a, **k) -> None:
                pass

            def set_description_str(self, *a, **k) -> None:
                pass

            def set_postfix(self, *a, **k) -> None:
                pass

            def set_postfix_str(self, *a, **k) -> None:
                pass

            def write(self, *a, **k) -> None:
                pass

        def _go() -> None:
            snapshot_download(
                repo_id=job.repo_id,
                repo_type="model",
                local_dir=str(Path(job.dest) / job.repo_id),
                allow_patterns=job.files,
                max_workers=MAX_WORKERS,
                tqdm_class=_Progress,
            )

        try:
            try:
                _go()
            except HfHubHTTPError as e:
                if "xet-read-token" not in str(e):
                    raise
                # Repo legacy (LFS puro): el endpoint Xet devuelve 404
                import huggingface_hub.file_download as fd
                publish({"type": "log", "msg": "Xet no disponible; reintentando via LFS..."})
                fd.is_xet_available = lambda: False
                _go()
        except Exception as e:  # noqa: BLE001 — el job debe morir con mensaje
            job.status = "error"
            job.error = str(e)
            publish({"type": "error", "error": str(e)})
            return
        job.status = "done"
        publish({"type": "done", "dest": str(Path(job.dest) / job.repo_id)})


# Singleton de la APP (1 usuario, proceso único).
manager = DownloadManager()
