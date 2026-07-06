"""Re-parse and re-persist stored raw ingest events with the current code.

Raw payloads are kept in ``raw_ingest_events`` precisely so normalization can be
re-run after the parser changes (e.g. adding a new metric). This walks stored
events, re-parses each payload with the current :func:`parse_payload`, and
idempotently upserts the result via :func:`persist_payload` — the same code path
as live ingest, so it is safe to run repeatedly.

DB-altering script: per project policy, get a Gemini second opinion before
running this against the live WebPortfolio database.

Usage:
    python -m scripts.reprocess_events --dry-run            # parse only, no writes
    python -m scripts.reprocess_events                      # reprocess all events
    python -m scripts.reprocess_events --limit 1            # newest event only
    python -m scripts.reprocess_events --contains sleep_analysis  # only matching payloads
"""
from __future__ import annotations

import argparse
import json
import sys

sys.path.insert(0, ".")

from app.db import SessionLocal  # noqa: E402
from app.models import RawIngestEvent  # noqa: E402
from app.normalize import parse_payload, persist_payload  # noqa: E402
from sqlalchemy import desc, select  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Reprocess stored raw ingest events")
    ap.add_argument("--dry-run", action="store_true", help="parse and report; do not write")
    ap.add_argument("--limit", type=int, default=None, help="reprocess only the N newest events")
    ap.add_argument(
        "--contains",
        default=None,
        help="only reprocess events whose raw payload contains this substring",
    )
    args = ap.parse_args()

    db = SessionLocal()
    try:
        stmt = select(RawIngestEvent).order_by(desc(RawIngestEvent.received_utc))
        if args.limit:
            stmt = stmt.limit(args.limit)
        events = db.execute(stmt).scalars().all()

        totals = {"workouts": 0, "daily_metrics": 0, "splits": 0}
        processed = 0
        for ev in events:
            if args.contains and args.contains not in ev.payload_json:
                continue
            try:
                payload = json.loads(ev.payload_json)
            except json.JSONDecodeError:
                print(f"  event {ev.id}: invalid JSON, skipped")
                continue
            counts = persist_payload(parse_payload(payload), db)
            processed += 1
            for k in totals:
                totals[k] += counts[k]
            print(
                f"  event {ev.id} ({ev.received_utc}): "
                f"workouts={counts['workouts']} daily_metrics={counts['daily_metrics']} "
                f"splits={counts['splits']}"
            )

        if args.dry_run:
            db.rollback()
            print(f"DRY RUN — rolled back. Would have touched {processed} event(s): {totals}")
        else:
            db.commit()
            print(f"Committed. Reprocessed {processed} event(s): {totals}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
