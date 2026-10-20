"""Run one label from raw bytes to a checklist."""

from __future__ import annotations

import time

import cv2
import numpy as np

from app.models import LabelApplication, VerificationResult
from app.pipeline.constants import LATENCY_BUDGET_MS, MAX_FILE_BYTES
from app.pipeline.ocr import measure_style, recognize
from app.pipeline.preprocess import downscale, preprocess
from app.pipeline.verifier import verify_document


class ImageRejected(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


def verify_bytes(
    data: bytes,
    application: LabelApplication,
    filename: str = "label",
) -> VerificationResult:
    started = time.perf_counter()
    gray = _prepare(data)
    document = recognize(gray)
    signals = measure_style(gray, document)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return verify_document(
        document,
        application,
        filename=filename,
        elapsed_ms=elapsed_ms,
        signals=signals,
        latency_budget_ms=LATENCY_BUDGET_MS,
    )


def _prepare(data: bytes):
    if not data:
        raise ImageRejected("This file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise ImageRejected("This image is larger than 8 MB. Export a smaller JPG or PNG.")
    array = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ImageRejected("This file doesn't look like an image. Use a JPG or PNG photo.")
    return preprocess(downscale(image))
