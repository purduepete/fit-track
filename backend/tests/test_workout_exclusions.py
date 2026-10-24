from datetime import datetime, timedelta

import pytest
from app.geo import DistanceSample, HrSample, RoutePoint
from app.models import Workout, WorkoutRoutePoint, WorkoutSample, WorkoutSplit
from app.normalize import EXCLUDED_WORKOUT_IDS, ParsedPayload, build_workout, persist_payload
from scripts.remove_excluded_workouts import remove_excluded_workouts


def payload(workout_id: str, local_date: str = "2026-10-07") -> ParsedPayload:
    start = datetime.fromisoformat(local_date)
    return ParsedPayload(workouts=[build_workout(
        raw_type="Indoor Cycling", workout_id=workout_id,
        start_utc=start, end_utc=start + timedelta(seconds=600),
        tz_offset_minutes=0, source_name="Zwift", device_name=None,
        duration_sec=600, distance_m=2000, active_energy_kcal=125,
        avg_hr=120, max_hr=130, min_hr=110,
        route=[RoutePoint(start, 51.5, -0.1), RoutePoint(start + timedelta(seconds=600), 51.51, -0.1)],
        hr_samples=[HrSample(start, 120)],
        distance_samples=[DistanceSample(start, start + timedelta(seconds=600), 2000)],
    )])


@pytest.mark.parametrize("workout_id", sorted(EXCLUDED_WORKOUT_IDS))
@pytest.mark.parametrize("uppercase", [False, True])
def test_live_import_and_replay_cannot_restore_excluded_ids(db_session, workout_id, uppercase, caplog):
    workout_id = workout_id.upper() if uppercase else workout_id
    with caplog.at_level("INFO", logger="fittrack"):
        for _ in range(2):
            assert persist_payload(payload(workout_id), db_session)["workouts"] == 0
    assert "Skipping permanently excluded workout" in caplog.text
    assert db_session.query(Workout).count() == 0
    assert db_session.query(WorkoutRoutePoint).count() == 0


def test_removal_is_exact_and_deletes_children_without_restoring_on_replay(db_session, monkeypatch):
    keep = [
        "6B46623E-D748-47EF-ACBA-599718EFF2CD",
        "4702DC63-95F5-48AD-A6E8-CC36F9FD44FF",
        "26FCE55C-F7D0-4C5E-9C0B-05D68ED35518",
    ]
    for workout_id in keep:
        persist_payload(payload(workout_id), db_session)
    with monkeypatch.context() as patch:
        patch.setattr("app.normalize.EXCLUDED_WORKOUT_IDS", frozenset())
        for workout_id in EXCLUDED_WORKOUT_IDS:
            persist_payload(payload(workout_id.upper()), db_session)
    db_session.flush()
    assert len(remove_excluded_workouts(db_session)) == 4
    assert db_session.query(Workout).count() == 7
    assert len(remove_excluded_workouts(db_session, apply=True)) == 4
    for workout_id in EXCLUDED_WORKOUT_IDS:
        assert persist_payload(payload(workout_id), db_session)["workouts"] == 0
    assert {w.uuid for w in db_session.query(Workout)} == set(keep)
    for model in (WorkoutRoutePoint, WorkoutSample, WorkoutSplit):
        assert {row.workout_uuid for row in db_session.query(model)} == set(keep)
    assert remove_excluded_workouts(db_session, apply=True) == []


def test_wrong_date_aborts_without_deleting(db_session):
    workout_id = next(iter(EXCLUDED_WORKOUT_IDS))
    db_session.add(Workout(
        uuid=workout_id, workout_type="Indoor Cycling", local_date="2026-10-08",
        start_utc=datetime(2026, 10, 8), end_utc=datetime(2026, 10, 8),
        has_route=False, created_utc=datetime(2026, 10, 8), updated_utc=datetime(2026, 10, 8),
    ))
    db_session.flush()
    with pytest.raises(ValueError, match="approved date and type"):
        remove_excluded_workouts(db_session, apply=True)
    assert db_session.query(Workout).count() == 1
