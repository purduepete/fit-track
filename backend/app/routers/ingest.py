"""Ingestion endpoint consumed by the Health Auto Export iOS app."""
import json

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import require_ingest
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

    The raw body is stored first (deduplicated by SHA-256 hash) so parsing can
    be re-run later without asking the phone to resend data. Normalization then
    performs idempotent upserts keyed on the Apple workout UUID.
    """
    raw_bytes = await request.body()
    raw_text = raw_bytes.decode("utf-8")
    digest = payload_hash(raw_text)

    existing = db.execute(
        select(RawIngestEvent).where(RawIngestEvent.payload_hash == digest)
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
        db.commit()

    payload = json.loads(raw_text)
    parsed = parse_payload(payload)
    counts = persist_payload(parsed, db)

    event.status = "processed"
    event.processed_utc = utcnow()
    db.commit()

    return IngestResult(status="ok", **counts)
