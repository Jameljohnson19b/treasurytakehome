"""Compare an application to what was read on the label.

Three outcomes, on purpose:

- MATCH — safe to accept without a second look
- REVIEW — a person should decide (close wording, odd capitalization, weak scan)
- MISMATCH — the values clearly disagree, or the warning breaks a hard rule

A missing application field never counts against the label.
"""

from __future__ import annotations

from app.models import (
    VERDICT_TEXT,
    FieldResult,
    FieldStatus,
    ImageSignals,
    LabelApplication,
    OcrDocument,
    OcrWord,
    Verdict,
    VerificationResult,
)
from app.pipeline.constants import (
    ABV_MATCH_TOLERANCE,
    ABV_REVIEW_TOLERANCE,
    FUZZY_MATCH,
    FUZZY_REVIEW,
    LOW_FIELD_CONFIDENCE,
    TINY_WARNING_PX,
    TINY_WARNING_RATIO,
    UNREADABLE_CONFIDENCE,
    UNREADABLE_MIN_ALNUM,
    WARNING_OCR_DISTANCE,
)
from app.pipeline.parser import (
    best_window,
    canonical_warning,
    case_style,
    fold_country,
    guess_prominent_line,
    letters_preserving_case,
    norm_alnum,
    norm_words,
    parse_alcohol,
    parse_volume,
    parse_warning,
    text_lines,
    warning_needs_human_read,
)

FIELD_LABELS = {
    "brand_name": "Brand name",
    "class_type": "Class / type",
    "alcohol_content": "Alcohol content",
    "net_contents": "Net contents",
    "producer_address": "Producer address",
    "country_of_origin": "Country of origin",
    "government_warning": "Government warning",
}


def document_confidence(document: OcrDocument) -> float:
    scored = [word.confidence for word in document.words if word.text.strip()]
    if scored:
        return sum(scored) / len(scored)
    return document.mean_confidence


def is_unreadable(document: OcrDocument) -> bool:
    alnum = norm_alnum(document.text)
    if len(alnum) < UNREADABLE_MIN_ALNUM:
        return True
    return document_confidence(document) < UNREADABLE_CONFIDENCE


def verify_document(
    document: OcrDocument,
    application: LabelApplication,
    *,
    filename: str = "label",
    elapsed_ms: int = 0,
    signals: ImageSignals | None = None,
    latency_budget_ms: int = 5000,
) -> VerificationResult:
    signals = signals or ImageSignals()
    confidence = round(document_confidence(document), 1)

    if is_unreadable(document):
        fields = _unreadable_fields(application)
        return _bundle(
            filename=filename,
            elapsed_ms=elapsed_ms,
            fields=fields,
            document=document,
            confidence=confidence,
            unreadable=True,
            latency_budget_ms=latency_budget_ms,
        )

    lines = text_lines(document.text)
    fields = [
        _text_field(
            "brand_name",
            application.brand_name,
            lines,
            document.words,
            kind="name",
            fallback=guess_prominent_line(lines),
        ),
        _text_field(
            "class_type",
            application.class_type,
            lines,
            document.words,
            kind="name",
        ),
        _alcohol_field(application.alcohol_content, document),
        _volume_field(application.net_contents, document),
        _text_field(
            "producer_address",
            application.producer_address,
            lines,
            document.words,
            kind="address",
        ),
        _text_field(
            "country_of_origin",
            application.country_of_origin,
            lines,
            document.words,
            kind="country",
        ),
        _warning_field(document, signals),
    ]
    return _bundle(
        filename=filename,
        elapsed_ms=elapsed_ms,
        fields=fields,
        document=document,
        confidence=confidence,
        unreadable=False,
        latency_budget_ms=latency_budget_ms,
    )


def rollup(fields: list[FieldResult]) -> Verdict:
    counted = [field.status for field in fields if field.status != FieldStatus.NOT_PROVIDED]
    if any(status == FieldStatus.MISMATCH for status in counted):
        return Verdict.REJECT
    if any(status == FieldStatus.REVIEW for status in counted):
        return Verdict.NEEDS_REVIEW
    if counted and all(status == FieldStatus.MATCH for status in counted):
        return Verdict.APPROVE
    return Verdict.NEEDS_REVIEW


def _bundle(
    *,
    filename: str,
    elapsed_ms: int,
    fields: list[FieldResult],
    document: OcrDocument,
    confidence: float,
    unreadable: bool,
    latency_budget_ms: int,
) -> VerificationResult:
    verdict = rollup(fields)
    attention = list(
        dict.fromkeys(
            field.reason
            for field in fields
            if field.status in {FieldStatus.REVIEW, FieldStatus.MISMATCH} and field.reason
        )
    )
    compared = [
        field
        for field in fields
        if field.key != "government_warning" and field.status != FieldStatus.NOT_PROVIDED
    ]
    if verdict == Verdict.APPROVE and not compared:
        verdict = Verdict.NEEDS_REVIEW
        attention.append(
            "No application data was entered, so this label cannot be approved automatically."
        )
    if unreadable:
        attention = ["We could not read this photo. Ask for a clearer picture of the label."]
    return VerificationResult(
        filename=filename,
        elapsed_ms=elapsed_ms,
        over_budget=elapsed_ms > latency_budget_ms,
        verdict=verdict,
        verdict_text=VERDICT_TEXT[verdict],
        unreadable=unreadable,
        ocr_confidence=confidence,
        ocr_text=document.text.strip(),
        fields=fields,
        attention=attention,
    )


def _unreadable_fields(application: LabelApplication) -> list[FieldResult]:
    reason = "We could not read this photo. Ask for a clearer picture of the label."
    provided = {
        "brand_name": application.brand_name,
        "class_type": application.class_type,
        "alcohol_content": application.alcohol_content,
        "net_contents": application.net_contents,
        "producer_address": application.producer_address,
        "country_of_origin": application.country_of_origin,
        "government_warning": "Required TTB statement",
    }
    return [
        FieldResult(
            key=key,
            label=FIELD_LABELS[key],
            status=FieldStatus.REVIEW,
            application_value=_clean(value) if key != "government_warning" else "Required TTB statement",
            label_value=None,
            reason=reason,
        )
        for key, value in provided.items()
    ]


def _text_field(
    key: str,
    expected: str | None,
    lines: list[str],
    words: list[OcrWord],
    *,
    kind: str,
    fallback: str | None = None,
) -> FieldResult:
    label = FIELD_LABELS[key]
    cleaned = _clean(expected)
    if cleaned is None:
        return FieldResult(
            key=key,
            label=label,
            status=FieldStatus.NOT_PROVIDED,
            application_value=None,
            label_value=fallback,
            reason="Not on the application. The label was not penalized for this.",
        )

    # The brand is the name at the top of the label, not the producer line
    # lower down that often repeats those same words.
    pool = lines[:2] if key == "brand_name" else lines
    found, score, line_start, line_end = best_window(pool, cleaned, kind=kind)
    span_words = _words_on_lines(words, line_start, line_end)
    if found is None or score < 50:
        return _maybe_uncertain(
            FieldResult(
                key=key,
                label=label,
                status=FieldStatus.MISMATCH,
                application_value=cleaned,
                label_value=found,
                score=round(score, 1) if found else 0,
                reason="Not found on the label.",
            ),
            span_words or words,
            found,
        )

    if kind == "country" and fold_country(found) == fold_country(cleaned):
        return _maybe_uncertain(
            FieldResult(
                key=key,
                label=label,
                status=FieldStatus.MATCH,
                application_value=cleaned,
                label_value=found,
                score=100,
            ),
            span_words,
            found,
        )

    if norm_alnum(found) == norm_alnum(cleaned):
        if key == "brand_name" and _brand_case_needs_review(found, cleaned):
            return _maybe_uncertain(
                FieldResult(
                    key=key,
                    label=label,
                    status=FieldStatus.REVIEW,
                    application_value=cleaned,
                    label_value=found,
                    score=round(score, 1),
                    reason=(
                        "Capitalization differs. The words are the same, "
                        "so an agent should confirm this is the brand."
                    ),
                ),
                span_words,
                found,
            )
        return _maybe_uncertain(
            FieldResult(
                key=key,
                label=label,
                status=FieldStatus.MATCH,
                application_value=cleaned,
                label_value=found,
                score=100,
            ),
            span_words,
            found,
        )

    if score >= FUZZY_MATCH:
        status = FieldStatus.MATCH
        reason = None
    elif score >= FUZZY_REVIEW:
        status = FieldStatus.REVIEW
        reason = f"Close, but not the same ({score:.0f}% similar). Compare the two spellings."
    else:
        status = FieldStatus.MISMATCH
        reason = f"Does not match what is on the application ({score:.0f}% similar)."

    return _maybe_uncertain(
        FieldResult(
            key=key,
            label=label,
            status=status,
            application_value=cleaned,
            label_value=found,
            score=round(score, 1),
            reason=reason,
        ),
        span_words,
        found,
    )


def _brand_case_needs_review(found: str, expected: str) -> bool:
    """All-caps on the label and title case on the form is a judgment call.

    A single letter losing its capital in the scan is not. Those stay a match
    when the letters themselves agree.
    """
    if letters_preserving_case(found) == letters_preserving_case(expected):
        return False
    found_style = case_style(found)
    expected_style = case_style(expected)
    if found_style == expected_style:
        return False
    return "upper" in {found_style, expected_style} and found_style != expected_style


def _alcohol_field(expected: str | None, document: OcrDocument) -> FieldResult:
    label = FIELD_LABELS["alcohol_content"]
    reading = parse_alcohol(document.text)
    cleaned = _clean(expected)
    if cleaned is None:
        return FieldResult(
            key="alcohol_content",
            label=label,
            status=FieldStatus.NOT_PROVIDED,
            label_value=reading.snippet,
            reason="Not on the application. The label was not penalized for this.",
        )

    expected_reading = parse_alcohol(cleaned)
    if expected_reading.canonical_abv is None:
        return FieldResult(
            key="alcohol_content",
            label=label,
            status=FieldStatus.REVIEW,
            application_value=cleaned,
            label_value=reading.snippet,
            reason="The application alcohol content could not be read as a percent or proof.",
        )

    field_words = _words_for_snippet(document.words, reading.snippet)
    if reading.canonical_abv is None:
        return _maybe_uncertain(
            FieldResult(
                key="alcohol_content",
                label=label,
                status=FieldStatus.MISMATCH,
                application_value=cleaned,
                label_value=None,
                score=0,
                reason="No alcohol content found on the label.",
            ),
            field_words,
            reading.snippet,
        )

    difference = abs(reading.canonical_abv - expected_reading.canonical_abv)
    reason = _alcohol_reason(reading, expected_reading, difference)
    if reading.inconsistent and difference <= ABV_MATCH_TOLERANCE:
        status = FieldStatus.REVIEW
        reason = (
            f"The label shows {_fmt_abv(reading.abv)} and {_fmt_proof(reading.proof)}, "
            f"which do not agree ({_fmt_proof(reading.proof)} is {_fmt_abv((reading.proof or 0) / 2)}). "
            "Confirm which number is official."
        )
    elif difference <= ABV_MATCH_TOLERANCE:
        status = FieldStatus.MATCH
    elif difference <= ABV_REVIEW_TOLERANCE:
        status = FieldStatus.REVIEW
    else:
        status = FieldStatus.MISMATCH

    return _maybe_uncertain(
        FieldResult(
            key="alcohol_content",
            label=label,
            status=status,
            application_value=cleaned,
            label_value=reading.snippet,
            score=100 if status == FieldStatus.MATCH else round(max(0, 100 - difference * 20), 1),
            reason=reason if status != FieldStatus.MATCH or _strings_differ(reading.snippet, cleaned) else None,
        ),
        field_words or document.words,
        reading.snippet,
    )


def _alcohol_reason(reading, expected_reading, difference: float) -> str | None:
    label_abv = reading.canonical_abv
    app_abv = expected_reading.canonical_abv
    if label_abv is None or app_abv is None:
        return None
    proof_note = ""
    if reading.abv is None and reading.proof is not None:
        proof_note = f"{_fmt_proof(reading.proof)} equals {_fmt_abv(label_abv)}. "
    if difference <= ABV_MATCH_TOLERANCE:
        if proof_note:
            return proof_note.strip()
        if reading.snippet and expected_reading.snippet and norm_words(reading.snippet) != norm_words(
            expected_reading.snippet
        ):
            return f"Both sides are {_fmt_abv(label_abv)}."
        return None
    if difference <= ABV_REVIEW_TOLERANCE:
        return f"Close: the label reads as {_fmt_abv(label_abv)} and the application says {_fmt_abv(app_abv)}."
    return (
        f"The label reads as {_fmt_abv(label_abv)} and the application says {_fmt_abv(app_abv)}."
    )


def _volume_field(expected: str | None, document: OcrDocument) -> FieldResult:
    label = FIELD_LABELS["net_contents"]
    reading = parse_volume(document.text)
    cleaned = _clean(expected)
    if cleaned is None:
        return FieldResult(
            key="net_contents",
            label=label,
            status=FieldStatus.NOT_PROVIDED,
            label_value=reading.snippet,
            reason="Not on the application. The label was not penalized for this.",
        )

    expected_reading = parse_volume(cleaned)
    if expected_reading.milliliters is None:
        return FieldResult(
            key="net_contents",
            label=label,
            status=FieldStatus.REVIEW,
            application_value=cleaned,
            label_value=reading.snippet,
            reason="The application net contents could not be read as a volume.",
        )
    if reading.milliliters is None:
        return _maybe_uncertain(
            FieldResult(
                key="net_contents",
                label=label,
                status=FieldStatus.MISMATCH,
                application_value=cleaned,
                label_value=None,
                score=0,
                reason="No net contents found on the label.",
            ),
            document.words,
            None,
        )

    difference = abs(reading.milliliters - expected_reading.milliliters)
    tolerance = max(2.0, expected_reading.milliliters * 0.01)
    same = difference <= tolerance
    reason = None
    if same and reading.snippet and norm_words(reading.snippet) != norm_words(cleaned):
        reason = (
            f"{reading.snippet} is {_fmt_ml(reading.milliliters)}, "
            f"the same as {_fmt_ml(expected_reading.milliliters)}."
        )
    if not same:
        reason = (
            f"The label is {_fmt_ml(reading.milliliters)} and the application is "
            f"{_fmt_ml(expected_reading.milliliters)}."
        )
    return _maybe_uncertain(
        FieldResult(
            key="net_contents",
            label=label,
            status=FieldStatus.MATCH if same else FieldStatus.MISMATCH,
            application_value=cleaned,
            label_value=reading.snippet,
            score=100 if same else 0,
            reason=reason,
        ),
        _words_for_snippet(document.words, reading.snippet) or document.words,
        reading.snippet,
    )


def _warning_field(document: OcrDocument, signals: ImageSignals) -> FieldResult:
    label = FIELD_LABELS["government_warning"]
    reading = parse_warning(document.text)
    required = "GOVERNMENT WARNING:"
    reasons: list[str] = []

    if not reading.present and not reading.body_exact and reading.body_distance > WARNING_OCR_DISTANCE:
        status = FieldStatus.MISMATCH
        reasons.append("The government warning is not on this label.")
        shown = None
    elif reading.prefix_raw and not reading.prefix_is_all_caps:
        status = FieldStatus.MISMATCH
        reasons.append('The header is not in all caps. It must read "GOVERNMENT WARNING:".')
        shown = reading.prefix_raw if reading.prefix_raw.endswith(":") else f"{reading.prefix_raw}:"
    elif not reading.prefix_raw:
        status = FieldStatus.MISMATCH
        reasons.append('The label is missing the "GOVERNMENT WARNING:" header.')
        shown = reading.body_snippet
    elif reading.body_exact and reading.body_distance == 0:
        status = FieldStatus.MATCH
        shown = required
    elif reading.body_distance == 0 and not reading.body_exact:
        status = FieldStatus.REVIEW
        reasons.append("The warning words match, but capitalization inside the statement differs.")
        shown = reading.prefix_raw
    elif warning_needs_human_read(reading.body_distance):
        status = FieldStatus.REVIEW
        reasons.append(
            "The warning is off by only a few characters. Compare it word for word in case the scanner missed one."
        )
        shown = reading.prefix_raw
    else:
        status = FieldStatus.MISMATCH
        reasons.append("The warning wording does not match the required statement.")
        diff = _diff_hint(reading.body_snippet or "", canonical_warning())
        if diff:
            reasons.append(diff)
        shown = reading.prefix_raw or "Wording differs"

    if status == FieldStatus.MATCH and signals.warning_bold is False:
        status = FieldStatus.REVIEW
        reasons.append("The header does not look bold. Confirm the type weight.")
    if status == FieldStatus.MATCH and _warning_is_tiny(signals):
        status = FieldStatus.REVIEW
        reasons.append("The warning type looks very small. Confirm it is easy to read.")

    result = FieldResult(
        key="government_warning",
        label=label,
        status=status,
        application_value=required if status != FieldStatus.MATCH else "Exact required statement",
        label_value="Exact required statement" if status == FieldStatus.MATCH else shown,
        score=100 if status == FieldStatus.MATCH else 0,
        reason=" ".join(reasons) if reasons else None,
    )
    warning_words = [
        word
        for word in document.words
        if word.text.casefold().strip(":") in {"government", "warning"}
        or "surgeon" in word.text.casefold()
    ]
    return _maybe_uncertain(result, warning_words or document.words, shown)


def _warning_is_tiny(signals: ImageSignals) -> bool:
    if signals.warning_height_px is None:
        return False
    if signals.warning_height_px <= TINY_WARNING_PX:
        return True
    if signals.brand_height_px and signals.brand_height_px > 0:
        return (signals.warning_height_px / signals.brand_height_px) < TINY_WARNING_RATIO
    return False


def _maybe_uncertain(result: FieldResult, words: list[OcrWord], snippet: str | None) -> FieldResult:
    """A weak scan never becomes an automatic pass or an automatic fail."""
    if result.status == FieldStatus.NOT_PROVIDED:
        return result
    confidence = _confidence_for(words, snippet)
    if confidence is None or confidence >= LOW_FIELD_CONFIDENCE:
        return result
    note = "The scanner was not confident it read this correctly, so a person should compare it."
    reason = f"{result.reason} {note}".strip() if result.reason else note
    return result.model_copy(
        update={
            "status": FieldStatus.REVIEW,
            "reason": reason,
        }
    )


def _confidence_for(words: list[OcrWord], snippet: str | None) -> float | None:
    if not words:
        return None
    if not snippet:
        scored = [word.confidence for word in words if word.text.strip()]
        return sum(scored) / len(scored) if scored else None
    key = norm_alnum(snippet)
    used = [word.confidence for word in words if word.text.strip() and norm_alnum(word.text) in key]
    if not used:
        scored = [word.confidence for word in words if word.text.strip()]
        return sum(scored) / len(scored) if scored else None
    return sum(used) / len(used)


def _words_on_lines(
    words: list[OcrWord], start: int | None, end: int | None
) -> list[OcrWord]:
    if start is None or end is None:
        return []
    return [word for word in words if word.text.strip() and start <= word.line_id <= end]


def _words_for_snippet(words: list[OcrWord], snippet: str | None) -> list[OcrWord]:
    if not snippet:
        return []
    key = norm_alnum(snippet)
    return [word for word in words if word.text.strip() and norm_alnum(word.text) in key]


def _diff_hint(found: str, canon: str) -> str:
    if not found:
        return ""
    limit = min(len(found), len(canon))
    for index in range(limit):
        if found[index] != canon[index]:
            start = max(0, index - 24)
            end = min(len(found), index + 28)
            return f'Near the difference, the label reads "{found[start:end].strip()}".'
    if len(found) != len(canon):
        return "The statement is longer or shorter than the required text."
    return ""


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _strings_differ(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return True
    return norm_words(left) != norm_words(right)


def _fmt_abv(value: float | None) -> str:
    if value is None:
        return "an unknown strength"
    rounded = round(value, 2)
    if rounded == int(rounded):
        return f"{int(rounded)}% ABV"
    return f"{rounded:.2f}% ABV"


def _fmt_proof(value: float | None) -> str:
    if value is None:
        return "unknown proof"
    if value == int(value):
        return f"{int(value)} proof"
    return f"{value:.1f} proof"


def _fmt_ml(value: float) -> str:
    if abs(value - round(value)) < 0.05:
        return f"{int(round(value))} mL"
    return f"{value:.1f} mL"


def confidence_is_low(words: list[OcrWord]) -> bool:
    """True when the field scan is too weak to pass or fail on its own."""
    if not words:
        return False
    scored = [word.confidence for word in words if word.text.strip()]
    if not scored:
        return False
    return (sum(scored) / len(scored)) < LOW_FIELD_CONFIDENCE
