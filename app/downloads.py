r"""Cola de descargas con progreso en vivo (requisitos R5, R6).

Cada job corre el modulo `resumable` del core (hf-downloader) en su propio
hilo: reanudable byte-level (`.part` + `Range: bytes=N-` + SHA256), archivo
por archivo. Un callback publica eventos (start / progress / file_done /
paused / done / error) a una cola por job; el endpoint SSE
(`GET /api/downloads/<id>/events`) los reenvia al navegador.

Los glob de los paquetes (R12) se expanden a paths exactos contra el
tree del repo al hacer `submit` (sin glob no se toca la red).

Pausa: el hilo sale limpio dejando el `.part` (estado `paused`);
reanudar/reintentar = relanzamiento idempotente — los archivos ya
completados se saltan (`final.exists()`) y los parciales continúan desde
el `.part` (lo gestiona el core).

Destino: el path de storage elegido (R11): `<storage>\<repo>`.
Token: el propio huggingface_hub (env HF_TOKEN o `hf auth login`).
"""
from __future__ import annotations

import fnmatch
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from huggingface_hub import HfApi, get_token
from huggingface_hub.utils import HfHubHTTPError
from resumable import DownloadFailed, DownloadPaused, hf_resumable_download

DEFAULT_DEST = Path(r"D:\Downloads")
_PUBLISH_EVERY = 0.25  # s: thottle de eventos de progreso por job
_GLOB_CHARS = set("*?[")


@dataclass
class Job:
    id: str
    repo_id: str
    files: list[str]
    dest: str
    status: str = "queued"  # queued | running | paused | done | error
    error: str | None = None
    events: queue.Queue = field(default_factory=queue.Queue)
    pause_event: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None


class DownloadManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(self, repo_id: str, files: list[str],
               dest: Path = DEFAULT_DEST) -> Job:
        job = Job(id=uuid.uuid4().hex[:8], repo_id=repo_id,
                  files=sorted(_expand_patterns(repo_id, files)),
                  dest=str(dest))
        with self._lock:
            self._jobs[job.id] = job
        job._thread = threading.Thread(target=self._run, args=(job,),
                                       daemon=True)
        job._thread.start()
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda j: j.id)

    def pause(self, job_id: str) -> Job:
        """Pide la pausa: el hilo sale limpio dejando el `.part`.

        Raise:
            KeyError si no existe el job; ValueError si no esta en
            running/queued.
        """
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.status not in ("running", "queued"):
            raise ValueError(job.status)
        job.pause_event.set()
        return job

    def resume(self, job_id: str) -> Job:
        """Relanza la descarga de forma idempotente: los archivos
        completados se saltan y los parciales siguen del `.part`.

        Raise:
            KeyError si no existe el job; ValueError si no esta en
            paused/error.
        """
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.status not in ("paused", "error"):
            raise ValueError(job.status)
        job.pause_event.clear()
        job.error = None
        job.status = "running"
        job._thread = threading.Thread(target=self._run, args=(job,),
                                       daemon=True)
        job._thread.start()
        return job

    # retry = mismo contrato que resume (estados permitidos: paused/error).
    retry = resume

    # ------------------------------------------------------------------ #

    def _run(self, job: Job) -> None:
        job.status = "running"
        last = {"t": 0.0}
        dest_dir = Path(job.dest) / job.repo_id
        count = len(job.files)

        def publish(event: dict) -> None:
            job.events.put(event)

        publish({"type": "start", "files": job.files,
                 "dest": str(dest_dir)})

        for i, path in enumerate(job.files):
            # Pausa pedida en un punto de file boundary: salir antes de
            # tocar el siguiente archivo (la pausa a mitad de archivo la
            # resuelve el core via stop_event -> DownloadPaused).
            if job.pause_event.is_set():
                job.status = "paused"
                publish({"type": "paused", "path": path})
                return

            def _prog(done: int, total: int, _p: str = path) -> None:
                # Throttle: el core llama por chunk (1 MiB); publicar
                # ~4 eventos/s por job es suficiente para la barra.
                now = time.monotonic()
                if now - last["t"] >= _PUBLISH_EVERY:
                    last["t"] = now
                    publish({"type": "progress", "path": _p,
                             "done": done, "total": total})

            try:
                hf_resumable_download(job.repo_id, path, dest_dir,
                                      repo_type="model", progress=_prog,
                                      stop_event=job.pause_event)
            except DownloadPaused:
                job.status = "paused"
                publish({"type": "paused", "path": path})
                return
            except DownloadFailed as e:
                self._fail(job, path, e)
                return
            except HfHubHTTPError as e:
                # gated / 401 / 404 / 403... (el core deja propagar lo que
                # no mapea a DownloadFailed)
                self._fail(job, path, e)
                return
            except Exception as e:  # noqa: BLE001 — el job debe morir con mensaje
                self._fail(job, path, e)
                return
            # index = archivos completados hasta este evento (1..count);
            # incluye los que se saltaron por estar ya completos.
            publish({"type": "file_done", "path": path,
                     "index": i + 1, "count": count})

        job.status = "done"
        publish({"type": "done", "dest": str(dest_dir)})

    @staticmethod
    def _fail(job: Job, path: str, e: Exception) -> None:
        msg = f"{path}: {e}"
        job.status = "error"
        job.error = msg
        job.events.put({"type": "error", "error": msg})


def _expand_patterns(repo_id: str, files: list[str],
                     repo_type: str = "model") -> list[str]:
    """Expande los glob (paquetes R12) a paths exactos del tree del repo.

    Si la selección no lleva glob, la regresa tal cual sin tocar la red.
    Un patrón sin coincidencias simplemente no aporta archivos.
    """
    has_glob = any(c in f for f in files for c in _GLOB_CHARS)
    if not has_glob:
        return list(files)
    token = get_token()
    api = HfApi(token=token) if token else HfApi()
    tree = [
        item.path
        for item in api.list_repo_tree(repo_id, repo_type=repo_type,
                                       recursive=True)
        if hasattr(item, "path") and hasattr(item, "size")  # sin RepoFolder
    ]
    out: list[str] = []
    for f in files:
        if any(c in f for c in _GLOB_CHARS):
            out.extend(p for p in tree if fnmatch.fnmatch(p, f))
        else:
            out.append(f)
    return out


# Singleton de la APP (1 usuario, proceso único).
manager = DownloadManager()
