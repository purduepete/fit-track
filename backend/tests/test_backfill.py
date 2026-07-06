"""Tests for the XML backfill: parity with JSON ingest (D1) and daily aggregation (P8)."""
from app.normalize import parse_workout
from lxml import etree
from scripts.backfill_export_xml import _aggregate_daily, parse_workout_element


def test_json_and_xml_parse_agree_on_shared_fields():
    """The JSON and XML import paths must derive identical workouts (no drift).

    Both funnel through ``normalize.build_workout``, so equivalent source data
    must produce the same synthetic UUID, type mapping and derived fields.
    """
    json_w = {
        "workoutActivityType": "HKWorkoutActivityTypeRunning",
        "start": "2026-07-05 11:39:13 -0700",
        "end": "2026-07-05 12:10:07 -0700",
        "duration": 1853.6,
        "distance": {"qty": 2.3, "units": "mi"},
        "activeEnergyBurned": {"qty": 286.6},
        "avgHeartRate": {"qty": 117.8},
    }
    xml = (
        '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" '
        'startDate="2026-07-05 11:39:13 -0700" endDate="2026-07-05 12:10:07 -0700" '
        'duration="1853.6" durationUnit="s" totalDistance="2.3" totalDistanceUnit="mi" '
        'totalEnergyBurned="286.6">'
        '<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="117.8"/>'
        "</Workout>"
    )

    j = parse_workout(json_w)
    x, _ = parse_workout_element(etree.fromstring(xml))
    assert j is not None and x is not None

    # No Apple id -> both synthesize the SAME UUID from raw type + start.
    assert j.uuid == x.uuid
    for f in (
        "workout_type", "start_utc", "end_utc", "tz_offset_minutes", "local_date",
        "duration_sec", "distance_m", "active_energy_kcal", "avg_hr", "max_hr", "min_hr",
    ):
        assert getattr(j, f) == getattr(x, f), f


def test_aggregate_daily_from_running_accumulators():
    # metric -> day -> [sum, count, last]
    agg = {
        "step_count": {"2026-07-05": [100.0, 3.0, 40.0]},          # sum
        "resting_heart_rate": {"2026-07-05": [180.0, 3.0, 55.0]},  # avg
        "body_mass": {"2026-07-05": [300.0, 4.0, 75.0]},           # last
    }
    out = {(m.metric_type, m.local_date): m.value for m in _aggregate_daily(agg)}
    assert out[("step_count", "2026-07-05")] == 100.0
    assert out[("resting_heart_rate", "2026-07-05")] == 60.0
    assert out[("body_mass", "2026-07-05")] == 75.0
