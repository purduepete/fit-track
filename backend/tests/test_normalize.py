"""Unit tests for the Health Auto Export normalizer."""
from app.normalize import (
    as_number,
    distance_to_meters,
    local_date_str,
    parse_dt,
    parse_payload,
    parse_workout,
    unit_of,
)


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
    assert len(parsed.daily_metrics) == 2
    assert parsed.daily_metrics[0].metric_type == "step_count"
    assert parsed.daily_metrics[0].local_date == "2026-07-05"
