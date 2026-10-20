"""Pull alcohol, volume, warning, and text spans out of scanner text.

These functions do not decide pass or fail. They only read.
"""

from __future__ import annotations

import re

from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein

from app.pipeline.constants import GOVERNMENT_WARNING_BODY, WARNING_OCR_DISTANCE

PERCENT_RE = re.compile(
    r"(?P<value>\d{1,3}(?:\.\d+)?)\s*%"
    r"(?:\s*(?:alc\.?\s*/?\s*vol\.?|a\.?b\.?v\.?|alcohol(?:\s+by\s+volume)?))?",
    re.IGNORECASE,
)
PROOF_RE = re.compile(
    r"(?P<value>\d{1,3}(?:\.\d+)?)\s*(?:°\s*)?proof\b",
    re.IGNORECASE,
)
VOLUME_RE = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*"
    r"(?P<unit>millilit(?:er|re)s?|m[lL]|centilit(?:er|re)s?|c[lL]|"
    r"lit(?:er|re)s?|fl\.?\s*oz\.?|ounces?)\b",
    re.IGNORECASE,
)
# "0.75 L" — a bare L, not the L hiding inside mL.
VOLUME_L_RE = re.compile(r"(?P<value>\d+(?:\.\d+)?)\s*L\b")
WARNING_PREFIX_RE = re.compile(r"government\s+warning\s*:?", re.IGNORECASE)

COUNTRY_ALIASES = {
    "usa": "united states",
    "us": "united states",
    "u s a": "united states",
    "u s": "united states",
    "united states of america": "united states",
    "america": "united states",
    "uk": "united kingdom",
    "u k": "united kingdom",
    "great britain": "united kingdom",
    "britain": "united kingdom",
    "england": "united kingdom",
}


def normalize_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def norm_alnum(value: str) -> str:
    """Lowercase letters and digits only, for 'same words' checks."""
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def norm_words(value: str) -> str:
    folded = (
        value.casefold()
        .replace("'", "")
        .replace("\u2019", "")
        .replace("\u2018", "")
        .replace("`", "")
    )
    folded = re.sub(r"[^a-z0-9]+", " ", folded)
    return re.sub(r"\s+", " ", folded).strip()


def letters_preserving_case(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", value)


def case_style(value: str) -> str:
    letters = re.sub(r"[^A-Za-z]", "", value)
    if not letters:
        return "empty"
    if letters.isupper():
        return "upper"
    if letters.islower():
        return "lower"
    return "mixed"


class AlcoholReading:
    def __init__(
        self,
        abv: float | None,
        proof: float | None,
        snippet: str | None,
        inconsistent: bool,
    ) -> None:
        self.abv = abv
        self.proof = proof
        self.snippet = snippet
        self.inconsistent = inconsistent

    @property
    def canonical_abv(self) -> float | None:
        if self.abv is not None:
            return self.abv
        if self.proof is not None:
            return self.proof / 2
        return None


class VolumeReading:
    def __init__(self, milliliters: float | None, snippet: str | None) -> None:
        self.milliliters = milliliters
        self.snippet = snippet


class WarningReading:
    def __init__(
        self,
        present: bool,
        prefix_raw: str | None,
        prefix_is_all_caps: bool,
        body_exact: bool,
        body_distance: int,
        body_snippet: str | None,
    ) -> None:
        self.present = present
        self.prefix_raw = prefix_raw
        self.prefix_is_all_caps = prefix_is_all_caps
        self.body_exact = body_exact
        self.body_distance = body_distance
        self.body_snippet = body_snippet


def _plausible_abv(value: float) -> bool:
    return 0.5 <= value <= 95


def _plausible_proof(value: float) -> bool:
    return 1 <= value <= 190


def parse_alcohol(text: str) -> AlcoholReading:
    if not text:
        return AlcoholReading(None, None, None, False)

    percents = []
    for match in PERCENT_RE.finditer(text):
        value = float(match.group("value"))
        if _plausible_abv(value):
            percents.append((value, match))

    proofs = []
    for match in PROOF_RE.finditer(text):
        value = float(match.group("value"))
        if _plausible_proof(value):
            proofs.append((value, match))

    # Prefer a percent that is explicitly marked Alc./Vol. or ABV.
    chosen_percent = None
    for value, match in percents:
        tail = text[match.end() : match.end() + 24]
        head = text[max(0, match.start() - 8) : match.end()]
        if re.search(r"alc|abv|vol", head + tail, re.IGNORECASE):
            chosen_percent = value
            break
    if chosen_percent is None and percents:
        chosen_percent = percents[0][0]

    chosen_proof = proofs[0][0] if proofs else None
    inconsistent = False
    if chosen_percent is not None and chosen_proof is not None:
        if abs(chosen_percent - (chosen_proof / 2)) > 0.3:
            inconsistent = True

    anchors = [match for _, match in percents] + [match for _, match in proofs]
    snippet = _tight_snippet(text, anchors)
    return AlcoholReading(chosen_percent, chosen_proof, snippet, inconsistent)


def parse_volume(text: str) -> VolumeReading:
    if not text:
        return VolumeReading(None, None)
    match = VOLUME_RE.search(text)
    if match:
        ml = _to_milliliters(float(match.group("value")), match.group("unit"))
        return VolumeReading(ml, _tight_snippet(text, [match]))
    match = VOLUME_L_RE.search(text)
    if match:
        ml = float(match.group("value")) * 1000
        return VolumeReading(ml, _tight_snippet(text, [match]))
    return VolumeReading(None, None)


def _to_milliliters(value: float, unit: str) -> float:
    key = re.sub(r"[^a-z]", "", unit.casefold())
    if key in {"ml", "milliliter", "milliliters", "millilitre", "millilitres"}:
        return value
    if key in {"cl", "centiliter", "centiliters", "centilitre", "centilitres"}:
        return value * 10
    if key in {"l", "liter", "liters", "litre", "litres"}:
        return value * 1000
    if key in {"floz", "oz", "ounce", "ounces"}:
        return value * 29.5735295625
    return value


def _tight_snippet(text: str, matches: list[re.Match[str]]) -> str | None:
    """The label line that holds the number, unless that line is a whole paragraph."""
    if not matches:
        return None
    start = matches[0].start()
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", start)
    if line_end < 0:
        line_end = len(text)
    line = normalize_ws(text[line_start:line_end])
    if line and len(line) <= 90:
        return line
    return " ".join(normalize_ws(match.group(0)) for match in matches)


def canonical_warning() -> str:
    return normalize_ws(GOVERNMENT_WARNING_BODY)


def parse_warning(text: str) -> WarningReading:
    squashed = normalize_ws(text)
    if not squashed:
        return WarningReading(False, None, False, False, 999, None)

    prefix_match = WARNING_PREFIX_RE.search(squashed)
    prefix_raw = normalize_ws(prefix_match.group(0)) if prefix_match else None
    prefix_caps = _prefix_is_all_caps(prefix_raw) if prefix_raw else False

    canon = canonical_warning()
    if prefix_match:
        rest = squashed[prefix_match.end() :].lstrip(" :")
    else:
        rest = squashed

    exact_at = rest.find(canon)
    in_full = squashed.find(canon)
    if exact_at == 0 or (exact_at < 0 and in_full >= 0):
        return WarningReading(True, prefix_raw, prefix_caps, True, 0, prefix_raw)

    folded_index = rest.casefold().find(canon.casefold())
    if folded_index >= 0:
        snippet = rest[folded_index : folded_index + len(canon)]
        distance = 0 if snippet == canon else Levenshtein.distance(snippet, canon)
        # Case-only difference still has a character distance. Call it zero
        # edits of wording and let the matcher decide capitalization.
        if snippet.casefold() == canon.casefold():
            distance = 0
            exact = snippet == canon
        else:
            exact = False
        return WarningReading(True, prefix_raw, prefix_caps, exact, distance, snippet)

    alignment = fuzz.partial_ratio_alignment(canon, rest) if rest else None
    if alignment is None or alignment.score < 55:
        present = prefix_raw is not None
        return WarningReading(present, prefix_raw, prefix_caps, False, 999, prefix_raw)

    snippet = rest[alignment.dest_start : alignment.dest_end]
    distance = Levenshtein.distance(snippet, canon)
    exact = snippet == canon
    present = prefix_raw is not None or alignment.score >= 70
    return WarningReading(present, prefix_raw, prefix_caps, exact, distance, snippet)


def _prefix_is_all_caps(prefix: str) -> bool:
    letters = re.sub(r"[^A-Za-z]", "", prefix)
    return letters.isupper() and letters.casefold() == "governmentwarning"


def warning_needs_human_read(distance: int) -> bool:
    return 0 < distance <= WARNING_OCR_DISTANCE


def text_lines(text: str) -> list[str]:
    return [normalize_ws(line) for line in text.splitlines() if normalize_ws(line)]


def windows(lines: list[str], max_lines: int = 3) -> list[str]:
    found: list[str] = []
    for size in range(1, max_lines + 1):
        for index in range(0, max(0, len(lines) - size) + 1):
            found.append(normalize_ws(" ".join(lines[index : index + size])))
    return found


def fold_country(value: str) -> str:
    cleaned = norm_words(value)
    cleaned = re.sub(
        r"^(product of|produced in|made in|imported from|country of origin)\s+",
        "",
        cleaned,
    ).strip()
    return COUNTRY_ALIASES.get(cleaned, cleaned)


def best_window(
    lines: list[str], expected: str, *, kind: str
) -> tuple[str | None, float, int | None, int | None]:
    """Return the closest label span, its score, and the line indexes it came from."""
    if not expected.strip() or not lines:
        return None, 0.0, None, None
    best_text: str | None = None
    best_score = -1.0
    best_span: tuple[int, int] = (0, 0)
    expected_key = fold_country(expected) if kind == "country" else norm_words(expected)
    max_lines = 2 if kind == "name" else 3
    for size in range(1, max_lines + 1):
        for index in range(0, max(0, len(lines) - size) + 1):
            candidate = normalize_ws(" ".join(lines[index : index + size]))
            candidate_key = fold_country(candidate) if kind == "country" else norm_words(candidate)
            if not candidate_key:
                continue
            if kind == "address":
                score = float(fuzz.token_sort_ratio(candidate_key, expected_key))
            else:
                score = float(fuzz.ratio(candidate_key, expected_key))
            tighter = best_text is not None and len(candidate) < len(best_text)
            if score > best_score or (score == best_score and tighter):
                best_score = score
                best_text = candidate
                best_span = (index, index + size - 1)
    if best_score < 0 or best_text is None:
        return None, 0.0, None, None
    return best_text, best_score, best_span[0], best_span[1]


def guess_prominent_line(lines: list[str]) -> str | None:
    """First label line that is not alcohol, volume, or the warning."""
    for line in lines:
        if WARNING_PREFIX_RE.search(line):
            continue
        if parse_alcohol(line).canonical_abv is not None and len(line) < 48:
            continue
        if parse_volume(line).milliliters is not None and len(line) < 24:
            continue
        if len(norm_alnum(line)) >= 3:
            return line
    return None
