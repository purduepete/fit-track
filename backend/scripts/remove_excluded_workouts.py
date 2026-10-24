"""Remove the 4 user-excluded 10/07/2026 workouts after independent DB review.

Run from backend: python -m scripts.remove_excluded_workouts [--apply]
Without --apply, validate and report the exact rows without deleting anything.
Raw ingest events and daily metrics are retained.
"""
import argparse

from app.db import SessionLocal
from app.models import Workout
from app.normalize import EXCLUDED_WORKOUT_IDS
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session


def remove_excluded_workouts(db: Session, *, apply: bool = False) -> list[str]:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(8791, 1)"))
    workouts = list(db.scalars(
        select(Workout).where(func.lower(Workout.uuid).in_(EXCLUDED_WORKOUT_IDS))
    ))
    for workout in workouts:
        if workout.local_date != "2026-10-07" or workout.workout_type != "Indoor Cycling":
            raise ValueError(f"Excluded workout {workout.uuid} does not match the approved date and type.")
    ids = sorted(workout.uuid for workout in workouts)
    if apply:
        for workout in workouts:
            db.delete(workout)
        db.flush()
    return ids


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Commit the approved deletions.")
    args = parser.parse_args()
    with SessionLocal() as db:
        ids = remove_excluded_workouts(db, apply=args.apply)
        if args.apply:
            db.commit()
        else:
            db.rollback()
    print(f"{'Removed' if args.apply else 'Would remove'} {len(ids)} excluded workouts: {', '.join(ids)}")


if __name__ == "__main__":
    main()
