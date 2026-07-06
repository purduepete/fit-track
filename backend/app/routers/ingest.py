"""Ingestion endpoint consumed by the Health Auto Export iOS app."""
import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import require_ingest
from ..config import get_settings
from ..db import get_db
from ..models import RawIngestEvent
from ..normalize import parse_payload, payload_hash, persist_payload
from ..schemas import IngestResult
from ..timeutil import utcnow

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


@router.post("/health-auto-export", response_model=IngestResult)
async def ingest_health_auto_export(
    request: Request,
    db: Session = Depends(get_db),
    _token=Depends(require_ingest),
) -> IngestResult:
    """Accept a Health Auto Export JSON payload.

    The raw body, the normalized rows and the event status are written in a
    single transaction (committed at the end), so a crash mid-persist leaves no
    partial state. Duplicates are detected by the SHA-256 payload hash, and
    normalization performs idempotent upserts keyed on the Apple workout UUID.
    """
    max_bytes = get_settings().max_ingest_bytes
    # Fast path: reject via the Content-Length header before reading any body.
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Payload exceeds {max_bytes} bytes",
        )

    # Stream the body and abort as soon as the running total exceeds the cap, so a
    # missing/inaccurate Content-Length cannot buffer an unbounded upload into
    # memory and OOM the container.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Payload exceeds {max_bytes} bytes",
            )
    raw_text = bytes(raw).decode("utf-8")
    digest = payload_hash(raw_text)

    # Lock the dedupe row so concurrent retries of the same payload serialize:
    # if a prior request left the event in "received" (e.g. crashed mid-persist),
    # only one retry reprocesses it; the other blocks here, then sees "processed"
    # and returns a duplicate. No-op on SQLite (FOR UPDATE is omitted).
    existing = db.execute(
        select(RawIngestEvent)
        .where(RawIngestEvent.payload_hash == digest)
        .with_for_update()
    ).scalar_one_or_none()
    if existing is not None and existing.status == "processed":
        return IngestResult(status="ok", duplicate=True)

    event = existing or RawIngestEvent(
        source="health_auto_export",
        received_utc=utcnow(),
        payload_hash=digest,
        payload_json=raw_text,
        status="received",
    )
    if existing is None:
        db.add(event)
        try:
            # Flush (not commit) so the whole ingest is one transaction: the event
            # row, the normalized rows and status='processed' commit together at
            # the end. A concurrent insert of the same payload still trips the
            # payload_hash unique constraint here and is returned as a duplicate.
            db.flush()
        except IntegrityError:
            db.rollback()
            return IngestResult(status="ok", duplicate=True)

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body is not valid JSON.",
        ) from exc
    parsed = parse_payload(payload)
    counts = persist_payload(parsed, db)

    event.status = "processed"
    event.processed_utc = utcnow()
    db.commit()

    return IngestResult(
        status="ok",
        workouts=counts["workouts"],
        daily_metrics=counts["daily_metrics"],
        splits=counts["splits"],
    )
