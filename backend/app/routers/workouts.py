"""Read endpoints for the workout list and per-workout detail (splits/route/HR)."""
import math
from collections.abc import Sequence
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import case, func, nulls_last, select
from sqlalchemy.orm import Session

from ..auth import require_control, require_read
from ..db import get_db
from ..models import Workout, WorkoutRoutePoint, WorkoutSample, WorkoutSplit
from ..point_exclusions import point_view
from ..schemas import (
    ElevationPointOut,
    HrPointOut,
    PointExclusion,
    PointExclusionChanges,
    PointExclusionRequest,
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
        rows = list(db.scalars(select(model).where(*where).order_by(order_col, id_col)))
        return rows, len(rows)
    ids = list(db.scalars(select(id_col).where(*where).order_by(order_col, id_col)))
    total = len(ids)
    idxs = _sample_indices(total, cap)
    if len(idxs) == total:
        rows = list(db.scalars(select(model).where(*where).order_by(order_col, id_col)))
        return rows, total
    wanted = [ids[i] for i in idxs]
    rows = list(db.scalars(select(model).where(id_col.in_(wanted)).order_by(order_col, id_col)))
    return rows, total


def _sort_column(key: str) -> Any:
    if key == "distance":
        return Workout.distance_m
    if key == "pace":
        # Seconds per meter; null without a positive distance and a duration.
        return case(
            (
                (Workout.distance_m > 0) & Workout.duration_sec.is_not(None),
                Workout.duration_sec / Workout.distance_m,
            ),
            else_=None,
        )
    if key == "kcal":
        return Workout.active_energy_kcal
    if key == "power":
        return Workout.average_watts
    if key == "wkg":
        return Workout.watts_per_kg
    if key == "duration":
        return Workout.duration_sec
    if key == "hr":
        return Workout.avg_hr
    if key == "maxhr":
        return Workout.max_hr
    if key == "cadence":
        return Workout.average_cadence
    if key == "elev":
        return Workout.elevation_gain_m
    return Workout.start_utc


@router.get("", response_model=WorkoutList)
def list_workouts(
    db: Session = Depends(get_db),
    _token=Depends(require_read),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    workout_type: str | None = None,
    date_from: str | None = Query(None, description="Inclusive local start date (YYYY-MM-DD)."),
    date_to: str | None = Query(None, description="Inclusive local end date (YYYY-MM-DD)."),
    sort: Literal[
        "date", "duration", "distance", "pace", "kcal", "hr", "maxhr", "power", "wkg", "cadence", "elev"
    ] = "date",
    order: Literal["asc", "desc"] = "desc",
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
    column = _sort_column(sort)
    primary = column.asc() if order == "asc" else column.desc()
    stmt = (
        select(Workout)
        .where(*filters)
        # Missing values sort last either way; newest first breaks ties.
        .order_by(nulls_last(primary), Workout.start_utc.desc(), Workout.uuid.desc())
        .offset(offset)
        .limit(limit)
    )
    items = [
        point_view(db, w).summary if w.point_exclusions else WorkoutSummary.model_validate(w, from_attributes=True)
        for w in db.scalars(stmt)
    ]
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

    # Adjacent workouts by start time for prev/next navigation. prev = next-older
    # (start_utc just below this one), next = next-newer (just above). Ties on
    # start_utc are broken by uuid so navigation is stable and can't loop.
    prev_uuid = db.scalar(
        select(Workout.uuid)
        .where(
            (Workout.start_utc < w.start_utc)
            | ((Workout.start_utc == w.start_utc) & (Workout.uuid < uuid))
        )
        .order_by(Workout.start_utc.desc(), Workout.uuid.desc())
        .limit(1)
    )
    next_uuid = db.scalar(
        select(Workout.uuid)
        .where(
            (Workout.start_utc > w.start_utc)
            | ((Workout.start_utc == w.start_utc) & (Workout.uuid > uuid))
        )
        .order_by(Workout.start_utc.asc(), Workout.uuid.asc())
        .limit(1)
    )

    if full or w.point_exclusions or (w.source_name == "Strava" and not w.has_route):
        view = point_view(db, w)
        summary = view.summary
        splits = view.splits
        route_total, hr_total = len(view.route), len(view.heart_rate)
        route_out = view.route if full else [view.route[i] for i in _sample_indices(route_total, MAX_ROUTE_POINTS)]
        hr_out = view.heart_rate if full else [view.heart_rate[i] for i in _sample_indices(hr_total, MAX_HR_POINTS)]
        exclusions = view.exclusions
        data_points = view.points if full else []
        min_hr = view.min_hr
        elevations = [
            ElevationPointOut(ts_utc=point.ts_utc, elevation_m=value)
            for point in view.points if not point.excluded for value in point.elevation_m
        ]
        if not full:
            elevations = [elevations[i] for i in _sample_indices(len(elevations), MAX_ROUTE_POINTS)]
    else:
        summary = WorkoutSummary.model_validate(w, from_attributes=True)
        splits = [
            SplitOut.model_validate(s, from_attributes=True)
            for s in db.scalars(
                select(WorkoutSplit)
                .where(WorkoutSplit.workout_uuid == uuid)
                .order_by(WorkoutSplit.unit_system, WorkoutSplit.split_index)
            )
        ]
        route_out, route_total = _load_series(
            db, WorkoutRoutePoint, WorkoutRoutePoint.id, WorkoutRoutePoint.seq,
            [WorkoutRoutePoint.workout_uuid == uuid], MAX_ROUTE_POINTS, False,
        )
        hr_out, hr_total = _load_series(
            db, WorkoutSample, WorkoutSample.id, WorkoutSample.start_utc,
            [WorkoutSample.workout_uuid == uuid, WorkoutSample.metric_type == "heart_rate"],
            MAX_HR_POINTS, False,
        )
        exclusions = []
        data_points = []
        min_hr = w.min_hr
        elevations = [
            ElevationPointOut(ts_utc=row.ts_utc, elevation_m=row.elevation_m)
            for row in route_out
            if row.elevation_m is not None and math.isfinite(row.elevation_m)
        ]

    return WorkoutDetail(
        **summary.model_dump(),
        source_name=w.source_name,
        device_name=w.device_name,
        end_utc=w.end_utc,
        min_hr=min_hr,
        splits=splits,
        route=[RoutePointOut.model_validate(r, from_attributes=True) for r in route_out],
        elevation_series=elevations,
        hr_series=[HrPointOut(ts_utc=s.start_utc, bpm=s.value) for s in hr_out],
        point_exclusions=exclusions,
        data_points=data_points,
        route_total=route_total,
        hr_total=hr_total,
        route_downsampled=len(route_out) < route_total,
        hr_downsampled=len(hr_out) < hr_total,
        prev_uuid=prev_uuid,
        next_uuid=next_uuid,
    )


def _lock_workout(db: Session, uuid: str) -> Workout:
    workout = db.scalar(select(Workout).where(Workout.uuid == uuid).with_for_update())
    if workout is None:
        raise HTTPException(status_code=404, detail="Workout not found")
    return workout


def _require_edit_header(value: str | None) -> None:
    if value != "1":
        raise HTTPException(status_code=403, detail="Missing FitTrack edit header")


def _validate_new_exclusions(db: Session, workout: Workout, timestamps: set[datetime]) -> None:
    if not timestamps:
        return
    view = point_view(db, workout)
    if timestamps - {point.ts_utc for point in view.points}:
        raise HTTPException(status_code=404, detail="Workout point not found")
    if not view.can_recalculate:
        raise HTTPException(
            status_code=409,
            detail="Original distance samples are unavailable; this workout's splits cannot be recalculated.",
        )


@router.post("/{uuid}/point-exclusions/batch")
def save_point_exclusions(
    uuid: str,
    request: PointExclusionChanges,
    x_fittrack_edit: str | None = Header(default=None),
    db: Session = Depends(get_db),
    _token=Depends(require_control),
) -> dict[str, str]:
    _require_edit_header(x_fittrack_edit)
    exclude = {point.ts_utc for point in request.exclude}
    restore = {point.ts_utc for point in request.restore}
    if exclude & restore:
        raise HTTPException(status_code=422, detail="A point cannot be both excluded and restored")
    workout = _lock_workout(db, uuid)
    current = {PointExclusion.model_validate(item).ts_utc for item in workout.point_exclusions}
    _validate_new_exclusions(db, workout, exclude - current)
    workout.point_exclusions = [
        PointExclusion(ts_utc=timestamp).model_dump(mode="json")
        for timestamp in sorted((current | exclude) - restore)
    ]
    db.commit()
    return {"status": "saved"}


@router.post("/{uuid}/point-exclusions", response_model=PointExclusion, status_code=201)
def exclude_point(
    uuid: str,
    request: PointExclusionRequest,
    x_fittrack_edit: str | None = Header(default=None),
    db: Session = Depends(get_db),
    _token=Depends(require_control),
) -> PointExclusion:
    _require_edit_header(x_fittrack_edit)
    workout = _lock_workout(db, uuid)
    exclusions = [PointExclusion.model_validate(item) for item in workout.point_exclusions]
    exclusion = PointExclusion(ts_utc=request.ts_utc)
    if exclusion in exclusions:
        raise HTTPException(status_code=409, detail="Point is already excluded")
    _validate_new_exclusions(db, workout, {exclusion.ts_utc})
    workout.point_exclusions = [*workout.point_exclusions, exclusion.model_dump(mode="json")]
    db.commit()
    return exclusion


@router.post("/{uuid}/point-exclusions/restore")
def restore_point(
    uuid: str,
    exclusion: PointExclusion,
    x_fittrack_edit: str | None = Header(default=None),
    db: Session = Depends(get_db),
    _token=Depends(require_control),
) -> dict[str, str]:
    _require_edit_header(x_fittrack_edit)
    workout = _lock_workout(db, uuid)
    exclusions = [PointExclusion.model_validate(item) for item in workout.point_exclusions]
    if exclusion not in exclusions:
        raise HTTPException(status_code=404, detail="Excluded point not found")
    exclusions.remove(exclusion)
    workout.point_exclusions = [item.model_dump(mode="json") for item in exclusions]
    db.commit()
    return {"status": "restored"}
