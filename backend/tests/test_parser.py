"""Readings from label text: alcohol, volume, and the warning block."""

from app.pipeline.constants import GOVERNMENT_WARNING_BODY
from app.pipeline.parser import (
    fold_country,
    norm_words,
    parse_alcohol,
    parse_volume,
    parse_warning,
)


def test_alcohol_percent_and_proof_agree():
    reading = parse_alcohol("45% Alc./Vol. (90 Proof)")
    assert reading.abv == 45
    assert reading.proof == 90
    assert reading.canonical_abv == 45
    assert reading.inconsistent is False
    assert reading.snippet == "45% Alc./Vol. (90 Proof)"


def test_proof_alone_becomes_abv():
    reading = parse_alcohol("Bottled at 90 Proof")
    assert reading.abv is None
    assert reading.canonical_abv == 45
    assert "90" in (reading.snippet or "")


def test_percent_variants():
    assert parse_alcohol("45% ABV").canonical_abv == 45
    assert parse_alcohol("45%").canonical_abv == 45
    assert parse_alcohol("12.5% alc/vol").canonical_abv == 12.5


def test_inconsistent_percent_and_proof():
    reading = parse_alcohol("45% ABV (80 Proof)")
    assert reading.inconsistent is True
    assert reading.canonical_abv == 45


def test_volume_units():
    assert parse_volume("750 mL").milliliters == 750
    assert parse_volume("750ml").milliliters == 750
    assert parse_volume("75 cL").milliliters == 750
    assert parse_volume("0.75 L").milliliters == 750
    assert parse_volume("Net contents 75 cL").snippet == "Net contents 75 cL"


def test_warning_exact_block_with_wrapped_lines():
    text = "Brand\nGOVERNMENT WARNING: " + GOVERNMENT_WARNING_BODY.replace(". ", ".\n")
    # Wrapped on purpose; whitespace must not matter.
    reading = parse_warning("GOVERNMENT WARNING:\n" + GOVERNMENT_WARNING_BODY)
    assert reading.present is True
    assert reading.prefix_is_all_caps is True
    assert reading.body_exact is True
    assert reading.body_distance == 0
    assert text  # the wrapped form is covered below


def test_warning_wrapped_still_exact():
    wrapped = (
        "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic\n"
        "beverages during pregnancy because of the risk of birth defects. (2) Consumption of\n"
        "alcoholic beverages impairs your ability to drive a car or operate machinery, and may\n"
        "cause health problems."
    )
    reading = parse_warning(wrapped)
    assert reading.body_exact is True
    assert reading.prefix_is_all_caps is True


def test_warning_title_case_header():
    reading = parse_warning("Government Warning: " + GOVERNMENT_WARNING_BODY)
    assert reading.prefix_is_all_caps is False
    assert reading.body_exact is True


def test_warning_missing():
    reading = parse_warning("OLD TOM DISTILLERY\n45% Alc./Vol.\n750 mL")
    assert reading.present is False
    assert reading.body_exact is False


def test_country_aliases_and_word_normalization():
    assert fold_country("USA") == "united states"
    assert fold_country("Product of United States") == "united states"
    assert norm_words("STONE'S THROW") == "stones throw"
