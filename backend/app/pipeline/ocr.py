"""Tesseract OCR behind a small interface.

A future cloud vision provider can implement recognize() the same way.
Nothing in this module opens a network connection.
"""

from __future__ import annotations

import shutil
from statistics import median

import cv2
import numpy as np
import pytesseract

from app.models import ImageSignals, OcrDocument, OcrWord

class ScannerUnavailable(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def tesseract_version() -> str | None:
    if not tesseract_available():
        return None
    try:
        return str(pytesseract.get_tesseract_version())
    except Exception:
        return None


def recognize(gray: np.ndarray) -> OcrDocument:
    if not tesseract_available():
        raise ScannerUnavailable(
            "The text scanner is not installed on this machine. Install Tesseract and try again."
        )
    primary = _recognize_once(gray, psm=6, timeout=4)
    if _is_weak(primary):
        # A second page-segmentation mode only when the first pass found almost nothing.
        try:
            alternate = _recognize_once(gray, psm=4, timeout=3)
        except Exception:
            alternate = None
        if alternate is not None and _richness(alternate) > _richness(primary):
            return alternate
    return primary


def measure_style(gray: np.ndarray, document: OcrDocument) -> ImageSignals:
    """Estimate whether the warning header is bold and how small the type is.

    The estimate is used only when it is obvious. An unclear measurement is
    left blank so a good label is not sent to review over a weak guess.
    """
    lines: dict[int, list[OcrWord]] = {}
    for word in document.words:
        if word.text.strip():
            lines.setdefault(word.line_id, []).append(word)
    if not lines:
        return ImageSignals()

    header_id = _warning_line_id(lines)
    brand_height = _tallest_height(lines)
    warning_height = None
    bold: bool | None = None

    if header_id is not None:
        header_words = lines.get(header_id, [])
        warning_height = _median_height(header_words)
        body_words = lines.get(header_id + 1, [])
        header_stroke = _median_stroke(gray, header_words)
        body_stroke = _median_stroke(gray, body_words)
        if header_stroke and body_stroke:
            if header_stroke >= body_stroke * 1.35:
                bold = True
            elif header_stroke <= body_stroke * 0.75:
                bold = False

    return ImageSignals(
        warning_bold=bold,
        warning_height_px=warning_height,
        brand_height_px=brand_height,
    )


def _recognize_once(gray: np.ndarray, psm: int, timeout: int) -> OcrDocument:
    config = f"--oem 1 --psm {psm}"
    try:
        data = pytesseract.image_to_data(
            gray,
            lang="eng",
            config=config,
            output_type=pytesseract.Output.DICT,
            timeout=timeout,
        )
    except Exception as exc:
        if _is_missing_scanner(exc):
            raise ScannerUnavailable(
                "The text scanner is not installed on this machine. Install Tesseract and try again."
            ) from exc
        return OcrDocument(text="", words=[], mean_confidence=0)

    grouped: dict[tuple[int, int, int], list[OcrWord]] = {}
    count = len(data["text"])
    for index in range(count):
        raw = data["text"][index]
        text = raw.strip() if isinstance(raw, str) else ""
        if not text:
            continue
        try:
            confidence = float(data["conf"][index])
        except (TypeError, ValueError):
            confidence = -1
        if confidence < 0:
            continue
        key = (
            int(data["block_num"][index]),
            int(data["par_num"][index]),
            int(data["line_num"][index]),
        )
        word = OcrWord(
            text=text,
            confidence=confidence,
            left=int(data["left"][index]),
            top=int(data["top"][index]),
            width=int(data["width"][index]),
            height=int(data["height"][index]),
        )
        grouped.setdefault(key, []).append(word)

    ordered_keys = sorted(
        grouped,
        key=lambda item: (min(word.top for word in grouped[item]), min(word.left for word in grouped[item])),
    )
    words: list[OcrWord] = []
    lines: list[str] = []
    for line_id, key in enumerate(ordered_keys):
        row = sorted(grouped[key], key=lambda word: word.left)
        for word in row:
            word.line_id = line_id
            words.append(word)
        lines.append(" ".join(word.text for word in row))

    confidences = [word.confidence for word in words]
    mean = sum(confidences) / len(confidences) if confidences else 0
    return OcrDocument(text="\n".join(lines), words=words, mean_confidence=mean)


def _is_missing_scanner(exc: Exception) -> bool:
    name = exc.__class__.__name__
    return name == "TesseractNotFoundError" or "tesseract is not installed" in str(exc).lower()


def _richness(document: OcrDocument) -> float:
    letters = sum(character.isalnum() for character in document.text)
    return letters + document.mean_confidence


def _is_weak(document: OcrDocument) -> bool:
    letters = sum(character.isalnum() for character in document.text)
    return letters < 12 or document.mean_confidence < 45


def _warning_line_id(lines: dict[int, list[OcrWord]]) -> int | None:
    ordered = sorted(lines)
    for index, line_id in enumerate(ordered):
        text = " ".join(word.text for word in lines[line_id]).casefold()
        if "government warning" in text:
            return line_id
        if index + 1 < len(ordered):
            nxt = ordered[index + 1]
            joined = text + " " + " ".join(word.text for word in lines[nxt]).casefold()
            if joined.startswith("government warning") or "government warning" in joined[:40]:
                return line_id
    return None


def _median_height(words: list[OcrWord]) -> float | None:
    heights = [word.height for word in words if word.height > 0]
    if not heights:
        return None
    return float(median(heights))


def _tallest_height(lines: dict[int, list[OcrWord]]) -> float | None:
    heights = [_median_height(words) for words in lines.values()]
    usable = [height for height in heights if height]
    if not usable:
        return None
    return float(max(usable))


def _median_stroke(gray: np.ndarray, words: list[OcrWord]) -> float | None:
    strokes = [stroke for word in words if (stroke := _relative_stroke(gray, word)) is not None]
    if len(strokes) < 2:
        return None
    return float(median(strokes))


def _relative_stroke(gray: np.ndarray, word: OcrWord) -> float | None:
    if word.width < 2 or word.height < 8:
        return None
    height, width = gray.shape[:2]
    x0 = max(0, word.left)
    y0 = max(0, word.top)
    x1 = min(width, word.left + word.width)
    y1 = min(height, word.top + word.height)
    roi = gray[y0:y1, x0:x1]
    if roi.size < 16:
        return None
    _threshold, ink = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if float(ink.mean()) < 8:
        return None
    distance = cv2.distanceTransform(ink, cv2.DIST_L2, 3)
    values = distance[ink > 0]
    if values.size == 0:
        return None
    return float(values.mean() * 2 / word.height)
