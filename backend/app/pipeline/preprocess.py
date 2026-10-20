"""Turn a label photo into a high-contrast grayscale image for the scanner."""

from __future__ import annotations

import cv2
import numpy as np


def downscale(image: np.ndarray, max_width: int = 1400, max_height: int = 1800) -> np.ndarray:
    height, width = image.shape[:2]
    scale = min(1.0, max_width / width, max_height / height)
    if scale >= 1:
        return image
    size = (max(1, int(width * scale)), max(1, int(height * scale)))
    return cv2.resize(image, size, interpolation=cv2.INTER_AREA)


def preprocess(bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = deskew(gray)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def deskew(gray: np.ndarray) -> np.ndarray:
    """Straighten a photo that is slightly rotated. Leave upright labels alone."""
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    _threshold, ink = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    coords = np.column_stack(np.where(ink > 0))
    if coords.shape[0] < 300:
        return gray

    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle
    # minAreaRect is ambiguous on nearly square text blocks. Only trust a small tilt.
    if abs(angle) < 0.4 or abs(angle) > 15:
        return gray

    height, width = gray.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    return cv2.warpAffine(
        gray,
        matrix,
        (width, height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )
