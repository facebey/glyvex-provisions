"""Lanzador y verificación de modelos (U15).

El lanzamiento de Provisions es MÍNIMO a propósito: `-m -c -ngl -host -port`
(+ `--tensor-split` en multi). Si falla, la causa es inequívoca — "no cabe" —
no "un flag mal". Las opciones avanzadas viven en la Suite (uso diario) y en
los presets de U16.

Cascada de engines: auto -> suite (runtime gestionado) -> user (ruta
configurada en data/engines.json) -> ollama. Provisions NO descarga ni
gestiona el engine: solo LEE el exe del runtime de la Suite (filesystem,
read-only) o usa lo que el usuario/Ollama ya tiene.

El server queda hijo del backend de Provisions: si la GUI se cierra, el
backend sigue vivo y el server se queda sirviendo ("dejar corriendo"); al
cerrar el backend, el hijo muere con él.

Verificación (mini-benchmark, lo justo para "cabe y responde"):
  llama  -> poll /health -> /v1/models -> chat completions streaming
            (TTFB + tok/s) -> snapshot de VRAM
  ollama -> Modelfile (FROM + num_ctx) + `ollama create` -> /api/chat
            (eval_count/eval_duration, keep_alive -1); stop -> `ollama stop`
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import shutil
import socket
import subprocess
import threading
import time
import uuid
from collections import deque
from pathlib import Path

import httpx2

from . import gguf, hardware, profiles, settings as st, suite
from .paths import DATA_DIR

NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
PORT_BASE = 8080        # default de llama-server; escalera 8080..8129
PORT_ATTEMPTS = 50
HEALTH_TIMEOUT_S = 300  # cargar un GGUF grande en CPU puede tardar
CHAT_TIMEOUT_S = 60
OLLAMA_PORT = 11434
OLLAMA_BASE = f"http://127.0.0.1:{OLLAMA_PORT}"

ENGINES_FILE = DATA_DIR / "engines.json"
OLLAMA_DIR = DATA_DIR / "ollama"

# Estados de una sesión: starting -> verifying -> ready | failed -> stopped
STATES = ("starting", "verifying", "ready", "failed", "stopped")


class EngineUnavailable(Exception):
    pass


class BusyError(Exception):
    pass


class PortBusyError(Exception):
    pass


# ---------------------------------------------------------------------------
# Settings de engines (data/engines.json — mismo patrón que settings/profiles)
# ---------------------------------------------------------------------------


def _engines_disk() -> dict:
    try:
        raw = json.loads(ENGINES_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def get_engines() -> dict:
    d = _engines_disk()
    user = d.get("user_binary")
    return {"user_binary": user if isinstance(user, str) and user.strip() else None}


def save_engines(user_binary: str | None) -> dict:
    ENGINES_FILE.parent.mkdir(parents=True, exist_ok=True)
    ENGINES_FILE.write_text(
        json.dumps({"user_binary": user_binary}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    return get_engines()


# ---------------------------------------------------------------------------
# Detección de engines (cascada)
# ---------------------------------------------------------------------------


def probe_binary(path: str) -> dict:
    """Sondea un llama-server.exe: ¿existe? ¿version? ¿soporta --tensor-split?

    Patrón de la Suite (probe + nunca romper el launch): cualquier fallo
    deja ok=False con un detalle accionable.
    """
    p = Path(path)
    if not p.is_file():
        return {"path": path, "ok": False, "version": None,
                "supports_ts": False, "detail": "el archivo no existe"}
    version = None
    supports_ts = False
    try:
        r = subprocess.run(
            [str(p), "--version"], capture_output=True, text=True,
            timeout=10, creationflags=NO_WINDOW)
        out = (r.stdout or "") + (r.stderr or "")
        for line in out.splitlines():
            if "version" in line.lower() or "b" in line:
                version = line.strip()[:120]
                break
        h = subprocess.run(
            [str(p), "--help"], capture_output=True, text=True,
            timeout=15, creationflags=NO_WINDOW)
        help_out = (h.stdout or "") + (h.stderr or "")
        supports_ts = ("--tensor-split" in help_out or "-ts " in help_out
                       or "\n-ts" in help_out)
        return {"path": path, "ok": True, "version": version,
                "supports_ts": supports_ts, "detail": None}
    except (OSError, subprocess.SubprocessError) as e:
        return {"path": path, "ok": False, "version": None,
                "supports_ts": False, "detail": str(e)[:200]}


def _ollama_alive() -> dict | None:
    try:
        r = httpx2.get(f"{OLLAMA_BASE}/api/version", timeout=2.0)
        if r.status_code == 200:
            return {"running": True, "version": r.json().get("version")}
    except httpx2.HTTPError:
        pass
    return {"running": False, "version": None}


def detect_engines() -> dict:
    """Inventario de engines disponibles + orden de la cascada auto."""
    engines: list[dict] = []
    rt = suite.find_managed_runtime()
    if rt:
        pr = probe_binary(rt["path"])
        engines.append({
            "id": "suite",
            "label": f"Suite — runtime gestionado ({rt['pin']})",
            "kind": "llama", "path": rt["path"], "pin": rt["pin"],
            **pr,
        })
    user = get_engines()["user_binary"]
    if user:
        pr = probe_binary(user)
        engines.append({
            "id": "user", "label": "Binario propio", "kind": "llama",
            "path": user, "pin": None, **pr,
        })
    ol = _ollama_alive()
    engines.append({
        "id": "ollama", "label": "Ollama", "kind": "ollama", "path": None,
        "pin": None,
        "ok": ol["running"], "version": ol.get("version"),
        "supports_ts": False,
        "detail": None if ol["running"] else
        "el daemon de Ollama no está corriendo en 127.0.0.1:11434",
    })
    available = [e["id"] for e in engines
                 if e["ok"] or (e["id"] == "ollama" and ol["running"])]
    return {"engines": engines, "available": available}


def _resolve_engine(requested: str) -> dict:
    """'auto' recorre la cascada; un id explícito debe estar disponible."""
    inv = detect_engines()
    by_id = {e["id"]: e for e in inv["engines"]}
    if requested != "auto":
        e = by_id.get(requested)
        if e is None or not e["ok"]:
            raise EngineUnavailable(
                f"engine {requested!r} no disponible: "
                f"{(e or {}).get('detail') or 'no detectado'}")
        return e
    for cand in ("suite", "user", "ollama"):
        e = by_id.get(cand)
        if e is not None and e["ok"]:
            return e
    raise EngineUnavailable(
        "no hay engine disponible: instalá Glyvex-AI-Suite (runtime "
        "gestionado), configurá un binario propio en Engines, o arrancá Ollama")


# ---------------------------------------------------------------------------
# Puertos, -ngl y comando
# ---------------------------------------------------------------------------


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(wanted: int | None) -> int:
    if wanted:
        if not _port_free(wanted):
            raise PortBusyError(f"el puerto {wanted} ya está en uso")
        return wanted
    for port in range(PORT_BASE, PORT_BASE + PORT_ATTEMPTS):
        if _port_free(port):
            return port
    raise PortBusyError(
        f"no hay puerto libre en {PORT_BASE}..{PORT_BASE + PORT_ATTEMPTS - 1}")


def _model_n_layers(model_path: Path) -> int | None:
    try:
        with open(model_path, "rb") as f:
            head = f.read(gguf.PROBE_CAP)
    except OSError:
        return None
    meta = gguf.parse_header(head)
    if not meta:
        return None
    arch = meta.get("general.architecture")
    v = meta.get(arch + ".block_count") if arch else None
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def compute_ngl(regime: str, caps: dict, model_path: Path) -> dict:
    """-ngl según régimen (decisión U15):
      gpu/multi -> 999 (todo a GPU);  cpu -> 0;
      offload   -> VRAM libre (o total en perfiles manuales R10, que no
                   conectamos) x ok_frac / bytes por capa, tope en n_layer.
    """
    if regime == "cpu":
        return {"ngl": 0, "detail": "todo en CPU"}
    if regime in ("gpu", "multi"):
        return {"ngl": 999, "detail": "todo en GPU (llama.cpp ajusta al real)"}
    if regime != "offload":
        return {"ngl": 0, "detail": None}

    gpus = caps.get("gpus") or []
    free = sum(int(g.get("vram_free_bytes") or 0) for g in gpus)
    total = sum(int(g.get("vram_total_bytes") or 0) for g in gpus)
    if free <= 0:
        # Perfil manual R10 (sin nvidia-smi) o iGPU: se usa la VRAM total.
        free, source = total, "VRAM total (sin lectura de VRAM libre)"
    else:
        source = "VRAM libre"
    if free <= 0:
        return {"ngl": 0, "detail": "sin GPU: offload degrada a CPU"}

    size = model_path.stat().st_size
    n_layer = _model_n_layers(model_path)
    if not n_layer:
        return {"ngl": 0, "detail": "sin header GGUF legible: offload degrada a CPU"}

    ok_frac = st.limits()["ok_frac"]
    per_layer = size / n_layer
    ngl = int(free * ok_frac / per_layer)
    capped = min(ngl, n_layer)
    detail = (f"{source} {free / 2 ** 30:.1f} GB x {ok_frac:.2f} / "
              f"{per_layer / 2 ** 30:.2f} GB/capa -> {capped}/{n_layer} capas en GPU")
    return {"ngl": capped, "detail": detail}


def _tensor_split(caps: dict) -> list[float] | None:
    """Pesos para --tensor-split en multi: VRAM de cada GPU (GiB, relativo)."""
    gpus = caps.get("gpus") or []
    if len(gpus) < 2:
        return None
    vals = [round(g["vram_total_bytes"] / 2 ** 30, 1) for g in gpus
            if g.get("vram_total_bytes")]
    return vals if len(vals) >= 2 else None


def build_command(binary: str, model_path: Path, port: int, ngl: int,
                  n_ctx: int, ts: list[float] | None) -> list[str]:
    """Comando mínimo de verificación (ver docstring del módulo)."""
    cmd = [binary,
           "-m", str(model_path),
           "-c", str(n_ctx),
           "-ngl", str(ngl),
           "--host", "127.0.0.1",
           "--port", str(port)]
    if ts:
        cmd += ["--tensor-split", ",".join(f"{v:g}" for v in ts)]
    return cmd


# ---------------------------------------------------------------------------
# Sesión y manager
# ---------------------------------------------------------------------------


class Session:
    """Una ejecución de llama-server (u Ollama) bajo el backend.

    `events` es la cola SSE (un solo consumidor por vez, patrón de
    descargas); `log` es el tail duradero de la salida del proceso.
    """

    def __init__(self, model_path: Path, engine: dict, port: int,
                 n_ctx: int, ngl: int, regime: str, ngl_detail: str | None,
                 ts: list[float] | None) -> None:
        self.id = f"{time.strftime('%y%m%d')}-{uuid.uuid4().hex[:6]}"
        self.model_path = str(model_path)
        self.engine = engine["id"]
        self.engine_label = engine["label"]
        self.kind = engine["kind"]
        self.binary = engine.get("path")
        self.port = port
        self.n_ctx = n_ctx
        self.ngl = ngl
        self.ngl_detail = ngl_detail
        self.ts = ts
        self.regime = regime
        self.state = "starting"
        self.error: str | None = None
        self.metrics: dict | None = None
        self.ollama_model: str | None = None
        self.started_at = time.time()
        self.process: subprocess.Popen | None = None
        self.log: deque[str] = deque(maxlen=500)
        self.events: queue.Queue = queue.Queue()
        self._lock = threading.Lock()

    def emit(self, ev: dict) -> None:
        self.events.put(ev)

    def log_line(self, line: str) -> None:
        line = line.rstrip("\n")
        if line:
            self.log.append(line)
            self.emit({"type": "log", "line": line})

    def set_state(self, state: str, error: str | None = None) -> None:
        with self._lock:
            self.state = state
            if error:
                self.error = error
        self.emit({"type": "state", "state": state, "error": self.error,
                   "metrics": self.metrics})

    def snapshot(self, tail: int = 60) -> dict:
        return {
            "id": self.id, "model_path": self.model_path, "engine": self.engine,
            "engine_label": self.engine_label, "kind": self.kind,
            "port": self.port, "n_ctx": self.n_ctx, "ngl": self.ngl,
            "ngl_detail": self.ngl_detail, "ts": self.ts, "regime": self.regime,
            "state": self.state, "error": self.error, "metrics": self.metrics,
            "ollama_model": self.ollama_model,
            "uptime_s": int(time.time() - self.started_at),
            "log_tail": list(self.log)[-tail:],
        }


def _vram_snapshot() -> list[dict]:
    """VRAM real tras la verificación (solo NVIDIA reporta libre)."""
    try:
        hw = hardware.detect()
        return [
            {"name": g["name"], "total_gb": round(g["vram_total_bytes"] / 2 ** 30, 1),
             "free_gb": round(g.get("vram_free_bytes", 0) / 2 ** 30, 1)}
            for g in hw.get("gpus", []) if g.get("vram_total_bytes")
        ]
    except Exception:
        return []


def _chat_probe(base: str, model_id: str) -> dict:
    """Mini-benchmark vía chat completions streaming: TTFB + tok/s."""
    payload = {
        "model": model_id,
        "messages": [{"role": "user",
                      "content": "Responde únicamente con la palabra OK."}],
        "max_tokens": 48,
        "temperature": 0,
        "stream": True,
    }
    ttfb_ms: float | None = None
    n_tokens = 0
    first = last = time.monotonic()
    with httpx2.Client(timeout=httpx2.Timeout(
            connect=10.0, read=CHAT_TIMEOUT_S, write=10.0, pool=10.0)) as client:
        with client.stream("POST", f"{base}/v1/chat/completions",
                           json=payload) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = chunk.get("choices") or []
                delta = (choices[0].get("delta") or {}) if choices else {}
                if delta.get("content"):
                    if ttfb_ms is None:
                        ttfb_ms = (time.monotonic() - first) * 1000
                    n_tokens += 1
                    last = time.monotonic()
    gen_s = last - (first + (ttfb_ms or 0) / 1000)
    tok_s = round(n_tokens / gen_s, 2) if n_tokens and gen_s > 0 else None
    return {"ttfb_ms": round(ttfb_ms) if ttfb_ms else None,
            "tokens": n_tokens, "tok_s": tok_s}


def _verify_llama(s: Session) -> None:
    base = f"http://127.0.0.1:{s.port}"
    deadline = time.time() + HEALTH_TIMEOUT_S
    try:
        # 1) el server termina de cargar el modelo (health 200)
        with httpx2.Client(timeout=3.0) as client:
            while time.time() < deadline:
                if s.process is not None and s.process.poll() is not None:
                    tail = " | ".join(list(s.log)[-5:])
                    s.set_state("failed",
                                f"el proceso terminó al cargar (code={s.process.returncode}); {tail}")
                    return
                try:
                    if client.get(f"{base}/health").status_code == 200:
                        break
                except httpx2.HTTPError:
                    pass
                time.sleep(2)
            else:
                s.set_state("failed",
                            f"timeout de carga ({HEALTH_TIMEOUT_S}s): el modelo "
                            "no terminó de cargar en este hardware")
                return

            # 2) id del modelo servido
            models = client.get(f"{base}/v1/models").json().get("data") or []
            if not models:
                s.set_state("failed", "el server no reporta ningún modelo")
                return
            model_id = models[0].get("id", "local")

        s.set_state("verifying")
        s.log_line(f"[prov] cargado: {model_id} — mini-benchmark…")

        # 3) primer token + velocidad de generación
        probe = _chat_probe(base, model_id)

        # 4) VRAM real (post-verificación)
        s.metrics = {**probe, "vram": _vram_snapshot(), "model_id": model_id}
        s.set_state("ready")
        s.log_line("[prov] verificación OK — el server queda corriendo "
                   f"en 127.0.0.1:{s.port}")
    except httpx2.HTTPError as e:
        s.set_state("failed", f"error HTTP contra el server: {e}"[:300])
    except Exception as e:  # noqa: BLE001 — el estado final es lo que importa
        s.set_state("failed", f"error en verificación: {e}"[:300])


def _ollama_model_name(model_path: Path) -> str:
    h = hashlib.sha1(str(model_path.resolve()).encode("utf-8")).hexdigest()[:8]
    return f"prov-{h}"


def _verify_ollama(s: Session) -> None:
    name = _ollama_model_name(Path(s.model_path))
    s.ollama_model = name
    try:
        # 1) Modelfile: FROM + num_ctx (la verificación también es mínima)
        OLLAMA_DIR.mkdir(parents=True, exist_ok=True)
        mf = OLLAMA_DIR / f"{name}.Modelfile"
        mf.write_text(f"FROM {Path(s.model_path).as_posix()}\n"
                      f"PARAMETER num_ctx {s.n_ctx}\n", encoding="utf-8")
        s.log_line(f"[prov] ollama create {name}…")
        r = subprocess.run(
            ["ollama", "create", name, "-f", str(mf)],
            capture_output=True, text=True, timeout=900, creationflags=NO_WINDOW)
        for line in ((r.stdout or "") + (r.stderr or "")).splitlines()[:20]:
            s.log_line(f"[ollama] {line}")
        if r.returncode != 0:
            s.set_state("failed", f"ollama create falló (code={r.returncode})")
            return

        # 2) chat: eval_count/eval_duration dan el tok/s; keep_alive -1 =
        #    el modelo queda cargado ("dejar corriendo" en Ollama).
        s.set_state("verifying")
        first = time.monotonic()
        res = httpx2.post(
            f"{OLLAMA_BASE}/api/chat",
            json={"model": name,
                  "messages": [{"role": "user",
                                "content": "Responde únicamente con la palabra OK."}],
                  "stream": False, "keep_alive": "-1",
                  "options": {"num_ctx": s.n_ctx, "temperature": 0}},
            timeout=httpx2.Timeout(
                connect=10.0, read=max(CHAT_TIMEOUT_S, 300),
                write=10.0, pool=10.0)).json()
        total_s = time.monotonic() - first
        eval_n = int(res.get("eval_count") or 0)
        eval_ns = int(res.get("eval_duration") or 0)
        s.metrics = {
            "ttfb_ms": round(total_s * 1000),  # sin streaming: tiempo total
            "tokens": eval_n,
            "tok_s": round(eval_n / (eval_ns / 1e9), 2) if eval_ns else None,
            "vram": _vram_snapshot(),
            "model_id": name,
            "response": (res.get("message") or {}).get("content", "")[:200],
        }
        s.set_state("ready")
        s.log_line(f"[prov] verificación OK — {name} queda cargado en Ollama "
                   "(keep_alive -1)")
    except httpx2.HTTPError as e:
        s.set_state("failed", f"Ollama: error HTTP: {e}"[:300])
    except FileNotFoundError:
        s.set_state("failed", "el binario `ollama` no está en el PATH")
    except subprocess.SubprocessError as e:
        s.set_state("failed", f"ollama create: {e}"[:300])
    except Exception as e:  # noqa: BLE001
        s.set_state("failed", f"error en verificación: {e}"[:300])


class Manager:
    """Sesión única activa (BusyError) — un server a la vez en Provisions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.current: Session | None = None

    def busy(self) -> bool:
        return (self.current is not None
                and self.current.state in ("starting", "verifying", "ready"))

    def launch(self, model_path: str, engine: str, profile_id: str,
               regime: str, context: int, port: int | None) -> Session:
        with self._lock:
            if self.busy():
                raise BusyError("ya hay una sesión activa: detenéla antes "
                                "de lanzar otra")
            p = Path(model_path)
            if not p.is_file():
                raise ValueError(f"archivo inexistente: {p}")
            eng = _resolve_engine(engine)
            caps = profiles.caps_for(profile_id)
            if caps is None:
                raise ValueError(f"perfil inexistente: {profile_id}")
            ngl_info = compute_ngl(regime, caps, p)
            ts = _tensor_split(caps) if regime == "multi" else None
            if ts and eng.get("supports_ts") is False:
                # El probe dijo que el binario no conoce -ts: se degrada.
                ts = None
            port = _pick_port(port)
            s = Session(p, eng, port, context, ngl_info["ngl"], regime,
                        ngl_info["detail"], ts)
            self.current = s

            if eng["kind"] == "llama":
                cmd = build_command(eng["path"], p, port, s.ngl, context, ts)
                s.log_line("[prov] $ " + " ".join(
                    '"' + c + '"' if " " in c else c for c in cmd))
                s.process = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace",
                    creationflags=NO_WINDOW)

                def _reader():
                    assert s.process is not None and s.process.stdout
                    for line in s.process.stdout:
                        s.log_line(line)

                threading.Thread(target=_reader, daemon=True).start()
                threading.Thread(target=_verify_llama, args=(s,),
                                 daemon=True).start()
            else:
                threading.Thread(target=_verify_ollama, args=(s,),
                                 daemon=True).start()
            s.emit({"type": "launched", "id": s.id, "port": port,
                    "engine": eng["id"], "ngl": s.ngl})
            return s

    def stop(self) -> dict:
        with self._lock:
            s = self.current
            if s is None or s.state in ("failed", "stopped"):
                return {"stopped": False, "state": (s.state if s else "none")}
            try:
                if s.kind == "llama" and s.process is not None \
                        and s.process.poll() is None:
                    s.log_line("[prov] deteniendo llama-server…")
                    s.process.terminate()
                    try:
                        s.process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        s.process.kill()
                        s.process.wait(timeout=5)
                elif s.kind == "ollama" and s.ollama_model:
                    r = subprocess.run(
                        ["ollama", "stop", s.ollama_model],
                        capture_output=True, text=True, timeout=30,
                        creationflags=NO_WINDOW)
                    s.log_line(f"[prov] ollama stop {s.ollama_model} "
                               f"(code={r.returncode})")
            except (OSError, subprocess.SubprocessError) as e:
                s.log_line(f"[prov] error al detener: {e}")
            s.set_state("stopped")
            return {"stopped": True, "state": "stopped"}

    def snapshot(self, tail: int = 60) -> dict | None:
        s = self.current
        return s.snapshot(tail=tail) if s else None


manager = Manager()
