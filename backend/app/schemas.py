"""Pydantic response/request schemas for the fittrack API."""
from datetime import datetime

from pydantic import BaseModel, Field


class IngestResult(BaseModel):
    status: str
    duplicate: bool = False
    workouts: int = 0
    daily_metrics: int = 0
    splits: int = 0


class WorkoutSummary(BaseModel):
    uuid: str
    workout_type: str
    local_date: str
    start_utc: datetime
    duration_sec: float | None
    distance_m: float | None
    active_energy_kcal: float | None
    avg_hr: float | None
    max_hr: float | None
    has_route: bool


class WorkoutList(BaseModel):
    items: list["WorkoutSummary"]
    total: int


class SplitOut(BaseModel):
    split_index: int
    unit_system: str
    distance_m: float
    duration_sec: float
    pace_sec_per_unit: float
    avg_hr: float | None
    source: str


class RoutePointOut(BaseModel):
    seq: int
    lat: float
    lon: float
    ts_utc: datetime


class HrPointOut(BaseModel):
    ts_utc: datetime
    bpm: float


class WorkoutDetail(WorkoutSummary):
    source_name: str | None
    device_name: str | None
    end_utc: datetime
    min_hr: float | None
    splits: list[SplitOut]
    route: list[RoutePointOut]
    hr_series: list[HrPointOut]
    # Full counts + whether the returned series were downsampled (fetch ?full=true
    # for the complete series).
    route_total: int = 0
    hr_total: int = 0
    route_downsampled: bool = False
    hr_downsampled: bool = False
    # Adjacent workouts by start time for prev/next navigation (null at the ends).
    prev_uuid: str | None = None  # next-older workout
    next_uuid: str | None = None  # next-newer workout


class MetricPoint(BaseModel):
    local_date: str
    value: float


class Vo2MaxBand(BaseModel):
    category: str
    category_index: int
    range_low: float | None
    range_high: float | None
    next_category: str | None
    next_at: float | None
    age: int
    sex: str


class SleepBand(BaseModel):
    category: str
    category_index: int
    target_low: float
    target_high: float


class DashboardSummary(BaseModel):
    workouts_7d: int
    minutes_7d: float
    active_kcal_7d: float
    latest_resting_hr: float | None
    latest_vo2max: float | None
    vo2max_band: Vo2MaxBand | None = None
    latest_sleep_hours: float | None = None
    sleep_band: SleepBand | None = None
    latest_steps: float | None = None
    latest_steps_date: str | None = None
    weekly_minutes: list[MetricPoint]
    resting_hr_trend: list[MetricPoint]
    vo2max_trend: list[MetricPoint]
    sleep_trend: list[MetricPoint] = []
    steps_trend: list[MetricPoint] = Field(default_factory=list)
