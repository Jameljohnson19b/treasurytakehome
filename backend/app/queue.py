"""In-memory batch queue.

A few hundred labels fit in one process. A later deployment can move the same
job shape onto Redis without changing the checklist the agent sees.
"""

from __future__ import annotations

import asyncio
import time
import uuid

from app.models import ItemFailure, JobView, LabelApplication, VerificationResult
from app.pipeline.constants import OCR_WORKERS
from app.pipeline.ocr import ScannerUnavailable
from app.pipeline.run import ImageRejected, verify_bytes
from app.storage import save_image


class Job:
    def __init__(self, total: int) -> None:
        self.id = uuid.uuid4().hex
        self.status = "queued"
        self.total = total
        self.completed = 0
        self.current_file: str | None = None
        self.started = time.perf_counter()
        self.items: list[VerificationResult] = []
        self.failed: list[ItemFailure] = []
        self._ordered: dict[int, VerificationResult | ItemFailure] = {}
        self._lock = asyncio.Lock()

    def view(self) -> JobView:
        elapsed = int((time.perf_counter() - self.started) * 1000)
        items = [value for value in self._ordered.values() if isinstance(value, VerificationResult)]
        failed = [value for value in self._ordered.values() if isinstance(value, ItemFailure)]
        # Keep completion order stable for the table: file order, not finish order.
        ordered_items = [
            self._ordered[index]
            for index in range(self.total)
            if index in self._ordered and isinstance(self._ordered[index], VerificationResult)
        ]
        ordered_failed = [
            self._ordered[index]
            for index in range(self.total)
            if index in self._ordered and isinstance(self._ordered[index], ItemFailure)
        ]
        return JobView(
            id=self.id,
            status=self.status,  # type: ignore[arg-type]
            total=self.total,
            completed=self.completed,
            current_file=self.current_file,
            elapsed_ms=elapsed,
            items=ordered_items or items,
            failed=ordered_failed or failed,
        )


class JobQueue:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self._semaphore = asyncio.Semaphore(OCR_WORKERS)

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def enqueue(self, work: list[tuple[str, bytes, LabelApplication]]) -> Job:
        job = Job(total=len(work))
        self.jobs[job.id] = job
        asyncio.create_task(self._run(job, work))
        return job

    async def _run(self, job: Job, work: list[tuple[str, bytes, LabelApplication]]) -> None:
        job.status = "running"

        async def one(index: int, filename: str, data: bytes, application: LabelApplication) -> None:
            async with self._semaphore:
                job.current_file = filename
                try:
                    stored = await asyncio.to_thread(_check, job.id, filename, data, application)
                except ImageRejected as exc:
                    stored = ItemFailure(filename=filename, error=exc.message)
                except ScannerUnavailable as exc:
                    stored = ItemFailure(filename=filename, error=exc.message)
                except Exception:
                    stored = ItemFailure(
                        filename=filename,
                        error="This label could not be checked. It can be retried on its own.",
                    )
                async with job._lock:
                    job._ordered[index] = stored
                    job.completed += 1

        await asyncio.gather(
            *(one(index, filename, data, application) for index, (filename, data, application) in enumerate(work))
        )
        job.status = "complete"
        job.current_file = None


def _check(job_id: str, filename: str, data: bytes, application: LabelApplication) -> VerificationResult:
    result = verify_bytes(data, application, filename)
    image_url = save_image(job_id, filename, data)
    return result.model_copy(update={"image_url": image_url})


queue = JobQueue()
