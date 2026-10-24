"""Strava sync tests use fake HTTP and the existing isolated SQLite fixture."""
import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from threading import Event

import httpx
import pytest
from app.models import RawIngestEvent, Workout, WorkoutSample, WorkoutSplit
from app.normalize import ParsedPayload, parse_workout, persist_payload
from app.strava import (
    Credentials,
    StravaClient,
    StravaError,
    load_credentials,
    parse_strava_payload,
    persist_strava_event,
    run_sync,
    save_credentials,
    summary_digest,
    sync_once,
)
from sqlalchemy.exc import SQLAlchemyError


def ride():
    return {
        "summary": {"id": 123, "sport_type": "VirtualRide", "distance": 2000},
        "activity": {
            "id": 123, "sport_type": "VirtualRide", "device_name": "Zwift",
            "start_date": "2026-10-23T02:30:00Z",
            "start_date_local": "2026-10-22T19:30:00Z",
            "elapsed_time": 600, "moving_time": 550, "distance": 2000,
            "calories": 125, "average_heartrate": 130, "max_heartrate": 150,
        },
        "streams": {
            "time": {"data": [0, 300, 600]},
            "distance": {"data": [0, 1000, 2000]},
            "heartrate": {"data": [110, 130, 150]},
            "latlng": {"data": [[1, 2], [3, 4], [5, 6]]},
        },
    }


@pytest.fixture
def token_file(tmp_path):
    path = tmp_path / "tokens.json"
    save_credentials(path, Credentials(
        client_id=42, client_secret="fake-secret", access_token="fake-access",
        refresh_token="fake-refresh", expires_at=int(datetime.now(UTC).timestamp()) + 3600,
        athlete_id=77, import_after=int((datetime.now(UTC) - timedelta(days=90)).timestamp()),
    ))
    return path


def test_parse_ride_local_date_streams_and_elapsed_time():
    workout = parse_strava_payload(ride()).workouts[0]
    assert workout.uuid == "strava:123"
    assert workout.local_date == "2026-10-22"
    assert workout.tz_offset_minutes == -420
    assert workout.workout_type == "Indoor Cycling"
    assert workout.source_name == "Strava"
    assert workout.duration_sec == 600
    assert workout.end_utc - workout.start_utc == timedelta(seconds=600)
    assert workout.distance_m == 2000
    assert workout.active_energy_kcal == 125
    assert workout.avg_hr == 130
    assert len(workout.hr_samples) == 3
    assert sum(s.meters for s in workout.distance_samples) == 2000
    assert workout.route == []  # Zwift's virtual coordinates are not real GPS.


def test_optional_data_can_be_absent():
    payload = ride()
    payload["streams"] = {}
    for key in ("calories", "average_heartrate", "max_heartrate"):
        del payload["activity"][key]
    workout = parse_strava_payload(payload).workouts[0]
    assert workout.avg_hr is None
    assert workout.active_energy_kcal is None
    assert workout.hr_samples == []


@pytest.mark.parametrize("field,value", [
    ("elapsed_time", -1), ("distance", float("nan")), ("elapsed_time", True),
    ("start_date", "bad"), ("start_date", "2026-10-23T02:30:00"),
    ("device_name", "ROUVY"), ("sport_type", "Ride"), ("id", "../123"),
])
def test_reject_invalid_or_non_zwift_activities(field, value):
    payload = ride()
    payload["activity"][field] = value
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


@pytest.mark.parametrize("key,data", [
    ("time", [0, 300, 299]), ("time", [0, 300, 601]),
    ("heartrate", [120]), ("distance", [0, 1200, 1000]),
])
def test_reject_malformed_streams(key, data):
    payload = ride()
    payload["streams"][key]["data"] = data
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


def test_persist_dedup_update_and_replay(db_session):
    payload = ride()
    counts = persist_strava_event(payload, db_session)
    assert counts["workouts"] == 1
    assert db_session.query(WorkoutSample).count() == 3
    assert db_session.query(WorkoutSplit).count() > 0
    assert persist_strava_event(payload, db_session)["workouts"] == 0
    changed = deepcopy(payload)
    changed["summary"]["distance"] = 2100
    changed["activity"]["distance"] = 2100
    assert persist_strava_event(changed, db_session)["workouts"] == 1
    assert db_session.query(Workout).count() == 1
    assert db_session.query(WorkoutSample).count() == 3
    assert db_session.get(Workout, "strava:123").distance_m == 2100
    event = db_session.query(RawIngestEvent).order_by(RawIngestEvent.id.desc()).first()
    assert event.source == "strava"
    parsed = parse_strava_payload(json.loads(event.payload_json))
    persist_payload(parsed, db_session, ingest_source="strava")
    assert db_session.query(Workout).count() == 1
    # An edit can revert to a previously seen summary.
    payload["activity"]["calories"] = 130
    assert persist_strava_event(payload, db_session)["workouts"] == 1
    assert db_session.get(Workout, "strava:123").distance_m == 2000
    replay = db_session.query(RawIngestEvent).filter(
        RawIngestEvent.payload_hash == summary_digest(payload["summary"]),
    ).one()
    assert json.loads(replay.payload_json)["activity"]["calories"] == 130


def health_ride(*, source="Zwift", start="2026-10-23T02:30:00Z"):
    workout = parse_workout({
        "id": "apple-123", "sourceName": source, "name": "Indoor Cycling",
        "start": start, "end": "2026-10-23T02:40:00Z", "duration": 600,
    })
    assert workout is not None
    return ParsedPayload(workouts=[workout])


@pytest.mark.parametrize("health_first", [True, False])
def test_cross_source_duplicate_both_arrival_orders(db_session, health_first):
    if health_first:
        persist_payload(health_ride(), db_session)
        db_session.commit()
        assert persist_strava_event(ride(), db_session)["workouts"] == 0
    else:
        persist_strava_event(ride(), db_session)
        assert persist_payload(health_ride(), db_session)["workouts"] == 0
    assert db_session.query(Workout).count() == 1


def test_different_ride_and_watch_recordings_preserved(db_session):
    persist_strava_event(ride(), db_session)
    assert persist_payload(health_ride(start="2026-10-23T02:20:00Z"), db_session)["workouts"] == 1
    payload = health_ride(source="Apple Watch")
    payload.workouts[0].uuid = "watch-123"
    assert persist_payload(payload, db_session)["workouts"] == 1


def test_default_health_source_exclusion_remains(db_session):
    assert persist_payload(parse_strava_payload(ride()), db_session)["workouts"] == 0


def test_refresh_rotates_and_saves_tokens_before_api_call(token_file):
    credentials = load_credentials(token_file)
    credentials.expires_at = 0
    save_credentials(token_file, credentials)
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/oauth/token":
            assert b"grant_type=refresh_token" in request.content
            return httpx.Response(200, json={
                "access_token": "new-access", "refresh_token": "new-refresh",
                "expires_at": int(datetime.now(UTC).timestamp()) + 3600,
            })
        assert request.headers["authorization"] == "Bearer new-access"
        assert load_credentials(token_file).refresh_token == "new-refresh"
        return httpx.Response(200, json={"id": 77})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        assert StravaClient(token_file, http).get("athlete") == {"id": 77}
    assert calls == ["/oauth/token", "/api/v3/athlete"]


@pytest.mark.parametrize("status", [401, 403, 429, 500, 302])
def test_http_errors_are_explicit_and_redacted(token_file, status):
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, text="fake-secret"))) as http:
        with pytest.raises(StravaError) as exc:
            StravaClient(token_file, http).get("athlete")
    assert "fake-secret" not in str(exc.value)


def test_atomic_save_failure_keeps_old_tokens(token_file, monkeypatch):
    original = token_file.read_text()

    def fail(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr(type(token_file), "replace", fail)
    with pytest.raises(StravaError):
        save_credentials(token_file, load_credentials(token_file))
    assert token_file.read_text() == original
    assert not token_file.with_suffix(".tmp").exists()


def test_sync_pagination_filter_and_repeat_skip(token_file, db_session):
    from contextlib import nullcontext

    payload = ride()
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/athlete"):
            return httpx.Response(200, json={"id": 77})
        if request.url.path.endswith("/athlete/activities"):
            assert int(request.url.params["after"]) >= load_credentials(token_file).import_after
            page = int(request.url.params["page"])
            return httpx.Response(200, json={
                1: [payload["summary"], {"id": 999, "sport_type": "Run"}],
                2: [{"id": 124, "sport_type": "VirtualRide"}], 3: [],
            }[page])
        if request.url.path.endswith("/124"):
            return httpx.Response(200, json={**payload["activity"], "id": 124, "device_name": "ROUVY"})
        if request.url.path.endswith("/streams"):
            return httpx.Response(200, json=payload["streams"])
        return httpx.Response(200, json=payload["activity"])

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        factory = lambda: nullcontext(db_session)  # noqa: E731
        assert sync_once(token_file, factory, http=http) == 1
        assert load_credentials(token_file).last_sync > 0
        assert sync_once(token_file, factory, http=http) == 0
    assert calls.count("/api/v3/activities/123") == 1
    assert calls.count("/api/v3/activities/123/streams") == 1
    assert db_session.query(Workout).count() == 1


def test_failed_sync_keeps_watermark(token_file, db_session):
    from contextlib import nullcontext

    def handler(request):
        if request.url.path.endswith("/athlete"):
            return httpx.Response(200, json={"id": 77})
        return httpx.Response(429)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(StravaError, match="rate limit"):
            sync_once(token_file, lambda: nullcontext(db_session), http=http)
    assert load_credentials(token_file).last_sync == 0


def test_worker_logs_failure_without_secrets(token_file, monkeypatch, caplog):
    from app import strava

    stop = Event()

    def fail(*args, **kwargs):
        stop.set()
        raise SQLAlchemyError("fake-secret in database error")

    monkeypatch.setattr(strava, "sync_once", fail)
    run_sync(stop, token_file, 900, None)
    assert "Strava sync failed" in caplog.text
    assert "fake-secret" not in caplog.text


@pytest.mark.parametrize("scope", ["read,activity:read_all", "read"])
def test_authorization_callback_state_and_scope(tmp_path, monkeypatch, scope):
    from threading import Thread
    from urllib.parse import parse_qs, urlencode, urlsplit

    from scripts import authorize_strava

    threads = []
    statuses = []
    path = tmp_path / "tokens.json"
    monkeypatch.setattr("builtins.input", lambda prompt: "42")
    monkeypatch.setattr(authorize_strava.getpass, "getpass", lambda prompt: "private-client-secret")
    monkeypatch.setattr(authorize_strava, "request_json", lambda *args, **kwargs: {
        "access_token": "new-access", "refresh_token": "new-refresh",
        "expires_at": int(datetime.now(UTC).timestamp()) + 3600, "athlete": {"id": 77},
    })

    def open_browser(url):
        query = parse_qs(urlsplit(url).query)

        def send_callback():
            base = query["redirect_uri"][0]
            for state in ["wrong-state", query["state"][0]]:
                callback = base + "?" + urlencode({"state": state, "scope": scope, "code": "private-code"})
                statuses.append(httpx.get(callback, timeout=10, trust_env=False).status_code)

        thread = Thread(target=send_callback)
        threads.append(thread)
        thread.start()
        return True

    monkeypatch.setattr(authorize_strava.webbrowser, "open", open_browser)
    if "activity:read_all" in scope:
        authorize_strava.authorize(path, 90)
        credentials = load_credentials(path)
        assert credentials.athlete_id == 77
        assert credentials.refresh_token == "new-refresh"
        assert abs(credentials.import_after - (int(datetime.now(UTC).timestamp()) - 90 * 86400)) < 5
    else:
        with pytest.raises(StravaError, match="permission missing"):
            authorize_strava.authorize(path, 90)
        assert not path.exists()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive()
    assert statuses == [400, 200]


def test_ride_and_raw_event_roll_back_together(db_session, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=db_session.get_bind(), autoflush=False, expire_on_commit=False)
    with factory() as db:
        def fail_commit():
            db.flush()
            raise SQLAlchemyError("simulated commit failure")

        monkeypatch.setattr(db, "commit", fail_commit)
        with pytest.raises(SQLAlchemyError):
            persist_strava_event(ride(), db)
    assert db_session.query(Workout).count() == 0
    assert db_session.query(RawIngestEvent).count() == 0
