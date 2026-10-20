"""Match uploaded images to application rows from JSON or a spreadsheet."""

from __future__ import annotations

import csv
import io
import json

from app.models import LabelApplication

class PairingError(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


_ALIASES = {
    "brand": "brand_name",
    "brand name": "brand_name",
    "brand_name": "brand_name",
    "class": "class_type",
    "class/type": "class_type",
    "class / type": "class_type",
    "class_type": "class_type",
    "type": "class_type",
    "abv": "alcohol_content",
    "alcohol": "alcohol_content",
    "alcohol content": "alcohol_content",
    "alcohol_content": "alcohol_content",
    "proof": "alcohol_content",
    "net contents": "net_contents",
    "net_contents": "net_contents",
    "volume": "net_contents",
    "contents": "net_contents",
    "producer": "producer_address",
    "producer address": "producer_address",
    "producer_address": "producer_address",
    "address": "producer_address",
    "name and address": "producer_address",
    "country": "country_of_origin",
    "country of origin": "country_of_origin",
    "country_of_origin": "country_of_origin",
    "filename": "filename",
    "file": "filename",
    "file name": "filename",
    "id": "application_id",
    "application_id": "application_id",
    "application id": "application_id",
    "is_import": "is_import",
    "import": "is_import",
    "is import": "is_import",
}


def parse_applications(json_text: str | None, csv_text: str | None) -> list[LabelApplication]:
    records: list[LabelApplication] = []
    if json_text and json_text.strip():
        records.extend(_from_json(json_text))
    if csv_text and csv_text.strip():
        records.extend(_from_csv(csv_text))
    return records


def pair_applications(
    filenames: list[str],
    applications: list[LabelApplication],
) -> list[LabelApplication]:
    """One application per image, by filename when present, otherwise by order."""
    if not applications:
        return [LabelApplication() for _ in filenames]

    named = [item for item in applications if (item.filename or "").strip()]
    if named:
        by_name = {_key(item.filename or ""): item for item in named}
        missing = [name for name in filenames if _key(name) not in by_name]
        if missing and len(named) != len(filenames):
            shown = ", ".join(missing[:3])
            raise PairingError(
                "Some images have no row in the spreadsheet. "
                f"Missing: {shown}. Use a filename column that matches each image name."
            )
        return [by_name.get(_key(name), LabelApplication(filename=name)) for name in filenames]

    if len(applications) == 1 and len(filenames) == 1:
        return applications
    if len(applications) != len(filenames):
        raise PairingError(
            f"The application data has {len(applications)} row"
            f"{'' if len(applications) == 1 else 's'} but you uploaded {len(filenames)} "
            f"image{'s' if len(filenames) != 1 else ''}. "
            "Use the same number of rows as images, or add a filename column."
        )
    return applications


def _from_json(raw: str) -> list[LabelApplication]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PairingError("The application data isn't valid JSON.") from exc
    if isinstance(payload, dict) and "application" in payload and isinstance(payload["application"], dict):
        payload = payload["application"]
    if isinstance(payload, dict):
        return [_model(payload)]
    if isinstance(payload, list):
        if not all(isinstance(item, dict) for item in payload):
            raise PairingError("Each application record needs to be an object.")
        return [_model(item) for item in payload]
    raise PairingError("Application JSON should be one object or a list of objects.")


def _from_csv(raw: str) -> list[LabelApplication]:
    reader = csv.DictReader(io.StringIO(raw.lstrip("\ufeff")))
    if not reader.fieldnames:
        raise PairingError("The spreadsheet needs a header row.")
    rows = []
    for row in reader:
        if not any((value or "").strip() for value in row.values()):
            continue
        mapped: dict[str, str] = {}
        for key, value in row.items():
            if key is None:
                continue
            canonical = _ALIASES.get(key.strip().casefold())
            if canonical:
                mapped[canonical] = (value or "").strip()
        rows.append(_model(mapped))
    return rows


def _model(data: dict) -> LabelApplication:
    cleaned = {}
    for key, value in data.items():
        canonical = _ALIASES.get(str(key).strip().casefold(), key)
        if canonical not in LabelApplication.model_fields:
            continue
        if canonical == "is_import":
            cleaned[canonical] = _truthy(value)
        elif value is None:
            continue
        else:
            text = str(value).strip()
            cleaned[canonical] = text or None
    return LabelApplication.model_validate(cleaned)


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().casefold() in {"1", "true", "yes", "y", "import"}


def _key(filename: str) -> str:
    name = filename.replace("\\", "/").split("/")[-1].strip().casefold()
    return name
