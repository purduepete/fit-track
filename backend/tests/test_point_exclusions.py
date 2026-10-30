from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch

import pytest
from app.models import RawIngestEvent, Workout, WorkoutRoutePoint, WorkoutSample
from app.strava import persist_strava_event


def ride():
    return {
        "summary": {"id": 123, "sport_type": "VirtualRide", "distance": 2200},
        "activity": {
            "id": 123,
            "sport_type": "VirtualRide",
            "device_name": "Zwift",
            "start_date": "2026-10-23T02:30:00Z",
            "start_date_local": "2026-10-22T19:30:00Z",
            "elapsed_time": 180,
            "moving_time": 180,
            "distance": 2200,
            "calories": 125,
            "average_heartrate": 150,
            "max_heartrate": 220,
            "total_elevation_gain": 1000,
        },
        "streams": {
            "time": {"data": [0, 60, 120, 180]},
            "distance": {"data": [0, 500, 1300, 2200]},
            "heartrate": {"data": [100, 220, 110, 120]},
            "latlng": {"data": [[1, 2], [3, 4], [5, 6], [7, 8]]},
            "altitude": {"data": [10, 1000, 20, 30]},
        },
    }


def test_batch_saves_all_changes_once_and_preserves_other_saved_points(client, auth_headers, db_session):
    persist_strava_event(ride(), db_session)
    url = "/api/workouts/strava:123"
    headers = {**auth_headers, "X-FitTrack-Edit": "1"}
    points = client.get(f"{url}?full=true", headers=auth_headers).json()["data_points"]
    markers = [{"ts_utc": point["ts_utc"]} for point in points]
    missing = {"ts_utc": "2026-10-23T02:31:05"}
    stored = db_session.get(Workout, "strava:123")
    stored.point_exclusions = [markers[0], markers[1], missing]
    db_session.commit()
    changes = {"exclude": [markers[2], markers[2]], "restore": [markers[1], missing]}
    with patch.object(db_session, "commit", wraps=db_session.commit) as commit:
        response = client.post(f"{url}/point-exclusions/batch", json=changes, headers=headers)
        assert response.status_code == 200
        assert response.json() == {"status": "saved"}
        commit.assert_called_once()
    after = client.get(f"{url}?full=true", headers=auth_headers).json()
    assert [point["ts_utc"] for point in after["point_exclusions"]] == [
        markers[0]["ts_utc"], markers[2]["ts_utc"]
    ]
    assert [point["excluded"] for point in after["data_points"]] == [True, False, True, False]
    assert after["avg_hr"] == 170
    assert db_session.query(WorkoutRoutePoint).count() == 4
    assert db_session.query(WorkoutSample).count() == 4
    assert client.post(f"{url}/point-exclusions/batch", json=changes, headers=headers).status_code == 200
    assert client.get(f"{url}?full=true", headers=auth_headers).json() == after


def test_batch_rejects_invalid_changes_without_saving_anything(client, auth_headers, db_session):
    persist_strava_event(ride(), db_session)
    url = "/api/workouts/strava:123"
    headers = {**auth_headers, "X-FitTrack-Edit": "1"}
    points = client.get(f"{url}?full=true", headers=auth_headers).json()["data_points"]
    first, second = ({"ts_utc": point["ts_utc"]} for point in points[:2])
    assert client.post(f"{url}/point-exclusions", json=first, headers=headers).status_code == 201
    invalid = {"ts_utc": "2026-10-24T00:00:00"}
    response = client.post(
        f"{url}/point-exclusions/batch",
        json={"exclude": [second, invalid], "restore": [first]},
        headers=headers,
    )
    assert response.status_code == 404
    assert db_session.get(Workout, "strava:123").point_exclusions == [first]
    response = client.post(
        f"{url}/point-exclusions/batch",
        json={"exclude": [second], "restore": [{"ts_utc": second["ts_utc"] + "Z"}]},
        headers=headers,
    )
    assert response.status_code == 422
    assert db_session.get(Workout, "strava:123").point_exclusions == [first]
    assert client.post(
        "/api/workouts/missing/point-exclusions/batch", json={}, headers=headers
    ).status_code == 404


def test_batch_missing_source_blocks_new_exclusions_but_allows_restoration(client, auth_headers, db_session):
    persist_strava_event(ride(), db_session)
    url = "/api/workouts/strava:123"
    headers = {**auth_headers, "X-FitTrack-Edit": "1"}
    points = client.get(f"{url}?full=true", headers=auth_headers).json()["data_points"]
    first, second = ({"ts_utc": point["ts_utc"]} for point in points[:2])
    assert client.post(f"{url}/point-exclusions", json=first, headers=headers).status_code == 201
    db_session.query(RawIngestEvent).delete()
    db_session.commit()
    response = client.post(
        f"{url}/point-exclusions/batch", json={"exclude": [second], "restore": [first]}, headers=headers
    )
    assert response.status_code == 409
    assert db_session.get(Workout, "strava:123").point_exclusions == [first]
    assert client.post(
        f"{url}/point-exclusions/batch", json={"restore": [first]}, headers=headers
    ).status_code == 200
    assert db_session.get(Workout, "strava:123").point_exclusions == []


def test_batch_requires_control_access_and_edit_header(client, auth_headers, db_session, monkeypatch):
    from app.config import get_settings

    persist_strava_event(ride(), db_session)
    url = "/api/workouts/strava:123/point-exclusions/batch"
    monkeypatch.setattr(get_settings(), "gateway_read_auth", False)
    assert client.post(url, json={}, headers={"X-FitTrack-Edit": "1"}).status_code == 401
    assert client.post(url, json={}, headers=auth_headers).status_code == 403
    monkeypatch.setattr(get_settings(), "gateway_read_auth", True)
    assert client.post(url, json={}).status_code == 403
    assert client.post(url, json={}, headers={"X-FitTrack-Edit": "1"}).status_code == 200


def test_exclusion_recalculates_whole_strava_point(client, auth_headers, db_session):
    payload = ride()
    persist_strava_event(payload, db_session)
    other = deepcopy(payload)
    other["summary"]["id"] = other["activity"]["id"] = 124
    persist_strava_event(other, db_session)
    detail_url = "/api/workouts/strava:123"
    edit_url = f"{detail_url}/point-exclusions"
    headers = {**auth_headers, "X-FitTrack-Edit": "1"}
    original = client.get(f"{detail_url}?full=true", headers=auth_headers).json()
    marker = {"ts_utc": original["data_points"][1]["ts_utc"]}

    assert client.post(edit_url, json=marker, headers=headers).status_code == 201
    after = client.get(f"{detail_url}?full=true", headers=auth_headers).json()
    assert [point["lat"] for point in after["route"]] == [1, 5, 7]
    assert [point["bpm"] for point in after["hr_series"]] == [100, 110, 120]
    assert [point["elevation_m"] for point in after["elevation_series"]] == [10, 20, 30]
    selected = after["data_points"][1]
    assert selected["excluded"] is True
    assert selected["route_count"] == 1
    assert selected["heart_rate_bpm"] == [220]
    assert selected["elevation_m"] == [1000]
    assert selected["distance_m"] == 500
    assert after["avg_hr"] == 110
    assert after["max_hr"] == 120
    assert after["min_hr"] == 100
    assert after["elevation_gain_m"] == 20
    assert after["distance_m"] == 2200
    assert after["duration_sec"] == 180
    assert after["active_energy_kcal"] == 125
    original_km = [split for split in original["splits"] if split["unit_system"] == "km"]
    adjusted_km = [split for split in after["splits"] if split["unit_system"] == "km"]
    assert adjusted_km[0]["duration_sec"] == pytest.approx(120 * 1000 / 1300)
    assert adjusted_km[0]["duration_sec"] != pytest.approx(original_km[0]["duration_sec"])
    listed = next(item for item in client.get("/api/workouts", headers=auth_headers).json()["items"]
                  if item["uuid"] == "strava:123")
    assert (listed["avg_hr"], listed["max_hr"], listed["elevation_gain_m"]) == (110, 120, 20)
    assert client.get("/api/workouts/strava:124", headers=auth_headers).json()["point_exclusions"] == []
    assert db_session.query(WorkoutRoutePoint).filter_by(workout_uuid="strava:123").count() == 4
    assert db_session.query(WorkoutSample).filter_by(workout_uuid="strava:123").count() == 4
    stored = db_session.get(Workout, "strava:123")
    assert (stored.avg_hr, stored.max_hr, stored.elevation_gain_m) == (150, 220, 1000)

    assert client.post(f"{edit_url}/restore", json=marker, headers=headers).status_code == 200
    restored = client.get(f"{detail_url}?full=true", headers=auth_headers).json()
    for field in ("route", "hr_series", "elevation_series", "splits", "avg_hr", "max_hr", "elevation_gain_m"):
        assert restored[field] == original[field]
    assert client.post(edit_url, json=marker, headers=headers).status_code == 201

    payload["summary"]["distance"] += 1
    payload["streams"]["altitude"]["data"][1] = 900
    payload["streams"]["heartrate"]["data"][1] = 210
    persist_strava_event(payload, db_session)
    reingested = client.get(f"{detail_url}?full=true", headers=auth_headers).json()
    assert reingested["point_exclusions"][0]["matched"] is True
    assert [point["bpm"] for point in reingested["hr_series"]] == [100, 110, 120]
    assert reingested["data_points"][1]["elevation_m"] == [900]

    payload["summary"]["distance"] += 1
    payload["streams"]["time"]["data"][1] = 65
    persist_strava_event(payload, db_session)
    unmatched = client.get(f"{detail_url}?full=true", headers=auth_headers).json()
    assert unmatched["point_exclusions"][0]["matched"] is False
    assert len(unmatched["route"]) == 4
    assert len(unmatched["hr_series"]) == 4
    assert client.post(f"{edit_url}/restore", json=marker, headers=headers).status_code == 200
    assert client.get(f"{detail_url}?full=true", headers=auth_headers).json()["point_exclusions"] == []


def test_distance_and_elevation_points_without_a_route(client, auth_headers, db_session):
    payload = ride()
    payload["streams"]["latlng"] = {"data": []}
    payload["streams"]["heartrate"] = {"data": []}
    persist_strava_event(payload, db_session)
    url = "/api/workouts/strava:123"
    original = client.get(url, headers=auth_headers).json()
    assert len(original["elevation_series"]) == 4
    full = client.get(f"{url}?full=true", headers=auth_headers).json()
    assert len(full["data_points"]) == 4
    marker = {"ts_utc": full["data_points"][-1]["ts_utc"]}
    headers = {**auth_headers, "X-FitTrack-Edit": "1"}
    assert client.post(f"{url}/point-exclusions", json=marker, headers=headers).status_code == 201
    after = client.get(f"{url}?full=true", headers=auth_headers).json()
    assert after["distance_m"] == 1300
    assert [point["elevation_m"] for point in after["elevation_series"]] == [10, 1000, 20]
    assert len(after["data_points"]) == 4
    assert after["data_points"][-1]["excluded"] is True


def test_missing_distance_source_is_reported_without_changing_samples(client, auth_headers, db_session):
    persist_strava_event(ride(), db_session)
    db_session.query(RawIngestEvent).delete()
    db_session.commit()
    url = "/api/workouts/strava:123"
    full = client.get(f"{url}?full=true", headers=auth_headers).json()
    marker = {"ts_utc": full["data_points"][1]["ts_utc"]}
    response = client.post(
        f"{url}/point-exclusions", json=marker, headers={**auth_headers, "X-FitTrack-Edit": "1"}
    )
    assert response.status_code == 409
    assert "Original distance samples are unavailable" in response.json()["detail"]
    assert db_session.get(Workout, "strava:123").point_exclusions == []


def test_missing_source_blocks_short_strava_workout_without_stored_splits(client, auth_headers, db_session):
    payload = ride()
    payload["activity"]["distance"] = payload["summary"]["distance"] = 20
    payload["streams"]["distance"]["data"] = [0, 5, 10, 20]
    persist_strava_event(payload, db_session)
    assert client.get("/api/workouts/strava:123", headers=auth_headers).json()["splits"] == []
    db_session.query(RawIngestEvent).delete()
    db_session.commit()
    url = "/api/workouts/strava:123"
    marker = {"ts_utc": client.get(f"{url}?full=true", headers=auth_headers).json()["data_points"][1]["ts_utc"]}
    response = client.post(
        f"{url}/point-exclusions", json=marker, headers={**auth_headers, "X-FitTrack-Edit": "1"}
    )
    assert response.status_code == 409
    assert "Original distance samples are unavailable" in response.json()["detail"]


def test_corrupt_newer_event_does_not_fall_back_to_older_source(client, auth_headers, db_session, caplog):
    persist_strava_event(ride(), db_session)
    older = db_session.query(RawIngestEvent).one()
    db_session.add(RawIngestEvent(
        source="strava",
        received_utc=older.received_utc + timedelta(seconds=1),
        processed_utc=older.processed_utc + timedelta(seconds=1),
        status="processed",
        payload_hash="corrupt",
        payload_json='{"activity":{"id":123}',
    ))
    db_session.commit()
    url = "/api/workouts/strava:123"
    marker = {"ts_utc": client.get(f"{url}?full=true", headers=auth_headers).json()["data_points"][1]["ts_utc"]}
    response = client.post(
        f"{url}/point-exclusions", json=marker, headers={**auth_headers, "X-FitTrack-Edit": "1"}
    )
    assert response.status_code == 409
    assert "invalid JSON" in caplog.text
    assert db_session.get(Workout, "strava:123").point_exclusions == []


def test_missing_source_after_exclusion_warns_and_still_allows_restore(client, auth_headers, db_session):
    persist_strava_event(ride(), db_session)
    url = "/api/workouts/strava:123"
    marker = {"ts_utc": client.get(f"{url}?full=true", headers=auth_headers).json()["data_points"][1]["ts_utc"]}
    headers = {**auth_headers, "X-FitTrack-Edit": "1"}
    assert client.post(f"{url}/point-exclusions", json=marker, headers=headers).status_code == 201
    db_session.query(RawIngestEvent).delete()
    db_session.commit()
    detail = client.get(f"{url}?full=true", headers=auth_headers).json()
    assert "Original distance samples are unavailable" in detail["point_exclusion_warning"]
    assert detail["distance_m"] is None
    assert detail["splits"] == []
    assert client.post(f"{url}/point-exclusions/restore", json=marker, headers=headers).status_code == 200
    assert client.get(url, headers=auth_headers).json()["distance_m"] == 2200
