"""DeskCheck HTTP API.

One process serves the checklist and, when the web app has been built,
the page itself. Checking a label does not call any outside service.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from app.models import LabelApplication
from app.pairing import PairingError, parse_applications, pair_applications
from app.pipeline.constants import LATENCY_BUDGET_MS, MAX_BATCH_FILES, MAX_FILE_BYTES
from app.pipeline.ocr import ScannerUnavailable, tesseract_available, tesseract_version
from app.pipeline.run import ImageRejected, verify_bytes
from app.queue import queue
from app.samples import find_sample, load_samples, sample_path
from app.storage import purge_expired, resolve_image, save_image

ROOT = Path(__file__).resolve().parents[2]
STATIC_DIR = Path(os.environ.get("STATIC_DIR", ROOT / "frontend" / "out"))

CSV_TEMPLATE = (
    "filename,brand_name,class_type,alcohol_content,net_contents,"
    "producer_address,country_of_origin,is_import\n"
    "old-tom.png,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,"
    "45% Alc./Vol. (90 Proof),750 mL,"
    "\"Old Tom Distillery, 100 Distillery Lane, Louisville, KY 40202\","
    "United States,no\n"
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = asyncio.Event()

    async def sweep() -> None:
        while not stop.is_set():
            await asyncio.to_thread(purge_expired)
            try:
                await asyncio.wait_for(stop.wait(), timeout=600)
            except asyncio.TimeoutError:
                continue

    task = asyncio.create_task(sweep())
    try:
        yield
    finally:
        stop.set()
        task.cancel()


app = FastAPI(
    title="DeskCheck",
    summary="Local checklist for alcohol label review.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok" if tesseract_available() else "degraded",
        "ocr_engine": "tesseract",
        "tesseract_available": tesseract_available(),
        "tesseract_version": tesseract_version(),
        "external_network_calls": False,
        "latency_budget_ms": LATENCY_BUDGET_MS,
        "max_batch": MAX_BATCH_FILES,
    }


@app.get("/api/samples")
def samples():
    return load_samples()


@app.get("/api/samples/{sample_id}/image")
def sample_image(sample_id: str):
    sample = find_sample(sample_id)
    if sample is None:
        raise HTTPException(status_code=404, detail="That example is not on this machine.")
    path = sample_path(sample)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="That example image is missing.")
    return FileResponse(path)


@app.post("/api/verify/sample/{sample_id}")
async def verify_sample(sample_id: str):
    sample = find_sample(sample_id)
    if sample is None:
        raise HTTPException(status_code=404, detail="That example is not on this machine.")
    path = sample_path(sample)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="That example image is missing.")
    try:
        result = await asyncio.to_thread(
            verify_bytes,
            path.read_bytes(),
            sample.application,
            sample.filename,
        )
    except ImageRejected as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except ScannerUnavailable as exc:
        raise HTTPException(status_code=503, detail=exc.message) from exc
    return result.model_copy(update={"image_url": f"/api/samples/{sample.id}/image"})


@app.get("/api/applications/template.csv")
def application_template() -> Response:
    return Response(
        content=CSV_TEMPLATE,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=deskcheck-applications.csv"},
    )


@app.post("/api/verify")
async def verify_one(
    file: UploadFile = File(...),
    application: str = Form("{}"),
):
    data = await file.read()
    filename = file.filename or "label"
    _reject_oversize(data, filename)
    try:
        applications = parse_applications(application, None)
    except PairingError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    form = applications[0] if applications else LabelApplication()
    try:
        result = await asyncio.to_thread(verify_bytes, data, form, filename)
    except ImageRejected as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except ScannerUnavailable as exc:
        raise HTTPException(status_code=503, detail=exc.message) from exc
    image_url = save_image(uuid.uuid4().hex, filename, data)
    return result.model_copy(update={"image_url": image_url})


@app.post("/api/verify/batch")
async def verify_batch(
    files: list[UploadFile] = File(...),
    application: str = Form(""),
    applications: str = Form(""),
    spreadsheet: UploadFile | None = File(None),
):
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"300 labels is the maximum for one batch. You sent {len(files)}. "
                "Split them into groups of 300."
            ),
        )
    if not files:
        raise HTTPException(status_code=400, detail="Choose at least one label image.")

    csv_text = ""
    if spreadsheet is not None and spreadsheet.filename:
        csv_text = (await spreadsheet.read()).decode("utf-8", errors="replace")
    json_text = applications.strip() or application.strip()
    try:
        parsed = parse_applications(json_text, csv_text)
        filenames = [item.filename or "label" for item in files]
        paired = pair_applications(filenames, parsed)
    except PairingError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc

    work: list[tuple[str, bytes, LabelApplication]] = []
    for upload, form in zip(files, paired, strict=True):
        data = await upload.read()
        filename = upload.filename or "label"
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"{filename} is larger than 8 MB. Export a smaller JPG or PNG.",
            )
        work.append((filename, data, form))

    job = queue.enqueue(work)
    return job.view()


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = queue.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="That batch is no longer on this machine.")
    return job.view()


@app.get("/api/jobs/{job_id}/images/{name}")
def job_image(job_id: str, name: str):
    try:
        path = resolve_image(job_id, name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="That image is no longer on this machine.") from None
    return FileResponse(path)


def _reject_oversize(data: bytes, filename: str) -> None:
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"{filename} is larger than 8 MB. Export a smaller JPG or PNG.",
        )


if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
else:

    @app.get("/")
    def api_only_root() -> dict:
        return {
            "name": "DeskCheck",
            "message": "The checker is running. Start the web app, or open /docs for the API.",
            "external_network_calls": False,
        }
