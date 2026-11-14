"""Fill power, cadence, elevation and W/kg on Health Zwift rides from Strava.

Rides recorded before the Strava import boundary came in through Apple Health
(for example from RunGap) without power, cadence or elevation. This lists the
Strava virtual rides in a date range, matches each to a stored non-Strava
cycling workout (start within 60 s and end within 120 s, the same rule as the
cross-source duplicate check), reads the ride's details, and fills only empty
fields. W/kg uses the saved athlete weight and is never recalculated.

Stop the app first: this shares the Strava credential file, and a token refresh
rotates the refresh token. DB-altering: get the independent review first.

Usage (from backend):
    python -m scripts.enrich_from_strava --token-file PATH --start 2026-10-06          # dry run
    python -m scripts.enrich_from_strava --token-file PATH --start 2026-10-06 --apply
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from sqlalchemy import select, text
from sqlalchemy.orm import Session

sys.path.insert(0, ".")

from app.models import Workout  # noqa: E402
from app.normalize import _current_weight_kg  # noqa: E402
from app.strava import StravaClient, StravaError, _optional_nonnegative  # noqa: E402
from app.timeutil import utcnow  # noqa: E402


@dataclass
class Match:
    activity_id: int
    workout_uuid: str | None
    local_date: str | None
    changes: dict[str, float]
    note: str = ""


def _start(summary: dict) -> datetime:
    try:
        start = datetime.fromisoformat(summary["start_date"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise StravaError("Strava returned an invalid ride start time.") from exc
    return start.astimezone(UTC).replace(tzinfo=None)


def enrich(client: StravaClient, db: Session, after: int, before: int) -> list[Match]:
    """Stage updates in ``db`` (no commit) and describe each Strava virtual ride."""
    if db.get_bind().dialect.name == "postgresql":
        # The import lock keeps Health and Strava writers out until this commits.
        db.execute(text("SELECT pg_advisory_xact_lock(8791, 1)"))
    weight = _current_weight_kg(db)
    results: list[Match] = []
    page = 1
    while True:
        activities = client.get("athlete/activities", after=after, before=before, per_page=100, page=page)
        if not isinstance(activities, list):
            raise StravaError("Strava returned an invalid activity list.")
        if not activities:
            break
        for summary in activities:
            if not isinstance(summary, dict) or summary.get("sport_type", summary.get("type")) != "VirtualRide":
                continue
            activity_id = summary.get("id")
            start = _start(summary)
            end = start + timedelta(seconds=float(summary.get("elapsed_time") or 0))
            candidates = [
                w for w in db.scalars(
                    select(Workout).where(
                        Workout.start_utc >= start - timedelta(seconds=60),
                        Workout.start_utc <= start + timedelta(seconds=60),
                        Workout.uuid.not_like("strava:%"),
                    )
                )
                if "cycl" in w.workout_type.casefold() and abs((w.end_utc - end).total_seconds()) <= 120
            ]
            if len(candidates) != 1:
                results.append(Match(activity_id, None, None, {}, f"{len(candidates)} matching rides"))
                continue
            workout = candidates[0]
            activity = client.get(f"activities/{activity_id}")
            if not isinstance(activity, dict) or activity.get("id") != activity_id:
                raise StravaError("Strava returned details for a different activity.")
            values = {
                "average_watts": _optional_nonnegative(activity, "average_watts"),
                "average_cadence": _optional_nonnegative(activity, "average_cadence"),
                "elevation_gain_m": _optional_nonnegative(activity, "total_elevation_gain"),
            }
            changes = {
                field: value for field, value in values.items()
                if value is not None and getattr(workout, field) is None
            }
            watts = changes.get("average_watts", workout.average_watts)
            if workout.watts_per_kg is None and watts is not None and weight:
                changes["watts_per_kg"] = round(watts / weight, 2)
            for field, value in changes.items():
                setattr(workout, field, value)
            if changes:
                workout.updated_utc = utcnow()
            results.append(Match(activity_id, workout.uuid, workout.local_date, changes))
        page += 1
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Fill Health Zwift rides from matching Strava rides")
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--start", required=True, help="First local date to read (YYYY-MM-DD)")
    parser.add_argument("--apply", action="store_true", help="commit the changes (default is a dry run)")
    args = parser.parse_args()

    from app.db import SessionLocal

    with httpx.Client(timeout=30, follow_redirects=False) as http, SessionLocal() as db:
        client = StravaClient(args.token_file, http)
        # One day of margin covers rides whose UTC start is the previous local day.
        after = int(datetime.fromisoformat(args.start).replace(tzinfo=UTC).timestamp()) - 86400
        before = client.credentials.import_after
        results = enrich(client, db, after, before)
        for r in results:
            label = r.workout_uuid or "no match"
            detail = r.changes or r.note or "nothing to fill"
            print(f"  strava {r.activity_id} -> {label} {r.local_date or ''} {detail}")
        changed = sum(1 for r in results if r.changes)
        unmatched = sum(1 for r in results if r.workout_uuid is None)
        if args.apply:
            db.commit()
        else:
            db.rollback()
        verb = "Updated" if args.apply else "DRY RUN: would update"
        print(f"{verb} {changed} workout(s); {len(results)} Strava virtual ride(s); {unmatched} unmatched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
