"""Dashboard aggregate endpoint (last-7-day summary + trend series)."""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import vo2max
from ..auth import require_read
from ..config import get_settings
from ..db import get_db
from ..models import DailyMetric, Workout
from ..schemas import DashboardSummary, MetricPoint, Vo2MaxBand
from ..timeutil import utcnow

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# HAE metric names that represent resting HR / VO2 max vary; match loosely.
RESTING_HR_NAMES = ("resting_heart_rate", "restingHeartRate")
VO2MAX_NAMES = ("vo2_max", "vo2Max", "vO2Max")

# Trend windows keep dashboard queries/payloads bounded as history grows.
WEEK_DAYS = 7
RESTING_TREND_DAYS = 90
# VO2 max moves slowly, so a longer window is needed to see a trend at all.
VO2MAX_TREND_DAYS = 365


def _latest_metric(db: Session, names: tuple[str, ...]) -> float | None:
    row = db.execute(
        select(DailyMetric.value)
        .where(DailyMetric.metric_type.in_(names))
        .order_by(DailyMetric.local_date.desc())
        .limit(1)
    ).scalar_one_or_none()
    return row


def _vo2max_band(value: float | None) -> Vo2MaxBand | None:
    """Interpret a VO2 max value against the athlete's age/sex, when configured."""
    if value is None:
        return None
    settings = get_settings()
    if settings.athlete_birth_date is None or not settings.athlete_sex:
        return None
    age = vo2max.age_on(settings.athlete_birth_date)
    result = vo2max.classify(value, age, settings.athlete_sex)
    return Vo2MaxBand(**result) if result else None


@router.get("", response_model=DashboardSummary)
def dashboard(
    db: Session = Depends(get_db),
    _token=Depends(require_read),
) -> DashboardSummary:
    since = utcnow() - timedelta(days=WEEK_DAYS)
    # local_date is a "YYYY-MM-DD" string, so lexical >= is a valid date window.
    resting_since = (utcnow() - timedelta(days=RESTING_TREND_DAYS)).strftime("%Y-%m-%d")
    vo2max_since = (utcnow() - timedelta(days=VO2MAX_TREND_DAYS)).strftime("%Y-%m-%d")

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

    # Count active days, not raw workout rows: two workouts on the same day
    # count as one toward the "Workouts (7d)" KPI.
    workouts_7d = len(by_date)
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

    vo2max_trend = db.execute(
        select(DailyMetric.local_date, DailyMetric.value)
        .where(
            DailyMetric.metric_type.in_(VO2MAX_NAMES),
            DailyMetric.local_date >= vo2max_since,
        )
        .order_by(DailyMetric.local_date)
    ).all()

    latest_vo2max = _latest_metric(db, VO2MAX_NAMES)

    return DashboardSummary(
        workouts_7d=workouts_7d,
        minutes_7d=round(duration_7d / 60.0, 1),
        active_kcal_7d=round(energy_7d, 0),
        latest_resting_hr=_latest_metric(db, RESTING_HR_NAMES),
        latest_vo2max=latest_vo2max,
        vo2max_band=_vo2max_band(latest_vo2max),
        weekly_minutes=[MetricPoint(local_date=d, value=round(s / 60.0, 1)) for d, _, s, _ in by_date],
        resting_hr_trend=[MetricPoint(local_date=d, value=v) for d, v in resting_trend],
        vo2max_trend=[MetricPoint(local_date=d, value=v) for d, v in vo2max_trend],
    )
