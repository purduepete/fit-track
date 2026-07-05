"""Tests for auth token hashing and persistence idempotency."""
from app.auth import hash_token
from app.normalize import parse_payload, persist_payload
from app.models import Workout, WorkoutSplit


def test_hash_token_deterministic():
    assert hash_token("abc") == hash_token("abc")
    assert hash_token("abc") != hash_token("abd")
    assert len(hash_token("abc")) == 64


def _payload() -> dict:
    return {
        "data": {
            "workouts": [
                {
                    "id": "W1",
                    "name": "Outdoor Walk",
                    "start": "2026-07-05 11:39:13 -0700",
                    "end": "2026-07-05 12:10:07 -0700",
                    "duration": 1853.6,
                    "distance": {"qty": 2.3, "units": "mi"},
                    "route": [
                        {"latitude": 0.0, "longitude": 0.0,
                         "timestamp": "2026-07-05 11:39:13 -0700"},
                        {"latitude": 0.03, "longitude": 0.0,
                         "timestamp": "2026-07-05 12:10:07 -0700"},
                    ],
                    "heartRateData": [
                        {"date": "2026-07-05 11:39:16 -0700", "Avg": 110},
                    ],
                }
            ],
            "metrics": [
                {"name": "resting_heart_rate", "units": "count/min",
                 "data": [{"date": "2026-07-05 06:00:00 -0700", "qty": 55}]}
            ],
        }
    }


def test_persist_is_idempotent(db_session):
    parsed = parse_payload(_payload())
    persist_payload(parsed, db_session)
    first = db_session.query(Workout).count()
    splits_first = db_session.query(WorkoutSplit).count()

    # Re-ingest the identical payload.
    persist_payload(parse_payload(_payload()), db_session)
    assert db_session.query(Workout).count() == first == 1
    # Splits are replaced, not duplicated.
    assert db_session.query(WorkoutSplit).count() == splits_first


def test_persist_computes_splits(db_session):
    persist_payload(parse_payload(_payload()), db_session)
    splits = db_session.query(WorkoutSplit).filter_by(unit_system="mi").all()
    assert len(splits) >= 1
    assert all(s.workout_uuid == "W1" for s in splits)
