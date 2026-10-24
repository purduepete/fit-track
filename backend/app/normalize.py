"""Normalize Health Auto Export (HAE) JSON payloads into fittrack entities.

HAE's JSON shape varies across app versions, so parsing is deliberately
tolerant: numeric values may be scalars or ``{"qty": .., "units": ..}`` objects,
and the same concept may appear under several key names. Parsing is kept pure
(no DB access) so it can be unit-tested in isolation; :func:`persist_payload`
handles idempotent upserts and split computation.
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
import uuid as uuidlib
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

from dateutil import parser as dtparser
from sqlalchemy import delete, insert, select, text
from sqlalchemy.orm import Session

from . import models
from .geo import (
    DistanceSample,
    HrSample,
    RoutePoint,
    compute_splits,
    filter_route_outliers,
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


def as_source_name(value) -> str | None:
    """Coerce an HAE source field to its display name.

    HAE changed workout ``source`` from a bare string to
    ``{"name": ..., "identifier": ...}``; the dict then reached pyodbc as a bind
    parameter and every ingest failed with "Unknown object type dict during
    describe". Accept either shape, and keep the name short enough for the
    Unicode(120) column.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        value = first(value, "name", "identifier")
        if value is None:
            return None
    return str(value)[:120]


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


_ISO_OFFSET_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*([+-]\d{2}):?(\d{2})?$"
)


def _fast_parse_dt(text: str) -> datetime | None:
    """Fast path for common HAE / ISO timestamp shapes via ``fromisoformat``.

    HAE emits ``YYYY-MM-DD HH:MM:SS ±HHMM`` (space before a colon-less offset),
    which ``fromisoformat`` won't accept directly, so normalize it first. Returns
    ``None`` when the shape isn't recognized so the caller falls back to the
    (much slower, but very tolerant) dateutil parser.
    """
    t = text.strip()
    if not t:
        return None
    if t[-1] in ("Z", "z"):
        t = t[:-1] + "+00:00"
    m = _ISO_OFFSET_RE.match(t)
    if m:
        date_part, time_part, off_h, off_m = m.groups()
        t = f"{date_part}T{time_part}{off_h}:{off_m or '00'}"
    else:
        t = t.replace(" ", "T", 1)
    try:
        return datetime.fromisoformat(t)
    except ValueError:
        return None


def parse_dt(value) -> tuple[datetime | None, int | None]:
    """Parse an HAE date string into ``(naive_utc_datetime, tz_offset_minutes)``.

    Naive inputs are returned as-is with a ``None`` offset. Offset-aware inputs
    are converted to UTC and the original local offset (in minutes) is captured
    so callers can reconstruct the local calendar date.
    """
    if value is None or value == "":
        return None, None
    dt = _fast_parse_dt(str(value))
    if dt is None:
        try:
            dt = dtparser.parse(str(value))
        except (ValueError, OverflowError):
            return None, None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=None), None
    offset = dt.utcoffset()
    offset_min = int(offset.total_seconds() // 60) if offset is not None else 0
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


EXCLUDED_WORKOUT_SOURCES = frozenset({"rouvy", "strava"})


def _excluded_workout_source(source_name: str | None) -> bool:
    return source_name is not None and source_name.strip().casefold() in EXCLUDED_WORKOUT_SOURCES


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
        # json.loads accepts bare NaN and Infinity, and the geo maths has no
        # defence against either. Coordinates are bounded, so check here.
        if not (math.isfinite(lat) and math.isfinite(lon)):
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
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
def build_workout(
    *,
    raw_type: str,
    start_utc: datetime,
    end_utc: datetime | None,
    tz_offset_minutes: int | None,
    source_name: str | None,
    device_name: str | None,
    duration_sec: float | None,
    distance_m: float | None,
    active_energy_kcal: float | None,
    avg_hr: float | None,
    max_hr: float | None,
    min_hr: float | None,
    workout_id: str | None = None,
    route: list[RoutePoint] | None = None,
    hr_samples: list[HrSample] | None = None,
    distance_samples: list[DistanceSample] | None = None,
) -> ParsedWorkout:
    """Assemble a :class:`ParsedWorkout` from already-extracted primitive fields.

    Shared by JSON ingest (:func:`parse_workout`) and the XML backfill so both
    import paths apply identical type-mapping, synthetic-UUID fallback and local
    date derivation, and cannot drift apart. Callers stay thin field-extractors.
    """
    return ParsedWorkout(
        uuid=str(workout_id) if workout_id else synth_workout_uuid(raw_type, start_utc),
        workout_type=WORKOUT_TYPE_MAP.get(raw_type, raw_type),
        source_name=source_name,
        device_name=device_name,
        start_utc=start_utc,
        end_utc=end_utc if end_utc is not None else start_utc,
        tz_offset_minutes=tz_offset_minutes,
        local_date=local_date_str(start_utc, tz_offset_minutes),
        duration_sec=duration_sec,
        distance_m=distance_m,
        active_energy_kcal=active_energy_kcal,
        avg_hr=avg_hr,
        max_hr=max_hr,
        min_hr=min_hr,
        route=route or [],
        hr_samples=hr_samples or [],
        distance_samples=distance_samples or [],
    )


def parse_workout(w: dict) -> ParsedWorkout | None:
    start_utc, tz = parse_dt(first(w, "start", "startDate", "start_time"))
    end_utc, _ = parse_dt(first(w, "end", "endDate", "end_time"))
    if start_utc is None:
        return None

    dist_field = first(w, "distance", "totalDistance", "distanceWalkingRunning")
    distance_m = distance_to_meters(dist_field, unit_of(dist_field, first(w, "distanceUnits")))

    return build_workout(
        raw_type=first(w, "workoutActivityType", "type", "name", default="Workout"),
        workout_id=first(w, "id", "uuid"),
        start_utc=start_utc,
        end_utc=end_utc,
        tz_offset_minutes=tz,
        source_name=as_source_name(first(w, "sourceName", "source")),
        device_name=as_source_name(first(w, "device", "deviceName")),
        duration_sec=as_number(first(w, "duration", "durationSeconds")),
        distance_m=distance_m,
        active_energy_kcal=as_number(
            first(w, "activeEnergyBurned", "activeEnergy", "totalEnergyBurned")
        ),
        avg_hr=as_number(first(w, "avgHeartRate", "averageHeartRate")),
        max_hr=as_number(first(w, "maxHeartRate")),
        min_hr=as_number(first(w, "minHeartRate")),
        route=_parse_route(first(w, "route", "routePoints", "gpx", default=[])),
        hr_samples=_parse_hr_samples(first(w, "heartRateData", default=[])),
        distance_samples=_parse_distance_samples(
            first(w, "walkingAndRunningDistance", default=[])
        ),
    )


def synth_workout_uuid(raw_type: str, start_utc: datetime) -> str:
    """Deterministic UUID for workouts that arrive without an Apple id.

    Shared by JSON ingest and the XML backfill so the same underlying workout
    resolves to the same id regardless of the import path.
    """
    seed = f"{raw_type}|{start_utc.isoformat()}"
    return str(uuidlib.uuid5(uuidlib.NAMESPACE_URL, seed))


# HAE names the sleep metric variously; matched case-insensitively.
SLEEP_METRIC_NAMES = ("sleep_analysis", "sleepanalysis", "sleep")
# Metric type persisted for nightly asleep hours (unit: hours).
SLEEP_METRIC_TYPE = "sleep_asleep_hours"

# HAE exports steps as the cumulative-counter metric ``step_count``.
STEP_METRIC_NAMES = ("step_count",)
STEP_METRIC_TYPE = "step_count"


def _to_hours(value) -> float | None:
    """Coerce an HAE sleep duration to hours.

    HAE has shipped these durations as seconds in some app versions and as
    decimal hours in others. Nobody sleeps more than 24 hours in a night, so any
    value above 24 is treated as seconds and converted; otherwise it is already
    in hours. Negative/None values yield ``None``.
    """
    n = as_number(value)
    if n is None or n < 0:
        return None
    return n / 3600.0 if n > 24 else n


def _sleep_local_date(point: dict) -> str | None:
    """Attribute a sleep session to its wake-up local date.

    Apple attributes sleep spanning midnight to the wake day, so prefer the end
    of the session, falling back to any available date field.
    """
    for key in ("sleepEnd", "sleepEndDate", "endDate", "end", "date", "timestamp"):
        ts, tz = parse_dt(point.get(key))
        if ts is not None:
            return local_date_str(ts, tz)
    return None


def _sleep_hours_for_point(point: dict) -> float | None:
    """Best-effort asleep hours for one HAE sleep data point.

    Prefers an explicit total, then the sum of sleep stages, then a generic
    value; each source is normalized to hours. Some HAE versions report
    ``asleep: 0`` and carry the real total in ``totalSleep``, so ``totalSleep``
    is tried first and any zero is treated as "not populated". In-bed time is
    deliberately not used as it overstates actual sleep.
    """
    total = _to_hours(first(point, "totalSleep", "asleep", "asleepUnspecified"))
    if total and total > 0:
        return total
    stage_sum = sum(h for k in ("core", "deep", "rem") if (h := _to_hours(point.get(k))))
    if stage_sum > 0:
        return stage_sum
    generic = _to_hours(first(point, "value", "qty"))
    if generic and generic > 0:
        return generic
    return None


def _parse_sleep_metric(points: list) -> list[ParsedDailyMetric]:
    """Sum asleep hours per (wake date, source).

    HAE may split one night into several data points, but daily metrics are
    keyed one-per-(date, type, source), so intervals are summed here rather than
    left to overwrite one another on upsert.
    """
    totals: dict[tuple[str, str], float] = {}
    for point in points or []:
        local_date = _sleep_local_date(point)
        hours = _sleep_hours_for_point(point)
        if local_date is None or hours is None or hours <= 0:
            continue
        source = as_source_name(first(point, "source", "sourceName")) or ""
        key = (local_date, source)
        totals[key] = totals.get(key, 0.0) + hours
    return [
        ParsedDailyMetric(
            local_date=local_date,
            metric_type=SLEEP_METRIC_TYPE,
            value=round(hours, 3),
            unit="hr",
            source_name=source,
        )
        for (local_date, source), hours in totals.items()
    ]


def _parse_step_metric(points: list) -> list[ParsedDailyMetric]:
    """Sum step counts into one device-agnostic total per local day.

    HAE exports ``step_count`` as many intraday (per-minute) points, each holding
    the steps taken in that interval, so the daily total is their sum — not the
    last point (which the generic path would keep, yielding a single minute's
    count). Apple/HAE already de-duplicates overlapping devices *within* each
    interval point (hence the joined ``Watch|iPhone`` source labels), so points
    are summed across sources into a single source-less daily total. Summing
    per-source and taking the max would instead drop steps recorded under a
    different source label on the same day.
    """
    totals: dict[str, float] = {}
    for point in points or []:
        ts, tz = parse_dt(first(point, "date", "timestamp"))
        qty = as_number(first(point, "qty", "value"))
        if ts is None or qty is None or qty < 0:
            continue
        local_date = local_date_str(ts, tz)
        totals[local_date] = totals.get(local_date, 0.0) + qty
    return [
        ParsedDailyMetric(
            local_date=local_date,
            metric_type=STEP_METRIC_TYPE,
            value=round(steps),
            unit="count",
            source_name="",
        )
        for local_date, steps in totals.items()
    ]


def parse_daily_metrics(metrics: list) -> list[ParsedDailyMetric]:
    out: list[ParsedDailyMetric] = []
    for m in metrics or []:
        name = first(m, "name", "metric")
        units = first(m, "units", "unit")
        if not name:
            continue
        if str(name).lower() in SLEEP_METRIC_NAMES:
            out.extend(_parse_sleep_metric(first(m, "data", default=[])))
            continue
        if str(name).lower() in STEP_METRIC_NAMES:
            out.extend(_parse_step_metric(first(m, "data", default=[])))
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
                    source_name=as_source_name(first(point, "source", "sourceName")) or "",
                )
            )
    return out


def parse_payload(payload: dict) -> ParsedPayload:
    """Parse a full HAE payload. Accepts ``{"data": {...}}`` or a bare data dict."""
    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    workouts = [
        pw for w in data.get("workouts", [])
        if (pw := parse_workout(w)) and not _excluded_workout_source(pw.source_name)
    ]
    daily = parse_daily_metrics(data.get("metrics", []))
    return ParsedPayload(workouts=workouts, daily_metrics=daily)


def payload_hash(raw_text: str) -> str:
    return hashlib.sha256(raw_text.encode("utf-8")).hexdigest()


# --- persistence (idempotent upserts) ---------------------------------------
# Azure SQL rejects a statement with more than 2,100 parameters. Every unbounded
# IN (...) / executemany is chunked below this so a large payload or a multi-year
# backfill cannot blow the limit mid-ingest.
_IN_CHUNK = 1000


def _chunked(seq: list, size: int | None = None):
    """Yield successive ``size``-length slices of ``seq`` (defaults to _IN_CHUNK)."""
    size = size or _IN_CHUNK
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _bulk_insert(db: Session, model: type, rows: list[dict], chunk: int | None = None) -> None:
    """Insert child rows via Core executemany, chunked to bound statement size."""
    for batch in _chunked(rows, chunk):
        db.execute(insert(model), batch)


def _cross_source_zwift_duplicate(pw: ParsedWorkout, db: Session) -> bool:
    is_direct = pw.uuid.startswith("strava:") and pw.source_name == "Strava"
    is_health = (pw.source_name or "").strip().casefold() == "zwift"
    if not (is_direct or is_health) or "cycl" not in pw.workout_type.casefold():
        return False
    candidates = db.scalars(
        select(models.Workout).where(
            models.Workout.start_utc >= pw.start_utc - timedelta(seconds=60),
            models.Workout.start_utc <= pw.start_utc + timedelta(seconds=60),
            models.Workout.uuid != pw.uuid,
        )
    )
    for existing in candidates:
        other_direct = existing.uuid.startswith("strava:") and existing.source_name == "Strava"
        other_health = (existing.source_name or "").strip().casefold() == "zwift"
        if (
            ((is_direct and other_health) or (is_health and other_direct))
            and "cycl" in existing.workout_type.casefold()
            and abs((existing.end_utc - pw.end_utc).total_seconds()) <= 120
        ):
            logging.getLogger("fittrack").info(
                "Skipping duplicate Zwift workout %s; already stored as %s", pw.uuid, existing.uuid,
            )
            return True
    return False


def persist_payload(
    parsed: ParsedPayload, db: Session, *,
    ingest_source: Literal["health_auto_export", "strava"] = "health_auto_export",
) -> dict[str, int]:
    """Idempotently upsert a parsed payload. Transaction-neutral: this flushes
    but does NOT commit, so the caller owns the transaction boundary (the ingest
    route commits the normalized rows and the RawIngestEvent status atomically)."""
    if db.get_bind().dialect.name == "postgresql":
        # Keep Health and Strava duplicate checks serialized through commit.
        db.execute(text("SELECT pg_advisory_xact_lock(8791, 1)"))
    now = utcnow()
    counts = {"workouts": 0, "daily_metrics": 0, "splits": 0, "route_points_dropped": 0}

    # Enforce exclusions here too because historical import paths can construct
    # ParsedPayload directly without passing through parse_payload.
    workouts = [
        pw for pw in parsed.workouts
        if (ingest_source == "strava" or not _excluded_workout_source(pw.source_name))
        and not _cross_source_zwift_duplicate(pw, db)
    ]

    # Batch-fetch existing workouts by UUID (avoids a SELECT per workout).
    workout_uuids = [pw.uuid for pw in workouts]
    existing_workouts: dict[str, models.Workout] = {}
    for batch in _chunked(workout_uuids):
        existing_workouts.update(
            {
                w.uuid: w
                for w in db.execute(
                    select(models.Workout).where(models.Workout.uuid.in_(batch))
                ).scalars()
            }
        )

    # Accumulate child rows across ALL workouts, then bulk-insert once per table.
    route_rows: list[dict] = []
    sample_rows: list[dict] = []
    split_rows: list[dict] = []

    for pw in workouts:
        existing = existing_workouts.get(pw.uuid)
        # Bad GPS fixes would otherwise drive both the map and the stored splits,
        # which are GPS-derived. `distance_m` comes from the payload and is untouched.
        # Zwift coordinates describe virtual geography; real-world speed limits
        # and GPS-derived distances do not apply to these routes.
        virtual_route = ingest_source == "strava"
        route, dropped = (pw.route, 0) if virtual_route else filter_route_outliers(pw.route, pw.workout_type)
        counts["route_points_dropped"] += dropped
        has_route = len(route) >= 2
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

        for seq, rp in enumerate(route):
            route_rows.append(
                {
                    "workout_uuid": pw.uuid,
                    "seq": seq,
                    "ts_utc": rp.ts_utc,
                    "lat": rp.lat,
                    "lon": rp.lon,
                    "elevation_m": rp.elevation_m,
                    "speed_mps": rp.speed_mps,
                }
            )
        for hs in pw.hr_samples:
            sample_rows.append(
                {
                    "workout_uuid": pw.uuid,
                    "metric_type": "heart_rate",
                    "start_utc": hs.ts_utc,
                    "end_utc": hs.ts_utc,
                    "value": hs.bpm,
                    "unit": "bpm",
                }
            )
        # Build the distance/time + HR axes once and derive both unit systems.
        splits = compute_splits([] if virtual_route else route, pw.distance_samples, pw.hr_samples, ("mi", "km"))
        for r in splits:
            split_rows.append(
                {
                    "workout_uuid": pw.uuid,
                    "unit_system": r.unit_system,
                    "split_index": r.split_index,
                    "distance_m": r.distance_m,
                    "duration_sec": r.duration_sec,
                    "pace_sec_per_unit": r.pace_sec_per_unit,
                    "avg_hr": r.avg_hr,
                    "source": r.source,
                }
            )
        counts["splits"] += len(splits)

    # Ensure parent workout rows exist before touching their children.
    db.flush()

    # Replace child rows set-wise for every workout in this payload (idempotent
    # re-ingest): one DELETE per child table (chunked) instead of three per workout.
    for child in (models.WorkoutRoutePoint, models.WorkoutSample, models.WorkoutSplit):
        for batch in _chunked(workout_uuids):
            db.execute(delete(child).where(child.workout_uuid.in_(batch)))

    _bulk_insert(db, models.WorkoutRoutePoint, route_rows)
    _bulk_insert(db, models.WorkoutSample, sample_rows)
    _bulk_insert(db, models.WorkoutSplit, split_rows)

    # Batch-fetch existing daily metrics for the payload's dates/types in one
    # query (avoids a SELECT per metric). The map doubles as the in-payload
    # dedupe cache: SQL Server allows only one NULL per UNIQUE index and, with
    # autoflush off, freshly-added rows are invisible to a SELECT — so we
    # coalesce source_name to "" and reuse rows by (local_date, type, source).
    metrics_by_key: dict[tuple[str, str, str], models.DailyMetric] = {}
    metric_dates = list({dm.local_date for dm in parsed.daily_metrics})
    metric_types = list({dm.metric_type for dm in parsed.daily_metrics})
    for date_batch in _chunked(metric_dates):
        for m in db.execute(
            select(models.DailyMetric).where(
                models.DailyMetric.local_date.in_(date_batch),
                models.DailyMetric.metric_type.in_(metric_types),
            )
        ).scalars():
            metrics_by_key[(m.local_date, m.metric_type, m.source_name or "")] = m

    for dm in parsed.daily_metrics:
        source = dm.source_name or ""
        key = (dm.local_date, dm.metric_type, source)
        row = metrics_by_key.get(key)
        if row is None:
            row = models.DailyMetric(
                local_date=dm.local_date,
                metric_type=dm.metric_type,
                source_name=source,
            )
            db.add(row)
            metrics_by_key[key] = row
        row.value = dm.value
        row.unit = dm.unit
        row.updated_utc = now
        counts["daily_metrics"] += 1

    db.flush()
    return counts
