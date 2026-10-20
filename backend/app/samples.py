"""Bundled sample labels used by the demo and the test matrix."""

from __future__ import annotations

import json
from pathlib import Path

from app.models import SampleSummary

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_DIR = ROOT / "sample-data"
CATALOG_PATH = SAMPLE_DIR / "applications.json"


def load_samples() -> list[SampleSummary]:
    if not CATALOG_PATH.is_file():
        return []
    payload = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    rows = payload.get("samples", payload if isinstance(payload, list) else [])
    samples = []
    for row in rows:
        samples.append(SampleSummary.model_validate(row))
    return samples


def find_sample(sample_id: str) -> SampleSummary | None:
    for sample in load_samples():
        if sample.id == sample_id:
            return sample
    return None


def sample_path(sample: SampleSummary) -> Path:
    return SAMPLE_DIR / "labels" / sample.filename
