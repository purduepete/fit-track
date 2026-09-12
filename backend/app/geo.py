"""Geo helpers and split computation from GPS route points or distance samples."""
from __future__ import annotations

import bisect
import math
from collections.abc import Callable
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


def _hr_avg_fn(hr: list[HrSample]) -> Callable[[datetime, datetime], float | None]:
    """Pre-sort HR once and build prefix sums so each split's average HR is an
    O(log n) range lookup instead of a full scan. Built once and reused across
    unit systems (mi/km) so the samples are sorted a single time per workout.
    """
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

    return avg_hr


def _splits_from_axes(
    dist_axis: list[float],
    time_axis: list[float],
    start_dt: datetime,
    avg_hr: Callable[[datetime, datetime], float | None],
    unit_system: str,
    source: str,
) -> list[SplitRow]:
    """Build per-unit splits from monotonic cumulative distance/elapsed arrays.

    Working in elapsed seconds (relative to ``start_dt``) and reconstructing
    datetimes with ``timedelta`` avoids the naive-``datetime.timestamp()`` local
    timezone trap. ``avg_hr`` is a prebuilt range lookup (see :func:`_hr_avg_fn`).
    """
    unit_m = MILE_M if unit_system == "mi" else KM_M
    total_dist = dist_axis[-1]
    total_time = time_axis[-1]
    if total_dist <= 0:
        return []

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


def _axes_from_route(points: list[RoutePoint]) -> tuple[list[float], list[float], datetime]:
    """Cumulative haversine distance + elapsed-seconds axes from GPS points."""
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
    return dist_axis, time_axis, start_dt


def _axes_from_samples(dist: list[DistanceSample]) -> tuple[list[float], list[float], datetime]:
    """Cumulative distance + elapsed-seconds axes from distance-increment samples."""
    dist = sorted(dist, key=lambda d: d.start_utc)
    start_dt = dist[0].start_utc
    dist_axis = [0.0]
    time_axis = [0.0]
    cum = 0.0
    for s in dist:
        cum += s.meters
        dist_axis.append(cum)
        time_axis.append((s.end_utc - start_dt).total_seconds())
    return dist_axis, time_axis, start_dt


# --- GPS outlier filtering -------------------------------------------------
#
# Health Auto Export carries no horizontal-accuracy field, so a bad fix can only
# be spotted kinematically. Speed is the ONLY rejection criterion here: a real
# dead-end out-and-back, U-turn or switchback walked at human pace is never
# touched, because rejecting on geometry misreads those as spikes.

# The travel budget stops growing after this many seconds, so a long stationary
# pause cannot make a distant spike look "reachable".
DT_CLAMP_S = 15.0
# Stationary GPS jitter is tolerated but never re-anchors, so it cannot chain.
JITTER_M = 10.0
# Consecutive rejects that must agree with each other before a relocation is believed.
CLUSTER_N = 3
# Caps are set to physical plausibility, not to the pace the activity implies.
# A walk that ends with a bus ride is still real GPS: measured against 17,671
# stored points, a 4.5 m/s walk cap deleted 230 points of smooth 12-13 m/s
# vehicle travel across 3 workouts, while every genuine bad fix ran 20-72 m/s.
DEFAULT_SPEED_CAP_MPS = 15.0
_SPEED_CAPS_MPS: tuple[tuple[tuple[str, ...], float], ...] = (
    (("cycl", "bike", "ride"), 25.0),
    (("swim",), 3.0),
)


def speed_cap_mps(workout_type: str | None) -> float:
    """Plausible top speed for a workout type. Matched on a lowercased substring
    because raw HAE names ("Outdoor Walk") are not in ``WORKOUT_TYPE_MAP``."""
    name = (workout_type or "").lower()
    for keys, cap in _SPEED_CAPS_MPS:
        if any(k in name for k in keys):
            return cap
    return DEFAULT_SPEED_CAP_MPS


def _reachable(a: RoutePoint, b: RoutePoint, cap: float, *, floor: bool) -> bool:
    dt = abs((b.ts_utc - a.ts_utc).total_seconds())
    if dt <= 0:
        # Two fixes on the same timestamp. HAE emits these regularly, and they
        # are undecidable kinematically. Rejecting the later one de-duplicates
        # the track: a zero-duration segment only adds spurious length and makes
        # the split pace divide by zero. This is most of what the filter removes.
        return False
    budget = cap * min(dt, DT_CLAMP_S)
    if floor:
        budget = max(JITTER_M, budget)
    return haversine_m(a.lat, a.lon, b.lat, b.lon) <= budget


def _self_consistent(run: list[tuple[int, RoutePoint]], cap: float) -> bool:
    return all(
        _reachable(run[i - 1][1], run[i][1], cap, floor=False) for i in range(1, len(run))
    )


def _pass_keep(seq: list[tuple[int, RoutePoint]], cap: float) -> set[int]:
    """One directional sweep. Keeps indices reachable from the last trusted point."""
    kept: set[int] = set()
    if not seq:
        return kept
    anchor_i, anchor = seq[0]
    kept.add(anchor_i)
    pending: list[tuple[int, RoutePoint]] = []
    for idx, p in seq[1:]:
        if _reachable(anchor, p, cap, floor=True):
            kept.add(idx)
            pending.clear()
            # Re-anchor only on a strict pass, so points admitted by the jitter
            # floor alone keep being measured from the same capped anchor.
            if _reachable(anchor, p, cap, floor=False):
                anchor = p
            continue
        pending.append((idx, p))
        if len(pending) > CLUSTER_N:
            pending.pop(0)
        if len(pending) == CLUSTER_N and _self_consistent(pending, cap):
            kept.update(j for j, _ in pending)
            anchor = pending[-1][1]
            pending.clear()
    # A genuine relocation that resumes for only two points before the track ends
    # would otherwise be thrown away. A single uncorroborated point stays dropped.
    if len(pending) >= 2 and _self_consistent(pending, cap):
        kept.update(j for j, _ in pending)
    return kept


def filter_route_outliers(
    points: list[RoutePoint], workout_type: str | None
) -> tuple[list[RoutePoint], int]:
    """Drop GPS fixes that would require an impossible speed.

    Returns the surviving points (time-ordered) and how many were dropped. The
    sweep runs forward and backward and keeps the intersection, so a cold-start
    or cold-finish spike is removed instead of being trusted as a seed. A point
    that only one direction disliked is restored if both surviving neighbours
    are reachable, which stops one poisoned endpoint from deleting a good run.
    """
    ordered = sorted(points, key=lambda p: p.ts_utc)
    if len(ordered) < 4:
        return ordered, 0

    cap = speed_cap_mps(workout_type)
    indexed = list(enumerate(ordered))
    forward = _pass_keep(indexed, cap)
    backward = _pass_keep(list(reversed(indexed)), cap)
    keep = forward & backward

    for i in sorted(forward ^ backward):
        left = max((j for j in keep if j < i), default=None)
        right = min((j for j in keep if j > i), default=None)
        if left is None or right is None:
            continue
        if _reachable(ordered[left], ordered[i], cap, floor=True) and _reachable(
            ordered[i], ordered[right], cap, floor=True
        ):
            keep.add(i)

    # Losing half a track means the filter, not the track, is wrong. Bailing out
    # also keeps the kept length >= 2, so `has_route` and the split source
    # ("gps" vs "sample") can never flip as a side effect of filtering.
    if len(keep) < max(2, 0.5 * len(ordered)):
        return ordered, 0
    return [p for i, p in indexed if i in keep], len(ordered) - len(keep)


def compute_splits(
    points: list[RoutePoint],
    dist_samples: list[DistanceSample],
    hr: list[HrSample],
    unit_systems: tuple[str, ...] = ("mi", "km"),
) -> list[SplitRow]:
    """Compute splits for several unit systems, building the distance/time and
    HR axes ONCE (GPS route preferred, distance samples as fallback)."""
    if len(points) >= 2:
        dist_axis, time_axis, start_dt = _axes_from_route(points)
        source = "gps"
    elif dist_samples:
        dist_axis, time_axis, start_dt = _axes_from_samples(dist_samples)
        source = "sample"
    else:
        return []
    avg_hr = _hr_avg_fn(hr)
    out: list[SplitRow] = []
    for unit_system in unit_systems:
        out.extend(_splits_from_axes(dist_axis, time_axis, start_dt, avg_hr, unit_system, source))
    return out


def compute_splits_from_route(
    points: list[RoutePoint],
    hr: list[HrSample],
    unit_system: str = "mi",
) -> list[SplitRow]:
    """Roll GPS points into per-unit splits using cumulative haversine distance."""
    if len(points) < 2:
        return []
    dist_axis, time_axis, start_dt = _axes_from_route(points)
    return _splits_from_axes(dist_axis, time_axis, start_dt, _hr_avg_fn(hr), unit_system, "gps")


def compute_splits_from_samples(
    dist: list[DistanceSample],
    hr: list[HrSample],
    unit_system: str = "mi",
) -> list[SplitRow]:
    """Fallback splits for indoor workouts with no GPS, using distance samples."""
    if not dist:
        return []
    dist_axis, time_axis, start_dt = _axes_from_samples(dist)
    return _splits_from_axes(dist_axis, time_axis, start_dt, _hr_avg_fn(hr), unit_system, "sample")
