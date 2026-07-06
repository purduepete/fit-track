"""Read endpoints for the workout list and per-workout detail (splits/route/HR)."""
from collections.abc import Sequence
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import require_read
from ..db import get_db
from ..models import Workout, WorkoutRoutePoint, WorkoutSample, WorkoutSplit
from ..schemas import (
    HrPointOut,
    RoutePointOut,
    SplitOut,
    WorkoutDetail,
    WorkoutList,
    WorkoutSummary,
)

router = APIRouter(prefix="/api/workouts", tags=["workouts"])

# Default caps on the route / HR series returned by the detail endpoint. Long
# GPS workouts hold thousands of points; returning them all bloats the response
# and the client render. Pass ?full=true for the full-resolution series.
MAX_ROUTE_POINTS = 500
MAX_HR_POINTS = 500


def _sample_indices(n: int, cap: int) -> list[int]:
    """Indices to keep when uniformly subsampling ``n`` items to at most ``cap``.

    Preserves the first and last index; deterministic (same input -> same output)
    so the client sees a stable curve.
    """
    if cap <= 0 or n <= cap:
        return list(range(n))
    if cap == 1:
        return [0]
    step = (n - 1) / (cap - 1)
    return sorted({round(i * step) for i in range(cap)})


def _load_series(
    db: Session,
    model: type[Any],
    id_col: Any,
    order_col: Any,
    where: Sequence[Any],
    cap: int,
    full: bool,
) -> tuple[list[Any], int]:
    """Load an ordered child series, downsampling in the DB to at most ``cap`` rows.

    Fetches only the ordered ids first (a single lightweight column), picks the
    sampled positions, then loads just those full rows -- so a long GPS/HR series
    is never fully materialized in the app. ``full=True`` returns every row.
    Returns ``(rows, total)`` where ``total`` is the untruncated count.
    """
    if full:
        rows = list(db.scalars(select(model).where(*where).order_by(order_col)))
        return rows, len(rows)
    ids = list(db.scalars(select(id_col).where(*where).order_by(order_col)))
    total = len(ids)
    idxs = _sample_indices(total, cap)
    if len(idxs) == total:
        rows = list(db.scalars(select(model).where(*where).order_by(order_col)))
        return rows, total
    wanted = [ids[i] for i in idxs]
    rows = list(db.scalars(select(model).where(id_col.in_(wanted)).order_by(order_col)))
    return rows, total


@router.get("", response_model=WorkoutList)
def list_workouts(
    db: Session = Depends(get_db),
    _token=Depends(require_read),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    workout_type: str | None = None,
    date_from: str | None = Query(None, description="Inclusive local start date (YYYY-MM-DD)."),
    date_to: str | None = Query(None, description="Inclusive local end date (YYYY-MM-DD)."),
) -> WorkoutList:
    # local_date is a "YYYY-MM-DD" string, so lexical comparisons are valid dates.
    filters = []
    if workout_type:
        filters.append(Workout.workout_type == workout_type)
    if date_from:
        filters.append(Workout.local_date >= date_from)
    if date_to:
        filters.append(Workout.local_date <= date_to)

    total = db.scalar(select(func.count()).select_from(Workout).where(*filters)) or 0
    stmt = (
        select(Workout)
        .where(*filters)
        .order_by(Workout.start_utc.desc())
        .offset(offset)
        .limit(limit)
    )
    items = [WorkoutSummary.model_validate(w, from_attributes=True) for w in db.scalars(stmt)]
    return WorkoutList(items=items, total=total)


@router.get("/types", response_model=list[str])
def list_workout_types(
    db: Session = Depends(get_db),
    _token=Depends(require_read),
) -> list[str]:
    """Distinct workout types present in the data, for the filter dropdown."""
    return list(
        db.scalars(select(Workout.workout_type).distinct().order_by(Workout.workout_type))
    )


@router.get("/{uuid}", response_model=WorkoutDetail)
def get_workout(
    uuid: str,
    full: bool = Query(False, description="Return full-resolution route/HR instead of downsampled."),
    db: Session = Depends(get_db),
    _token=Depends(require_read),
) -> WorkoutDetail:
    w = db.get(Workout, uuid)
    if w is None:
        raise HTTPException(status_code=404, detail="Workout not found")

    # Return every split (both unit systems); the client selects mi/km locally so
    # toggling units never refetches the workout.
    splits = db.scalars(
        select(WorkoutSplit)
        .where(WorkoutSplit.workout_uuid == uuid)
        .order_by(WorkoutSplit.unit_system, WorkoutSplit.split_index)
    ).all()
    route_out, route_total = _load_series(
        db, WorkoutRoutePoint, WorkoutRoutePoint.id, WorkoutRoutePoint.seq,
        [WorkoutRoutePoint.workout_uuid == uuid], MAX_ROUTE_POINTS, full,
    )
    hr_out, hr_total = _load_series(
        db, WorkoutSample, WorkoutSample.id, WorkoutSample.start_utc,
        [WorkoutSample.workout_uuid == uuid, WorkoutSample.metric_type == "heart_rate"],
        MAX_HR_POINTS, full,
    )

    return WorkoutDetail(
        **WorkoutSummary.model_validate(w, from_attributes=True).model_dump(),
        source_name=w.source_name,
        device_name=w.device_name,
        end_utc=w.end_utc,
        min_hr=w.min_hr,
        splits=[SplitOut.model_validate(s, from_attributes=True) for s in splits],
        route=[RoutePointOut.model_validate(r, from_attributes=True) for r in route_out],
        hr_series=[HrPointOut(ts_utc=s.start_utc, bpm=s.value) for s in hr_out],
        route_total=route_total,
        hr_total=hr_total,
        route_downsampled=len(route_out) < route_total,
        hr_downsampled=len(hr_out) < hr_total,
    )
