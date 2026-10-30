"""Build a workout view with whole timestamped points excluded."""
import json
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import fmean
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from .geo import DistanceSample, HrSample, RoutePoint, compute_splits, haversine_m
from .models import RawIngestEvent, Workout, WorkoutRoutePoint, WorkoutSample, WorkoutSplit
from .normalize import parse_workout
from .schemas import PointExclusion, PointExclusionOut, SplitOut, WorkoutPointOut, WorkoutSummary
from .strava import parse_strava_payload

logger = logging.getLogger("fittrack")


@dataclass
class DistanceSource:
    kind: Literal["cumulative", "increment"]
    points: list[tuple[datetime, float]]
    samples: list[DistanceSample]
    timestamps: list[datetime]
    elevations: list[tuple[datetime, float]]


@dataclass
class PointView:
    summary: WorkoutSummary
    min_hr: float | None
    route: list[WorkoutRoutePoint]
    heart_rate: list[WorkoutSample]
    splits: list[SplitOut]
    points: list[WorkoutPointOut]
    exclusions: list[PointExclusionOut]
    can_recalculate: bool


def _distance_source(db: Session, workout: Workout) -> tuple[DistanceSource | None, bool]:
    is_strava = workout.uuid.startswith("strava:") and workout.source_name == "Strava"
    source = "strava" if is_strava else "health_auto_export"
    needle = workout.uuid.removeprefix("strava:") if is_strava else workout.uuid
    candidates = db.execute(
        select(RawIngestEvent.id, RawIngestEvent.payload_json)
        .where(
            RawIngestEvent.source == source,
            RawIngestEvent.status == "processed",
            RawIngestEvent.payload_json.contains(needle),
        )
        .order_by(RawIngestEvent.processed_utc.desc(), RawIngestEvent.id.desc())
    )
    for event_id, payload_json in candidates:
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            logger.error("Stored ingest event %s contains invalid JSON", event_id)
            return None, False
        if not isinstance(payload, dict):
            logger.error("Stored ingest event %s is not a JSON object", event_id)
            return None, False
        if is_strava:
            activity = payload.get("activity")
            if not isinstance(activity, dict) or str(activity.get("id")) != needle:
                continue
            parsed = parse_strava_payload(payload).workouts[0]
            streams = payload.get("streams") or {}
            times = (streams.get("time") or {}).get("data") or []
            distances = (streams.get("distance") or {}).get("data") or []
            altitudes = (streams.get("altitude") or {}).get("data") or []
            timestamps = [parsed.start_utc + timedelta(seconds=float(second)) for second in times]
            points = [
                (timestamp, float(distance))
                for timestamp, distance in zip(timestamps, distances, strict=False)
            ]
            elevations = [
                (timestamp, float(elevation))
                for timestamp, elevation in zip(timestamps, altitudes, strict=False)
                if elevation is not None
            ]
            return DistanceSource("cumulative", points, parsed.distance_samples, timestamps, elevations), True

        data = payload.get("data", payload)
        if not isinstance(data, dict):
            continue
        for item in data.get("workouts", []):
            if not isinstance(item, dict):
                continue
            candidate = parse_workout(item)
            if candidate is not None and candidate.uuid == workout.uuid:
                return (
                    DistanceSource(
                        "increment",
                        [(sample.start_utc, sample.meters) for sample in candidate.distance_samples],
                        candidate.distance_samples,
                        [sample.start_utc for sample in candidate.distance_samples],
                        [],
                    ),
                    True,
                )
    return None, True


def _route_points(rows: list[WorkoutRoutePoint]) -> list[RoutePoint]:
    return [
        RoutePoint(row.ts_utc, row.lat, row.lon, row.elevation_m, row.speed_mps)
        for row in rows
    ]


def _remaining_distances(source: DistanceSource | None, excluded: set[datetime]) -> list[DistanceSample]:
    if source is None:
        return []
    points = [(timestamp, distance) for timestamp, distance in source.points if timestamp not in excluded]
    if source.kind == "increment":
        return [
            DistanceSample(timestamp, points[i + 1][0] if i + 1 < len(points) else timestamp, distance)
            for i, (timestamp, distance) in enumerate(points)
        ]
    return [
        DistanceSample(start[0], end[0], end[1] - start[1])
        for start, end in zip(points, points[1:], strict=False)
    ]


def point_view(db: Session, workout: Workout) -> PointView:
    route = list(db.scalars(
        select(WorkoutRoutePoint)
        .where(WorkoutRoutePoint.workout_uuid == workout.uuid)
        .order_by(WorkoutRoutePoint.seq, WorkoutRoutePoint.id)
    ))
    heart_rate = list(db.scalars(
        select(WorkoutSample)
        .where(
            WorkoutSample.workout_uuid == workout.uuid,
            WorkoutSample.metric_type == "heart_rate",
        )
        .order_by(WorkoutSample.start_utc, WorkoutSample.id)
    ))
    stored_splits = list(db.scalars(
        select(WorkoutSplit)
        .where(WorkoutSplit.workout_uuid == workout.uuid)
        .order_by(WorkoutSplit.unit_system, WorkoutSplit.split_index)
    ))
    source, source_valid = _distance_source(db, workout)
    exclusions = [PointExclusion.model_validate(item) for item in workout.point_exclusions]
    excluded = {item.ts_utc for item in exclusions}
    points: dict[datetime, WorkoutPointOut] = {}

    def point(timestamp: datetime) -> WorkoutPointOut:
        if timestamp not in points:
            points[timestamp] = WorkoutPointOut(ts_utc=timestamp, excluded=timestamp in excluded)
        return points[timestamp]

    for row in route:
        item = point(row.ts_utc)
        item.route_count += 1
        if row.elevation_m is not None and math.isfinite(row.elevation_m):
            item.elevation_m.append(row.elevation_m)
        if row.speed_mps is not None and math.isfinite(row.speed_mps):
            item.speed_mps.append(row.speed_mps)
    for sample in heart_rate:
        point(sample.start_utc).heart_rate_bpm.append(sample.value)
    if source is not None:
        for timestamp in source.timestamps:
            point(timestamp)
        for timestamp, elevation in source.elevations:
            item = point(timestamp)
            if not item.elevation_m:
                item.elevation_m.append(elevation)
        for timestamp, meters in source.points:
            item = point(timestamp)
            item.distance_m = meters if item.distance_m is None else item.distance_m + meters
            item.distance_kind = source.kind

    matched = excluded.intersection(points)
    remaining_route = [row for row in route if row.ts_utc not in matched]
    remaining_hr = [row for row in heart_rate if row.start_utc not in matched]
    summary = WorkoutSummary.model_validate(workout, from_attributes=True)
    min_hr = workout.min_hr
    splits = [SplitOut.model_validate(row, from_attributes=True) for row in stored_splits]
    is_strava = workout.uuid.startswith("strava:") and workout.source_name == "Strava"
    uses_gps = not is_strava and len(route) >= 2
    needs_distance = any(row.source == "sample" for row in stored_splits)
    can_recalculate = (
        source_valid
        and (not is_strava or source is not None)
        and (uses_gps or workout.distance_m is None or source is not None)
        and (not needs_distance or bool(source and source.samples))
    )

    if matched:
        if any(row.ts_utc in matched for row in route):
            summary.has_route = len(remaining_route) >= 2
        if any(row.start_utc in matched for row in heart_rate):
            values = [row.value for row in remaining_hr if math.isfinite(row.value)]
            summary.avg_hr = fmean(values) if values else None
            summary.max_hr = max(values) if values else None
            min_hr = min(values) if values else None
        if any(points[timestamp].elevation_m for timestamp in matched):
            elevations = [
                elevation
                for timestamp in sorted(points)
                if timestamp not in matched
                for elevation in points[timestamp].elevation_m
            ]
            summary.elevation_gain_m = (
                sum(max(0.0, end - start) for start, end in zip(elevations, elevations[1:], strict=False))
                if len(elevations) >= 2 else None
            )
        if uses_gps and any(row.ts_utc in matched for row in route):
            ordered = sorted(remaining_route, key=lambda row: row.ts_utc)
            summary.distance_m = (
                sum(
                    haversine_m(start.lat, start.lon, end.lat, end.lon)
                    for start, end in zip(ordered, ordered[1:], strict=False)
                )
                if len(ordered) >= 2 else None
            )
        elif not uses_gps and source and any(timestamp in matched for timestamp, _ in source.points):
            remaining = [(timestamp, value) for timestamp, value in source.points if timestamp not in matched]
            if source.kind == "cumulative":
                summary.distance_m = remaining[-1][1] - remaining[0][1] if len(remaining) >= 2 else None
            else:
                summary.distance_m = sum(value for _, value in remaining) if remaining else None

        if not can_recalculate:
            summary.distance_m = None
            summary.point_exclusion_warning = (
                "Original distance samples are unavailable. Adjusted distance and splits cannot be calculated."
            )
            logger.warning(
                "Cannot recalculate excluded workout %s: original distance samples unavailable", workout.uuid
            )
            splits = []
        else:
            geo_route = _route_points(remaining_route)
            gps_route = [] if is_strava else geo_route
            elevation_points = [
                RoutePoint(timestamp, 0.0, 0.0, elevation)
                for timestamp in sorted(points)
                if timestamp not in matched
                for elevation in points[timestamp].elevation_m
            ]
            hr = [HrSample(row.start_utc, row.value) for row in remaining_hr if math.isfinite(row.value)]
            recalculated = compute_splits(
                gps_route,
                [] if uses_gps else _remaining_distances(source, matched),
                hr,
                elevation_points=elevation_points,
            )
            splits = [SplitOut.model_validate(row, from_attributes=True) for row in recalculated]

    return PointView(
        summary=summary,
        min_hr=min_hr,
        route=remaining_route,
        heart_rate=remaining_hr,
        splits=splits,
        points=[points[timestamp] for timestamp in sorted(points)],
        exclusions=[
            PointExclusionOut(ts_utc=item.ts_utc, matched=item.ts_utc in matched)
            for item in exclusions
        ],
        can_recalculate=can_recalculate,
    )
