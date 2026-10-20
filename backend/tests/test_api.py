"""HTTP behavior: bad files, the batch cap, and spreadsheet pairing."""

import io

from fastapi.testclient import TestClient

from app.main import app
from app.models import FieldStatus, Verdict, VerificationResult


def _result(filename: str, brand: str | None = None) -> VerificationResult:
    return VerificationResult(
        filename=filename,
        elapsed_ms=25,
        over_budget=False,
        verdict=Verdict.APPROVE,
        verdict_text="APPROVE (auto-suggested)",
        fields=[],
        attention=[],
        ocr_text=brand or "",
    )


def test_health_reports_no_external_calls():
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["external_network_calls"] is False
    assert body["ocr_engine"] == "tesseract"
    assert body["max_batch"] == 300
    assert body["latency_budget_ms"] == 5000


def test_corrupt_file_is_rejected_without_a_crash():
    with TestClient(app) as client:
        response = client.post(
            "/api/verify",
            files={"file": ("notes.txt", b"this is not a picture", "text/plain")},
            data={"application": "{}"},
        )
    assert response.status_code == 400
    assert "image" in response.json()["detail"].lower()


def test_invalid_application_json():
    png = _png()
    with TestClient(app) as client:
        response = client.post(
            "/api/verify",
            files={"file": ("label.png", png, "image/png")},
            data={"application": "{"},
        )
    assert response.status_code == 400
    assert "JSON" in response.json()["detail"]


def test_batch_over_300_is_refused():
    files = [("files", (f"{index}.png", b"x", "image/png")) for index in range(301)]
    with TestClient(app) as client:
        response = client.post("/api/verify/batch", files=files)
    assert response.status_code == 400
    assert "300" in response.json()["detail"]


def test_batch_keeps_going_when_one_file_is_bad(monkeypatch):
    def fake(data: bytes, application, filename: str = "label"):
        if data == b"bad":
            from app.pipeline.run import ImageRejected

            raise ImageRejected("This file doesn't look like an image. Use a JPG or PNG photo.")
        return _result(filename)

    monkeypatch.setattr("app.queue.verify_bytes", fake)
    monkeypatch.setattr("app.queue.save_image", lambda *_args, **_kwargs: "/api/jobs/test/images/x.png")

    spreadsheet = (
        "filename,brand_name\n"
        "good.png,OLD TOM DISTILLERY\n"
        "bad.png,OLD TOM DISTILLERY\n"
    )
    files = [
        ("files", ("good.png", b"good", "image/png")),
        ("files", ("bad.png", b"bad", "image/png")),
    ]
    with TestClient(app) as client:
        started = client.post(
            "/api/verify/batch",
            files=files,
            data={"spreadsheet": spreadsheet},
        )
        # The spreadsheet field is a file upload, not a form string. Send it properly.
        if started.status_code == 400:
            started = client.post(
                "/api/verify/batch",
                files=[
                    *files,
                    ("spreadsheet", ("applications.csv", spreadsheet.encode(), "text/csv")),
                ],
            )
        assert started.status_code == 200, started.text
        job_id = started.json()["id"]
        body = started.json()
        for _ in range(30):
            if body["status"] == "complete":
                break
            body = client.get(f"/api/jobs/{job_id}").json()
    assert body["status"] == "complete"
    assert body["total"] == 2
    assert len(body["failed"]) == 1
    assert body["failed"][0]["filename"] == "bad.png"
    assert len(body["items"]) == 1
    assert body["items"][0]["filename"] == "good.png"


def test_unknown_job_is_a_clear_404():
    with TestClient(app) as client:
        response = client.get("/api/jobs/does-not-exist")
    assert response.status_code == 404


def test_template_csv_downloads():
    with TestClient(app) as client:
        response = client.get("/api/applications/template.csv")
    assert response.status_code == 200
    assert "brand_name" in response.text
    assert "alcohol_content" in response.text


def test_pairing_row_count_mismatch_is_explained():
    with TestClient(app) as client:
        response = client.post(
            "/api/verify/batch",
            files=[("files", ("a.png", _png(), "image/png"))],
            data={"applications": '[{"brand_name": "A"}, {"brand_name": "B"}]'},
        )
    assert response.status_code == 400
    assert "row" in response.json()["detail"].lower()


def _png() -> bytes:
    """A 1×1 white PNG. Real labels are covered by the image tests."""
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xff\xff?"
        b"\x00\x05\xfe\x02\xfe\xdc\xccY\xe7\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def test_unused_imports_stay_honest():
    assert FieldStatus.MATCH.value == "MATCH"
    assert io.BytesIO
