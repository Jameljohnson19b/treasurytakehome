"""Request and response shapes for a single label checklist."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class FieldStatus(str, Enum):
    MATCH = "MATCH"
    REVIEW = "REVIEW"
    MISMATCH = "MISMATCH"
    NOT_PROVIDED = "NOT_PROVIDED"


class Verdict(str, Enum):
    APPROVE = "APPROVE"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    REJECT = "REJECT"


VERDICT_TEXT = {
    Verdict.APPROVE: "APPROVE (auto-suggested)",
    Verdict.NEEDS_REVIEW: "NEEDS AGENT REVIEW",
    Verdict.REJECT: "REJECT (suggested)",
}


class LabelApplication(BaseModel):
    """Fields an agent would copy off the COLA application. All optional."""

    application_id: str | None = None
    filename: str | None = None
    brand_name: str | None = None
    class_type: str | None = None
    alcohol_content: str | None = None
    net_contents: str | None = None
    producer_address: str | None = None
    country_of_origin: str | None = None
    is_import: bool = False


class OcrWord(BaseModel):
    text: str
    confidence: float = 0
    left: int = 0
    top: int = 0
    width: int = 0
    height: int = 0
    line_id: int = 0


class OcrDocument(BaseModel):
    """Scanner output. Built from Tesseract or directly in tests."""

    text: str = ""
    words: list[OcrWord] = Field(default_factory=list)
    mean_confidence: float = 0


class ImageSignals(BaseModel):
    """Measurements that depend on pixels. None means we could not tell."""

    warning_bold: bool | None = None
    warning_height_px: float | None = None
    brand_height_px: float | None = None


class FieldResult(BaseModel):
    key: str
    label: str
    status: FieldStatus
    application_value: str | None = None
    label_value: str | None = None
    score: float | None = None
    reason: str | None = None


class VerificationResult(BaseModel):
    filename: str
    elapsed_ms: int
    over_budget: bool
    verdict: Verdict
    verdict_text: str
    unreadable: bool = False
    ocr_confidence: float = 0
    ocr_text: str = ""
    fields: list[FieldResult]
    attention: list[str] = Field(default_factory=list)
    image_url: str | None = None
    error: str | None = None


class ItemFailure(BaseModel):
    filename: str
    error: str


class JobView(BaseModel):
    id: str
    status: Literal["queued", "running", "complete"]
    total: int
    completed: int
    current_file: str | None = None
    elapsed_ms: int = 0
    items: list[VerificationResult] = Field(default_factory=list)
    failed: list[ItemFailure] = Field(default_factory=list)


class SampleSummary(BaseModel):
    id: str
    title: str
    description: str
    filename: str
    expected_verdict: str
    application: LabelApplication
