"""Geo helpers and split computation from GPS route points or distance samples."""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass
from datetime import datetime, timedelta

EARTH_RADIUS_M = 6_371_000.0
MILE_M = 1609.344
KM_M = 1000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    # Clamp to guard against floating-point rounding pushing a slightly > 1.0,
    # which would make math.asin(math.sqrt(a)) raise a domain error.
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, a)))


@dataclass
class SplitRow:
    unit_system: str
    split_index: int
    distance_m: float
    duration_sec: float
    pace_sec_per_unit: float
    avg_hr: float | None
    source: str


@dataclass
class RoutePoint:
    ts_utc: datetime
    lat: float
    lon: float
    elevation_m: float | None = None
    speed_mps: float | None = None


@dataclass
class HrSample:
    ts_utc: datetime
    bpm: float


@dataclass
class DistanceSample:
    start_utc: datetime
    end_utc: datetime
    meters: float


def _interp_time(dist_axis: list[float], time_axis: list[float], target: float) -> float:
    """Linear-interpolate elapsed seconds at a cumulative-distance target."""
    idx = bisect.bisect_left(dist_axis, target)
    if idx <= 0:
        return time_axis[0]
    if idx >= len(dist_axis):
        return time_axis[-1]
    d0, d1 = dist_axis[idx - 1], dist_axis[idx]
    t0, t1 = time_axis[idx - 1], time_axis[idx]
    if d1 == d0:
        return t1
    frac = (target - d0) / (d1 - d0)
    return t0 + frac * (t1 - t0)


def _splits_from_axes(
    dist_axis: list[float],
    time_axis: list[float],
    start_dt: datetime,
    hr: list[HrSample],
    unit_system: str,
    source: str,
) -> list[SplitRow]:
    """Build per-unit splits from monotonic cumulative distance/elapsed arrays.

    Working in elapsed seconds (relative to ``start_dt``) and reconstructing
    datetimes with ``timedelta`` avoids the naive-``datetime.timestamp()`` local
    timezone trap.
    """
    unit_m = MILE_M if unit_system == "mi" else KM_M
    total_dist = dist_axis[-1]
    total_time = time_axis[-1]
    if total_dist <= 0:
        return []

    # Pre-sort HR once and build prefix sums so each split's average HR is an
    # O(log n) range lookup instead of a full scan (was O(splits x samples)).
    hr_sorted = sorted(hr, key=lambda h: h.ts_utc)
    hr_times = [h.ts_utc for h in hr_sorted]
    hr_prefix = [0.0]
    for h in hr_sorted:
        hr_prefix.append(hr_prefix[-1] + h.bpm)

    def avg_hr(seg_start: datetime, seg_end: datetime) -> float | None:
        lo = bisect.bisect_left(hr_times, seg_start)
        hi = bisect.bisect_right(hr_times, seg_end)
        n = hi - lo
        return (hr_prefix[hi] - hr_prefix[lo]) / n if n else None

    splits: list[SplitRow] = []
    prev_elapsed = 0.0
    k = 1
    while k * unit_m <= total_dist + 1e-6:
        elapsed = _interp_time(dist_axis, time_axis, k * unit_m)
        dur = elapsed - prev_elapsed
        seg_start = start_dt + timedelta(seconds=prev_elapsed)
        seg_end = start_dt + timedelta(seconds=elapsed)
        splits.append(
            SplitRow(
                unit_system=unit_system,
                split_index=k,
                distance_m=unit_m,
                duration_sec=dur,
                pace_sec_per_unit=dur,
                avg_hr=avg_hr(seg_start, seg_end),
                source=source,
            )
        )
        prev_elapsed = elapsed
        k += 1

    remaining = total_dist - (k - 1) * unit_m
    if remaining > unit_m * 0.05:
        dur = total_time - prev_elapsed
        pace = dur / (remaining / unit_m) if remaining > 0 else 0.0
        seg_start = start_dt + timedelta(seconds=prev_elapsed)
        seg_end = start_dt + timedelta(seconds=total_time)
        splits.append(
            SplitRow(
                unit_system=unit_system,
                split_index=k,
                distance_m=remaining,
                duration_sec=dur,
                pace_sec_per_unit=pace,
                avg_hr=avg_hr(seg_start, seg_end),
                source=source,
            )
        )
    return splits


def compute_splits_from_route(
    points: list[RoutePoint],
    hr: list[HrSample],
    unit_system: str = "mi",
) -> list[SplitRow]:
    """Roll GPS points into per-unit splits using cumulative haversine distance."""
    if len(points) < 2:
        return []
    points = sorted(points, key=lambda p: p.ts_utc)
    start_dt = points[0].ts_utc
    dist_axis = [0.0]
    time_axis = [0.0]
    cum = 0.0
    for i in range(1, len(points)):
        a, b = points[i - 1], points[i]
        cum += haversine_m(a.lat, a.lon, b.lat, b.lon)
        dist_axis.append(cum)
        time_axis.append((b.ts_utc - start_dt).total_seconds())
    return _splits_from_axes(dist_axis, time_axis, start_dt, hr, unit_system, "gps")


def compute_splits_from_samples(
    dist: list[DistanceSample],
    hr: list[HrSample],
    unit_system: str = "mi",
) -> list[SplitRow]:
    """Fallback splits for indoor workouts with no GPS, using distance samples."""
    if not dist:
        return []
    dist = sorted(dist, key=lambda d: d.start_utc)
    start_dt = dist[0].start_utc
    dist_axis = [0.0]
    time_axis = [0.0]
    cum = 0.0
    for s in dist:
        cum += s.meters
        dist_axis.append(cum)
        time_axis.append((s.end_utc - start_dt).total_seconds())
    return _splits_from_axes(dist_axis, time_axis, start_dt, hr, unit_system, "sample")
