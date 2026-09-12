"""Unit tests for the Health Auto Export normalizer."""
from app.normalize import (
    _parse_route,
    as_number,
    as_source_name,
    distance_to_meters,
    local_date_str,
    parse_daily_metrics,
    parse_dt,
    parse_payload,
    parse_workout,
    unit_of,
)


def test_parse_route_rejects_non_finite_and_out_of_range_coordinates():
    # json.loads accepts bare NaN and Infinity, and the geo maths cannot survive
    # either, so the boundary has to reject them.
    ts = "2026-07-05 12:00:00 +0000"
    raw = [
        {"latitude": 47.6, "longitude": -122.1, "timestamp": ts},
        {"latitude": float("nan"), "longitude": -122.1, "timestamp": ts},
        {"latitude": 47.6, "longitude": float("inf"), "timestamp": ts},
        {"latitude": 91.0, "longitude": -122.1, "timestamp": ts},
        {"latitude": 47.6, "longitude": 181.0, "timestamp": ts},
    ]
    pts = _parse_route(raw)
    assert len(pts) == 1
    assert pts[0].lat == 47.6


def test_as_number_variants():
    assert as_number(5) == 5.0
    assert as_number({"qty": 3.5, "units": "mi"}) == 3.5
    assert as_number({"value": 2}) == 2.0
    assert as_number("7.5") == 7.5
    assert as_number(None) is None
    assert as_number("nope") is None


def test_unit_of():
    assert unit_of({"qty": 1, "units": "mi"}) == "mi"
    assert unit_of({"qty": 1, "unit": "km"}) == "km"
    assert unit_of(5, default="count") == "count"


def test_distance_to_meters_units():
    assert abs(distance_to_meters({"qty": 1, "units": "mi"}, "mi") - 1609.344) < 1e-3
    assert distance_to_meters({"qty": 1, "units": "km"}, "km") == 1000.0
    assert distance_to_meters({"qty": 100, "units": "m"}, "m") == 100.0


def test_parse_dt_offset_to_utc():
    utc, off = parse_dt("2026-07-05 11:39:13 -0700")
    assert utc.hour == 18  # 11:39 PDT -> 18:39 UTC
    assert off == -420


def test_parse_dt_naive():
    utc, off = parse_dt("2026-07-05 11:39:13")
    assert utc.hour == 11
    assert off is None


def test_parse_dt_bad():
    assert parse_dt("") == (None, None)
    assert parse_dt(None) == (None, None)


def test_fast_parse_dt_matches_dateutil():
    from app.normalize import _fast_parse_dt
    from dateutil import parser as dtparser

    for s in [
        "2026-07-05 11:39:13 -0700",
        "2026-07-05T11:39:13-07:00",
        "2026-07-05 11:39:13",
        "2026-07-05T11:39:13Z",
        "2026-07-05 11:39:13.500 -0700",
    ]:
        fast = _fast_parse_dt(s)
        assert fast is not None, s
        assert fast == dtparser.parse(s), s


def test_parse_dt_handles_z_suffix():
    utc, off = parse_dt("2026-07-05T11:39:13Z")
    assert utc.hour == 11
    assert off == 0


def test_local_date_uses_offset():
    # 01:30 UTC at -0700 is still the previous local day.
    from datetime import datetime

    assert local_date_str(datetime(2026, 7, 6, 1, 30), -420) == "2026-07-05"


def _sample_workout() -> dict:
    return {
        "id": "ABC-123",
        "name": "Outdoor Run",
        "start": "2026-07-05 11:39:13 -0700",
        "end": "2026-07-05 12:10:07 -0700",
        "duration": 1853.6,
        "distance": {"qty": 2.3, "units": "mi"},
        "activeEnergyBurned": {"qty": 286.6, "units": "kcal"},
        "avgHeartRate": {"qty": 117.8, "units": "count/min"},
        "maxHeartRate": {"qty": 143, "units": "count/min"},
        "heartRateData": [
            {"date": "2026-07-05 11:39:16 -0700", "Avg": 81, "units": "count/min"},
            {"date": "2026-07-05 11:40:16 -0700", "Avg": 120, "units": "count/min"},
        ],
        "route": [
            {"latitude": 47.857, "longitude": -122.540, "timestamp": "2026-07-05 11:39:13 -0700",
             "altitude": 92.1, "speed": 1.7},
            {"latitude": 47.858, "longitude": -122.540, "timestamp": "2026-07-05 11:39:14 -0700"},
        ],
        "walkingAndRunningDistance": [
            {"qty": 0.001, "units": "mi", "date": "2026-07-05 11:39:17 -0700"},
        ],
    }


def test_parse_workout_fields():
    w = parse_workout(_sample_workout())
    assert w.uuid == "ABC-123"
    assert w.workout_type == "Outdoor Run"
    assert w.tz_offset_minutes == -420
    assert w.local_date == "2026-07-05"
    assert abs(w.distance_m - 2.3 * 1609.344) < 1.0
    assert w.avg_hr == 117.8
    assert len(w.route) == 2
    assert w.route[0].elevation_m == 92.1
    assert w.route[0].speed_mps == 1.7
    assert len(w.hr_samples) == 2
    assert len(w.distance_samples) == 1


def test_parse_workout_synthesizes_uuid_when_missing():
    payload = _sample_workout()
    del payload["id"]
    w = parse_workout(payload)
    assert w.uuid  # deterministic uuid5
    assert parse_workout(payload).uuid == w.uuid


def test_as_source_name_accepts_string_or_object():
    assert as_source_name("Jim's Apple Watch") == "Jim's Apple Watch"
    assert as_source_name({"name": "Watch", "identifier": "com.apple.health.X"}) == "Watch"
    assert as_source_name({"identifier": "com.apple.health.X"}) == "com.apple.health.X"
    assert as_source_name({}) is None
    assert as_source_name(None) is None
    assert len(as_source_name({"name": "x" * 500})) == 120


def test_parse_workout_accepts_object_source():
    """HAE switched workout ``source`` from a string to an object."""
    payload = _sample_workout()
    payload["source"] = {"name": "Jim's Apple Watch", "identifier": "com.apple.health.FFCB"}
    w = parse_workout(payload)
    assert w.source_name == "Jim's Apple Watch"


def test_parse_daily_metrics_accepts_object_source():
    metrics = [
        {
            "name": "active_energy",
            "units": "kcal",
            "data": [
                {
                    "date": "2026-09-11 10:00:00 -0700",
                    "qty": 12.5,
                    "source": {"name": "Jim's Apple Watch", "identifier": "com.apple.health.X"},
                }
            ],
        }
    ]
    (m,) = parse_daily_metrics(metrics)
    assert m.source_name == "Jim's Apple Watch"


def test_synth_uuid_matches_across_json_and_xml_import_paths():
    """A workout with no Apple id must resolve to the SAME synthetic uuid whether
    it arrives via JSON ingest or the XML backfill (shared synth_workout_uuid)."""
    from app.normalize import synth_workout_uuid
    from lxml import etree
    from scripts.backfill_export_xml import parse_workout_element

    start = "2026-07-05 11:39:13 -0700"
    raw_type = "HKWorkoutActivityTypeRunning"

    json_w = parse_workout({"workoutActivityType": raw_type, "start": start, "end": start})
    xml_el = etree.fromstring(
        f'<Workout workoutActivityType="{raw_type}" startDate="{start}" '
        f'endDate="{start}" duration="10" durationUnit="min"/>'
    )
    xml_w, _ = parse_workout_element(xml_el)

    assert json_w.uuid == xml_w.uuid
    assert json_w.uuid == synth_workout_uuid(raw_type, json_w.start_utc)


def test_parse_payload_wraps_data():
    parsed = parse_payload({"data": {"workouts": [_sample_workout()], "metrics": []}})
    assert len(parsed.workouts) == 1


def test_parse_daily_metrics():
    payload = {
        "data": {
            "workouts": [],
            "metrics": [
                {
                    "name": "step_count",
                    "units": "count",
                    "data": [
                        {"date": "2026-07-05 08:00:00 -0700", "qty": 1000},
                        {"date": "2026-07-05 09:00:00 -0700", "qty": 500},
                    ],
                }
            ],
        }
    }
    parsed = parse_payload(payload)
    # Intraday step points sum into one source-less daily total.
    assert len(parsed.daily_metrics) == 1
    m = parsed.daily_metrics[0]
    assert m.metric_type == "step_count"
    assert m.local_date == "2026-07-05"
    assert m.value == 1500
    assert m.source_name == ""


def test_parse_step_metric_sums_across_sources_and_days():
    # HAE ships steps as many intraday points, sometimes with distinct (even
    # pipe-joined) source labels; all points for a day sum into one total.
    payload = {
        "data": {
            "workouts": [],
            "metrics": [
                {
                    "name": "step_count",
                    "units": "count",
                    "data": [
                        {"date": "2026-07-05 08:00:00 -0700", "qty": 1200, "source": "iPhone"},
                        {"date": "2026-07-05 09:00:00 -0700", "qty": 800, "source": "Apple Watch"},
                        {"date": "2026-07-05 10:00:00 -0700", "qty": 400.6, "source": "Apple Watch|iPhone"},
                        {"date": "2026-07-06 07:00:00 -0700", "qty": 5000, "source": "iPhone"},
                    ],
                }
            ],
        }
    }
    metrics = {m.local_date: m for m in parse_payload(payload).daily_metrics}
    assert metrics["2026-07-05"].value == 2401  # 1200 + 800 + 400.6, rounded
    assert metrics["2026-07-06"].value == 5000
    assert all(m.source_name == "" for m in metrics.values())


def _sleep_metric(points):
    return parse_payload({"data": {"workouts": [], "metrics": [
        {"name": "sleep_analysis", "units": "hr", "data": points}
    ]}}).daily_metrics


def test_parse_sleep_hours_format_attributed_to_wake_day():
    # HAE version that exports hours; asleep spans midnight -> attributed to wake day.
    metrics = _sleep_metric([
        {"sleepStart": "2026-07-04 23:00:00 -0700",
         "sleepEnd": "2026-07-05 06:30:00 -0700",
         "asleep": 7.4, "source": "Apple Watch"},
    ])
    assert len(metrics) == 1
    m = metrics[0]
    assert m.metric_type == "sleep_asleep_hours"
    assert m.unit == "hr"
    assert m.local_date == "2026-07-05"
    assert m.value == 7.4


def test_parse_sleep_seconds_format_normalized_to_hours():
    # Some HAE versions export seconds; anything > 24 is treated as seconds.
    metrics = _sleep_metric([
        {"sleepEnd": "2026-07-05 06:00:00 -0700", "asleep": 27000, "source": "Watch"},
    ])
    assert len(metrics) == 1
    assert metrics[0].value == 7.5


def test_parse_sleep_prefers_total_when_asleep_is_zero():
    # Real HAE shape: asleep=0, real total in totalSleep, stages also present.
    metrics = _sleep_metric([
        {"sleepStart": "2026-06-28 02:02:00 -0700",
         "sleepEnd": "2026-06-28 08:31:38 -0700",
         "asleep": 0, "totalSleep": 6.4937,
         "core": 3.758, "deep": 0.898, "rem": 1.837, "awake": 0,
         "date": "2026-06-28 00:00:00 -0700", "source": "Apple Watch"},
    ])
    assert len(metrics) == 1
    assert metrics[0].local_date == "2026-06-28"
    assert metrics[0].value == 6.494


def test_parse_sleep_falls_back_to_stage_sum():
    metrics = _sleep_metric([
        {"sleepEnd": "2026-07-05 06:00:00 -0700",
         "core": 4.0, "deep": 1.5, "rem": 1.0, "awake": 0.5},
    ])
    assert len(metrics) == 1
    assert metrics[0].value == 6.5


def test_parse_sleep_sums_fragmented_intervals_per_night():
    # Two points for the same wake day + source should sum, not overwrite.
    metrics = _sleep_metric([
        {"sleepEnd": "2026-07-05 02:00:00 -0700", "asleep": 3.0, "source": "Watch"},
        {"sleepEnd": "2026-07-05 06:30:00 -0700", "asleep": 4.5, "source": "Watch"},
    ])
    assert len(metrics) == 1
    assert metrics[0].local_date == "2026-07-05"
    assert metrics[0].value == 7.5
