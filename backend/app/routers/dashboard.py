"""Dashboard aggregate endpoint (weekly summary + trend series)."""
from datetime import date, timedelta
from math import floor

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import sleep as sleepmod
from .. import vo2max
from ..auth import require_read
from ..config import get_settings
from ..db import get_db
from ..models import DailyMetric, RawIngestEvent, Workout
from ..schemas import DashboardSummary, MetricPoint, SleepBand, Vo2MaxBand
from ..timeutil import utcnow

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# HAE metric names that represent resting HR / VO2 max vary; match loosely.
RESTING_HR_NAMES = ("resting_heart_rate", "restingHeartRate")
VO2MAX_NAMES = ("vo2_max", "vo2Max", "vO2Max")
SLEEP_NAMES = ("sleep_asleep_hours",)
STEP_NAMES = ("step_count",)

# Trend windows keep dashboard queries/payloads bounded as history grows.
WEEK_DAYS = 7
RESTING_TREND_DAYS = 90
# VO2 max moves slowly, so a longer window is needed to see a trend at all.
VO2MAX_TREND_DAYS = 365
SLEEP_TREND_DAYS = 30
STEPS_TREND_DAYS = 30


def _minutes_at_second_precision(seconds: float) -> float:
    # Match the frontend's nearest-second rounding, including half seconds.
    whole_seconds = floor(seconds)
    return (whole_seconds + int(seconds - whole_seconds >= 0.5)) / 60.0


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


def _sleep_band(value: float | None) -> SleepBand | None:
    result = sleepmod.classify(value)
    return SleepBand(**result) if result else None


@router.get("", response_model=DashboardSummary)
def dashboard(
    db: Session = Depends(get_db),
    _token=Depends(require_read),
    week_from: str | None = Query(None, description="Inclusive local week start (YYYY-MM-DD)."),
    week_to: str | None = Query(None, description="Inclusive local week end (YYYY-MM-DD)."),
) -> DashboardSummary:
    # The client sends its Pacific Monday-Sunday week so the cards match the
    # Workouts page; without bounds the summary covers the last 7 local days.
    try:
        first = date.fromisoformat(week_from) if week_from else (utcnow() - timedelta(days=WEEK_DAYS - 1)).date()
        last = date.fromisoformat(week_to) if week_to else first + timedelta(days=WEEK_DAYS - 1)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="week_from and week_to must be YYYY-MM-DD dates") from exc
    if not timedelta(0) <= last - first < timedelta(days=WEEK_DAYS):
        raise HTTPException(status_code=422, detail="The week must span 1 to 7 days")
    week_dates = [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)]
    # local_date is a "YYYY-MM-DD" string, so lexical >= is a valid date window.
    resting_since = (utcnow() - timedelta(days=RESTING_TREND_DAYS)).strftime("%Y-%m-%d")
    vo2max_since = (utcnow() - timedelta(days=VO2MAX_TREND_DAYS)).strftime("%Y-%m-%d")
    sleep_since = (utcnow() - timedelta(days=SLEEP_TREND_DAYS)).strftime("%Y-%m-%d")
    steps_since = (utcnow() - timedelta(days=STEPS_TREND_DAYS)).strftime("%Y-%m-%d")

    # One grouped scan of the week: per-day counts/duration/energy. The 7-day
    # KPI totals are derived from these rows, avoiding a second window scan.
    by_date = db.execute(
        select(
            Workout.local_date,
            func.count(Workout.uuid),
            func.coalesce(func.sum(Workout.duration_sec), 0.0),
            func.coalesce(func.sum(Workout.active_energy_kcal), 0.0),
        )
        .where(Workout.local_date >= week_dates[0], Workout.local_date <= week_dates[-1])
        .group_by(Workout.local_date)
        .order_by(Workout.local_date)
    ).all()

    # Count active days, not raw workout rows: two workouts on the same day
    # count as one toward the "Active days" KPI.
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

    sleep_trend = db.execute(
        select(DailyMetric.local_date, DailyMetric.value)
        .where(
            DailyMetric.metric_type.in_(SLEEP_NAMES),
            DailyMetric.local_date >= sleep_since,
        )
        .order_by(DailyMetric.local_date)
    ).all()

    latest_sleep = _latest_metric(db, SLEEP_NAMES)

    # Steps are normalized to exactly one source-less total row per day (summed
    # across all intraday points), so read the per-day values directly.
    steps_rows = db.execute(
        select(DailyMetric.local_date, DailyMetric.value)
        .where(
            DailyMetric.metric_type.in_(STEP_NAMES),
            DailyMetric.local_date >= steps_since,
        )
        .order_by(DailyMetric.local_date)
    ).all()
    steps_by_date = {d: round(v) for d, v in steps_rows}

    # Pad to a contiguous window (oldest first, today last) so the chart always
    # shows every calendar day; days without data are gaps (value=None).
    end_date = utcnow().date()
    window_dates = [
        (end_date - timedelta(days=offset)).strftime("%Y-%m-%d")
        for offset in range(STEPS_TREND_DAYS - 1, -1, -1)
    ]
    steps_trend = [MetricPoint(local_date=d, value=steps_by_date.get(d)) for d in window_dates]
    # latest = most recent day *with data* (not necessarily today).
    days_with_data = [p for p in steps_trend if p.value is not None]
    latest_steps = days_with_data[-1].value if days_with_data else None
    latest_steps_date = days_with_data[-1].local_date if days_with_data else None

    # 7-day block averages anchored to the most recent day: the last 7 days form
    # one block, the prior 7 another, and so on. Every day in a block takes that
    # block's mean (over the days that actually have data), so the chart draws a
    # flat line per block that steps at each boundary. A block with no data at all
    # stays None (a gap in the line).
    last_index = len(steps_trend) - 1
    block_values: dict[int, list[float]] = {}
    for i, point in enumerate(steps_trend):
        if point.value is not None:
            block_values.setdefault((last_index - i) // 7, []).append(point.value)
    steps_avg7_trend: list[MetricPoint] = []
    for i, point in enumerate(steps_trend):
        values = block_values.get((last_index - i) // 7)
        avg = round(sum(values) / len(values)) if values else None
        steps_avg7_trend.append(MetricPoint(local_date=point.local_date, value=avg))

    # Days within the padded steps window that have at least one logged workout,
    # so the chart can flag them. local_date is a "YYYY-MM-DD" string like steps.
    workout_days = [
        d
        for (d,) in db.execute(
            select(Workout.local_date)
            .where(Workout.local_date >= window_dates[0])
            .distinct()
            .order_by(Workout.local_date)
        ).all()
    ]

    # When data was last uploaded: the newest successfully processed ingest.
    # Events still in "received" (failed mid-persist) don't count, since none of
    # their rows are visible.
    minutes_by_date = {d: _minutes_at_second_precision(s) for d, _, s, _ in by_date}
    last_ingest_utc = db.execute(
        select(func.max(RawIngestEvent.processed_utc)).where(RawIngestEvent.status == "processed")
    ).scalar_one_or_none()

    return DashboardSummary(
        last_ingest_utc=last_ingest_utc,
        workouts_7d=workouts_7d,
        minutes_7d=_minutes_at_second_precision(duration_7d),
        active_kcal_7d=round(energy_7d, 0),
        latest_resting_hr=_latest_metric(db, RESTING_HR_NAMES),
        latest_vo2max=latest_vo2max,
        vo2max_band=_vo2max_band(latest_vo2max),
        latest_sleep_hours=latest_sleep,
        sleep_band=_sleep_band(latest_sleep),
        latest_steps=latest_steps,
        latest_steps_date=latest_steps_date,
        weekly_minutes=[MetricPoint(local_date=d, value=minutes_by_date.get(d, 0.0)) for d in week_dates],
        resting_hr_trend=[MetricPoint(local_date=d, value=v) for d, v in resting_trend],
        vo2max_trend=[MetricPoint(local_date=d, value=v) for d, v in vo2max_trend],
        sleep_trend=[MetricPoint(local_date=d, value=v) for d, v in sleep_trend],
        steps_trend=steps_trend,
        steps_avg7_trend=steps_avg7_trend,
        workout_days=workout_days,
    )
