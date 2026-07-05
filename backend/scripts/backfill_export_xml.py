"""One-time historical backfill from an Apple Health ``export.zip``.

The native ``export.xml`` can be hundreds of MB, so it is parsed with a
streaming ``lxml.etree.iterparse`` loop (never loaded fully into memory).
Workout summaries and per-day aggregate metrics are extracted; if the export
contains ``workout-routes/*.gpx`` files, routes are attached to their workouts
and mileage splits are computed for historical runs too.

DB-altering script: per project policy, get a Gemini second opinion before
running this against the live WebPortfolio database.

Usage:
    python -m scripts.backfill_export_xml --export-dir "C:\\path\\to\\apple_health_export"
    python -m scripts.backfill_export_xml --xml export.xml --no-routes
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, ".")

from app.db import SessionLocal  # noqa: E402
from app.geo import RoutePoint  # noqa: E402
from app.normalize import (  # noqa: E402
    WORKOUT_TYPE_MAP,
    ParsedDailyMetric,
    ParsedPayload,
    ParsedWorkout,
    distance_to_meters,
    local_date_str,
    parse_dt,
    persist_payload,
    synth_workout_uuid,
)
from lxml import etree  # noqa: E402

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}

# Apple Record type -> (fittrack metric name, aggregation)
RECORD_METRICS = {
    "HKQuantityTypeIdentifierStepCount": ("step_count", "sum"),
    "HKQuantityTypeIdentifierActiveEnergyBurned": ("active_energy", "sum"),
    "HKQuantityTypeIdentifierAppleExerciseTime": ("apple_exercise_time", "sum"),
    "HKQuantityTypeIdentifierRestingHeartRate": ("resting_heart_rate", "avg"),
    "HKQuantityTypeIdentifierVO2Max": ("vo2_max", "avg"),
    "HKQuantityTypeIdentifierBodyMass": ("body_mass", "last"),
}


def _clear(elem) -> None:
    elem.clear()
    while elem.getprevious() is not None:
        del elem.getparent()[0]


def parse_workout_element(w) -> tuple[ParsedWorkout | None, str | None]:
    """Return (ParsedWorkout, gpx_relative_path) from a <Workout> element."""
    start_utc, tz = parse_dt(w.get("startDate"))
    end_utc, _ = parse_dt(w.get("endDate"))
    if start_utc is None:
        return None, None
    if end_utc is None:
        end_utc = start_utc

    raw_type = w.get("workoutActivityType", "Workout")
    duration = w.get("duration")
    duration_sec = None
    if duration is not None:
        val = float(duration)
        duration_sec = val * 60 if w.get("durationUnit", "min") == "min" else val

    distance_m = distance_to_meters(w.get("totalDistance"), w.get("totalDistanceUnit"))

    avg_hr = max_hr = min_hr = None
    for stat in w.findall("WorkoutStatistics"):
        if stat.get("type") == "HKQuantityTypeIdentifierHeartRate":
            avg_hr = _f(stat.get("average"))
            max_hr = _f(stat.get("maximum"))
            min_hr = _f(stat.get("minimum"))

    gpx_path = None
    route = w.find("WorkoutRoute")
    if route is not None:
        ref = route.find("FileReference")
        if ref is not None:
            gpx_path = ref.get("path")

    wid = synth_workout_uuid(raw_type, start_utc)

    pw = ParsedWorkout(
        uuid=wid,
        workout_type=WORKOUT_TYPE_MAP.get(raw_type, raw_type),
        source_name=w.get("sourceName"),
        device_name=w.get("device"),
        start_utc=start_utc,
        end_utc=end_utc,
        tz_offset_minutes=tz,
        local_date=local_date_str(start_utc, tz),
        duration_sec=duration_sec,
        distance_m=distance_m,
        active_energy_kcal=_f(w.get("totalEnergyBurned")),
        avg_hr=avg_hr,
        max_hr=max_hr,
        min_hr=min_hr,
    )
    return pw, gpx_path


def _f(value) -> float | None:
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


def load_gpx(path: str) -> list[RoutePoint]:
    pts: list[RoutePoint] = []
    try:
        tree = etree.parse(path)
    except (OSError, etree.XMLSyntaxError):
        return pts
    for trkpt in tree.iterfind(".//g:trkpt", GPX_NS):
        lat = _f(trkpt.get("lat"))
        lon = _f(trkpt.get("lon"))
        tnode = trkpt.find("g:time", GPX_NS)
        if lat is None or lon is None or tnode is None or not tnode.text:
            continue
        ts, _ = parse_dt(tnode.text)
        if ts is not None:
            pts.append(RoutePoint(ts_utc=ts, lat=lat, lon=lon))
    return pts


def backfill(export_dir: str, xml_path: str, include_routes: bool) -> None:
    workouts: list[ParsedWorkout] = []
    gpx_by_uuid: dict[str, str] = {}
    # metric_type -> local_date -> [values] (or running sum/last)
    agg: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

    context = etree.iterparse(xml_path, events=("end",), tag=("Workout", "Record"))
    n_workouts = n_records = 0
    for _, elem in context:
        if elem.tag == "Workout":
            pw, gpx = parse_workout_element(elem)
            if pw:
                workouts.append(pw)
                if gpx and include_routes:
                    gpx_by_uuid[pw.uuid] = gpx
                n_workouts += 1
        else:  # Record
            rtype = elem.get("type")
            mapping = RECORD_METRICS.get(rtype)
            if mapping:
                start_utc, tz = parse_dt(elem.get("startDate"))
                val = _f(elem.get("value"))
                if start_utc is not None and val is not None:
                    d = local_date_str(start_utc, tz)
                    agg[mapping[0]][d].append(val)
                    n_records += 1
        _clear(elem)

    # Attach GPX routes and let persist compute splits.
    if include_routes and gpx_by_uuid:
        base = export_dir
        by_uuid = {w.uuid: w for w in workouts}
        for wid, rel in gpx_by_uuid.items():
            gpx_file = os.path.join(base, rel.lstrip("/\\"))
            if os.path.exists(gpx_file):
                pts = load_gpx(gpx_file)
                if len(pts) >= 2:
                    by_uuid[wid].route = pts

    daily = _aggregate_daily(agg)

    parsed = ParsedPayload(workouts=workouts, daily_metrics=daily)
    with SessionLocal() as db:
        counts = persist_payload(parsed, db)
    print(
        f"Parsed {n_workouts} workouts, {n_records} metric records.\n"
        f"Persisted: {counts}"
    )


def _aggregate_daily(agg: dict[str, dict[str, list[float]]]) -> list[ParsedDailyMetric]:
    out: list[ParsedDailyMetric] = []
    for metric, per_day in agg.items():
        how = next(v for k, (name, v) in RECORD_METRICS.items() if name == metric)
        for day, values in per_day.items():
            if how == "sum":
                value = sum(values)
            elif how == "avg":
                value = sum(values) / len(values)
            else:  # last
                value = values[-1]
            out.append(
                ParsedDailyMetric(
                    local_date=day,
                    metric_type=metric,
                    value=round(value, 3),
                    unit=None,
                    source_name="apple_health_export",
                )
            )
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Backfill fittrack from Apple Health export.xml")
    p.add_argument("--export-dir", help="Folder containing export.xml and workout-routes/")
    p.add_argument("--xml", help="Path to export.xml (defaults to <export-dir>/export.xml)")
    p.add_argument("--no-routes", action="store_true", help="Skip GPX route/splits backfill")
    args = p.parse_args()

    export_dir = args.export_dir or (os.path.dirname(args.xml) if args.xml else ".")
    xml_path = args.xml or os.path.join(export_dir, "export.xml")
    if not os.path.exists(xml_path):
        raise SystemExit(f"export.xml not found at {xml_path}")

    print(f"Backfilling from {xml_path} (routes={'off' if args.no_routes else 'on'})...")
    print(f"Started {datetime.now().isoformat(timespec='seconds')}")
    backfill(export_dir, xml_path, include_routes=not args.no_routes)


if __name__ == "__main__":
    main()
