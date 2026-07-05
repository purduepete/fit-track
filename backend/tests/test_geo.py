"""Unit tests for geo helpers and split computation."""
from datetime import datetime, timedelta

from app.geo import (
    DistanceSample,
    HrSample,
    RoutePoint,
    compute_splits_from_route,
    compute_splits_from_samples,
    haversine_m,
)

BASE = datetime(2026, 7, 5, 12, 0, 0)


def test_haversine_known_distance():
    # ~1 degree of latitude is ~111 km.
    d = haversine_m(0.0, 0.0, 1.0, 0.0)
    assert 110_000 < d < 112_000


def test_haversine_zero():
    assert haversine_m(47.0, -122.0, 47.0, -122.0) == 0.0


def test_haversine_coincident_points_no_domain_error():
    # Floating-point rounding must not push the asin/sqrt argument past 1.0.
    assert haversine_m(47.123456, -122.123456, 47.123456, -122.123456) == 0.0
    assert haversine_m(0.0, 0.0, 0.0, 0.0) == 0.0


def _straight_line_route(n: int, spacing_m: float, secs_per_point: float) -> list[RoutePoint]:
    """Points marching north; ~spacing_m apart, one every secs_per_point seconds."""
    deg_per_m = 1.0 / 111_320.0
    return [
        RoutePoint(
            ts_utc=BASE + timedelta(seconds=i * secs_per_point),
            lat=i * spacing_m * deg_per_m,
            lon=0.0,
        )
        for i in range(n)
    ]


def test_route_splits_constant_pace():
    # 3200 m at 1 m/s -> two 1000 m km-splits of ~1000 s each.
    route = _straight_line_route(n=321, spacing_m=10.0, secs_per_point=10.0)
    splits = compute_splits_from_route(route, [], "km")
    full = [s for s in splits if abs(s.distance_m - 1000.0) < 1e-6]
    assert len(full) == 3
    for s in full:
        assert abs(s.pace_sec_per_unit - 1000.0) < 20.0  # ~1000 s/km


def test_route_split_durations_sum_to_total():
    route = _straight_line_route(n=250, spacing_m=10.0, secs_per_point=5.0)
    splits = compute_splits_from_route(route, [], "mi")
    total = sum(s.duration_sec for s in splits)
    expected = (len(route) - 1) * 5.0
    assert abs(total - expected) < 5.0


def test_route_avg_hr_per_split():
    route = _straight_line_route(n=250, spacing_m=10.0, secs_per_point=5.0)
    hr = [HrSample(ts_utc=BASE + timedelta(seconds=i * 5.0), bpm=120.0) for i in range(250)]
    splits = compute_splits_from_route(route, hr, "km")
    assert splits[0].avg_hr == 120.0


def test_avg_hr_correct_with_unsorted_and_varied_samples():
    # HR climbs over time; feeding it out of order must still yield correct
    # per-split averages (the prefix-sum path pre-sorts internally).
    route = _straight_line_route(n=250, spacing_m=10.0, secs_per_point=5.0)
    ordered = [HrSample(ts_utc=BASE + timedelta(seconds=i * 5.0), bpm=float(100 + i)) for i in range(250)]
    shuffled = list(reversed(ordered))  # same samples, out of order
    a = compute_splits_from_route(route, ordered, "km")
    b = compute_splits_from_route(route, shuffled, "km")
    # Ordering of the input HR must not change any computed split average.
    assert [s.avg_hr for s in a] == [s.avg_hr for s in b]
    assert a[0].avg_hr is not None and a[0].avg_hr > 100.0


def test_route_too_few_points():
    assert compute_splits_from_route([], [], "mi") == []
    assert compute_splits_from_route([RoutePoint(BASE, 0, 0)], [], "mi") == []


def test_sample_splits():
    # 30 samples of 100 m every 60 s -> 3000 m -> three 1000 m splits.
    samples = [
        DistanceSample(
            start_utc=BASE + timedelta(seconds=i * 60),
            end_utc=BASE + timedelta(seconds=(i + 1) * 60),
            meters=100.0,
        )
        for i in range(30)
    ]
    splits = compute_splits_from_samples(samples, [], "km")
    full = [s for s in splits if abs(s.distance_m - 1000.0) < 1e-6]
    assert len(full) == 3
    for s in full:
        assert abs(s.pace_sec_per_unit - 600.0) < 30.0  # 10 samples * 60 s


def test_sample_splits_empty():
    assert compute_splits_from_samples([], [], "mi") == []
