"""Draw the example labels used by the checklist and the test matrix."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.pipeline.constants import GOVERNMENT_WARNING_BODY  # noqa: E402

PUBLIC = ROOT / "public" / "samples"
LABELS = ROOT / "sample-data" / "labels"
ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf"
ARIAL_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

WARNING = GOVERNMENT_WARNING_BODY


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = ARIAL_BOLD if bold else ARIAL
    if Path(path).exists():
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def wrap(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.ImageFont, width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        current = ""
        for word in words:
            trial = word if not current else f"{current} {word}"
            if draw.textlength(trial, font=face) <= width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = word
        if current:
            lines.append(current)
    return lines


def draw_label(
    blocks: list[tuple[str, ImageFont.ImageFont, str]],
    *,
    centered: bool = True,
) -> Image.Image:
    image = Image.new("RGB", (1200, 1680), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((28, 28, 1171, 1651), outline="black", width=4)
    draw.rectangle((44, 44, 1155, 1635), outline="black", width=2)
    y = 110
    for text, face, fill in blocks:
        for line in wrap(draw, text, face, 980):
            box = draw.textbbox((0, 0), line, font=face)
            line_width = box[2] - box[0]
            height = box[3] - box[1]
            x = (1200 - line_width) / 2 if centered else 90
            draw.text((x, y), line, font=face, fill=fill)
            y += height + 18
        y += 10
    return image


def standard(
    *,
    brand: str = "OLD TOM DISTILLERY",
    klass: str = "Kentucky Straight Bourbon Whiskey",
    alcohol: str = "45% Alc./Vol. (90 Proof)",
    volume: str = "750 mL",
    producer: tuple[str, str, str] = (
        "Old Tom Distillery",
        "100 Distillery Lane",
        "Louisville, KY 40202",
    ),
    country: str = "United States",
    warning_header: str | None = "GOVERNMENT WARNING:",
    warning_body: str | None = WARNING,
    header_bold: bool = True,
) -> Image.Image:
    blocks: list[tuple[str, ImageFont.ImageFont, str]] = [
        (brand, font(68, True), "black"),
        (klass, font(40), "black"),
        (alcohol, font(44, True), "black"),
        (volume, font(44, True), "black"),
        (producer[0], font(32), "black"),
        (producer[1], font(32), "black"),
        (producer[2], font(32), "black"),
        (country, font(32), "black"),
    ]
    if warning_header:
        blocks.append((warning_header, font(34, header_bold), "black"))
    if warning_body:
        blocks.append((warning_body, font(30), "black"))
    return draw_label(blocks)


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    LABELS.mkdir(parents=True, exist_ok=True)
    old_tom = {
        "brand_name": "OLD TOM DISTILLERY",
        "class_type": "Kentucky Straight Bourbon Whiskey",
        "alcohol_content": "45% Alc./Vol. (90 Proof)",
        "net_contents": "750 mL",
        "producer_address": "Old Tom Distillery, 100 Distillery Lane, Louisville, KY 40202",
        "country_of_origin": "United States",
        "is_import": False,
    }
    stones_app = {
        "brand_name": "Stone's Throw",
        "class_type": "Kentucky Straight Bourbon Whiskey",
        "alcohol_content": "45% Alc./Vol. (90 Proof)",
        "net_contents": "750 mL",
        "producer_address": "Stone's Throw Distillery, 100 River Road, Seattle, WA 98101",
        "country_of_origin": "United States",
        "is_import": False,
    }
    cases = [
        (
            "perfect",
            "01-perfect.png",
            "Correct bourbon label",
            "Every field matches, including the required warning.",
            "APPROVE",
            old_tom,
            standard(),
        ),
        (
            "brand-case",
            "02-brand-case.png",
            "Brand is in all caps",
            "The label says STONE'S THROW and the application says Stone's Throw.",
            "NEEDS_REVIEW",
            stones_app,
            standard(
                brand="STONE'S THROW",
                producer=("Stone's Throw Distillery", "100 River Road", "Seattle, WA 98101"),
            ),
        ),
        (
            "wrong-abv",
            "03-wrong-abv.png",
            "Alcohol is off by a point",
            "The label says 46% and the application says 45%.",
            "REJECT",
            old_tom,
            standard(alcohol="46% Alc./Vol. (92 Proof)"),
        ),
        (
            "centiliters",
            "04-centiliters.png",
            "Volume in centiliters",
            "75 cL is the same amount as 750 mL.",
            "APPROVE",
            old_tom,
            standard(volume="75 cL"),
        ),
        (
            "proof",
            "05-proof.png",
            "Proof instead of percent",
            "The label shows 90 proof. The application says 45% ABV.",
            "APPROVE",
            {**old_tom, "alcohol_content": "45% ABV"},
            standard(alcohol="90 Proof"),
        ),
        (
            "warning-case",
            "06-warning-case.png",
            "Warning not in all caps",
            "The header says Government Warning instead of GOVERNMENT WARNING.",
            "REJECT",
            old_tom,
            standard(warning_header="Government Warning:", header_bold=False),
        ),
        (
            "warning-wording",
            "07-warning-wording.png",
            "Warning wording changed",
            "The required statement was rewritten.",
            "REJECT",
            old_tom,
            standard(warning_body=WARNING.replace("women should not", "people should not")),
        ),
        (
            "glare",
            "08-glare.png",
            "Washed-out photo",
            "The picture is too light to read. The tool should ask for another photo.",
            "NEEDS_REVIEW",
            old_tom,
            wash(standard()),
        ),
        (
            "angled",
            "09-angled.png",
            "Crooked photo",
            "The bottle was photographed at an angle.",
            "APPROVE",
            old_tom,
            standard().rotate(8, expand=True, fillcolor="white", resample=Image.Resampling.BICUBIC),
        ),
        (
            "missing-warning",
            "10-missing-warning.png",
            "Warning missing",
            "The government warning is not on the label.",
            "REJECT",
            old_tom,
            standard(warning_header=None, warning_body=None),
        ),
    ]

    samples = []
    for sample_id, filename, title, description, verdict, application, image in cases:
        image.save(PUBLIC / filename, "PNG")
        shutil.copy(PUBLIC / filename, LABELS / filename)
        samples.append(
            {
                "id": sample_id,
                "title": title,
                "description": description,
                "filename": filename,
                "expected_verdict": verdict,
                "application": application,
            }
        )
    payload = {"samples": samples}
    (PUBLIC / "catalog.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (ROOT / "sample-data" / "applications.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {len(samples)} labels.")


def wash(image: Image.Image) -> Image.Image:
    faded = ImageEnhance.Contrast(image).enhance(0.05)
    faded = ImageEnhance.Brightness(faded).enhance(1.85)
    return faded.filter(ImageFilter.GaussianBlur(radius=1.2))


if __name__ == "__main__":
    main()
