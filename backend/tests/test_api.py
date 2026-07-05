"""End-to-end API tests via FastAPI TestClient (in-memory SQLite)."""
import json

WORKOUT_PAYLOAD = {
    "data": {
        "workouts": [
            {
                "id": "API-W1",
                "name": "Outdoor Run",
                "start": "2026-07-05 11:39:13 -0700",
                "end": "2026-07-05 12:10:07 -0700",
                "duration": 1853.6,
                "distance": {"qty": 2.3, "units": "mi"},
                "activeEnergyBurned": {"qty": 286.6, "units": "kcal"},
                "avgHeartRate": {"qty": 117.8},
                "route": [
                    {"latitude": 0.0, "longitude": 0.0,
                     "timestamp": "2026-07-05 11:39:13 -0700"},
                    {"latitude": 0.03, "longitude": 0.0,
                     "timestamp": "2026-07-05 12:10:07 -0700"},
                ],
                "heartRateData": [{"date": "2026-07-05 11:39:16 -0700", "Avg": 110}],
            }
        ],
        "metrics": [],
    }
}


def test_health_endpoint_is_open(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_ingest_requires_token(client):
    r = client.post("/api/ingest/health-auto-export", json=WORKOUT_PAYLOAD)
    assert r.status_code == 401


def test_ingest_rejects_bad_token(client):
    r = client.post(
        "/api/ingest/health-auto-export",
        json=WORKOUT_PAYLOAD,
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_full_ingest_and_read_flow(client, auth_headers):
    r = client.post(
        "/api/ingest/health-auto-export",
        content=json.dumps(WORKOUT_PAYLOAD),
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["workouts"] == 1

    # Re-ingest identical payload -> duplicate short-circuits.
    r2 = client.post(
        "/api/ingest/health-auto-export",
        content=json.dumps(WORKOUT_PAYLOAD),
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert r2.json()["duplicate"] is True

    # List
    lst = client.get("/api/workouts", headers=auth_headers).json()
    assert len(lst) == 1
    assert lst[0]["uuid"] == "API-W1"
    assert lst[0]["has_route"] is True

    # Detail with splits + route + hr
    detail = client.get("/api/workouts/API-W1?unit=mi", headers=auth_headers).json()
    assert detail["workout_type"] == "Outdoor Run"
    assert len(detail["route"]) == 2
    assert len(detail["splits"]) >= 1
    assert len(detail["hr_series"]) == 1

    # Dashboard
    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert "workouts_7d" in dash


def test_workout_404(client, auth_headers):
    assert client.get("/api/workouts/nope", headers=auth_headers).status_code == 404


def test_downsample_preserves_endpoints_and_cap():
    from app.routers import workouts as wr

    data = list(range(1000))
    out = wr._downsample(data, 100)
    assert len(out) <= 100
    assert out[0] == 0 and out[-1] == 999
    assert out == wr._downsample(data, 100)  # deterministic


def test_downsample_noop_when_within_cap():
    from app.routers import workouts as wr

    assert wr._downsample([1, 2, 3], 500) == [1, 2, 3]
    assert wr._downsample([], 500) == []


def _ingest(client, auth_headers, payload=WORKOUT_PAYLOAD):
    return client.post(
        "/api/ingest/health-auto-export",
        content=json.dumps(payload),
        headers={**auth_headers, "Content-Type": "application/json"},
    )


def test_workout_detail_downsamples_and_full_opt_in(client, auth_headers, monkeypatch):
    from app.routers import workouts as wr

    assert _ingest(client, auth_headers).status_code == 200
    monkeypatch.setattr(wr, "MAX_ROUTE_POINTS", 1)  # force downsampling of the 2-point route

    d = client.get("/api/workouts/API-W1?unit=mi", headers=auth_headers).json()
    assert d["route_total"] == 2
    assert d["route_downsampled"] is True
    assert len(d["route"]) == 1

    full = client.get("/api/workouts/API-W1?unit=mi&full=true", headers=auth_headers).json()
    assert len(full["route"]) == 2
    assert full["route_downsampled"] is False


def test_ingest_rejects_oversized_payload(client, auth_headers):
    from app.config import get_settings

    get_settings().max_ingest_bytes = 10  # tiny cap; any real payload exceeds it
    try:
        r = _ingest(client, auth_headers)
        assert r.status_code == 413, r.text
    finally:
        get_settings().max_ingest_bytes = 25 * 1024 * 1024


def test_dashboard_trends_are_windowed(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import Workout
    from app.timeutil import utcnow

    now = utcnow()
    recent, old = now - timedelta(days=1), now - timedelta(days=30)
    db_session.add_all(
        [
            Workout(
                uuid="recent", workout_type="Walk", start_utc=recent, end_utc=recent,
                local_date=recent.strftime("%Y-%m-%d"), duration_sec=600,
                has_route=False, created_utc=now, updated_utc=now,
            ),
            Workout(
                uuid="old", workout_type="Walk", start_utc=old, end_utc=old,
                local_date=old.strftime("%Y-%m-%d"), duration_sec=600,
                has_route=False, created_utc=now, updated_utc=now,
            ),
        ]
    )
    db_session.commit()

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert dash["workouts_7d"] == 1
    dates = [p["local_date"] for p in dash["weekly_workouts"]]
    assert recent.strftime("%Y-%m-%d") in dates
    assert old.strftime("%Y-%m-%d") not in dates
