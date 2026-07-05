"""Normalize Health Auto Export (HAE) JSON payloads into fittrack entities.

HAE's JSON shape varies across app versions, so parsing is deliberately
tolerant: numeric values may be scalars or ``{"qty": .., "units": ..}`` objects,
and the same concept may appear under several key names. Parsing is kept pure
(no DB access) so it can be unit-tested in isolation; :func:`persist_payload`
handles idempotent upserts and split computation.
"""
from __future__ import annotations

import hashlib
import uuid as uuidlib
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from dateutil import parser as dtparser
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import models
from .geo import (
    DistanceSample,
    HrSample,
    RoutePoint,
    compute_splits_from_route,
    compute_splits_from_samples,
)
from .timeutil import utcnow

# --- Apple workout activity type -> friendly name ----------------------------
WORKOUT_TYPE_MAP = {
    "HKWorkoutActivityTypeRunning": "Running",
    "HKWorkoutActivityTypeWalking": "Walking",
    "HKWorkoutActivityTypeCycling": "Cycling",
    "HKWorkoutActivityTypeHiking": "Hiking",
    "HKWorkoutActivityTypeSwimming": "Swimming",
    "HKWorkoutActivityTypeTraditionalStrengthTraining": "Strength",
    "HKWorkoutActivityTypeFunctionalStrengthTraining": "Functional Strength",
    "HKWorkoutActivityTypeYoga": "Yoga",
    "HKWorkoutActivityTypeHighIntensityIntervalTraining": "HIIT",
    "HKWorkoutActivityTypeElliptical": "Elliptical",
    "HKWorkoutActivityTypeRowing": "Rowing",
}

MILE_M = 1609.344


# --- tolerant field helpers --------------------------------------------------
def first(d: dict, *keys, default=None):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def as_number(value) -> float | None:
    """Coerce scalar / {"qty": ..} / numeric-string into a float."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        return as_number(value.get("qty", value.get("value")))
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def unit_of(value, default: str | None = None) -> str | None:
    if isinstance(value, dict):
        return value.get("units", value.get("unit", default))
    return default


def parse_dt(value) -> tuple[datetime | None, int | None]:
    """Parse an HAE date string into ``(naive_utc_datetime, tz_offset_minutes)``.

    Naive inputs are returned as-is with a ``None`` offset. Offset-aware inputs
    are converted to UTC and the original local offset (in minutes) is captured
    so callers can reconstruct the local calendar date.
    """
    if value is None or value == "":
        return None, None
    try:
        dt = dtparser.parse(str(value))
    except (ValueError, OverflowError):
        return None, None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=None), None
    offset_min = int(dt.utcoffset().total_seconds() // 60)
    utc = dt.astimezone(UTC).replace(tzinfo=None)
    return utc, offset_min


def local_date_str(utc: datetime, tz_offset_minutes: int | None) -> str:
    local = utc + timedelta(minutes=tz_offset_minutes) if tz_offset_minutes else utc
    return local.strftime("%Y-%m-%d")


# --- parsed dataclasses ------------------------------------------------------
@dataclass
class ParsedWorkout:
    uuid: str
    workout_type: str
    source_name: str | None
    device_name: str | None
    start_utc: datetime
    end_utc: datetime
    tz_offset_minutes: int | None
    local_date: str
    duration_sec: float | None
    distance_m: float | None
    active_energy_kcal: float | None
    avg_hr: float | None
    max_hr: float | None
    min_hr: float | None
    route: list[RoutePoint] = field(default_factory=list)
    hr_samples: list[HrSample] = field(default_factory=list)
    distance_samples: list[DistanceSample] = field(default_factory=list)


@dataclass
class ParsedDailyMetric:
    local_date: str
    metric_type: str
    value: float
    unit: str | None
    source_name: str | None


@dataclass
class ParsedPayload:
    workouts: list[ParsedWorkout] = field(default_factory=list)
    daily_metrics: list[ParsedDailyMetric] = field(default_factory=list)


# --- distance / route parsing ------------------------------------------------
_DISTANCE_TO_M = {"km": 1000.0, "mi": MILE_M, "m": 1.0, "yd": 0.9144, "ft": 0.3048}


def distance_to_meters(value, units: str | None) -> float | None:
    qty = as_number(value)
    if qty is None:
        return None
    units = (units or unit_of(value) or "km").lower()
    return qty * _DISTANCE_TO_M.get(units, 1000.0)


def _parse_route(raw: list) -> list[RoutePoint]:
    pts: list[RoutePoint] = []
    for p in raw or []:
        lat = as_number(first(p, "latitude", "lat"))
        lon = as_number(first(p, "longitude", "lon", "lng"))
        ts, _ = parse_dt(first(p, "timestamp", "date", "time"))
        if lat is None or lon is None or ts is None:
            continue
        pts.append(
            RoutePoint(
                ts_utc=ts,
                lat=lat,
                lon=lon,
                elevation_m=as_number(first(p, "altitude", "elevation")),
                speed_mps=as_number(p.get("speed")),
            )
        )
    return pts


def _parse_hr_samples(raw: list) -> list[HrSample]:
    out: list[HrSample] = []
    for h in raw or []:
        ts, _ = parse_dt(first(h, "date", "timestamp", "time"))
        bpm = as_number(first(h, "Avg", "avg", "qty", "value"))
        if ts is not None and bpm is not None:
            out.append(HrSample(ts_utc=ts, bpm=bpm))
    return out


def _parse_distance_samples(raw: list) -> list[DistanceSample]:
    """HAE ``walkingAndRunningDistance`` is a per-interval increment series.

    Each point carries a single timestamp and an incremental distance; we pair
    consecutive points to form (start, end, meters) samples so indoor workouts
    without GPS can still produce splits.
    """
    parsed: list[tuple[datetime, float]] = []
    for p in raw or []:
        ts, _ = parse_dt(first(p, "date", "timestamp"))
        meters = distance_to_meters(p, unit_of(p))
        if ts is not None and meters is not None:
            parsed.append((ts, meters))
    parsed.sort(key=lambda x: x[0])
    out: list[DistanceSample] = []
    for i, (ts, meters) in enumerate(parsed):
        end = parsed[i + 1][0] if i + 1 < len(parsed) else ts
        out.append(DistanceSample(start_utc=ts, end_utc=end, meters=meters))
    return out


# --- top-level parse ---------------------------------------------------------
def parse_workout(w: dict) -> ParsedWorkout | None:
    start_utc, tz = parse_dt(first(w, "start", "startDate", "start_time"))
    end_utc, _ = parse_dt(first(w, "end", "endDate", "end_time"))
    if start_utc is None:
        return None
    if end_utc is None:
        end_utc = start_utc

    raw_type = first(w, "workoutActivityType", "type", "name", default="Workout")
    workout_type = WORKOUT_TYPE_MAP.get(raw_type, raw_type)

    wid = first(w, "id", "uuid")
    if not wid:
        wid = _synth_uuid(raw_type, start_utc)

    dist_field = first(w, "distance", "totalDistance", "distanceWalkingRunning")
    distance_m = distance_to_meters(dist_field, unit_of(dist_field, first(w, "distanceUnits")))

    hr_samples = _parse_hr_samples(first(w, "heartRateData", default=[]))
    route = _parse_route(first(w, "route", "routePoints", "gpx", default=[]))
    distance_samples = _parse_distance_samples(
        first(w, "walkingAndRunningDistance", default=[])
    )

    return ParsedWorkout(
        uuid=str(wid),
        workout_type=workout_type,
        source_name=first(w, "sourceName", "source"),
        device_name=first(w, "device", "deviceName"),
        start_utc=start_utc,
        end_utc=end_utc,
        tz_offset_minutes=tz,
        local_date=local_date_str(start_utc, tz),
        duration_sec=as_number(first(w, "duration", "durationSeconds")),
        distance_m=distance_m,
        active_energy_kcal=as_number(
            first(w, "activeEnergyBurned", "activeEnergy", "totalEnergyBurned")
        ),
        avg_hr=as_number(first(w, "avgHeartRate", "averageHeartRate")),
        max_hr=as_number(first(w, "maxHeartRate")),
        min_hr=as_number(first(w, "minHeartRate")),
        route=route,
        hr_samples=hr_samples,
        distance_samples=distance_samples,
    )


def _synth_uuid(raw_type: str, start_utc: datetime) -> str:
    seed = f"{raw_type}|{start_utc.isoformat()}"
    return str(uuidlib.uuid5(uuidlib.NAMESPACE_URL, seed))


def parse_daily_metrics(metrics: list) -> list[ParsedDailyMetric]:
    out: list[ParsedDailyMetric] = []
    for m in metrics or []:
        name = first(m, "name", "metric")
        units = first(m, "units", "unit")
        if not name:
            continue
        for point in first(m, "data", default=[]):
            ts, tz = parse_dt(first(point, "date", "timestamp"))
            qty = as_number(first(point, "qty", "value", "Avg", "avg"))
            if ts is None or qty is None:
                continue
            out.append(
                ParsedDailyMetric(
                    local_date=local_date_str(ts, tz),
                    metric_type=str(name),
                    value=qty,
                    unit=units,
                    source_name=first(point, "source", "sourceName") or "",
                )
            )
    return out


def parse_payload(payload: dict) -> ParsedPayload:
    """Parse a full HAE payload. Accepts ``{"data": {...}}`` or a bare data dict."""
    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    workouts = [pw for w in data.get("workouts", []) if (pw := parse_workout(w))]
    daily = parse_daily_metrics(data.get("metrics", []))
    return ParsedPayload(workouts=workouts, daily_metrics=daily)


def payload_hash(raw_text: str) -> str:
    return hashlib.sha256(raw_text.encode("utf-8")).hexdigest()


# --- persistence (idempotent upserts) ---------------------------------------
def persist_payload(parsed: ParsedPayload, db: Session) -> dict[str, int]:
    now = utcnow()
    counts = {"workouts": 0, "daily_metrics": 0, "splits": 0}

    for pw in parsed.workouts:
        existing = db.get(models.Workout, pw.uuid)
        has_route = len(pw.route) >= 2
        if existing is None:
            existing = models.Workout(uuid=pw.uuid, created_utc=now)
            db.add(existing)
        existing.workout_type = pw.workout_type
        existing.source_name = pw.source_name
        existing.device_name = pw.device_name
        existing.start_utc = pw.start_utc
        existing.end_utc = pw.end_utc
        existing.tz_offset_minutes = pw.tz_offset_minutes
        existing.local_date = pw.local_date
        existing.duration_sec = pw.duration_sec
        existing.distance_m = pw.distance_m
        existing.active_energy_kcal = pw.active_energy_kcal
        existing.avg_hr = pw.avg_hr
        existing.max_hr = pw.max_hr
        existing.min_hr = pw.min_hr
        existing.has_route = has_route
        existing.updated_utc = now
        counts["workouts"] += 1

        # Replace child rows for this workout (idempotent re-ingest).
        db.execute(
            delete(models.WorkoutRoutePoint).where(
                models.WorkoutRoutePoint.workout_uuid == pw.uuid
            )
        )
        db.execute(
            delete(models.WorkoutSample).where(models.WorkoutSample.workout_uuid == pw.uuid)
        )
        db.execute(
            delete(models.WorkoutSplit).where(models.WorkoutSplit.workout_uuid == pw.uuid)
        )

        for seq, rp in enumerate(sorted(pw.route, key=lambda p: p.ts_utc)):
            db.add(
                models.WorkoutRoutePoint(
                    workout_uuid=pw.uuid,
                    seq=seq,
                    ts_utc=rp.ts_utc,
                    lat=rp.lat,
                    lon=rp.lon,
                    elevation_m=rp.elevation_m,
                    speed_mps=rp.speed_mps,
                )
            )
        for hs in pw.hr_samples:
            db.add(
                models.WorkoutSample(
                    workout_uuid=pw.uuid,
                    metric_type="heart_rate",
                    start_utc=hs.ts_utc,
                    end_utc=hs.ts_utc,
                    value=hs.bpm,
                    unit="bpm",
                )
            )

        counts["splits"] += _persist_splits(pw, db)

    # Dedupe within this payload: SQL Server allows only one NULL per UNIQUE
    # index and (with autoflush off) freshly-added rows are invisible to the
    # SELECT below, so intra-payload duplicates would otherwise create colliding
    # rows and fail on commit. Coalesce source_name to "" and reuse rows by key.
    seen: dict[tuple[str, str, str], models.DailyMetric] = {}
    for dm in parsed.daily_metrics:
        source = dm.source_name or ""
        key = (dm.local_date, dm.metric_type, source)
        row = seen.get(key)
        if row is None:
            row = db.execute(
                select(models.DailyMetric).where(
                    models.DailyMetric.local_date == dm.local_date,
                    models.DailyMetric.metric_type == dm.metric_type,
                    models.DailyMetric.source_name == source,
                )
            ).scalar_one_or_none()
            if row is None:
                row = models.DailyMetric(
                    local_date=dm.local_date,
                    metric_type=dm.metric_type,
                    source_name=source,
                )
                db.add(row)
            seen[key] = row
        row.value = dm.value
        row.unit = dm.unit
        row.updated_utc = now
        counts["daily_metrics"] += 1

    db.commit()
    return counts


def _persist_splits(pw: ParsedWorkout, db: Session) -> int:
    total = 0
    for unit_system in ("mi", "km"):
        if len(pw.route) >= 2:
            rows = compute_splits_from_route(pw.route, pw.hr_samples, unit_system)
        elif pw.distance_samples:
            rows = compute_splits_from_samples(pw.distance_samples, pw.hr_samples, unit_system)
        else:
            rows = []
        for r in rows:
            db.add(
                models.WorkoutSplit(
                    workout_uuid=pw.uuid,
                    unit_system=r.unit_system,
                    split_index=r.split_index,
                    distance_m=r.distance_m,
                    duration_sec=r.duration_sec,
                    pace_sec_per_unit=r.pace_sec_per_unit,
                    avg_hr=r.avg_hr,
                    source=r.source,
                )
            )
            total += 1
    return total
