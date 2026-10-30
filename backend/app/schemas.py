"""Pydantic response/request schemas for the fittrack API."""
import math
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


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
    elevation_gain_m: float | None = None
    point_exclusion_warning: str | None = None


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
    elevation_gain_m: float | None = None


class PointExclusion(BaseModel):
    ts_utc: datetime

    @field_validator("ts_utc")
    @classmethod
    def _naive_utc(cls, value: datetime) -> datetime:
        return value.astimezone(UTC).replace(tzinfo=None) if value.utcoffset() is not None else value


class PointExclusionOut(PointExclusion):
    matched: bool


class PointExclusionRequest(PointExclusion):
    pass


class WorkoutPointOut(BaseModel):
    ts_utc: datetime
    route_count: int = 0
    elevation_m: list[float] = Field(default_factory=list)
    speed_mps: list[float] = Field(default_factory=list)
    heart_rate_bpm: list[float] = Field(default_factory=list)
    distance_m: float | None = None
    distance_kind: Literal["cumulative", "increment"] | None = None
    excluded: bool = False


class RoutePointOut(BaseModel):
    seq: int
    lat: float
    lon: float
    ts_utc: datetime
    elevation_m: float | None = None

    @field_validator("elevation_m")
    @classmethod
    def _finite_elevation(cls, value: float | None) -> float | None:
        # Older Apple rows may hold NaN/Infinity, which JSON cannot encode.
        return value if value is not None and math.isfinite(value) else None


class HrPointOut(BaseModel):
    ts_utc: datetime
    bpm: float


class ElevationPointOut(BaseModel):
    ts_utc: datetime
    elevation_m: float


class WorkoutDetail(WorkoutSummary):
    source_name: str | None
    device_name: str | None
    end_utc: datetime
    min_hr: float | None
    splits: list[SplitOut]
    route: list[RoutePointOut]
    elevation_series: list[ElevationPointOut]
    hr_series: list[HrPointOut]
    point_exclusions: list[PointExclusionOut] = Field(default_factory=list)
    data_points: list[WorkoutPointOut] = Field(default_factory=list)
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
    # Nullable so padded trend series (e.g. steps) can represent a day with no
    # data as a gap rather than a zero.
    value: float | None = None


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
    # When data was last uploaded (newest processed ingest event), or null if
    # nothing has been ingested yet.
    last_ingest_utc: datetime | None = None
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
    steps_avg7_trend: list[MetricPoint] = Field(default_factory=list)
    workout_days: list[str] = Field(default_factory=list)
