"""Checklist decisions. These are the cases the interviews called out."""

from app.models import FieldStatus, ImageSignals, LabelApplication, OcrDocument, OcrWord, Verdict
from app.pipeline.constants import GOVERNMENT_WARNING_BODY
from app.pipeline.verifier import rollup, verify_document

WARNING = "GOVERNMENT WARNING: " + GOVERNMENT_WARNING_BODY


def document(text: str, confidence: float = 96, height: int = 28) -> OcrDocument:
    words: list[OcrWord] = []
    for line_id, line in enumerate(text.splitlines() or [text]):
        for token in line.split():
            words.append(
                OcrWord(text=token, confidence=confidence, height=height, line_id=line_id)
            )
    return OcrDocument(text=text, words=words, mean_confidence=confidence)


def application(**overrides) -> LabelApplication:
    payload = {
        "brand_name": "OLD TOM DISTILLERY",
        "class_type": "Kentucky Straight Bourbon Whiskey",
        "alcohol_content": "45% Alc./Vol. (90 Proof)",
        "net_contents": "750 mL",
        "producer_address": "Old Tom Distillery, 100 Distillery Lane, Louisville, KY 40202",
        "country_of_origin": "United States",
        "is_import": False,
    }
    payload.update(overrides)
    return LabelApplication(**payload)


def label(
    *,
    brand: str = "OLD TOM DISTILLERY",
    alcohol: str = "45% Alc./Vol. (90 Proof)",
    volume: str = "750 mL",
    warning: str = WARNING,
    producer: tuple[str, str, str] = (
        "Old Tom Distillery",
        "100 Distillery Lane",
        "Louisville, KY 40202",
    ),
    country: str = "United States",
    klass: str = "Kentucky Straight Bourbon Whiskey",
) -> str:
    return "\n".join(
        [
            brand,
            klass,
            alcohol,
            volume,
            producer[0],
            producer[1],
            producer[2],
            country,
            warning,
        ]
    )


def field(result, key):
    return next(item for item in result.fields if item.key == key)


def test_perfect_label_is_an_approve():
    result = verify_document(document(label()), application())
    assert result.verdict == Verdict.APPROVE
    assert result.unreadable is False
    assert all(
        item.status == FieldStatus.MATCH
        for item in result.fields
        if item.status != FieldStatus.NOT_PROVIDED
    )


def test_all_caps_brand_is_review_not_a_mismatch():
    """Dave Morrison: STONE'S THROW and Stone's Throw are the same brand."""
    text = label(
        brand="STONE'S THROW",
        producer=("Stone's Throw Distillery", "100 River Road", "Seattle, WA 98101"),
    )
    form = application(
        brand_name="Stone's Throw",
        producer_address="Stone's Throw Distillery, 100 River Road, Seattle, WA 98101",
    )
    result = verify_document(document(text), form)
    brand = field(result, "brand_name")
    assert brand.status == FieldStatus.REVIEW
    assert "apital" in (brand.reason or "")
    assert field(result, "class_type").status == FieldStatus.MATCH
    assert result.verdict == Verdict.NEEDS_REVIEW


def test_minor_brand_capitalization_inside_mixed_case_still_matches():
    text = label(brand="Old Tom Distillery")
    form = application(brand_name="Old Tom distillery")
    result = verify_document(document(text), form)
    assert field(result, "brand_name").status == FieldStatus.MATCH


def test_abv_off_by_one_point_is_a_mismatch():
    text = label(alcohol="46% Alc./Vol. (92 Proof)")
    result = verify_document(document(text), application())
    assert field(result, "alcohol_content").status == FieldStatus.MISMATCH
    assert result.verdict == Verdict.REJECT


def test_centiliters_match_milliliters():
    text = label(volume="75 cL")
    result = verify_document(document(text), application(net_contents="750 mL"))
    volume = field(result, "net_contents")
    assert volume.status == FieldStatus.MATCH
    assert "750" in (volume.reason or "")


def test_proof_matches_half_the_number_as_abv():
    text = label(alcohol="90 Proof")
    result = verify_document(document(text), application(alcohol_content="45% ABV"))
    alcohol = field(result, "alcohol_content")
    assert alcohol.status == FieldStatus.MATCH
    assert result.verdict == Verdict.APPROVE


def test_warning_title_case_is_a_mismatch():
    """Jenny Park: 'Government Warning' in title case is a rejection."""
    text = label(warning="Government Warning: " + GOVERNMENT_WARNING_BODY)
    result = verify_document(document(text), application())
    warning = field(result, "government_warning")
    assert warning.status == FieldStatus.MISMATCH
    assert "all caps" in (warning.reason or "")
    assert result.verdict == Verdict.REJECT


def test_warning_wording_change_is_a_mismatch():
    altered = GOVERNMENT_WARNING_BODY.replace("women should not", "people should not")
    text = label(warning="GOVERNMENT WARNING: " + altered)
    result = verify_document(document(text), application())
    warning = field(result, "government_warning")
    assert warning.status == FieldStatus.MISMATCH
    assert "wording" in (warning.reason or "")


def test_missing_warning_is_a_mismatch():
    text = label(warning="Enjoy responsibly.")
    result = verify_document(document(text), application())
    assert field(result, "government_warning").status == FieldStatus.MISMATCH
    assert result.verdict == Verdict.REJECT


def test_unreadable_image_is_review_and_never_a_pass():
    result = verify_document(document("??", confidence=12), application())
    assert result.unreadable is True
    assert result.verdict == Verdict.NEEDS_REVIEW
    assert all(item.status == FieldStatus.REVIEW for item in result.fields)
    assert not any(item.status == FieldStatus.MATCH for item in result.fields)


def test_low_field_confidence_blocks_an_automatic_match():
    text = label()
    words = []
    for line_id, line in enumerate(text.splitlines()):
        for token in line.split():
            confidence = 42 if token in {"OLD", "TOM", "DISTILLERY"} else 96
            words.append(OcrWord(text=token, confidence=confidence, height=28, line_id=line_id))
    result = verify_document(OcrDocument(text=text, words=words, mean_confidence=90), application())
    assert field(result, "brand_name").status == FieldStatus.REVIEW
    assert field(result, "class_type").status == FieldStatus.MATCH
    assert result.verdict == Verdict.NEEDS_REVIEW


def test_missing_application_field_is_not_held_against_the_label():
    result = verify_document(document(label()), application(country_of_origin=None))
    assert field(result, "country_of_origin").status == FieldStatus.NOT_PROVIDED
    assert result.verdict == Verdict.APPROVE


def test_empty_application_is_not_auto_approved():
    result = verify_document(document(label()), LabelApplication())
    assert result.verdict == Verdict.NEEDS_REVIEW
    assert field(result, "government_warning").status == FieldStatus.MATCH


def test_close_class_type_is_review():
    text = label(klass="Kentucky Straight Bourbon")
    result = verify_document(document(text), application())
    assert field(result, "class_type").status == FieldStatus.REVIEW
    assert result.verdict == Verdict.NEEDS_REVIEW


def test_clearly_different_brand_is_a_mismatch():
    text = label(brand="NEW RIVER SPIRITS")
    result = verify_document(document(text), application())
    assert field(result, "brand_name").status == FieldStatus.MISMATCH
    assert result.verdict == Verdict.REJECT


def test_country_alias_matches():
    text = label(country="USA")
    result = verify_document(document(text), application(country_of_origin="United States"))
    assert field(result, "country_of_origin").status == FieldStatus.MATCH


def test_tiny_warning_type_is_review_even_when_the_words_are_right():
    result = verify_document(
        document(label()),
        application(),
        signals=ImageSignals(warning_bold=True, warning_height_px=11, brand_height_px=64),
    )
    warning = field(result, "government_warning")
    assert warning.status == FieldStatus.REVIEW
    assert "small" in (warning.reason or "")


def test_header_that_is_not_bold_is_review():
    result = verify_document(
        document(label()),
        application(),
        signals=ImageSignals(warning_bold=False, warning_height_px=24, brand_height_px=64),
    )
    assert field(result, "government_warning").status == FieldStatus.REVIEW
    assert "bold" in (field(result, "government_warning").reason or "")


def test_inconsistent_proof_on_the_label_is_review():
    text = label(alcohol="45% ABV (80 Proof)")
    result = verify_document(document(text), application(alcohol_content="45% ABV"))
    alcohol = field(result, "alcohol_content")
    assert alcohol.status == FieldStatus.REVIEW
    assert "do not agree" in (alcohol.reason or "")


def test_rollup_prefers_mismatch_over_review():
    from app.models import FieldResult

    verdict = rollup(
        [
            FieldResult(key="a", label="A", status=FieldStatus.REVIEW),
            FieldResult(key="b", label="B", status=FieldStatus.MISMATCH),
            FieldResult(key="c", label="C", status=FieldStatus.NOT_PROVIDED),
        ]
    )
    assert verdict == Verdict.REJECT
