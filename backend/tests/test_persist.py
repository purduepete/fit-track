"""Tests for auth token hashing and persistence idempotency."""
from app.auth import hash_token
from app.models import DailyMetric, Workout, WorkoutSplit
from app.normalize import parse_payload, persist_payload


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


def test_persist_batches_multiple_workouts_and_metrics(db_session):
    """Multiple workouts + metrics persist correctly via the batched lookups."""
    payload = {
        "data": {
            "workouts": [
                {"id": "M1", "name": "Outdoor Walk",
                 "start": "2026-07-05 08:00:00 -0700", "end": "2026-07-05 08:30:00 -0700",
                 "duration": 1800.0, "distance": {"qty": 1.5, "units": "mi"}},
                {"id": "M2", "name": "Outdoor Run",
                 "start": "2026-07-05 18:00:00 -0700", "end": "2026-07-05 18:20:00 -0700",
                 "duration": 1200.0, "distance": {"qty": 2.0, "units": "mi"}},
            ],
            "metrics": [
                {"name": "resting_heart_rate", "units": "count/min",
                 "data": [{"date": "2026-07-05 06:00:00 -0700", "qty": 55}]},
                {"name": "vo2_max", "units": "ml/kg/min",
                 "data": [{"date": "2026-07-05 06:00:00 -0700", "qty": 42}]},
            ],
        }
    }
    counts = persist_payload(parse_payload(payload), db_session)
    assert counts["workouts"] == 2
    assert counts["daily_metrics"] == 2
    assert db_session.query(Workout).count() == 2
    assert {w.uuid for w in db_session.query(Workout).all()} == {"M1", "M2"}
    assert db_session.query(DailyMetric).count() == 2

    # Re-ingest updates in place (no duplicates) through the batched path.
    persist_payload(parse_payload(payload), db_session)
    assert db_session.query(Workout).count() == 2
    assert db_session.query(DailyMetric).count() == 2


def test_persist_chunks_in_clauses_across_boundaries(db_session, monkeypatch):
    """With a tiny chunk size, workouts and metrics that span multiple IN-clause
    batches must all persist and stay idempotent (regression for the Azure SQL
    2,100-parameter limit, which is enforced by chunking)."""
    from app import normalize

    monkeypatch.setattr(normalize, "_IN_CHUNK", 2)  # force several chunks

    payload = {
        "data": {
            "workouts": [
                {
                    "id": f"C{i}", "name": "Outdoor Walk",
                    "start": f"2026-07-{i + 1:02d} 08:00:00 -0700",
                    "end": f"2026-07-{i + 1:02d} 08:30:00 -0700",
                    "duration": 1800.0, "distance": {"qty": 1.0, "units": "mi"},
                }
                for i in range(5)
            ],
            "metrics": [
                {
                    "name": "resting_heart_rate", "units": "count/min",
                    "data": [
                        {"date": f"2026-07-{i + 1:02d} 06:00:00 -0700", "qty": 50 + i}
                        for i in range(5)
                    ],
                }
            ],
        }
    }
    counts = persist_payload(parse_payload(payload), db_session)
    assert counts["workouts"] == 5
    assert counts["daily_metrics"] == 5
    assert db_session.query(Workout).count() == 5
    assert db_session.query(DailyMetric).count() == 5

    # Re-ingest across the same chunk boundaries updates in place (no duplicates).
    persist_payload(parse_payload(payload), db_session)
    assert db_session.query(Workout).count() == 5
    assert db_session.query(DailyMetric).count() == 5


def test_persist_computes_splits(db_session):
    persist_payload(parse_payload(_payload()), db_session)
    splits = db_session.query(WorkoutSplit).filter_by(unit_system="mi").all()
    assert len(splits) >= 1
    assert all(s.workout_uuid == "W1" for s in splits)


def test_persist_dedupes_null_source_daily_metrics(db_session):
    """Duplicate metric points with no source must collapse to one row.

    Regression for the SQLite-vs-SQL-Server UNIQUE-with-NULLs mismatch: source_name
    is coalesced to "" and intra-payload duplicates are deduped, so a second row
    with a NULL source can never be created (which SQL Server rejects on commit).
    """
    payload = {
        "data": {
            "metrics": [
                {
                    "name": "resting_heart_rate",
                    "units": "count/min",
                    "data": [
                        {"date": "2026-07-05 06:00:00 -0700", "qty": 55},
                        {"date": "2026-07-05 06:30:00 -0700", "qty": 60},
                    ],
                }
            ]
        }
    }
    counts = persist_payload(parse_payload(payload), db_session)
    assert counts["daily_metrics"] == 2

    rows = db_session.query(DailyMetric).all()
    # Both points share (local_date, metric_type, source) -> a single row.
    assert len(rows) == 1
    assert rows[0].source_name == ""
    # Last value wins.
    assert rows[0].value == 60
