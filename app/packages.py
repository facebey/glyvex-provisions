"""Paquetes de modelos por escenario (R12, unidad 5).

- Los manifiestos son archivos .json de texto plano en
  `<storage>\\packajes\\`: editables con cualquier editor, copiables entre
  servers de la empresa y versionables en git. El storage y sus paquetes
  viajan juntos.
- Manifiesto: {name, scenario?, profile?, files[]}. Cada entrada es
  {repo_id, file} (archivo exacto del repo) o {repo_id, pattern} (glob,
  p. ej. "*Q4_K_M.gguf" para tomar TODAS las cuantizaciones Q4_K_M).
- Descargar un paquete = 1 job por repo único (destino = el storage del
  paquete). Los glob se expanden a paths exactos contra el tree del repo en
  `downloads.submit` (solo si hay glob: sin `*?[` no se toca la red); el
  downloader del core recibe la lista ya resuelta.
- profile/scenario son metadatos del escenario: no afectan la descarga.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from pydantic import BaseModel, Field, model_validator

PACKAGES_DIRNAME = "packajes"
MAX_FILES = 500  # cap de entradas por manifiesto


class PackageFile(BaseModel):
    """Entrada del manifiesto: repo + archivo exacto O patrón glob."""

    repo_id: str = Field(min_length=1, max_length=200)
    file: str | None = Field(default=None, min_length=1, max_length=300)
    pattern: str | None = Field(default=None, min_length=1, max_length=300)

    @model_validator(mode="after")
    def _exactly_one(self) -> "PackageFile":
        if (self.file is None) == (self.pattern is None):
            raise ValueError(
                f"{self.repo_id}: cada entrada lleva un archivo exacto "
                "(file) o un patrón glob (pattern), no ambos"
            )
        return self


class Package(BaseModel):
    """Forma del manifiesto en disco: <storage>\\packajes\\<id>.json."""

    name: str = Field(min_length=1, max_length=80)
    scenario: str | None = Field(default=None, max_length=200)
    profile: str | None = Field(default=None, max_length=80)
    files: list[PackageFile] = Field(min_length=1, max_length=MAX_FILES)


def packages_dir(root: Path) -> Path:
    return root / PACKAGES_DIRNAME


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "paquete"


def _safe_id(package_id: str) -> str:
    """El id es un nombre de archivo plano: sin separadores de path ni
    puntos dobles (evita path traversal)."""
    if (
        not package_id
        or package_id in (".", "..")
        or "/" in package_id
        or "\\" in package_id
        or ":" in package_id
    ):
        raise ValueError(f"package id inválido: {package_id!r}")
    return package_id


def _read_file(f: Path) -> dict:
    """Lee un manifiesto devolviéndolo con id + error (null si es válido).
    Los JSON/manifiestos inválidos vuelven con la bandera error en vez de
    romper el listado: la UI los muestra pero no los deja descargar."""
    data = {
        "id": f.stem,
        "name": f.stem,
        "scenario": None,
        "profile": None,
        "files": [],
        "error": None,
    }
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
        pkg = Package.model_validate(raw)
    except json.JSONDecodeError as e:
        data["error"] = f"JSON inválido: {e}"
        return data
    except Exception as e:  # pydantic.ValidationError
        data["error"] = "manifiesto inválido: " + str(e).split("\n")[0][:200]
        return data
    data.update(
        name=pkg.name,
        scenario=pkg.scenario,
        profile=pkg.profile,
        files=[x.model_dump(exclude_none=True) for x in pkg.files],
    )
    return data


def list_packages(root: Path) -> list[dict]:
    """Escanea <storage>\\packajes\\*.json (ordenado). Carpeta inexistente
    = sin paquetes (no es error)."""
    pdir = packages_dir(root)
    if not pdir.is_dir():
        return []
    return [_read_file(f) for f in sorted(pdir.glob("*.json"))]


def create_package(root: Path, body: Package) -> dict:
    """Escribe el manifiesto en <storage>\\packajes\\<slug>.json (sufijo
    -N si el id ya existe). Crea la carpeta si hace falta."""
    pdir = packages_dir(root)
    pdir.mkdir(parents=True, exist_ok=True)
    base = _slug(body.name)
    pid, n = base, 2
    while (pdir / f"{pid}.json").exists():
        pid = f"{base}-{n}"
        n += 1
    payload = body.model_dump(exclude_none=True)
    f = pdir / f"{pid}.json"
    f.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return _read_file(f)


def read_package(root: Path, package_id: str) -> dict | None:
    """Manifiesto validado para descargar. None si no existe; ValueError si
    existe pero no es un manifiesto válido."""
    pid = _safe_id(package_id)
    f = packages_dir(root) / f"{pid}.json"
    if not f.is_file():
        return None
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
        pkg = Package.model_validate(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"manifiesto inválido (JSON): {e}") from None
    except Exception as e:  # pydantic.ValidationError
        raise ValueError(
            "manifiesto inválido: " + str(e).split("\n")[0][:200]
        ) from None
    return pkg.model_dump(exclude_none=True)


def delete_package(root: Path, package_id: str) -> bool:
    pid = _safe_id(package_id)
    f = packages_dir(root) / f"{pid}.json"
    if not f.is_file():
        return False
    f.unlink()
    return True
