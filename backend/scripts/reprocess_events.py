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
from app.geo import filter_route_outliers  # noqa: E402
from app.models import RawIngestEvent  # noqa: E402
from app.normalize import parse_payload, persist_payload  # noqa: E402
from app.strava import parse_strava_payload  # noqa: E402
from sqlalchemy import desc, select  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Reprocess stored raw ingest events")
    ap.add_argument("--dry-run", action="store_true", help="parse and report; do not write")
    ap.add_argument("--limit", type=int, default=None, help="reprocess only the N newest events")
    ap.add_argument(
        "--oldest-first",
        action="store_true",
        help=(
            "process events oldest-first so the most recent (complete) rolling-window "
            "export wins the final upsert for a day; use for a full rebuild"
        ),
    )
    ap.add_argument(
        "--contains",
        default=None,
        help="only reprocess events whose raw payload contains this substring",
    )
    args = ap.parse_args()

    db = SessionLocal()
    try:
        order = RawIngestEvent.received_utc.asc() if args.oldest_first else desc(RawIngestEvent.received_utc)
        stmt = select(RawIngestEvent.id, RawIngestEvent.received_utc).order_by(order)
        if args.limit:
            stmt = stmt.limit(args.limit)
        # Only the keys up front. Each event commits separately below, so holding
        # ORM rows would re-SELECT every one after the first commit; holding the
        # payloads instead would pull ~900 MB of JSON into memory at once.
        events = db.execute(stmt).all()

        totals = {"workouts": 0, "daily_metrics": 0, "splits": 0, "route_points_dropped": 0}
        processed = 0
        failed = 0
        for ev_id, received_utc in events:
            source, payload_json = db.execute(
                select(RawIngestEvent.source, RawIngestEvent.payload_json).where(RawIngestEvent.id == ev_id)
            ).one()
            if args.contains and args.contains not in payload_json:
                continue
            try:
                payload = json.loads(payload_json)
            except json.JSONDecodeError:
                print(f"  event {ev_id}: invalid JSON, skipped")
                continue
            # Each event is its own transaction, so one bad payload cannot leave an
            # earlier workout with its child rows deleted and not reinserted.
            try:
                if source == "strava":
                    parsed = parse_strava_payload(payload)
                elif source == "health_auto_export":
                    parsed = parse_payload(payload)
                else:
                    raise ValueError(f"Unsupported ingest source: {source}")
                for pw in parsed.workouts:
                    kept, dropped = filter_route_outliers(pw.route, pw.workout_type)
                    if dropped:
                        print(
                            f"    {pw.uuid} ({pw.workout_type}): "
                            f"route {len(pw.route)} -> {len(kept)} ({dropped} dropped)"
                        )
                counts = persist_payload(parsed, db, ingest_source=source)
                if args.dry_run:
                    db.rollback()
                else:
                    db.commit()
            except Exception as exc:  # noqa: BLE001 - report and keep going
                db.rollback()
                failed += 1
                print(f"  event {ev_id}: FAILED, rolled back ({exc})")
                continue
            processed += 1
            for k in totals:
                totals[k] += counts[k]
            print(
                f"  event {ev_id} ({received_utc}): "
                f"workouts={counts['workouts']} daily_metrics={counts['daily_metrics']} "
                f"splits={counts['splits']} route_points_dropped={counts['route_points_dropped']}"
            )

        verb = "Would have touched" if args.dry_run else "Reprocessed"
        prefix = "DRY RUN — each event rolled back. " if args.dry_run else "Committed per event. "
        print(f"{prefix}{verb} {processed} event(s), {failed} failed: {totals}")
        return 1 if failed else 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
