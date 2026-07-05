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
