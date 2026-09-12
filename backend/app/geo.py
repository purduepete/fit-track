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
# Each activity gets a self-powered cap and a ceiling. The ceiling is only
# reached where the net displacement around a fix shows the ground was really
# covered, so a walk that ends on a bus keeps its 12-13 m/s leg (230 such points
# across 3 real walks) while a fix claiming 11 m/s from a standstill does not.
DEFAULT_SPEED_CAPS_MPS = (15.0, 15.0)
_SPEED_CAPS_MPS: tuple[tuple[tuple[str, ...], tuple[float, float]], ...] = (
    (("cycl", "bike", "ride"), (25.0, 25.0)),
    (("swim",), (3.0, 3.0)),
    (("run", "jog"), (8.0, 15.0)),
    (("walk", "hike"), (4.5, 15.0)),
)
# Half-width of the window whose net displacement corroborates a fast fix.
CORRIDOR_WINDOW_S = 10.0
CORRIDOR_K = 1.6
# Multipath off a large structure draws a long path that goes nowhere. Only the
# first step of such a burst is individually impossible, so the rest is invisible
# to a pairwise test and has to be caught as a window.
WANDER_WINDOW_S = 30.0
# A hard ceiling on the fixes one window may span. The time bound alone is set
# by the payload, so a burst of thousands of sub-second or duplicate timestamps
# would make the candidate scan quadratic on an authenticated ingest request.
# 30 s of 8 Hz sampling is already far denser than any watch emits.
WANDER_WINDOW_MAX_PTS = 240
WANDER_MIN_PATH_M = 60.0
WANDER_RATIO = 3.0
WANDER_DEV_M = 12.0


def speed_caps_mps(workout_type: str | None) -> tuple[float, float]:
    """``(self-powered cap, corroborated ceiling)`` for a workout type. Matched on
    a lowercased substring because raw HAE names ("Outdoor Walk") are not in
    ``WORKOUT_TYPE_MAP``."""
    name = (workout_type or "").lower()
    for keys, caps in _SPEED_CAPS_MPS:
        if any(k in name for k in keys):
            return caps
    return DEFAULT_SPEED_CAPS_MPS


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


def _step_speed(a: RoutePoint, b: RoutePoint) -> float:
    dt = abs((b.ts_utc - a.ts_utc).total_seconds())
    if dt <= 0:
        return 0.0
    return haversine_m(a.lat, a.lon, b.lat, b.lon) / dt


def _corridor_caps(ordered: list[RoutePoint], ped: float, ceiling: float) -> list[float]:
    """Per-fix speed ceiling, raised only where the surrounding net displacement
    shows real travel. Net displacement is taken from window edges, so noise
    inside a window cannot inflate it. The best of the leading, trailing and full
    window wins, because a centred window averages an acceleration with whatever
    came before it and would clip the start of a genuine vehicle leg."""
    caps: list[float] = []
    lo = hi = 0

    def net_speed(i: int, j: int) -> float:
        span = (ordered[j].ts_utc - ordered[i].ts_utc).total_seconds()
        if span <= 0:
            return 0.0
        return haversine_m(ordered[i].lat, ordered[i].lon, ordered[j].lat, ordered[j].lon) / span

    for i, p in enumerate(ordered):
        while (p.ts_utc - ordered[lo].ts_utc).total_seconds() > CORRIDOR_WINDOW_S:
            lo += 1
        hi = max(hi, i)
        while (
            hi + 1 < len(ordered)
            and (ordered[hi + 1].ts_utc - p.ts_utc).total_seconds() <= CORRIDOR_WINDOW_S
        ):
            hi += 1
        v = max(net_speed(lo, i), net_speed(i, hi), net_speed(lo, hi))
        caps.append(min(ceiling, max(ped, CORRIDOR_K * v)))
    return caps


def _local_xy(origin: RoutePoint, p: RoutePoint) -> tuple[float, float]:
    # Wrap the longitude difference so a step across the antimeridian reads as
    # the short way round, matching what haversine_m measures.
    dlon = (p.lon - origin.lon + 180.0) % 360.0 - 180.0
    east = haversine_m(origin.lat, origin.lon, origin.lat, origin.lon + dlon)
    north = haversine_m(origin.lat, origin.lon, p.lat, origin.lon)
    return (
        east if dlon >= 0 else -east,
        north if p.lat >= origin.lat else -north,
    )


def _dev_from_chord(a: RoutePoint, b: RoutePoint, p: RoutePoint) -> float:
    """Distance from ``p`` to the ``a``-``b`` segment, in metres."""
    bx, by = _local_xy(a, b)
    px, py = _local_xy(a, p)
    span = bx * bx + by * by
    if span <= 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / span))
    return math.hypot(px - t * bx, py - t * by)


def _wander_drops(ordered: list[RoutePoint], ped: float) -> set[int]:
    """Fixes inside a multipath burst: a long path with little net displacement,
    anchored on at least one step that is impossible under the self-powered cap.
    Without that anchor a genuine out-and-back walk would score the same."""
    n = len(ordered)
    path = [0.0]
    impossible = [0]
    for i in range(1, n):
        path.append(
            path[-1]
            + haversine_m(ordered[i - 1].lat, ordered[i - 1].lon, ordered[i].lat, ordered[i].lon)
        )
        impossible.append(impossible[-1] + (_step_speed(ordered[i - 1], ordered[i]) > ped))

    # Strongest window per start, then settle them best-first. Taking the first
    # window that qualifies instead lets a chord start on the corridor and end
    # inside the burst, which deletes good track and spares the excursion.
    candidates: list[tuple[float, int, int]] = []
    hi = 0
    for s in range(n - 2):
        hi = max(hi, s)
        limit = min(n - 1, s + WANDER_WINDOW_MAX_PTS)
        while (
            hi < limit
            and (ordered[hi + 1].ts_utc - ordered[s].ts_utc).total_seconds() <= WANDER_WINDOW_S
        ):
            hi += 1
        hi = min(hi, limit)
        if impossible[hi] == impossible[s] or path[hi] - path[s] < WANDER_MIN_PATH_M:
            continue
        best = (0.0, -1)
        for e in range(s + 2, hi + 1):
            length = path[e] - path[s]
            if length < WANDER_MIN_PATH_M or impossible[e] == impossible[s]:
                continue
            net = haversine_m(ordered[s].lat, ordered[s].lon, ordered[e].lat, ordered[e].lon)
            ratio = length / max(net, 1.0)
            if ratio > best[0]:
                best = (ratio, e)
        if best[1] >= 0 and best[0] >= WANDER_RATIO:
            candidates.append((best[0], s, best[1]))

    drops: set[int] = set()
    taken: list[tuple[int, int]] = []
    for _, s, e in sorted(candidates, key=lambda c: (-c[0], c[1])):
        if any(s < t_e and t_s < e for t_s, t_e in taken):
            continue
        # Only the excursion goes: fixes already on the direct line are real
        # track that the burst happens to span.
        bad = {
            i
            for i in range(s + 1, e)
            if _dev_from_chord(ordered[s], ordered[e], ordered[i]) >= WANDER_DEV_M
        }
        if not bad:
            continue
        drops |= bad
        taken.append((s, e))
    return drops


def _self_consistent(run: list[tuple[int, RoutePoint]], caps: list[float]) -> bool:
    return all(
        _reachable(
            run[i - 1][1], run[i][1], min(caps[run[i - 1][0]], caps[run[i][0]]), floor=False
        )
        for i in range(1, len(run))
    )


def _pass_keep(seq: list[tuple[int, RoutePoint]], caps: list[float]) -> set[int]:
    """One directional sweep. Keeps indices reachable from the last trusted point."""
    kept: set[int] = set()
    if not seq:
        return kept
    anchor_i, anchor = seq[0]
    kept.add(anchor_i)
    pending: list[tuple[int, RoutePoint]] = []
    for idx, p in seq[1:]:
        cap = min(caps[anchor_i], caps[idx])
        if _reachable(anchor, p, cap, floor=True):
            kept.add(idx)
            pending.clear()
            # Re-anchor only on a strict pass, so points admitted by the jitter
            # floor alone keep being measured from the same capped anchor.
            if _reachable(anchor, p, cap, floor=False):
                anchor_i, anchor = idx, p
            continue
        pending.append((idx, p))
        if len(pending) > CLUSTER_N:
            pending.pop(0)
        if len(pending) == CLUSTER_N and _self_consistent(pending, caps):
            kept.update(j for j, _ in pending)
            anchor_i, anchor = pending[-1]
            pending.clear()
    # A genuine relocation that resumes for only two points before the track ends
    # would otherwise be thrown away. A single uncorroborated point stays dropped.
    if len(pending) >= 2 and _self_consistent(pending, caps):
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

    ped, ceiling = speed_caps_mps(workout_type)
    caps = _corridor_caps(ordered, ped, ceiling)
    indexed = list(enumerate(ordered))
    forward = _pass_keep(indexed, caps)
    backward = _pass_keep(list(reversed(indexed)), caps)
    keep = forward & backward

    for i in sorted(forward ^ backward):
        left = max((j for j in keep if j < i), default=None)
        right = min((j for j in keep if j > i), default=None)
        if left is None or right is None:
            continue
        if _reachable(
            ordered[left], ordered[i], min(caps[left], caps[i]), floor=True
        ) and _reachable(ordered[i], ordered[right], min(caps[i], caps[right]), floor=True):
            keep.add(i)

    keep -= _wander_drops(ordered, ped)

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
