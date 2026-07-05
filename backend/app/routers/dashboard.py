"""Dashboard aggregate endpoint (last-7-day summary + trend series)."""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import require_read
from ..db import get_db
from ..models import DailyMetric, Workout
from ..schemas import DashboardSummary, MetricPoint
from ..timeutil import utcnow

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# HAE metric names that represent resting HR / VO2 max vary; match loosely.
RESTING_HR_NAMES = ("resting_heart_rate", "restingHeartRate")
VO2MAX_NAMES = ("vo2_max", "vo2Max", "vO2Max")

# Trend windows keep dashboard queries/payloads bounded as history grows.
WEEK_DAYS = 7
RESTING_TREND_DAYS = 90


def _latest_metric(db: Session, names: tuple[str, ...]) -> float | None:
    row = db.execute(
        select(DailyMetric.value)
        .where(DailyMetric.metric_type.in_(names))
        .order_by(DailyMetric.local_date.desc())
        .limit(1)
    ).scalar_one_or_none()
    return row


@router.get("", response_model=DashboardSummary)
def dashboard(
    db: Session = Depends(get_db),
    _token=Depends(require_read),
) -> DashboardSummary:
    since = utcnow() - timedelta(days=WEEK_DAYS)
    # local_date is a "YYYY-MM-DD" string, so lexical >= is a valid date window.
    resting_since = (utcnow() - timedelta(days=RESTING_TREND_DAYS)).strftime("%Y-%m-%d")

    # One grouped scan of the week: per-day counts/duration/energy. The 7-day
    # KPI totals are derived from these rows, avoiding a second window scan.
    by_date = db.execute(
        select(
            Workout.local_date,
            func.count(Workout.uuid),
            func.coalesce(func.sum(Workout.duration_sec), 0.0),
            func.coalesce(func.sum(Workout.active_energy_kcal), 0.0),
        )
        .where(Workout.start_utc >= since)
        .group_by(Workout.local_date)
        .order_by(Workout.local_date)
    ).all()

    workouts_7d = sum(row[1] for row in by_date)
    duration_7d = sum(row[2] for row in by_date)
    energy_7d = sum(row[3] for row in by_date)

    resting_trend = db.execute(
        select(DailyMetric.local_date, DailyMetric.value)
        .where(
            DailyMetric.metric_type.in_(RESTING_HR_NAMES),
            DailyMetric.local_date >= resting_since,
        )
        .order_by(DailyMetric.local_date)
    ).all()

    return DashboardSummary(
        workouts_7d=workouts_7d,
        minutes_7d=round(duration_7d / 60.0, 1),
        active_kcal_7d=round(energy_7d, 0),
        latest_resting_hr=_latest_metric(db, RESTING_HR_NAMES),
        latest_vo2max=_latest_metric(db, VO2MAX_NAMES),
        weekly_minutes=[MetricPoint(local_date=d, value=round(s / 60.0, 1)) for d, _, s, _ in by_date],
        resting_hr_trend=[MetricPoint(local_date=d, value=v) for d, v in resting_trend],
    )
