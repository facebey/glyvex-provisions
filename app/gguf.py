"""Parser mínimo de cabeceras GGUF para la estimación v2 (U6-4).

Solo `struct` (cero dependencias nuevas). Consume el prefijo que obtiene el
core (`resumable.prefetch_head`, HTTP Range). Si la cabecera no cabe en el
prefijo o la arquitectura no es una atención transformer estándar, devuelve
None y la estimación degrada a v1 (tamaño x margen): mejor sin cifra que
una cifra mala.

Medido en archivos reales (2026-10-26): los hparams de atención
(`<arch>.block_count`, `<arch>.embedding_length`, `<arch>.attention.*`)
viven en un bloque contiguo ~1 KB al inicio de la metadata, ANTES de los
arrays del tokenizer (150k+ strings, 2-3 MB). El parser recorre la metadata
y se detiene al terminar ese bloque (primera clave fuera de `<arch>.` tras
reunir las necesarias), así que un prefijo de 1 MB sobra y nunca se toca el
vocabulario. Prefijo truncado dentro del bloque -> None (nunca KV parcial).

Layout GGUF v2/v3 little-endian (spec oficial ggml; verificado en archivos
reales; NO confundir con el orden alternativo STRING=11/ARRAY=12):
  "GGUF" | version u32 | n_tensors u64 | n_kv u64 | n_kv metadata | tensors
  metadata: key(string) | vtype u32 | value
  vtype: 0 u8 | 1 i8 | 2 u16 | 3 i16 | 4 u32 | 5 i32 | 6 f32 | 7 bool |
         8 string(len u64+utf8) | 9 array(elem vtype u32 + count u64) |
         10 u64 | 11 i64 | 12 f64

KV por capa (alineado con la Suite, backend/vram_estimate.py, commit
6e0017a "EST-SWA"; llama.cpp como referencia de medida): cada capa de
atención reserva window x kv_heads x (dim_K + dim_V) x 2 bytes, con
window = contexto en atención completa y min(contexto, sliding_window)
en las capas marcadas por <arch>.attention.sliding_window_pattern (solo
el escalar sliding_window = SWA uniforme en todas las capas). En gemma4
los heads cambian POR CAPA (head_count_kv es un array i32: se
materializa hasta _MAX_SCALAR_ARRAY, igual que la Suite). Híbridos SSM
(full_attention_interval=N): las capas no-atención no crecen con el
contexto — se suma su estado recurrente FIJO (ssm.*, fp32). Sin esos
campos el resultado es idéntico al modelo denso:
  kv/token = capas x heads_kv x (dim_K + dim_V) x 2 bytes, dims
  explícitos via attention.key_length/value_length si existen; si no,
  head_dim = embedding_length / head_count. Sin campos mínimos: None.

U23 (fix de arranque 2026-11-07): `resumable` (que a su vez importa
huggingface_hub + httpx2) se carga DIFERIDO en `repo_gguf_meta`: solo hace
falta al sondear una cabecera GGUF, no al arrancar el sidecar.
"""
from __future__ import annotations

import struct

PROBE_CAP = 1024 * 1024  # el bloque de hparams termina ~1 KB; 1 MB sobra
KV_DTYPE_BYTES = 2       # cache F16, default de llama.cpp (k_cache_type)
# Arrays de scalares que se materializan como lista (head_count_kv y
# sliding_window_pattern por capa en gemma4); los más grandes solo se
# saltan (misma regla _GGUF_MAX_SCALAR_ARRAY que la Suite).
_MAX_SCALAR_ARRAY = 4096

_T = struct.Struct
_FMT = {  # vtype oficial -> (formato struct, tamaño)
    0: _T("=B"), 1: _T("=b"), 2: _T("=H"), 3: _T("=h"), 4: _T("=I"),
    5: _T("=i"), 6: _T("=f"), 7: _T("=B"),
    # 8 string / 9 array se manejan aparte; 10/11/12:
    10: _T("=Q"), 11: _T("=q"), 12: _T("=d"),
}
_T_STRING, _T_ARRAY = 8, 9

# Claves necesarias para estimar KV (prefijo tras "<arch>.")
_REQ_KEYS = (".block_count", ".attention.head_count", ".embedding_length")
# Opcionales del mismo bloque: GQA y dims de cabeza, Sliding Window
# Attention (gemma4/gemma3: head_count_kv y sliding_window_pattern son
# arrays POR CAPA) y estado recurrente de híbridos SSM.
_OPT_KEYS = (".attention.layer_count_kv", ".attention.head_count_kv",
             ".attention.key_length", ".attention.value_length",
             ".attention.key_length_swa", ".attention.value_length_swa",
             ".attention.sliding_window", ".attention.sliding_window_pattern",
             ".full_attention_interval",
             ".ssm.inner_size", ".ssm.state_size", ".ssm.conv_kernel")

# Meta por REPO (no por archivo): todos los quant de un modelo comparten
# hparams; sondear cada archivo repetiría la red por nada. Negativos también
# cacheados.
_META_CACHE: dict[str, dict | None] = {}


def repo_gguf_meta(repo_id: str, weight_paths: list[str]) -> dict | None:
    """Metadatos de arquitectura desde el primer GGUF parseable del repo.

    Cacheado por proceso. Ante cualquier fallo de red/gated/truncado
    devuelve None: el llamador degrada a v1, nunca rompe.
    """
    if repo_id in _META_CACHE:
        return _META_CACHE[repo_id]
    # U23: diferido — el core resumable (huggingface_hub + httpx2) solo se
    # carga al sondear la cabecera, no al arrancar el sidecar.
    from resumable import prefetch_head
    meta: dict | None = None
    for p in weight_paths:
        head = prefetch_head(repo_id, p, PROBE_CAP)
        if head:
            meta = parse_header(head)
            if meta:
                break
    _META_CACHE[repo_id] = meta
    return meta


class _Truncated(Exception):
    """El prefijo terminó a mitad de la cabecera."""


class _Reader:
    __slots__ = ("b", "i")

    def __init__(self, buf: bytes) -> None:
        self.b = buf
        self.i = 0

    def take(self, n: int) -> bytes:
        j = self.i + n
        if j > len(self.b):
            raise _Truncated()
        s = self.b[self.i:j]
        self.i = j
        return s

    def u32(self) -> int:
        return _T("=I").unpack(self.take(4))[0]

    def u64(self) -> int:
        return _T("=Q").unpack(self.take(8))[0]


def _read_value(r: _Reader, vtype: int, keep: bool):
    """Consume un valor GGUF. Con keep=False solo avanza el offset sin
    materializar; los arrays de scalares se saltan en bloque (el vocabulario
    puede tener 150k+ elementos). Con keep=True los arrays de scalares
    chicos (<= _MAX_SCALAR_ARRAY) se materializan como lista: los hparams
    por capa de gemma4 (head_count_kv, sliding_window_pattern) caben de
    sobra; los arrays del tokenizer siguen sin leerse."""
    fmt = _FMT.get(vtype)
    if fmt is not None:
        raw = r.take(fmt.size)
        return fmt.unpack(raw)[0] if keep else None
    if vtype == _T_STRING:
        n = r.u64()
        raw = r.take(n)
        return raw.decode("utf-8", "replace") if keep and n < 1024 else None
    if vtype == _T_ARRAY:
        elem = r.u32()
        count = r.u64()
        esz = _FMT[elem].size if elem in _FMT else None
        if esz is not None:
            raw = r.take(esz * count)  # array de scalares: salto en bloque
            if keep and 0 < count <= _MAX_SCALAR_ARRAY:
                ef = _FMT[elem]
                return [ef.unpack_from(raw, off)[0]
                        for off in range(0, len(raw), esz)]
        else:
            for _ in range(count):  # strings u arrays anidados
                _read_value(r, elem, False)
        return None
    raise ValueError(f"vtype GGUF desconocido: {vtype}")


def parse_header(head: bytes | None) -> dict | None:
    """Cabecera GGUF -> dict con general.architecture + hparams del bloque
    de atención. None si no es GGUF v2/v3 o si el prefijo se trunca dentro
    del bloque de hparams (jamás se devuelve una KV potencialmente parcial).

    El corte es al FINAL del bloque de atención: tras reunir las claves
    necesarias se sigue leyendo mientras las claves pertenezcan a `<arch>.`
    (ahí viven head_count_kv/layer_count_kv de los modelos GQA), y se
    termina en la primera clave fuera del bloque (general.file_type,
    tokenizer...: los arrays del vocabulario nunca se leen).
    """
    if not head or len(head) < 24 or head[:4] != b"GGUF":
        return None
    r = _Reader(head)
    r.take(4)
    meta: dict = {}
    arch: str | None = None
    try:
        version = r.u32()
        if version < 2:  # v1 (longitudes u32) es legado: fuera de scope
            return None
        r.u64()  # n_tensors (la info de tensors no hace falta para KV)
        n_kv = r.u64()
        for _ in range(n_kv):
            klen = r.u64()
            if klen > 4096:
                return None  # key absurda: cabecera corrupta o descuadrada
            key = r.take(klen).decode("utf-8", "replace")
            if (arch is not None and not key.startswith(arch + ".")
                    and all(arch + k in meta for k in _REQ_KEYS)):
                break  # fin del bloque de atención: lo necesario ya está
            vtype = r.u32()
            interesting = (key == "general.architecture" or (
                arch is not None and key in
                (arch + k for k in _REQ_KEYS + _OPT_KEYS)))
            val = _read_value(r, vtype, keep=interesting)
            if key == "general.architecture":
                if not isinstance(val, str) or not val:
                    return None
                arch = val
                meta[key] = val
            elif interesting and (
                    (isinstance(val, (int, float)) and not isinstance(val, bool))
                    # Arrays por capa de gemma4: head_count_kv (i32) y
                    # sliding_window_pattern (bool); se guardan tal cual.
                    or (isinstance(val, list) and val and all(
                        isinstance(x, (int, float)) for x in val))):
                meta[key] = val
        return meta if arch else None
    except (_Truncated, ValueError, struct.error):
        # Prefijo corto o cabecera rara: v2 no aplica, el llamador degrada a v1.
        return None


def kv_cache_bytes(meta: dict | None, context: int) -> tuple[int, str] | None:
    """(bytes_kv_para_context, detalle_humano) | None si no se puede estimar.

    Modelo por capa (alineado con la Suite, backend/vram_estimate.py,
    commit 6e0017a "EST-SWA"): cada capa de atención suma
    window x kv_heads x (dim_K + dim_V) x KV_DTYPE_BYTES, con window =
    contexto en atención completa y min(contexto, sliding_window) en las
    capas del patrón (sliding_window escalar solo = SWA uniforme). En
    gemma4 kv_heads cambia por capa (head_count_kv array). Híbridos SSM
    (full_attention_interval=N): las capas SSM no crecen con el contexto;
    se suma su estado recurrente fijo (ssm.*, fp32). Sin esos campos el
    resultado es idéntico al modelo denso plano.
    """
    if not meta:
        return None
    arch = meta.get("general.architecture")
    if not arch:
        return None

    def num(suffix: str) -> int | None:
        v = meta.get(arch + suffix)
        if isinstance(v, list):
            v = v[0] if v else None  # array -> primera capa (regla Suite)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        return int(v) if v and v > 0 else None

    def layer_arr(suffix: str, allow_bool: bool = False) -> list | None:
        v = meta.get(arch + suffix)
        if not (isinstance(v, list) and v):
            return None
        for x in v:
            if not isinstance(x, (int, float)) or (isinstance(x, bool)
                                                   and not allow_bool):
                return None
        return v

    layers = num(".attention.layer_count_kv") or num(".block_count")
    heads = num(".attention.head_count")
    heads_kv = num(".attention.head_count_kv") or heads
    kdim = num(".attention.key_length")
    vdim = num(".attention.value_length")
    if kdim and vdim:
        full_dims = kdim + vdim  # dims explícitas por cabeza K/V
        head_note = f"K{kdim}+V{vdim}"
    else:
        hidden = num(".embedding_length")
        if not hidden or not heads:
            return None
        head_dim = hidden // heads
        if head_dim <= 0:
            return None
        full_dims = 2 * head_dim
        head_note = f"2x{head_dim} (head_dim)"
    if not (layers and heads_kv):
        return None

    # Campos por capa (ausentes en los densos: el bucle degenera a la
    # fórmula plana y el total queda idéntico al de antes del port).
    interval = num(".full_attention_interval")
    swa_window = num(".attention.sliding_window")
    pattern = layer_arr(".attention.sliding_window_pattern", allow_bool=True)
    kv_heads_layers = layer_arr(".attention.head_count_kv")
    swa_dim = num(".attention.key_length_swa")

    n_ssm = n_swa = kv_units = 0
    for i in range(layers):
        if interval and interval > 1 and (i + 1) % interval != 0:
            n_ssm += 1  # estado recurrente fijo: no crece con el contexto
            continue
        # Sin patrón por capa, sliding_window escalar = SWA uniforme
        # (mistral/gemma2 deslizan en todas); patrón más corto que n_layer
        # se completa como atención completa (no inventar patrones).
        if pattern is not None and i < len(pattern):
            sliding = bool(pattern[i])
        else:
            sliding = swa_window is not None and swa_window > 0
        window = min(context, swa_window) if sliding and swa_window else context
        kv_heads = (kv_heads_layers[i] if kv_heads_layers
                    and i < len(kv_heads_layers) else heads_kv)
        dims = 2 * swa_dim if sliding and swa_window and swa_dim else full_dims
        if sliding and swa_window:
            n_swa += 1
        kv_units += window * int(kv_heads) * int(dims)

    ssm_bytes = 0
    if n_ssm:
        inner, state = num(".ssm.inner_size"), num(".ssm.state_size")
        if inner and state:  # sin params SSM: 0 (mejor subestimar)
            conv = num(".ssm.conv_kernel") or 0
            ssm_bytes = n_ssm * inner * (state + conv) * 4
    total = kv_units * KV_DTYPE_BYTES + ssm_bytes

    if n_ssm or n_swa:
        parts = []
        if n_swa:
            parts.append(f"{n_swa} SWA@{swa_window}")
        parts.append(f"{layers - n_swa - n_ssm} full")
        if n_ssm:
            parts.append(f"{n_ssm} SSM ({ssm_bytes // (1024 * 1024)} MiB fijos)")
        return total, (f"{arch}: {layers} capas ({' + '.join(parts)}) "
                       f"x heads/dims por capa F16")

    per_token = layers * heads_kv * full_dims * KV_DTYPE_BYTES
    return total, (f"{arch}: {layers} capas x {heads_kv} heads KV x "
                   f"{head_note} F16 = {per_token // 1024} KiB/token")
