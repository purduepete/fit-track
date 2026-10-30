"""Unit tests for geo helpers and split computation."""
import time
from datetime import datetime, timedelta

from app.geo import (
    DistanceSample,
    HrSample,
    RoutePoint,
    _dev_from_chord,
    compute_splits,
    compute_splits_from_route,
    compute_splits_from_samples,
    filter_route_outliers,
    haversine_m,
    speed_caps_mps,
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


def test_compute_splits_returns_both_units_from_shared_axes():
    route = _straight_line_route(n=250, spacing_m=10.0, secs_per_point=5.0)
    hr = [HrSample(ts_utc=BASE + timedelta(seconds=i * 5.0), bpm=120.0) for i in range(250)]

    both = compute_splits(route, [], hr, ("mi", "km"))
    assert {s.unit_system for s in both} == {"mi", "km"}

    # Deriving both units from one axis build must equal computing each alone.
    mi_only = compute_splits_from_route(route, hr, "mi")
    km_only = compute_splits_from_route(route, hr, "km")
    assert len(both) == len(mi_only) + len(km_only)
    assert len([s for s in both if s.unit_system == "mi"]) == len(mi_only)


def test_compute_splits_falls_back_to_samples_without_route():
    samples = [
        DistanceSample(
            start_utc=BASE + timedelta(seconds=i * 60),
            end_utc=BASE + timedelta(seconds=(i + 1) * 60),
            meters=500.0,
        )
        for i in range(6)  # 3000 m total
    ]
    both = compute_splits([], samples, [], ("mi", "km"))
    assert {s.unit_system for s in both} == {"mi", "km"}
    assert all(s.source == "sample" for s in both)


def test_compute_splits_empty_without_data():
    assert compute_splits([], [], [], ("mi", "km")) == []


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


# --- GPS outlier filtering ---------------------------------------------------

WALK = "Outdoor Walk"
DEG_PER_M = 1.0 / 111_320.0


def _p(t_s: float, north_m: float, east_m: float = 0.0) -> RoutePoint:
    """A point (north, east) metres from the equator origin, t_s seconds in."""
    return RoutePoint(
        ts_utc=BASE + timedelta(seconds=t_s),
        lat=north_m * DEG_PER_M,
        lon=east_m * DEG_PER_M,
    )


def _walk(n: int) -> list[RoutePoint]:
    """A 1 Hz walk due north at 1.4 m/s."""
    return [_p(i, i * 1.4) for i in range(n)]


def _cum_m(points: list[RoutePoint]) -> float:
    return sum(
        haversine_m(a.lat, a.lon, b.lat, b.lon)
        for a, b in zip(points, points[1:], strict=False)
    )


def test_filter_leaves_a_clean_track_alone():
    pts = _walk(20)
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert kept == pts


def test_filter_drops_a_mid_track_spike():
    pts = _walk(20)
    pts[10] = _p(10, 14.0, 500.0)
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 1
    assert all(p.lon == 0.0 for p in kept)


def test_filter_drops_a_cold_start_spike():
    # The forward pass has to trust its seed, so only the backward pass can see this.
    pts = _walk(20)
    pts[0] = _p(0, 0.0, 500.0)
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 1
    assert kept == pts[1:]


def test_filter_drops_a_cold_finish_spike_without_losing_the_trailing_run():
    pts = _walk(20)
    pts[19] = _p(19, 26.6, 500.0)
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 1
    assert kept == pts[:19]


def test_filter_clamps_the_travel_budget_across_a_long_pause():
    # A 5-minute stationary pause must not buy enough budget to make a 200 m
    # spike look reachable.
    pts = [_p(i, i * 1.4) for i in range(5)]
    pts.append(_p(304, 5.6))
    pts.append(_p(305, 5.6, 200.0))
    pts.extend(_p(306 + i, 8.4 + i * 1.4) for i in range(5))
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 1
    assert all(p.lon == 0.0 for p in kept)


def test_filter_keeps_a_dead_end_out_and_back():
    out = [_p(i, i * 1.4) for i in range(10)]
    back = [_p(10 + i, (8 - i) * 1.4) for i in range(9)]
    kept, dropped = filter_route_outliers(out + back, WALK)
    assert dropped == 0
    assert len(kept) == 19


def test_filter_keeps_a_sharp_switchback():
    pts = [_p(i, i * 1.0, 1.0 if i % 2 else -1.0) for i in range(20)]
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert len(kept) == 20


def test_filter_keeps_a_coherent_run_after_a_dropout():
    pts = [_p(i, i * 1.4) for i in range(10)]
    pts += [_p(130 + i, 500.0 + i * 1.4) for i in range(10)]
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert len(kept) == 20


def test_filter_keeps_a_relocation_on_a_sparsely_sampled_track():
    # Self-consistency scales with the sampling interval; a fixed radius would not.
    pts = [_p(i * 30, i * 42.0) for i in range(6)]
    pts += [_p(270 + i * 30, 500.0 + i * 42.0) for i in range(6)]
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert len(kept) == 12


def test_filter_drops_a_scattered_noise_burst():
    pts = _walk(20)
    pts[8] = _p(8, 11.2, 300.0)
    pts[9] = _p(9, 800.0)
    pts[10] = _p(10, 14.0, -500.0)
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 3
    assert all(p.lon == 0.0 for p in kept)


def test_jitter_is_tolerated_but_cannot_chain():
    # At 5 Hz the speed cap alone allows only 3 m between fixes, so the 10 m
    # jitter floor is what admits these steps at all. A single floored predicate
    # would draw the whole drift in, because each step is under 10 m.
    pts = [_p(i * 0.2, i * 0.28) for i in range(20)]
    for i, east in zip(range(8, 12), (9.0, 18.0, 27.0, 36.0), strict=True):
        pts[i] = _p(i * 0.2, i * 0.28, east)
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 3
    assert sum(1 for p in kept if p.lon > 0) == 1


def test_filter_keeps_a_two_point_tail_after_a_dropout():
    pts = _walk(18)
    pts.append(_p(118, 23.8, 500.0))
    pts.append(_p(119, 25.2, 500.0))
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert len(kept) == 20


def test_filter_leaves_a_very_short_track_alone():
    pts = [_p(0, 0.0), _p(1, 500.0), _p(2, 1000.0)]
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert kept == pts


def test_filter_bails_out_when_most_of_the_track_would_go():
    pts = [_p(i, i * 1.4) for i in range(11)]
    junk = ((400.0, 0.0), (0.0, 700.0), (-500.0, 0.0), (0.0, -900.0), (1200.0, 0.0), (300.0, 300.0))
    for i, (north, east) in enumerate(junk, start=1):
        pts[i] = _p(i, north, east)
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert kept == pts


def test_speed_cap_follows_the_workout_type():
    # The same 60 m / 3 s jump: 20 m/s is fine on a bike, impossible on foot.
    pts = [_p(i * 3, i * 4.2) for i in range(20)]
    pts[10] = _p(30, 42.0, 60.0)
    assert filter_route_outliers(pts, "Cycling")[1] == 0
    assert filter_route_outliers(pts, WALK)[1] == 1


def test_a_vehicle_leg_at_the_end_of_a_walk_survives():
    # Measured on three real walks: the track ends with a smooth ramp to
    # 12-13 m/s held for 20-40 s, which is a bus, not a bad fix. An activity-pace
    # cap deleted 230 real points this way; the filter must keep them.
    north = 0.0
    pts = []
    for i in range(30):
        north += 1.4
        pts.append(_p(i, north))
    for j, mps in enumerate((5.0, 7.0, 9.0, 11.0, 12.5, 13.0, 13.0, 12.5, 11.0, 8.0)):
        north += mps
        pts.append(_p(30 + j, north))
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 0
    assert kept == pts


def test_speed_caps_pair_a_self_powered_cap_with_a_ceiling():
    assert speed_caps_mps("Outdoor Walk") == (4.5, 15.0)
    assert speed_caps_mps("Outdoor Run") == (8.0, 15.0)
    # A bike is already fast under its own power, and a swimmer is never on a bus.
    assert speed_caps_mps("Cycling") == (25.0, 25.0)
    assert speed_caps_mps("Open Water Swim") == (3.0, 3.0)
    assert speed_caps_mps(None) == (15.0, 15.0)


def test_a_fast_fix_that_covers_no_ground_is_dropped():
    # 77 m in 7 s is 11 m/s, under the 15 m/s ceiling that protects vehicle legs.
    # It is still impossible here, because the walk resumes where it left off.
    pts = [_p(i, i * 1.4) for i in range(20)]
    pts.append(_p(26, 26.6, 77.0))
    pts.extend(_p(27 + i, 28.0 + i * 1.4) for i in range(20))
    kept, dropped = filter_route_outliers(pts, WALK)
    assert dropped == 1
    assert all(p.lon == 0.0 for p in kept)


# Measured at Redmond Technology Station: 21 s of multipath in which the GPS
# path covers 155 m while the walker moves 27.6 m. (seconds, east m, north m).
_BURST = (
    (0, -15.5, -8.4),
    (1, -14.6, -13.9),
    (2, -14.0, -18.2),
    (3, -13.4, -22.7),
    (4, -12.1, -31.0),
    (11, -24.2, 45.1),
    (12, -19.0, 40.5),
    (13, -13.5, 36.6),
    (14, -10.1, 32.0),
    (15, -10.4, 30.8),
    (16, -15.4, 26.8),
    (17, -21.3, 22.0),
    (18, -25.1, 18.9),
    (19, -29.0, 17.2),
    (20, -32.8, 16.2),
    (21, -36.2, 14.6),
    (22, -38.0, 11.6),
    (23, -37.8, 7.8),
)


def test_filter_drops_a_multipath_burst_that_goes_nowhere():
    # Every step after the first is small and locally plausible, so only the
    # window shows it: the walker covered 27.6 m while the track drew 155 m.
    lead = [_p(i - 20, -8.4, -15.5 + (20 - i) * 1.3) for i in range(20)]
    burst = [_p(t, north, east) for t, east, north in _BURST]
    tail = [_p(24 + i, 7.8, -37.8 - (i + 1) * 3.9) for i in range(20)]
    kept, dropped = filter_route_outliers(lead + burst + tail, WALK)

    assert dropped == 11
    assert burst[5] not in kept  # the 77 m / 7 s teleport
    north_m = [p.lat / DEG_PER_M for p in kept]
    assert max(north_m) < 17.0  # the 45 m northern excursion is gone
    assert min(north_m) > -20.0  # and the 31 m southern dip
    # ~263 m of drawn track for ~130 m of travel. What survives is within 12 m
    # of the direct line, which is not separable from ordinary GPS wobble.
    assert _cum_m(kept) < 170.0
    assert lead + [burst[0]] == kept[: len(lead) + 1]
    assert kept[-len(tail) :] == tail


def test_a_brisk_out_and_back_is_not_mistaken_for_a_burst():
    # Same signature as a burst (66 m of path, ~2 m of net displacement) but
    # every step is walkable, so nothing here is impossible.
    out = [_p(i, i * 2.2) for i in range(15)]
    back = [_p(15 + i, (13 - i) * 2.2) for i in range(15)]
    kept, dropped = filter_route_outliers(out + back, WALK)
    assert dropped == 0
    assert len(kept) == 30


def test_a_dense_burst_cannot_make_the_scan_quadratic():
    # The window is bounded by time, and the payload sets the timestamps. Without
    # a count bound this shape is O(n^2) haversines on an ingest request thread.
    n = 4000
    pts = [_p(i * 0.002, i * 0.02) for i in range(n)]
    pts[n // 2] = _p(n // 2 * 0.002, 900.0, 900.0)
    started = time.perf_counter()
    kept, dropped = filter_route_outliers(pts, WALK)
    # Bounded runs in ~0.1 s; without the count bound the same input takes ~6 s,
    # and the cost is quadratic, so 20k fixes would take minutes.
    assert time.perf_counter() - started < 2.0
    assert len(kept) + dropped == n


def test_duplicate_timestamps_do_not_hang_or_explode():
    pts = [_p(0, float(i)) for i in range(600)]
    kept, dropped = filter_route_outliers(pts, WALK)
    assert len(kept) + dropped == 600


def test_a_step_across_the_antimeridian_is_measured_the_short_way():
    # 179.999 E to 179.999 W is ~220 m apart, not most of the way round the world.
    a = RoutePoint(ts_utc=BASE, lat=0.0, lon=179.999, elevation_m=None)
    b = RoutePoint(ts_utc=BASE + timedelta(seconds=60), lat=0.0, lon=-179.999, elevation_m=None)
    mid = RoutePoint(ts_utc=BASE + timedelta(seconds=30), lat=0.0, lon=180.0, elevation_m=None)
    assert _dev_from_chord(a, b, mid) < 1.0


def test_filtering_shrinks_gps_distance_and_keeps_gps_splits():
    clean = [_p(i * 5, i * 5.0) for i in range(500)]
    spiked = list(clean)
    spiked[250] = _p(1250, 1250.0, 400.0)
    kept, dropped = filter_route_outliers(spiked, WALK)
    assert dropped == 1
    assert _cum_m(kept) < _cum_m(spiked)
    assert abs(_cum_m(kept) - _cum_m(clean)) < 1.0
    splits = compute_splits(kept, [], [])
    assert splits
    assert all(s.source == "gps" for s in splits)

def _climbing_route(n: int, rise_m_per_point: float) -> list[RoutePoint]:
    route = _straight_line_route(n=n, spacing_m=10.0, secs_per_point=10.0)
    for i, p in enumerate(route):
        p.elevation_m = 100.0 + i * rise_m_per_point
    return route


def test_route_split_elevation_gain_counts_climbing():
    # 2000 m climbing 0.5 m per 10 m point: about 50 m per km split.
    splits = compute_splits_from_route(_climbing_route(201, 0.5), [], "km")
    assert [round(s.elevation_gain_m) for s in splits] == [50, 50]


def test_descent_only_split_has_zero_gain():
    splits = compute_splits_from_route(_climbing_route(201, -0.5), [], "km")
    assert [s.elevation_gain_m for s in splits] == [0.0, 0.0]


def test_route_without_elevation_has_no_split_gain():
    splits = compute_splits_from_route(_straight_line_route(201, 10.0, 10.0), [], "km")
    assert all(s.elevation_gain_m is None for s in splits)


def test_climb_straddling_split_boundary_is_shared():
    # Distance samples put the km boundary at 300 s; elevation is only sampled
    # at 0 s and 600 s, so neither split holds both points.
    samples = [
        DistanceSample(BASE, BASE + timedelta(seconds=300), 1000.0),
        DistanceSample(BASE + timedelta(seconds=300), BASE + timedelta(seconds=600), 1000.0),
    ]
    elevation = [
        RoutePoint(BASE, 0.0, 0.0, elevation_m=0.0),
        RoutePoint(BASE + timedelta(seconds=600), 0.0, 0.0, elevation_m=60.0),
    ]
    splits = compute_splits([], samples, [], ("km",), elevation_points=elevation)
    assert [s.source for s in splits] == ["sample", "sample"]
    assert [s.elevation_gain_m for s in splits] == [30.0, 30.0]


def test_split_gain_ignores_missing_and_non_finite_elevation():
    route = _climbing_route(201, 0.5)
    route[50].elevation_m = None
    route[60].elevation_m = float("nan")
    splits = compute_splits_from_route(route, [], "km")
    assert [round(s.elevation_gain_m) for s in splits] == [50, 50]
