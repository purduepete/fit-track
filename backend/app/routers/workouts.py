"""Read endpoints for the workout list and per-workout detail (splits/route/HR)."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import require_read
from ..db import get_db
from ..models import Workout, WorkoutRoutePoint, WorkoutSample, WorkoutSplit
from ..schemas import (
    HrPointOut,
    RoutePointOut,
    SplitOut,
    WorkoutDetail,
    WorkoutSummary,
)

router = APIRouter(prefix="/api/workouts", tags=["workouts"])


@router.get("", response_model=list[WorkoutSummary])
def list_workouts(
    db: Session = Depends(get_db),
    _token=Depends(require_read),
    limit: int = Query(100, le=500),
    offset: int = 0,
    workout_type: str | None = None,
) -> list[WorkoutSummary]:
    stmt = select(Workout).order_by(Workout.start_utc.desc())
    if workout_type:
        stmt = stmt.where(Workout.workout_type == workout_type)
    stmt = stmt.offset(offset).limit(limit)
    return [WorkoutSummary.model_validate(w, from_attributes=True) for w in db.scalars(stmt)]


@router.get("/{uuid}", response_model=WorkoutDetail)
def get_workout(
    uuid: str,
    unit: str = Query("mi", pattern="^(mi|km)$"),
    db: Session = Depends(get_db),
    _token=Depends(require_read),
) -> WorkoutDetail:
    w = db.get(Workout, uuid)
    if w is None:
        raise HTTPException(status_code=404, detail="Workout not found")

    splits = db.scalars(
        select(WorkoutSplit)
        .where(WorkoutSplit.workout_uuid == uuid, WorkoutSplit.unit_system == unit)
        .order_by(WorkoutSplit.split_index)
    ).all()
    route = db.scalars(
        select(WorkoutRoutePoint)
        .where(WorkoutRoutePoint.workout_uuid == uuid)
        .order_by(WorkoutRoutePoint.seq)
    ).all()
    hr = db.scalars(
        select(WorkoutSample)
        .where(WorkoutSample.workout_uuid == uuid, WorkoutSample.metric_type == "heart_rate")
        .order_by(WorkoutSample.start_utc)
    ).all()

    return WorkoutDetail(
        **WorkoutSummary.model_validate(w, from_attributes=True).model_dump(),
        source_name=w.source_name,
        device_name=w.device_name,
        end_utc=w.end_utc,
        min_hr=w.min_hr,
        splits=[SplitOut.model_validate(s, from_attributes=True) for s in splits],
        route=[RoutePointOut.model_validate(r, from_attributes=True) for r in route],
        hr_series=[HrPointOut(ts_utc=s.start_utc, bpm=s.value) for s in hr],
    )
