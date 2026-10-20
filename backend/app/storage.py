"""Local image files for the checklist. Deleted after two hours."""

from __future__ import annotations

import re
import time
import uuid
from pathlib import Path

from app.pipeline.constants import IMAGE_TTL_SECONDS

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "data" / "uploads"

_ID = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


def save_image(job_id: str, filename: str, data: bytes) -> str:
    folder = STORE / job_id
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex[:8]}_{_safe_filename(filename)}"
    (folder / name).write_bytes(data)
    return f"/api/jobs/{job_id}/images/{name}"


def resolve_image(job_id: str, name: str) -> Path:
    if not _ID.match(job_id) or not _NAME.match(name):
        raise FileNotFoundError(name)
    path = (STORE / job_id / name).resolve()
    root = STORE.resolve()
    if root != path and root not in path.parents:
        raise FileNotFoundError(name)
    if not path.is_file():
        raise FileNotFoundError(name)
    return path


def purge_expired(now: float | None = None) -> int:
    if not STORE.exists():
        return 0
    moment = time.time() if now is None else now
    removed = 0
    for folder in STORE.iterdir():
        if not folder.is_dir():
            continue
        try:
            age = moment - folder.stat().st_mtime
        except OSError:
            continue
        if age < IMAGE_TTL_SECONDS:
            continue
        for child in folder.iterdir():
            try:
                child.unlink()
            except OSError:
                pass
        try:
            folder.rmdir()
            removed += 1
        except OSError:
            pass
    return removed


def _safe_filename(filename: str) -> str:
    base = Path(filename or "label").name
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")[:80]
    return cleaned or "label"
